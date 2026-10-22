import 'server-only';
import { db } from './dbDriver';
import {
	dhcpLeaseSnapshotTable,
	metricSampleTable,
	metricSeriesTable,
	routerSnapshotTable,
	wifiRadioSnapshotTable,
	wanFailoverStateTable,
	wanFailoverEventTable,
	type MetricTier
} from '@/drizzle/schema/schema';
import { and, avg, eq, gte, inArray, lte, max, min, sql } from 'drizzle-orm';
import { getRoutersWithId } from './router';
import { getNetworkDeviceStats } from './routerInterfaces';
import { getWifiClientsTraffic, getWifiRadios } from './wifiAPs';
import { getHostTrafficTotals } from './hostTraffic';
import {
	ClientCounterTracker,
	MAX_SPAN_SECONDS,
	SeriesRowBuilder,
	counterSegment,
	resampleRawRows,
	RAW_CHART_STEP_SECONDS,
	type CounterReading,
	type RateUpdate,
	type Segment
} from './counterDiff';
import { getDhcpDevices } from './dhcpDevices';
import { ubusBatchCall } from './ubusCalls';
import { routerInfoSchema } from '@/types/ubusCalls';
import { logError } from '../client/errorLog';
import { fetchWanFailoverState, type WanFailoverState } from './wanFailover';

const RAW_RETENTION_SECONDS = 5 * 60;
const TIER_1M_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const TIER_5M_RETENTION_SECONDS = 90 * 24 * 60 * 60;
// '1h' tier is retained forever - never pruned.

const CLIENT_POLL_EVERY_N_TICKS = 5; // collector runs every 1s, clients/radios polled every 5s
const RADIO_CONFIG_EVERY_N_TICKS = 10; // wifi radio config + dhcp leases every ~10s
const ROUTER_INFO_EVERY_N_TICKS = 30; // uptime/load/mem every ~30s
const WAN_FAILOVER_EVERY_N_TICKS = 20; // active-WAN state every ~20s - the router's own watchdog already does the real 5s/15s work, this just mirrors it
const PRUNE_EVERY_N_TICKS = 60; // raw retention is 5 minutes, pruning once/minute is plenty
const MAX_CATCHUP_BUCKETS = 120;
// A bucket is rolled up only this long after it ends: late rate updates and
// backdated rows (counterDiff.ts) reach back up to MAX_SPAN_SECONDS. Must stay
// below RAW_RETENTION_SECONDS minus a 1m bucket.
const ROLLUP_GRACE_SECONDS = MAX_SPAN_SECONDS + 30;

type MetricScopeName = 'interface' | 'client' | 'client_lan' | 'client_wan' | 'radio' | 'network';
export type ClientSplitScope = 'client_lan' | 'client_wan';

// The `tx` parameter type from a `db.transaction(async (tx) => ...)` callback.
type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RouterRow = { id: number; displayName: string; isPrimary: number };

type CounterState = { rx: number; tx: number; time: number };
const lastCounters = new Map<string, CounterState>();
// Per-client counters, one per node, and every rate series' last row (see
// counterDiff.ts).
const clientCounters = new ClientCounterTracker();
const rateRows = new SeriesRowBuilder();
const seriesIdCache = new Map<string, number>();

type WifiIfnames = {
	[displayName: string]: { ifname: string; ssid: string; band: string }[];
};

let tickCount = 0;
let isCollecting = false;
let cachedIfnames: WifiIfnames = {};

const rollupCursors: Record<'1m' | '5m' | '1h', number | null> = {
	'1m': null,
	'5m': null,
	'1h': null
};

function seriesKey(
	scope: MetricScopeName,
	routerId: number | null,
	key: string
) {
	return `${scope}:${routerId ?? 'null'}:${key}`;
}

async function getOrCreateSeriesId(
	scope: MetricScopeName,
	routerId: number | null,
	key: string
): Promise<number> {
	const cacheKey = seriesKey(scope, routerId, key);
	const cached = seriesIdCache.get(cacheKey);
	if (cached) return cached;

	const existing = await db
		.select({ id: metricSeriesTable.id })
		.from(metricSeriesTable)
		.where(
			and(
				eq(metricSeriesTable.scope, scope),
				routerId === null
					? sql`${metricSeriesTable.routerId} is null`
					: eq(metricSeriesTable.routerId, routerId),
				eq(metricSeriesTable.key, key)
			)
		)
		.limit(1);

	if (existing.length) {
		seriesIdCache.set(cacheKey, existing[0].id);
		return existing[0].id;
	}

	try {
		const inserted = await db
			.insert(metricSeriesTable)
			.values({ scope, routerId, key })
			.returning({ id: metricSeriesTable.id });
		seriesIdCache.set(cacheKey, inserted[0].id);
		return inserted[0].id;
	} catch {
		// Lost a race with another insert of the same series - just re-select.
		const retry = await db
			.select({ id: metricSeriesTable.id })
			.from(metricSeriesTable)
			.where(
				and(
					eq(metricSeriesTable.scope, scope),
					routerId === null
						? sql`${metricSeriesTable.routerId} is null`
						: eq(metricSeriesTable.routerId, routerId),
					eq(metricSeriesTable.key, key)
				)
			)
			.limit(1);
		seriesIdCache.set(cacheKey, retry[0].id);
		return retry[0].id;
	}
}

type PendingRow = typeof metricSampleTable.$inferInsert;

type PendingUpdate = RateUpdate & { seriesId: number };
type SampleRows = { rows: PendingRow[]; updates: PendingUpdate[] };

// Rows (and updates to earlier rows) for one rate series this tick, from its
// segments - see SeriesRowBuilder.
async function buildRateRows(
	out: SampleRows,
	scope: 'interface' | 'client' | ClientSplitScope | 'network',
	routerId: number | null,
	key: string,
	segments: Segment[],
	nowSec: number,
	signal?: number
) {
	const built = rateRows.build(seriesKey(scope, routerId, key), segments, nowSec);
	if (!built) return;
	const seriesId = await getOrCreateSeriesId(scope, routerId, key);
	for (const row of built.rows) {
		out.rows.push({
			seriesId,
			tier: 'raw',
			timestamp: row.timestamp,
			intervalSec: row.intervalSec,
			rxAvg: row.rx,
			rxMax: row.rx,
			txAvg: row.tx,
			txMax: row.tx,
			signalAvg: signal ?? null,
			signalMin: signal ?? null
		});
	}
	for (const update of built.updates) out.updates.push({ seriesId, ...update });
}

