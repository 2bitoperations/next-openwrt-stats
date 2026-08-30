import 'server-only';
import { db } from './dbDriver';
import {
	dhcpLeaseSnapshotTable,
	metricSampleTable,
	metricSeriesTable,
	routerSnapshotTable,
	wifiRadioSnapshotTable,
	type MetricTier
} from '@/drizzle/schema/schema';
import { and, avg, eq, gte, inArray, lte, max, min, sql } from 'drizzle-orm';
import { getRoutersWithId } from './router';
import { getNetworkDeviceStats } from './routerInterfaces';
import { getNlbwHostTotals, getWifiClientsTraffic, getWifiRadios } from './wifiAPs';
import { getDhcpDevices } from './dhcpDevices';
import { ubusBatchCall } from './ubusCalls';
import { routerInfoSchema } from '@/types/ubusCalls';
import { logError } from '../client/errorLog';

const RAW_RETENTION_SECONDS = 5 * 60;
const TIER_1M_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const TIER_5M_RETENTION_SECONDS = 90 * 24 * 60 * 60;
// '1h' tier is retained forever - never pruned.

const CLIENT_POLL_EVERY_N_TICKS = 5; // collector runs every 1s, clients/radios polled every 5s
const RADIO_CONFIG_EVERY_N_TICKS = 10; // wifi radio config + dhcp leases every ~10s
const ROUTER_INFO_EVERY_N_TICKS = 30; // uptime/load/mem every ~30s
const PRUNE_EVERY_N_TICKS = 60; // raw retention is 5 minutes, pruning once/minute is plenty
const MAX_CATCHUP_BUCKETS = 120;

type MetricScopeName = 'interface' | 'client' | 'radio';

// The `tx` parameter type from a `db.transaction(async (tx) => ...)` callback.
type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RouterRow = { id: number; displayName: string; isPrimary: number };

// `source` guards against diffing across a basis change - e.g. a client
// roaming from wifi (hostapd's frame-level counters) to wired (nlbwmon's
// routed-traffic counters), which are on completely different scales and
// would produce a garbage delta if diffed against each other.
type CounterState = {
	rx: number;
	tx: number;
	time: number;
	source?: 'wifi' | 'nlbw';
};
const lastCounters = new Map<string, CounterState>();
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

async function buildInterfaceRow(
	scope: 'interface' | 'client',
	routerId: number | null,
	key: string,
	timestamp: number,
	rx: number,
	tx: number,
	signal?: number
): Promise<PendingRow> {
	const seriesId = await getOrCreateSeriesId(scope, routerId, key);
	return {
		seriesId,
		tier: 'raw',
		timestamp,
		rxAvg: rx,
		rxMax: rx,
		txAvg: tx,
		txMax: tx,
		signalAvg: signal ?? null,
		signalMin: signal ?? null
	};
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
): Promise<PendingRow[]> {
	const rows: PendingRow[] = [];
	await Promise.all(
		routers.map(async (router) => {
			const stats = await getNetworkDeviceStats(router.displayName);
			if (!stats.success) return;
			for (const [device, { rxBytes, txBytes }] of Object.entries(stats.data)) {
				const key = seriesKey('interface', router.id, device);
				const prev = lastCounters.get(key);
				lastCounters.set(key, { rx: rxBytes, tx: txBytes, time: nowSec });
				if (!prev) continue;
				const dt = nowSec - prev.time;
				const drx = rxBytes - prev.rx;
				const dtx = txBytes - prev.tx;
				if (dt <= 0 || drx < 0 || dtx < 0) continue;
				rows.push(
					await buildInterfaceRow(
						'interface',
						router.id,
						device,
						nowSec,
						drx / dt,
						dtx / dt
					)
				);
			}
		})
	);
	return rows;
}

