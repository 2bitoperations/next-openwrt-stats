// Turns cumulative byte counters into rate samples that conserve bytes.
//
// A client can have counters on several nodes at once: macacct keeps a MAC's
// counters on every node it was ever attached to (a roaming Wi-Fi client, or
// frames flooded to it at a node it isn't on), and hostapd can list a station
// at the AP it just left. These are never summed BEFORE diffing: if one node
// misses a poll (timeout, backoff) the sum drops, and when it answers again its
// whole lifetime counter (tens of GB) lands in one 5 s sample - the 60-200 Gb/s
// spikes seen 2026-10-21. Instead each node's counter is diffed against its own
// previous reading, giving a rate over that node's own time span (a Segment),
// and SeriesRowBuilder turns a series' segments into rows:
//
//  - every raw row records the span it covers (intervalSec), so rollups can
//    weight by time and totals agree across tiers;
//  - a node that comes back after missing polls covers (its last reading,
//    now]. Its rate is added to the rows already written for that span
//    (`updates`), not piled into the current 5 s row;
//  - a series that had no rows at all for a while (every node it is on missed
//    polls) gets backdated rows across the gap instead of one long sample.
//
// Updates and backdated rows touch at most MAX_SPAN_SECONDS of history, so the
// rollups wait ROLLUP_GRACE_SECONDS before closing a bucket (metrics.ts). A
// longer gap restarts that counter (its bytes over the gap are dropped).

// Faster than any link in these networks (2.5 GbE ports, Wi-Fi): a rate above
// this is a counter glitch (reset to an unrelated value), not traffic - skip it
// like a reset rather than store it.
export const MAX_PLAUSIBLE_BYTES_PER_SEC = 10e9 / 8;
// Longest outage a counter is diffed across (the collector's router backoff
// tops out at 2 min).
export const MAX_SPAN_SECONDS = 120;
// Backdated rows across a gap are this far apart (the client poll interval).
const BACKFILL_STEP_SECONDS = 5;

export type CounterReading = { id: string; rx: number; tx: number };
// rx/tx in bytes/s over (from, now].
export type Segment = { from: number; rx: number; tx: number };
export type RateRow = {
	timestamp: number;
	intervalSec: number;
	rx: number;
	tx: number;
};
// Add rx/tx (bytes/s) to the raw rows already written for (from, to], each in
// proportion to how much of its own interval falls in that span.
export type RateUpdate = { from: number; to: number; rx: number; tx: number };

type Prev = { rx: number; tx: number; time: number };

// Diffs a single cumulative counter per key (an interface's netdev counters).
export function counterSegment(
	prevByKey: Map<string, Prev>,
	key: string,
	rx: number,
	tx: number,
	nowSec: number
): Segment | null {
	const prev = prevByKey.get(key);
	prevByKey.set(key, { rx, tx, time: nowSec });
	if (!prev) return null;
	const dt = nowSec - prev.time;
	const drx = rx - prev.rx;
	const dtx = tx - prev.tx;
	// A decrease means the counters reset (reboot, macacct restart, Wi-Fi
	// reassociation, nlbwmon's monthly rollover, netdev recreated).
	if (dt <= 0 || dt > MAX_SPAN_SECONDS || drx < 0 || dtx < 0) return null;
	if (
		drx / dt > MAX_PLAUSIBLE_BYTES_PER_SEC ||
		dtx / dt > MAX_PLAUSIBLE_BYTES_PER_SEC
	) {
		return null;
	}
	return { from: prev.time, rx: drx / dt, tx: dtx / dt };
}

export class ClientCounterTracker {
	private clients = new Map<
		string,
		{ basis: string; counters: Map<string, Prev> }
	>();

	// One segment per node that has a valid delta this tick. `basis` is the
	// counter source (macacct / wifi / nlbw): counters on different bases count
	// different things, so a basis change starts over instead of diffing or
	// mixing them.
	segments(
		clientKey: string,
		basis: string,
		readings: CounterReading[],
		nowSec: number
	): Segment[] {
		let entry = this.clients.get(clientKey);
		if (!entry || entry.basis !== basis) {
			entry = { basis, counters: new Map() };
			this.clients.set(clientKey, entry);
		}
		const segments: Segment[] = [];
		for (const reading of readings) {
			const segment = counterSegment(
				entry.counters,
				reading.id,
				reading.rx,
				reading.tx,
				nowSec
			);
			if (segment) segments.push(segment);
		}
		return segments;
	}
}

export class SeriesRowBuilder {
	private lastRow = new Map<string, number>();

	build(
		seriesKey: string,
		segments: Segment[],
		nowSec: number
	): { rows: RateRow[]; updates: RateUpdate[] } | null {
		if (!segments.length) return null;
		const last = this.lastRow.get(seriesKey);
		// This row starts where the previous one ended, or - first row, or no
		// node had data in between (counters restarted after a long gap) -
		// where its oldest segment starts; that span stays empty (= no traffic).
		const start = Math.max(
			last ?? -Infinity,
			Math.min(...segments.map((s) => s.from))
		);
		const interval = nowSec - start;
		if (interval <= 0) return null;
		this.lastRow.set(seriesKey, nowSec);

		let rx = 0;
		let tx = 0;
		const updates: RateUpdate[] = [];
		for (const s of segments) {
			const overlap = nowSec - Math.max(s.from, start);
			rx += (s.rx * overlap) / interval;
			tx += (s.tx * overlap) / interval;
			if (s.from < start)
				updates.push({ from: s.from, to: start, rx: s.rx, tx: s.tx });
		}

		const pieces = Math.max(1, Math.round(interval / BACKFILL_STEP_SECONDS));
		const rows: RateRow[] = [];
		let pieceStart = start;
		for (let i = 1; i <= pieces; i++) {
			const timestamp =
				i === pieces ? nowSec : start + Math.round((interval * i) / pieces);
			rows.push({ timestamp, intervalSec: timestamp - pieceStart, rx, tx });
			pieceStart = timestamp;
		}
		return { rows, updates };
	}
}