async function buildRadioRow(
	routerId: number,
	key: string,
	timestamp: number,
	clientCount: number,
	signalAvg: number | null,
	signalMin: number | null,
	noiseAvg: number | null
): Promise<PendingRow> {
	const seriesId = await getOrCreateSeriesId('radio', routerId, key);
	return {
		seriesId,
		tier: 'raw',
		timestamp,
		rxAvg: 0,
		rxMax: 0,
		txAvg: 0,
		txMax: 0,
		signalAvg,
		signalMin,
		clientCountAvg: clientCount,
		clientCountMax: clientCount,
		noiseAvg
	};
}

// ---- Fetch phase: ubus calls + series-id resolution (cache-hit dominant,
// rarely touches the DB) - deliberately kept out of the write transaction
// below, since ubus round-trips are slow and unpredictable and must never
// hold a DB transaction open while waiting on a router. ----

async function computeInterfaceSampleRows(
	routers: RouterRow[],
	nowSec: number
): Promise<SampleRows> {
	const out: SampleRows = { rows: [], updates: [] };
	await Promise.all(
		routers.map(async (router) => {
			const stats = await getNetworkDeviceStats(router.displayName);
			if (!stats.success) return;
			const { stats: deviceStats, bridgeMembers } = stats.data;
			for (const [netdev, { rxBytes, txBytes }] of Object.entries(deviceStats)) {
				// A `wan` netdev that is a bridge port is an AP's uplink, not a WAN:
				// keep it out of the per-router WAN tab and Combined WAN.
				const device =
					netdev === 'wan' && bridgeMembers.includes(netdev) ? 'wan-bridged' : netdev;
				const key = seriesKey('interface', router.id, device);
				const segment = counterSegment(lastCounters, key, rxBytes, txBytes, nowSec);
				if (!segment) continue;
				await buildRateRows(out, 'interface', router.id, device, [segment], nowSec);
			}
		})
	);
	return out;
}

async function computeClientAndRadioSampleRows(
	routers: RouterRow[],
	nowSec: number
): Promise<SampleRows> {
	const out: SampleRows = { rows: [], updates: [] };
	const rows = out.rows;
	let wifi: { [mac: string]: { rxBytes: number; txBytes: number; signal?: number } } = {};
	let stations: { [mac: string]: { [apId: string]: { rxBytes: number; txBytes: number } } } =
		{};

	// Started now so its macacct calls share each router's request with the
	// wifi calls below.
	const hostsPromise = getHostTrafficTotals();

	if (Object.keys(cachedIfnames).length > 0) {
		const routerIdByName = new Map(routers.map((r) => [r.displayName, r.id]));
		const traffic = await getWifiClientsTraffic(cachedIfnames);

		if (traffic.success) {
			wifi = traffic.data;
			stations = traffic.stations;

			for (const [displayName, radios] of Object.entries(traffic.perRadio)) {
				const routerId = routerIdByName.get(displayName);
				if (routerId === undefined) continue;
				for (const [ifname, radioStats] of Object.entries(radios)) {
					const signals = radioStats.signals;
					const noises = radioStats.noises;
					rows.push(
						await buildRadioRow(
							routerId,
							ifname,
							nowSec,
							radioStats.clientCount,
							signals.length
								? signals.reduce((a, b) => a + b, 0) / signals.length
								: null,
							signals.length ? Math.min(...signals) : null,
							noises.length
								? noises.reduce((a, b) => a + b, 0) / noises.length
								: null
						)
					);
				}
			}
		}
	}

	// Per-client traffic: exactly one counter basis per client per tick, in
	// order of fidelity (see hostTraffic.ts):
	//   macacct - every frame the client sends/receives at the node it's
	//             attached to (wired or wifi, LAN-local included), counted once
	//   wifi    - hostapd station counters (wifi only; reset on reassociation)
	//   nlbw    - nlbwmon (routed local<->non-local flows only)
	// Signal strength still comes from wifi data whichever basis is used.
	const hosts = await hostsPromise;
	const hostRouters = hosts.success ? hosts.data : [];
	// Per MAC, one reading per router that reports it, grouped by source.
	type HostReading = CounterReading & {
		lan?: { rx: number; tx: number };
		wan?: { rx: number; tx: number };
	};
	const macacct: { [mac: string]: HostReading[] } = {};
	const nlbw: { [mac: string]: HostReading[] } = {};
	for (const { displayName, source, totals } of hostRouters) {
		const into = source === 'macacct' ? macacct : nlbw;
		for (const [mac, t] of Object.entries(totals)) {
			(into[mac] ??= []).push({
				id: displayName,
				rx: t.rxBytes,
				tx: t.txBytes,
				lan: t.lan,
				wan: t.wan
			});
		}
	}
	const macs = new Set([
		...Object.keys(macacct),
		...Object.keys(stations),
		...Object.keys(nlbw)
	]);

	for (const mac of macs) {
		const [source, readings] = macacct[mac]
			? (['macacct', macacct[mac]] as const)
			: stations[mac]
				? ([
						'wifi',
						Object.entries(stations[mac]).map(([id, c]) => ({
							id,
							rx: c.rxBytes,
							tx: c.txBytes
						}))
					] as const)
				: (['nlbw', nlbw[mac]] as const);
		const segments = clientCounters.segments(
			seriesKey('client', null, mac),
			source,
			readings,
			nowSec
		);
		await buildRateRows(out, 'client', null, mac, segments, nowSec, wifi[mac]?.signal);
	}

	// LAN / Internet breakdown (macacct >= 2 only): two more series per
	// client, diffed per router like the totals. The same segments also feed
	// the network-wide LAN aggregate (Combined LAN): local = bytes delivered to
	// clients from other LAN devices (each LAN-local frame counted once, at its
	// destination); internet = both directions of clients' internet traffic.
	// Column reuse for scope 'network' key 'lan': rx = LAN-local, tx = internet.
	const networkSegments: Segment[] = [];
	for (const [mac, readings] of Object.entries(macacct)) {
		// Only when every router reporting the MAC splits (mixed macacct
		// versions during a rollout would otherwise make lan + wan != total).
		if (!readings.every((r) => r.lan && r.wan)) continue;
		for (const scope of ['client_lan', 'client_wan'] as const) {
			const pairs = readings.map((r) => ({
				id: r.id,
				...(scope === 'client_lan' ? r.lan! : r.wan!)
			}));
			const segments = clientCounters.segments(
				seriesKey(scope, null, mac),
				'macacct',
				pairs,
				nowSec
			);
			await buildRateRows(out, scope, null, mac, segments, nowSec);
			for (const seg of segments) {
				networkSegments.push(
					scope === 'client_lan'
						? { from: seg.from, rx: seg.rx, tx: 0 }
						: { from: seg.from, rx: 0, tx: seg.rx + seg.tx }
				);
			}
		}
	}
	await buildRateRows(out, 'network', null, 'lan', networkSegments, nowSec);

	return out;
}