async function computeClientAndRadioSampleRows(
	routers: RouterRow[],
	nowSec: number
): Promise<PendingRow[]> {
	const rows: PendingRow[] = [];
	const wifiMacs = new Set<string>();

	if (Object.keys(cachedIfnames).length > 0) {
		const routerIdByName = new Map(routers.map((r) => [r.displayName, r.id]));
		const traffic = await getWifiClientsTraffic(cachedIfnames);

		if (traffic.success) {
			for (const [mac, data] of Object.entries(traffic.data)) {
				wifiMacs.add(mac);
				const key = seriesKey('client', null, mac);
				const prev = lastCounters.get(key);
				lastCounters.set(key, {
					rx: data.rxBytes,
					tx: data.txBytes,
					time: nowSec,
					source: 'wifi'
				});
				if (!prev || prev.source !== 'wifi') continue;
				const dt = nowSec - prev.time;
				const drx = data.rxBytes - prev.rx;
				const dtx = data.txBytes - prev.tx;
				if (dt <= 0 || drx < 0 || dtx < 0) continue;
				rows.push(
					await buildInterfaceRow(
						'client',
						null,
						mac,
						nowSec,
						drx / dt,
						dtx / dt,
						data.signal
					)
				);
			}

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

	// Wired (and any other non-wifi) client traffic, via nlbwmon. Skip any
	// MAC that already got a row from wifi data this tick - that traffic is
	// already covered by hostapd's own counters, so using both would
	// double-instrument the same number rather than add information.
	const nlbwTotals = await getNlbwHostTotals();
	if (nlbwTotals.success) {
		for (const [mac, data] of Object.entries(nlbwTotals.data)) {
			if (wifiMacs.has(mac)) continue;
			const key = seriesKey('client', null, mac);
			const prev = lastCounters.get(key);
			lastCounters.set(key, {
				rx: data.rxBytes,
				tx: data.txBytes,
				time: nowSec,
				source: 'nlbw'
			});
			if (!prev || prev.source !== 'nlbw') continue;
			const dt = nowSec - prev.time;
			const drx = data.rxBytes - prev.rx;
			const dtx = data.txBytes - prev.tx;
			// A negative delta here means nlbwmon's monthly accounting period
			// rolled over and its counters reset - same as an interface reboot,
			// just skip this sample and pick back up next tick.
			if (dt <= 0 || drx < 0 || dtx < 0) continue;
			rows.push(
				await buildInterfaceRow('client', null, mac, nowSec, drx / dt, dtx / dt)
			);
		}
	}

	return rows;
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

// ---- Write phase: pure DB, all wrapped in one transaction per tick so the
// whole batch fsyncs once instead of once per statement. ----

async function rollupTier(
	tx: DbClient,
	{
		sourceTier,
		targetTier,
		stepSeconds,
		nowSec
	}: {
		sourceTier: MetricTier;
		targetTier: '1m' | '5m' | '1h';
		stepSeconds: number;
		nowSec: number;
	}
) {
	const currentBucket = Math.floor(nowSec / stepSeconds);
	const cursor = rollupCursors[targetTier];
	if (cursor === null) {
		rollupCursors[targetTier] = currentBucket;
		return;
	}
	if (currentBucket <= cursor) return;

	const startBucket = Math.max(cursor, currentBucket - MAX_CATCHUP_BUCKETS);
	for (let bucket = startBucket; bucket < currentBucket; bucket++) {
		const bucketStart = bucket * stepSeconds;
		const bucketEnd = bucketStart + stepSeconds;
		const rows = await tx
			.select({
				seriesId: metricSampleTable.seriesId,
				rxAvg: avg(metricSampleTable.rxAvg),
				rxMax: max(metricSampleTable.rxMax),
				txAvg: avg(metricSampleTable.txAvg),
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
		const interfaceRows = await computeInterfaceSampleRows(
			routers.data,
			nowSec
		);

		let radioSnapshot: Awaited<ReturnType<typeof fetchWifiRadioSnapshot>> =
			null;
		let dhcpLeases: Awaited<ReturnType<typeof getDhcpDevices>> | null = null;
		if (tickCount % RADIO_CONFIG_EVERY_N_TICKS === 0) {
			radioSnapshot = await fetchWifiRadioSnapshot(routers.data);
			dhcpLeases = await getDhcpDevices();
		}

		let routerSnapshotRows: Awaited<ReturnType<typeof fetchRouterSnapshotRows>> =
			[];
		if (tickCount % ROUTER_INFO_EVERY_N_TICKS === 0) {
			routerSnapshotRows = await fetchRouterSnapshotRows(routers.data);
		}

		let clientRadioRows: PendingRow[] = [];
		if (tickCount % CLIENT_POLL_EVERY_N_TICKS === 0) {
			clientRadioRows = await computeClientAndRadioSampleRows(
				routers.data,
				nowSec
			);
		}

		// Write phase - everything below is pure DB work, batched into one
		// transaction so it fsyncs once instead of once per statement.
		await db.transaction(async (tx) => {
			const allSampleRows = [...interfaceRows, ...clientRadioRows];
			if (allSampleRows.length) {
				await tx.insert(metricSampleTable).values(allSampleRows);
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

			await rollupTier(tx, {
				sourceTier: 'raw',
				targetTier: '1m',
				stepSeconds: 60,
				nowSec
			});
			await rollupTier(tx, {
				sourceTier: '1m',
				targetTier: '5m',
				stepSeconds: 300,
				nowSec
			});
			await rollupTier(tx, {
				sourceTier: '5m',
				targetTier: '1h',
				stepSeconds: 3600,
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

export type MetricHistory = Awaited<ReturnType<typeof queryHistory>>;
export async function queryHistory({
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
	const tier = pickTier(to - from);

	try {
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

export type CachedDhcpLeases = Awaited<ReturnType<typeof getCachedDhcpLeases>>;
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
