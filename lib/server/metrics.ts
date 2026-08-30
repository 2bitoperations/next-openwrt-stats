import 'server-only';
import { db } from './dbDriver';
import {
	metricSampleTable,
	metricSeriesTable,
	type MetricTier
} from '@/drizzle/schema/schema';
import { and, avg, eq, gte, inArray, lte, max, min, sql } from 'drizzle-orm';
import { getRoutersWithId } from './router';
import { getNetworkDeviceStats } from './routerInterfaces';
import { getWifiAPs, getWifiClientsTraffic } from './wifiAPs';
import { logError } from '../client/errorLog';

const RAW_RETENTION_SECONDS = 5 * 60;
const TIER_1M_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const TIER_5M_RETENTION_SECONDS = 90 * 24 * 60 * 60;
// '1h' tier is retained forever - never pruned.

const CLIENT_POLL_EVERY_N_TICKS = 5; // collector runs every 1s, clients polled every 5s
const IFNAME_CACHE_MS = 60_000;
const MAX_CATCHUP_BUCKETS = 120;

type CounterState = { rx: number; tx: number; time: number };
const lastCounters = new Map<string, CounterState>();
const seriesIdCache = new Map<string, number>();

type WifiIfnames = {
	[displayName: string]: { ifname: string; ssid: string; band: string }[];
};

let tickCount = 0;
let isCollecting = false;
let cachedIfnames: WifiIfnames | undefined = undefined;
let cachedIfnamesAt = 0;

const rollupCursors: Record<'1m' | '5m' | '1h', number | null> = {
	'1m': null,
	'5m': null,
	'1h': null
};

function seriesKey(scope: 'interface' | 'client', routerId: number | null, key: string) {
	return `${scope}:${routerId ?? 'null'}:${key}`;
}

async function getOrCreateSeriesId(
	scope: 'interface' | 'client',
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

async function insertRawSample({
	scope,
	routerId,
	key,
	timestamp,
	rx,
	tx,
	signal
}: {
	scope: 'interface' | 'client';
	routerId: number | null;
	key: string;
	timestamp: number;
	rx: number;
	tx: number;
	signal?: number;
}) {
	const seriesId = await getOrCreateSeriesId(scope, routerId, key);
	await db.insert(metricSampleTable).values({
		seriesId,
		tier: 'raw',
		timestamp,
		rxAvg: rx,
		rxMax: rx,
		txAvg: tx,
		txMax: tx,
		signalAvg: signal ?? null,
		signalMin: signal ?? null
	});
}

async function getCachedIfnames() {
	if (!cachedIfnames || Date.now() - cachedIfnamesAt > IFNAME_CACHE_MS) {
		const wifiAPs = await getWifiAPs();
		if (wifiAPs.success) {
			cachedIfnames = wifiAPs.data.wifiAPsIfname;
			cachedIfnamesAt = Date.now();
		}
	}
	return cachedIfnames;
}

async function collectInterfaceMetrics(nowSec: number) {
	const routers = await getRoutersWithId();
	if (!routers.success) {
		logError({
			...routers,
			errorMessage: 'metrics collector: failed to list routers'
		});
		return;
	}

	await Promise.all(
		routers.data.map(async (router) => {
			const stats = await getNetworkDeviceStats(router.displayName);
			if (!stats.success) {
				return;
			}
			for (const [device, { rxBytes, txBytes }] of Object.entries(stats.data)) {
				const key = seriesKey('interface', router.id, device);
				const prev = lastCounters.get(key);
				lastCounters.set(key, { rx: rxBytes, tx: txBytes, time: nowSec });
				if (!prev) continue;
				const dt = nowSec - prev.time;
				const drx = rxBytes - prev.rx;
				const dtx = txBytes - prev.tx;
				if (dt <= 0 || drx < 0 || dtx < 0) continue;
				await insertRawSample({
					scope: 'interface',
					routerId: router.id,
					key: device,
					timestamp: nowSec,
					rx: drx / dt,
					tx: dtx / dt
				});
			}
		})
	);
}

async function collectClientMetrics(nowSec: number) {
	const ifnames = await getCachedIfnames();
	if (!ifnames) return;

	const traffic = await getWifiClientsTraffic(ifnames);
	if (!traffic.success) return;

	for (const [mac, data] of Object.entries(traffic.data)) {
		const key = seriesKey('client', null, mac);
		const prev = lastCounters.get(key);
		lastCounters.set(key, { rx: data.rxBytes, tx: data.txBytes, time: nowSec });
		if (!prev) continue;
		const dt = nowSec - prev.time;
		const drx = data.rxBytes - prev.rx;
		const dtx = data.txBytes - prev.tx;
		if (dt <= 0 || drx < 0 || dtx < 0) continue;
		await insertRawSample({
			scope: 'client',
			routerId: null,
			key: mac,
			timestamp: nowSec,
			rx: drx / dt,
			tx: dtx / dt,
			signal: data.signal
		});
	}
}

async function rollupTier({
	sourceTier,
	targetTier,
	stepSeconds,
	nowSec
}: {
	sourceTier: MetricTier;
	targetTier: '1m' | '5m' | '1h';
	stepSeconds: number;
	nowSec: number;
}) {
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
		const rows = await db
			.select({
				seriesId: metricSampleTable.seriesId,
				rxAvg: avg(metricSampleTable.rxAvg),
				rxMax: max(metricSampleTable.rxMax),
				txAvg: avg(metricSampleTable.txAvg),
				txMax: max(metricSampleTable.txMax),
				signalAvg: avg(metricSampleTable.signalAvg),
				signalMin: min(metricSampleTable.signalMin)
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
			await db.insert(metricSampleTable).values(
				rows.map((r) => ({
					seriesId: r.seriesId,
					tier: targetTier,
					timestamp: bucketStart,
					rxAvg: Number(r.rxAvg) || 0,
					rxMax: Number(r.rxMax) || 0,
					txAvg: Number(r.txAvg) || 0,
					txMax: Number(r.txMax) || 0,
					signalAvg: r.signalAvg !== null ? Number(r.signalAvg) : null,
					signalMin: r.signalMin !== null ? Number(r.signalMin) : null
				}))
			);
		}
	}
	rollupCursors[targetTier] = currentBucket;
}

async function pruneOldSamples(nowSec: number) {
	await db
		.delete(metricSampleTable)
		.where(
			and(
				eq(metricSampleTable.tier, 'raw'),
				sql`${metricSampleTable.timestamp} < ${nowSec - RAW_RETENTION_SECONDS}`
			)
		);
	await db
		.delete(metricSampleTable)
		.where(
			and(
				eq(metricSampleTable.tier, '1m'),
				sql`${metricSampleTable.timestamp} < ${nowSec - TIER_1M_RETENTION_SECONDS}`
			)
		);
	await db
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
		await collectInterfaceMetrics(nowSec);
		tickCount++;
		if (tickCount % CLIENT_POLL_EVERY_N_TICKS === 0) {
			await collectClientMetrics(nowSec);
		}
		await rollupTier({
			sourceTier: 'raw',
			targetTier: '1m',
			stepSeconds: 60,
			nowSec
		});
		await rollupTier({
			sourceTier: '1m',
			targetTier: '5m',
			stepSeconds: 300,
			nowSec
		});
		await rollupTier({
			sourceTier: '5m',
			targetTier: '1h',
			stepSeconds: 3600,
			nowSec
		});
		await pruneOldSamples(nowSec);
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
	scope: 'interface' | 'client';
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
				signalMin: metricSampleTable.signalMin
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