async function fetchWifiRadioSnapshot(routers: RouterRow[]) {
	const radios = await getWifiRadios();
	if (!radios.success) {
		logError({
			...radios,
			errorMessage: 'metrics collector: failed to refresh wifi radio snapshot'
		});
		return null;
	}

	const routerIdByName = new Map(routers.map((r) => [r.displayName, r.id]));
	const byRouterId = new Map<number, string>(); // routerId -> JSON of that router's radios
	const byRouter = new Map<string, typeof radios.data>();
	for (const radio of radios.data) {
		if (!byRouter.has(radio.displayName)) byRouter.set(radio.displayName, []);
		byRouter.get(radio.displayName)!.push(radio);
	}
	for (const [displayName, routerRadios] of byRouter.entries()) {
		const routerId = routerIdByName.get(displayName);
		if (routerId === undefined) continue;
		byRouterId.set(routerId, JSON.stringify(routerRadios));
	}

	// ap-only, ssid-bearing ifname map used for client polling next tick.
	const ifnames: WifiIfnames = {};
	for (const radio of radios.data) {
		if (radio.mode === 'mesh' || !radio.ssid) continue;
		if (!ifnames[radio.displayName]) ifnames[radio.displayName] = [];
		ifnames[radio.displayName].push({
			ifname: radio.ifname,
			ssid: radio.ssid,
			band: radio.band
		});
	}

	return { byRouterId, ifnames };
}

async function fetchRouterSnapshotRows(routers: RouterRow[]) {
	const results: { routerId: number; data: string }[] = [];
	await Promise.all(
		routers.map(async (router) => {
			const response = await ubusBatchCall({
				displayName: router.displayName,
				calls: [
					{ id: 1, params: ['system', 'info', {}] },
					{ id: 2, params: ['system', 'board', {}] }
				]
			});
			if (!response.success) return;
			const flattenData: { [key: string]: any } = {};
			response.data.forEach((data: any) => {
				if (data.result) {
					Object.keys(data.result[1]).forEach((key) => {
						flattenData[key] = data.result[1][key];
					});
				}
			});
			const parsed = routerInfoSchema.safeParse(flattenData);
			if (!parsed.success) return;
			results.push({ routerId: router.id, data: JSON.stringify(parsed.data) });
		})
	);
	return results;
}

async function fetchWanFailoverStateRows(routers: RouterRow[]) {
	const results: { routerId: number; state: WanFailoverState }[] = [];
	await Promise.all(
		routers.map(async (router) => {
			const response = await fetchWanFailoverState(router.displayName);
			if (!response.success || !response.data) return;
			results.push({ routerId: router.id, state: response.data });
		})
	);
	return results;
}

// ---- Write phase: pure DB, all wrapped in one transaction per tick so the
// whole batch fsyncs once instead of once per statement. ----

