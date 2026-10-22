// Charts re-poll the same window every 5-60 s. Instead of downloading all of
// it each time, keep the points already fetched and ask only for the tail
// (`since=`); the history endpoints answer with the points after it.
// Raw rows can still change for up to MAX_SPAN_SECONDS (120 s, counterDiff.ts)
// after they are written - a node that missed polls backfills its gap - so the
// last REFETCH_TAIL_SECONDS are always fetched again.
export const REFETCH_TAIL_SECONDS = 150;
// Raw chart buckets are 5 s (RAW_CHART_STEP_SECONDS); keep `since` on a
// bucket boundary.
const STEP_SECONDS = 5;

type Point = { timestamp: number };

// The `since` to ask for, or undefined for a full fetch (nothing cached yet,
// or what is cached is all older than the window).
export function sinceFor(lastTimestamp: number | undefined, from: number) {
	if (lastTimestamp === undefined) return undefined;
	const since =
		Math.floor((lastTimestamp - REFETCH_TAIL_SECONDS) / STEP_SECONDS) *
		STEP_SECONDS;
	return since > from ? since : undefined;
}

export function lastTimestamp(points: Point[] | undefined) {
	return points?.length ? points[points.length - 1].timestamp : undefined;
}

// Cached points up to `since` (and inside the window), then the fresh tail.
// A fresh point replaces a cached one with the same timestamp (rollup tiers
// return `since` itself again).
export function mergeTail<T extends Point>(
	cached: T[] | undefined,
	fresh: T[],
	since: number | undefined,
	from: number
): T[] {
	if (since === undefined || !cached) return fresh;
	const freshTimestamps = new Set(fresh.map((p) => p.timestamp));
	const kept = cached.filter(
		(p) =>
			p.timestamp >= from &&
			p.timestamp <= since &&
			!freshTimestamps.has(p.timestamp)
	);
	return kept.concat(fresh);
}