async function rollupTier(
	tx: DbClient,
	{
		sourceTier,
		targetTier,
		stepSeconds,
		sourceStepSeconds,
		nowSec
	}: {
		sourceTier: MetricTier;
		targetTier: '1m' | '5m' | '1h';
		stepSeconds: number;
		// Seconds each source row covers; null = raw, rows carry intervalSec.
		sourceStepSeconds: number | null;
		nowSec: number;
	}
) {
	const currentBucket = Math.floor((nowSec - ROLLUP_GRACE_SECONDS) / stepSeconds);
	// Rates are time-weighted: a bucket's average is the bytes its rows cover
	// divided by the bucket length, so a series present for part of a bucket
	// (a client that just appeared, a gap) counts as zero for the rest - never
	// its partial average stretched over the whole bucket. Totals then agree
	// across tiers. Raw rows without intervalSec (older code) fall back to the
	// plain average. Gauges (signal, client count, noise) stay plain averages.
	const weighted = (column: typeof metricSampleTable.rxAvg | typeof metricSampleTable.txAvg) =>
		sourceStepSeconds === null
			? sql<number>`case when count(${metricSampleTable.intervalSec}) = count(*) then sum(${column} * ${metricSampleTable.intervalSec}) / ${stepSeconds} else avg(${column}) end`
			: sql<number>`sum(${column}) * ${sourceStepSeconds} / ${stepSeconds}`;
	let cursor = rollupCursors[targetTier];
	if (cursor === null) {
		// After a restart, resume after the newest bucket already rolled up -
		// neither redo it (duplicate rows) nor skip the ones still pending.
		const [latest] = await tx
			.select({ timestamp: max(metricSampleTable.timestamp) })
			.from(metricSampleTable)
			.where(eq(metricSampleTable.tier, targetTier));
		cursor =
			latest?.timestamp != null
				? Math.max(
						Math.floor(latest.timestamp / stepSeconds) + 1,
						currentBucket - MAX_CATCHUP_BUCKETS
					)
				: currentBucket;
		rollupCursors[targetTier] = cursor;
	}
	if (currentBucket <= cursor) return;

	const startBucket = Math.max(cursor, currentBucket - MAX_CATCHUP_BUCKETS);
	for (let bucket = startBucket; bucket < currentBucket; bucket++) {
		const bucketStart = bucket * stepSeconds;
		const bucketEnd = bucketStart + stepSeconds;
		const rows = await tx
			.select({
				seriesId: metricSampleTable.seriesId,
				rxAvg: weighted(metricSampleTable.rxAvg),
				rxMax: max(metricSampleTable.rxMax),
				txAvg: weighted(metricSampleTable.txAvg),
				txMax: max(metricSampleTable.txMax),
				signalAvg: avg(metricSampleTable.signalAvg),
				signalMin: min(metricSampleTable.signalMin),
				clientCountAvg: avg(metricSampleTable.clientCountAvg),
				clientCountMax: max(metricSampleTable.clientCountMax),
				noiseAvg: avg(metricSampleTable.noiseAvg)
			})
			.from(metricSampleTable)
			.where(
				and(
					eq(metricSampleTable.tier, sourceTier),
					gte(metricSampleTable.timestamp, bucketStart),
					sql`${metricSampleTable.timestamp} < ${bucketEnd}`
				)
			)
			.groupBy(metricSampleTable.seriesId);

		if (rows.length) {
			await tx.insert(metricSampleTable).values(
				rows.map((r) => ({
					seriesId: r.seriesId,
					tier: targetTier,
					timestamp: bucketStart,
					rxAvg: Number(r.rxAvg) || 0,
					rxMax: Number(r.rxMax) || 0,
					txAvg: Number(r.txAvg) || 0,
					txMax: Number(r.txMax) || 0,
					signalAvg: r.signalAvg !== null ? Number(r.signalAvg) : null,
					signalMin: r.signalMin !== null ? Number(r.signalMin) : null,
					clientCountAvg:
						r.clientCountAvg !== null ? Number(r.clientCountAvg) : null,
					clientCountMax:
						r.clientCountMax !== null ? Number(r.clientCountMax) : null,
					noiseAvg: r.noiseAvg !== null ? Number(r.noiseAvg) : null
				}))
			);
		}
	}
	rollupCursors[targetTier] = currentBucket;
}

async function pruneOldSamples(tx: DbClient, nowSec: number) {
	await tx
		.delete(metricSampleTable)
		.where(
			and(
				eq(metricSampleTable.tier, 'raw'),
				sql`${metricSampleTable.timestamp} < ${nowSec - RAW_RETENTION_SECONDS}`
			)
		);
	await tx
		.delete(metricSampleTable)
		.where(
			and(
				eq(metricSampleTable.tier, '1m'),
				sql`${metricSampleTable.timestamp} < ${nowSec - TIER_1M_RETENTION_SECONDS}`
			)
		);
	await tx
		.delete(metricSampleTable)
		.where(
			and(
				eq(metricSampleTable.tier, '5m'),
				sql`${metricSampleTable.timestamp} < ${nowSec - TIER_5M_RETENTION_SECONDS}`
			)
		);
}

export async function collectTick() {
	if (isCollecting) return;
	isCollecting = true;
	try {
		const nowSec = Math.floor(Date.now() / 1000);
		tickCount++;

		const routers = await getRoutersWithId();
		if (!routers.success) {
			logError({
				...routers,
				errorMessage: 'metrics collector: failed to list routers'
			});
			return;
		}

		// Fetch phase - all ubus calls happen here, outside any transaction.
		// Concurrently, so that each router's calls for this tick are
		// coalesced into one HTTP request (see postUbus in ubusCalls.ts).
		const radioTick = tickCount % RADIO_CONFIG_EVERY_N_TICKS === 0;
		const [
			interfaceRows,
			[radioSnapshot, dhcpLeases],
			routerSnapshotRows,
			wanFailoverRows,
			clientRadioRows
		] = await Promise.all([
			computeInterfaceSampleRows(routers.data, nowSec),
			radioTick
				? fetchWifiRadioSnapshot(routers.data).then(
						async (snapshot) => [snapshot, await getDhcpDevices()] as const
					)
				: ([null, null] as const),
			tickCount % ROUTER_INFO_EVERY_N_TICKS === 0
				? fetchRouterSnapshotRows(routers.data)
				: [],
			tickCount % WAN_FAILOVER_EVERY_N_TICKS === 0
				? fetchWanFailoverStateRows(routers.data)
				: [],
			tickCount % CLIENT_POLL_EVERY_N_TICKS === 0
				? computeClientAndRadioSampleRows(routers.data, nowSec)
				: ({ rows: [], updates: [] } as SampleRows)
		]);

		// Write phase - everything below is pure DB work, batched into one
		// transaction so it fsyncs once instead of once per statement.
		await db.transaction(async (tx) => {
			const allSampleRows = [...interfaceRows.rows, ...clientRadioRows.rows];
			if (allSampleRows.length) {
				await tx.insert(metricSampleTable).values(allSampleRows);
			}
			// A node that came back after missed polls: add its rate to the raw
			// rows already written for the span it covers, each by the share of
			// its own interval inside (from, to].
			for (const u of [...interfaceRows.updates, ...clientRadioRows.updates]) {
				const share = sql`((${metricSampleTable.timestamp} - max(${metricSampleTable.timestamp} - ${metricSampleTable.intervalSec}, ${u.from})) * 1.0 / ${metricSampleTable.intervalSec})`;
				await tx
					.update(metricSampleTable)
					.set({
						rxAvg: sql`${metricSampleTable.rxAvg} + ${u.rx} * ${share}`,
						rxMax: sql`${metricSampleTable.rxMax} + ${u.rx} * ${share}`,
						txAvg: sql`${metricSampleTable.txAvg} + ${u.tx} * ${share}`,
						txMax: sql`${metricSampleTable.txMax} + ${u.tx} * ${share}`
					})
					.where(
						and(
							eq(metricSampleTable.seriesId, u.seriesId),
							eq(metricSampleTable.tier, 'raw'),
							sql`${metricSampleTable.intervalSec} > 0`,
							sql`${metricSampleTable.timestamp} > ${u.from}`,
							lte(metricSampleTable.timestamp, u.to)
						)
					);
			}

			if (radioSnapshot) {
				for (const [routerId, data] of radioSnapshot.byRouterId) {
					await tx
						.insert(wifiRadioSnapshotTable)
						.values({ routerId, data, updatedAt: nowSec })
						.onConflictDoUpdate({
							target: wifiRadioSnapshotTable.routerId,
							set: { data, updatedAt: nowSec }
						});
				}
			}
			if (dhcpLeases?.success) {
				const data = JSON.stringify(dhcpLeases.data);
				await tx
					.insert(dhcpLeaseSnapshotTable)
					.values({ id: 1, data, updatedAt: nowSec })
					.onConflictDoUpdate({
						target: dhcpLeaseSnapshotTable.id,
						set: { data, updatedAt: nowSec }
					});
			}
			for (const row of routerSnapshotRows) {
				await tx
					.insert(routerSnapshotTable)
					.values({ ...row, updatedAt: nowSec })
					.onConflictDoUpdate({
						target: routerSnapshotTable.routerId,
						set: { data: row.data, updatedAt: nowSec }
					});
			}

			for (const row of wanFailoverRows) {
				const existing = await tx
					.select({ since: wanFailoverStateTable.since })
					.from(wanFailoverStateTable)
					.where(eq(wanFailoverStateTable.routerId, row.routerId))
					.limit(1);

				// The watchdog's own "since" only moves on a real transition, so a
				// changed value here (or no prior row at all) is exactly a new event
				// - not a decision this collector has to make on its own.
				if (!existing.length || existing[0].since !== row.state.since) {
					await tx.insert(wanFailoverEventTable).values({
						routerId: row.routerId,
						timestamp: row.state.since,
						activeInterface: row.state.activeInterface
					});
				}

				await tx
					.insert(wanFailoverStateTable)
					.values({
						routerId: row.routerId,
						activeInterface: row.state.activeInterface,
						since: row.state.since,
						updatedAt: nowSec
					})
					.onConflictDoUpdate({
						target: wanFailoverStateTable.routerId,
						set: {
							activeInterface: row.state.activeInterface,
							since: row.state.since,
							updatedAt: nowSec
						}
					});
			}

			await rollupTier(tx, {
				sourceTier: 'raw',
				targetTier: '1m',
				stepSeconds: 60,
				sourceStepSeconds: null,
				nowSec
			});
			await rollupTier(tx, {
				sourceTier: '1m',
				targetTier: '5m',
				stepSeconds: 300,
				sourceStepSeconds: 60,
				nowSec
			});
			await rollupTier(tx, {
				sourceTier: '5m',
				targetTier: '1h',
				stepSeconds: 3600,
				sourceStepSeconds: 300,
				nowSec
			});
			if (tickCount % PRUNE_EVERY_N_TICKS === 0) {
				await pruneOldSamples(tx, nowSec);
			}
		});

		if (radioSnapshot) {
			cachedIfnames = radioSnapshot.ifnames;
		}
	} catch (error) {
		logError({ errorMessage: 'metrics collector tick failed', error });
	} finally {
		isCollecting = false;
	}
}

const NON_BREAKDOWN_DEVICES = new Set(['lo', 'wan', 'br-lan']);

export type InterfaceDevices = Awaited<ReturnType<typeof listInterfaceDevices>>;
export async function listInterfaceDevices(routerId: number) {
	try {
		const rows = await db
			.select({ key: metricSeriesTable.key })
			.from(metricSeriesTable)
			.where(
				and(
					eq(metricSeriesTable.scope, 'interface'),
					eq(metricSeriesTable.routerId, routerId)
				)
			);
		return {
			success: true,
			data: rows
				.map((r) => r.key)
				.filter((key) => !NON_BREAKDOWN_DEVICES.has(key))
				.sort()
		} as const;
	} catch (error) {
		logError({ errorMessage: 'Failed to list interface devices', error });
		return {
			success: false,
			errorMessage: 'Failed to list interface devices'
		} as const;
	}
}

const COMBINABLE_KEYS = ['wan', 'br-lan', 'bat0'] as const;
export type AvailableKeys = Awaited<ReturnType<typeof listAvailableCombinedKeys>>;
export async function listAvailableCombinedKeys() {
	try {
		const rows = await db
			.select({ key: metricSeriesTable.key })
			.from(metricSeriesTable)
			.where(
				and(
					eq(metricSeriesTable.scope, 'interface'),
					inArray(metricSeriesTable.key, [...COMBINABLE_KEYS])
				)
			);
		const found = new Set(rows.map((r) => r.key));
		return {
			success: true,
			data: {
				wan: found.has('wan'),
				'br-lan': found.has('br-lan'),
				bat0: found.has('bat0')
			}
		} as const;
	} catch (error) {
		logError({ errorMessage: 'Failed to list available combined keys', error });
		return {
			success: false,
			errorMessage: 'Failed to list available combined keys'
		} as const;
	}
}

function pickTier(rangeSeconds: number): MetricTier {
	if (rangeSeconds > 14 * 24 * 60 * 60) return '1h';
	if (rangeSeconds > 24 * 60 * 60) return '5m';
	if (rangeSeconds > 10 * 60) return '1m';
	return 'raw';
}

export type MetricHistoryPoint = {
	timestamp: number;
	rxAvg: number;
	rxMax: number;
	txAvg: number;
	txMax: number;
	signalAvg?: number | null;
	signalMin?: number | null;
	clientCountAvg?: number | null;
	clientCountMax?: number | null;
	noiseAvg?: number | null;
};

// Chart points as sent to the browser: rates rounded to whole bytes/s and
// gauges that are null (every non-radio series) left out - about a third of
// the JSON otherwise.
export function compactPoints(points: MetricHistoryPoint[]): MetricHistoryPoint[] {
	return points.map((p) => {
		const out: MetricHistoryPoint = {
			timestamp: p.timestamp,
			rxAvg: Math.round(p.rxAvg),
			rxMax: Math.round(p.rxMax),
			txAvg: Math.round(p.txAvg),
			txMax: Math.round(p.txMax)
		};
		for (const k of ['signalAvg', 'signalMin', 'clientCountAvg', 'clientCountMax', 'noiseAvg'] as const) {
			const v = p[k];
			if (v !== null && v !== undefined) out[k] = Math.round(v * 10) / 10;
		}
		return out;
	});
}

export type MetricHistory = Awaited<ReturnType<typeof queryHistory>>;
// `since` (optional): the caller already has the points up to it, so return
// only those after it (rollup tiers: from it on). The tier is still picked from the whole
// from..to range, so an incremental poll gets the same points a full one would.
export async function queryHistory({
	scope,
	key,
	routerId,
	combined,
	from,
	to,
	since
}: {
	scope: MetricScopeName;
	key: string;
	routerId?: number;
	combined?: boolean;
	from: number;
	to: number;
	since?: number;
}) {
	const tier = pickTier(to - from);
	// Raw buckets are stamped with their end and only whole ones inside the
	// range are returned, so a `since` on a bucket boundary gets exactly the
	// buckets after it.
	if (since !== undefined && since > from) {
		from = Math.floor(since / RAW_CHART_STEP_SECONDS) * RAW_CHART_STEP_SECONDS;
	}

	try {
		if (tier === 'raw') return await queryRawHistory({ scope, key, routerId, combined, from, to });
		if (combined) {
			const seriesRows = await db
				.select({ id: metricSeriesTable.id })
				.from(metricSeriesTable)
				.where(and(eq(metricSeriesTable.scope, scope), eq(metricSeriesTable.key, key)));
			const seriesIds = seriesRows.map((r) => r.id);
			if (!seriesIds.length) {
				return { success: true, data: [] as MetricHistoryPoint[] } as const;
			}
			const rows = await db
				.select({
					timestamp: metricSampleTable.timestamp,
					rxAvg: sql<number>`sum(${metricSampleTable.rxAvg})`,
					rxMax: sql<number>`sum(${metricSampleTable.rxMax})`,
					txAvg: sql<number>`sum(${metricSampleTable.txAvg})`,
					txMax: sql<number>`sum(${metricSampleTable.txMax})`
				})
				.from(metricSampleTable)
				.where(
					and(
						inArray(metricSampleTable.seriesId, seriesIds),
						eq(metricSampleTable.tier, tier),
						gte(metricSampleTable.timestamp, from),
						lte(metricSampleTable.timestamp, to)
					)
				)
				.groupBy(metricSampleTable.timestamp)
				.orderBy(metricSampleTable.timestamp);

			return {
				success: true,
				data: rows.map((r) => ({
					timestamp: r.timestamp,
					rxAvg: Number(r.rxAvg) || 0,
					rxMax: Number(r.rxMax) || 0,
					txAvg: Number(r.txAvg) || 0,
					txMax: Number(r.txMax) || 0
				})) as MetricHistoryPoint[]
			} as const;
		}

		const seriesRows = await db
			.select({ id: metricSeriesTable.id })
			.from(metricSeriesTable)
			.where(
				and(
					eq(metricSeriesTable.scope, scope),
					eq(metricSeriesTable.key, key),
					routerId === undefined
						? sql`${metricSeriesTable.routerId} is null`
						: eq(metricSeriesTable.routerId, routerId)
				)
			)
			.limit(1);

		if (!seriesRows.length) {
			return { success: true, data: [] as MetricHistoryPoint[] } as const;
		}

		const rows = await db
			.select({
				timestamp: metricSampleTable.timestamp,
				rxAvg: metricSampleTable.rxAvg,
				rxMax: metricSampleTable.rxMax,
				txAvg: metricSampleTable.txAvg,
				txMax: metricSampleTable.txMax,
				signalAvg: metricSampleTable.signalAvg,
				signalMin: metricSampleTable.signalMin,
				clientCountAvg: metricSampleTable.clientCountAvg,
				clientCountMax: metricSampleTable.clientCountMax,
				noiseAvg: metricSampleTable.noiseAvg
			})
			.from(metricSampleTable)
			.where(
				and(
					eq(metricSampleTable.seriesId, seriesRows[0].id),
					eq(metricSampleTable.tier, tier),
					gte(metricSampleTable.timestamp, from),
					lte(metricSampleTable.timestamp, to)
				)
			)
			.orderBy(metricSampleTable.timestamp);

		return { success: true, data: rows as MetricHistoryPoint[] } as const;
	} catch (error) {
		logError({ errorMessage: 'Failed to query metric history', error });
		return {
			success: false,
			errorMessage: 'Failed to query metric history'
		} as const;
	}
}

// Ranges served from the raw tier (<= 10 min) come back as 5 s averages:
// 1 s interface samples are too spiky to read, and fixed buckets line up
// series polled at different moments (combined and stacked charts).
async function queryRawHistory({
	scope,
	key,
	routerId,
	combined,
	from,
	to
}: {
	scope: MetricScopeName;
	key: string;
	routerId?: number;
	combined?: boolean;
	from: number;
	to: number;
}) {
	const seriesRows = await db
		.select({ id: metricSeriesTable.id })
		.from(metricSeriesTable)
		.where(
			and(
				eq(metricSeriesTable.scope, scope),
				eq(metricSeriesTable.key, key),
				combined
					? undefined
					: routerId === undefined
						? sql`${metricSeriesTable.routerId} is null`
						: eq(metricSeriesTable.routerId, routerId)
			)
		);
	const seriesIds = seriesRows.map((r) => r.id);
	if (!seriesIds.length) return { success: true, data: [] as MetricHistoryPoint[] } as const;

	const rows = await db
		.select({
			seriesId: metricSampleTable.seriesId,
			timestamp: metricSampleTable.timestamp,
			intervalSec: metricSampleTable.intervalSec,
			rxAvg: metricSampleTable.rxAvg,
			rxMax: metricSampleTable.rxMax,
			txAvg: metricSampleTable.txAvg,
			txMax: metricSampleTable.txMax,
			signalAvg: metricSampleTable.signalAvg,
			signalMin: metricSampleTable.signalMin,
			clientCountAvg: metricSampleTable.clientCountAvg,
			clientCountMax: metricSampleTable.clientCountMax,
			noiseAvg: metricSampleTable.noiseAvg
		})
		.from(metricSampleTable)
		.where(
			and(
				inArray(metricSampleTable.seriesId, seriesIds),
				eq(metricSampleTable.tier, 'raw'),
				// A row's span reaches back up to a bucket before its timestamp.
				gte(metricSampleTable.timestamp, from - RAW_CHART_STEP_SECONDS),
				lte(metricSampleTable.timestamp, to)
			)
		)
		.orderBy(metricSampleTable.seriesId, metricSampleTable.timestamp);

	const bySeries = new Map<number, typeof rows>();
	for (const row of rows) {
		const list = bySeries.get(row.seriesId) ?? [];
		list.push(row);
		bySeries.set(row.seriesId, list);
	}
	const perSeries = [...bySeries.values()].map((list) => resampleRawRows(list, from));
	if (!combined) {
		return { success: true, data: (perSeries[0] ?? []) as MetricHistoryPoint[] } as const;
	}
	// Combined: sum the routers' buckets, like the rollup tiers' combined query.
	const summed = new Map<number, MetricHistoryPoint>();
	for (const points of perSeries) {
		for (const p of points) {
			const acc = summed.get(p.timestamp) ?? { timestamp: p.timestamp, rxAvg: 0, rxMax: 0, txAvg: 0, txMax: 0 };
			acc.rxAvg += p.rxAvg;
			acc.rxMax += p.rxMax;
			acc.txAvg += p.txAvg;
			acc.txMax += p.txMax;
			summed.set(p.timestamp, acc);
		}
	}
	return {
		success: true,
		data: [...summed.values()].sort((a, b) => a.timestamp - b.timestamp)
	} as const;
}

export type CachedDhcpLeases = Awaited<ReturnType<typeof getCachedDhcpLeases>>;
// Combined Mesh: per router, the sum of what its mesh radios (wifi interfaces in
// mesh mode, per the cached radio snapshot - not bat0) TRANSMIT. Summed over
// routers, every over-the-air transmission is counted once per hop - the airtime
// load on the shared mesh channel.
export async function queryMeshHistory({
	from,
	to,
	since
}: {
	from: number;
	to: number;
	since?: number;
}) {
	const radios = await getCachedWifiRadios();
	if (!radios.success) return { success: false, errorMessage: 'Failed to get radios' } as const;
	const routers = await getRoutersWithId();
	if (!routers.success) return { success: false, errorMessage: 'Failed to get routers' } as const;

	const results: { displayName: string; points: MetricHistoryPoint[] }[] = [];
	for (const router of routers.data) {
		const meshIfnames = [
			...new Set(
				radios.data
					.filter((r) => r.displayName === router.displayName && r.mode === 'mesh' && r.ifname)
					.map((r) => r.ifname as string)
			)
		];
		if (meshIfnames.length === 0) continue;

		const byTimestamp = new Map<number, { txAvg: number; txMax: number }>();
		for (const ifname of meshIfnames) {
			const history = await queryHistory({
				scope: 'interface',
				key: ifname,
				routerId: router.id,
				from,
				to,
				since
			});
			if (!history.success) continue;
			for (const p of history.data) {
				const acc = byTimestamp.get(p.timestamp) ?? { txAvg: 0, txMax: 0 };
				byTimestamp.set(p.timestamp, { txAvg: acc.txAvg + p.txAvg, txMax: acc.txMax + p.txMax });
			}
		}
		const points = [...byTimestamp.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([timestamp, v]) => ({ timestamp, rxAvg: 0, rxMax: 0, txAvg: v.txAvg, txMax: v.txMax }));
		results.push({ displayName: router.displayName, points });
	}
	return { success: true, data: { routers: results } } as const;
}

export type MeshHistory = Awaited<ReturnType<typeof queryMeshHistory>>;

export async function getCachedDhcpLeases() {
	try {
		const row = await db
			.select()
			.from(dhcpLeaseSnapshotTable)
			.where(eq(dhcpLeaseSnapshotTable.id, 1))
			.limit(1);
		if (!row.length) {
			return { success: true, data: [] } as const;
		}
		return { success: true, data: JSON.parse(row[0].data) } as const;
	} catch (error) {
		logError({ errorMessage: 'Failed to read cached dhcp leases', error });
		return {
			success: false,
			errorMessage: 'Failed to read cached dhcp leases'
		} as const;
	}
}

export type CachedWanFailoverState = Awaited<
	ReturnType<typeof getCachedWanFailoverState>
>;
export async function getCachedWanFailoverState(routerId: number) {
	try {
		const row = await db
			.select()
			.from(wanFailoverStateTable)
			.where(eq(wanFailoverStateTable.routerId, routerId))
			.limit(1);
		if (!row.length) {
			// Not an error - this router may simply not run the watchdog.
			return { success: true, data: null } as const;
		}
		return { success: true, data: row[0] } as const;
	} catch (error) {
		logError({ errorMessage: 'Failed to read cached WAN failover state', error });
		return {
			success: false,
			errorMessage: 'Failed to read cached WAN failover state'
		} as const;
	}
}

export type CachedRouterInfo = Awaited<ReturnType<typeof getCachedRouterInfo>>;
export async function getCachedRouterInfo(routerId: number) {
	try {
		const row = await db
			.select()
			.from(routerSnapshotTable)
			.where(eq(routerSnapshotTable.routerId, routerId))
			.limit(1);
		if (!row.length) {
			return {
				success: false,
				errorMessage: 'No cached router info yet'
			} as const;
		}
		return { success: true, data: JSON.parse(row[0].data) } as const;
	} catch (error) {
		logError({ errorMessage: 'Failed to read cached router info', error });
		return {
			success: false,
			errorMessage: 'Failed to read cached router info'
		} as const;
	}
}

export type CachedWifiRadios = Awaited<ReturnType<typeof getCachedWifiRadios>>;
export async function getCachedWifiRadios(routerId?: number) {
	try {
		const rows =
			routerId !== undefined
				? await db
						.select()
						.from(wifiRadioSnapshotTable)
						.where(eq(wifiRadioSnapshotTable.routerId, routerId))
				: await db.select().from(wifiRadioSnapshotTable);
		const radios = rows.flatMap((r) => JSON.parse(r.data));
		return { success: true, data: radios } as const;
	} catch (error) {
		logError({ errorMessage: 'Failed to read cached wifi radios', error });
		return {
			success: false,
			errorMessage: 'Failed to read cached wifi radios'
		} as const;
	}
}

export type ClientBandwidthSummary = Awaited<
	ReturnType<typeof getClientBandwidthSummary>
>;
export async function getClientBandwidthSummary(windowSeconds: number) {
	const to = Math.floor(Date.now() / 1000);
	const from = to - windowSeconds;
	const tier = pickTier(windowSeconds);

	try {
		const rows = await db
			.select({
				mac: metricSeriesTable.key,
				total: sql<number>`sum(${metricSampleTable.rxAvg} + ${metricSampleTable.txAvg})`
			})
			.from(metricSampleTable)
			.innerJoin(
				metricSeriesTable,
				eq(metricSeriesTable.id, metricSampleTable.seriesId)
			)
			.where(
				and(
					eq(metricSeriesTable.scope, 'client'),
					eq(metricSampleTable.tier, tier),
					gte(metricSampleTable.timestamp, from),
					lte(metricSampleTable.timestamp, to)
				)
			)
			.groupBy(metricSeriesTable.key);

		const summary: { [mac: string]: number } = {};
		for (const row of rows) {
			summary[row.mac] = Number(row.total) || 0;
		}
		return { success: true, data: summary } as const;
	} catch (error) {
		logError({ errorMessage: 'Failed to get client bandwidth summary', error });
		return {
			success: false,
			errorMessage: 'Failed to get client bandwidth summary'
		} as const;
	}
}

// `since` (optional): only rows from then on, for a caller that keeps the rest.
export async function getClientRecentSeries(windowSeconds: number, since?: number) {
	const now = Math.floor(Date.now() / 1000);
	const from = since !== undefined ? Math.max(now - windowSeconds, since) : now - windowSeconds;

	try {
		const rows = await db
			.select({
				mac: metricSeriesTable.key,
				timestamp: metricSampleTable.timestamp,
				rxAvg: metricSampleTable.rxAvg,
				txAvg: metricSampleTable.txAvg
			})
			.from(metricSampleTable)
			.innerJoin(
				metricSeriesTable,
				eq(metricSeriesTable.id, metricSampleTable.seriesId)
			)
			.where(
				and(
					eq(metricSeriesTable.scope, 'client'),
					eq(metricSampleTable.tier, 'raw'),
					gte(metricSampleTable.timestamp, from)
				)
			)
			.orderBy(metricSampleTable.timestamp);

		const data: {
			[mac: string]: { timestamp: number; rxAvg: number; txAvg: number }[];
		} = {};
		for (const row of rows) {
			if (!data[row.mac]) {
				data[row.mac] = [];
			}
			data[row.mac].push({
				timestamp: row.timestamp,
				rxAvg: Math.round(Number(row.rxAvg) || 0),
				txAvg: Math.round(Number(row.txAvg) || 0)
			});
		}

		return { success: true, data } as const;
	} catch (error) {
		logError({ errorMessage: 'Failed to get client recent series', error });
		return {
			success: false,
			errorMessage: 'Failed to get client recent series'
		} as const;
	}
}

export type ClientRecentSeries = Awaited<ReturnType<typeof getClientRecentSeries>>;

const LATEST_RATE_STALE_AFTER_SECONDS = 15;

export type ClientLatestRates = Awaited<ReturnType<typeof getClientLatestRates>>;
export async function getClientLatestRates() {
	try {
		// Bare, non-aggregated columns alongside a single max() aggregate is a
		// documented SQLite extension: they're pulled from the row that
		// supplied the max value, not an arbitrary row - this gets each
		// series' most recent sample in one query instead of one per client.
		const rows = await db
			.select({
				mac: metricSeriesTable.key,
				rxAvg: metricSampleTable.rxAvg,
				txAvg: metricSampleTable.txAvg,
				timestamp: sql<number>`max(${metricSampleTable.timestamp})`
			})
			.from(metricSampleTable)
			.innerJoin(
				metricSeriesTable,
				eq(metricSeriesTable.id, metricSampleTable.seriesId)
			)
			.where(
				and(
					eq(metricSeriesTable.scope, 'client'),
					eq(metricSampleTable.tier, 'raw')
				)
			)
			.groupBy(metricSampleTable.seriesId);

		const now = Math.floor(Date.now() / 1000);
		const rates: { [mac: string]: { rxAvg: number; txAvg: number } } = {};
		for (const row of rows) {
			// Don't surface a stale rate forever for a client that stopped
			// reporting (went offline, or is a wifi client mid-roam).
			if (now - row.timestamp > LATEST_RATE_STALE_AFTER_SECONDS) continue;
			rates[row.mac] = {
				rxAvg: Number(row.rxAvg) || 0,
				txAvg: Number(row.txAvg) || 0
			};
		}
		return { success: true, data: rates } as const;
	} catch (error) {
		logError({ errorMessage: 'Failed to get client latest rates', error });
		return {
			success: false,
			errorMessage: 'Failed to get client latest rates'
		} as const;
	}
}
