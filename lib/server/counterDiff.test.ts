// Run: npx tsx lib/server/counterDiff.test.ts (no test framework in this repo).
import assert from 'node:assert/strict';
import {
	ClientCounterTracker,
	SeriesRowBuilder,
	MAX_PLAUSIBLE_BYTES_PER_SEC,
	type CounterReading,
	type RateRow
} from './counterDiff';

// In-memory raw table for one series: applies rows and updates exactly like
// the collector's INSERT / UPDATE (share = overlap of the row's interval).
class Series {
	rows: RateRow[] = [];
	tracker = new ClientCounterTracker();
	builder = new SeriesRowBuilder();
	tick(basis: string, readings: CounterReading[], now: number) {
		const built = this.builder.build(
			'k',
			this.tracker.segments('k', basis, readings, now),
			now
		);
		if (!built) return;
		for (const u of built.updates) {
			for (const r of this.rows) {
				if (!(r.intervalSec > 0 && r.timestamp > u.from && r.timestamp <= u.to))
					continue;
				const share =
					(r.timestamp - Math.max(r.timestamp - r.intervalSec, u.from)) /
					r.intervalSec;
				r.rx += u.rx * share;
				r.tx += u.tx * share;
			}
		}
		this.rows.push(...built.rows);
	}
	bytes(lo = -Infinity, hi = Infinity) {
		return this.rows
			.filter((r) => r.timestamp > lo && r.timestamp <= hi)
			.reduce((s, r) => s + r.rx * r.intervalSec, 0);
	}
	peak() {
		return Math.max(...this.rows.map((r) => r.rx));
	}
	// Time-weighted 60 s rollup, as rollupTier does for raw -> 1m.
	rollup1m() {
		const b = new Map<number, number>();
		for (const r of this.rows) {
			const k = Math.floor(r.timestamp / 60);
			b.set(k, (b.get(k) ?? 0) + (r.rx * r.intervalSec) / 60);
		}
		return b;
	}
}
const close = (a: number, b: number, tol = 1e-6) =>
	assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);

const K = 82_759_687_376; // kitchen's lifetime counter for Fancypants, 2026-10-21

// 1. Today's failure: kitchen (the real node, 1 MB/s) misses 12 polls while
//    main (stray flooded-frames counter) keeps answering. Bytes conserved,
//    every row at the true 1 MB/s, no spike.
{
	const s = new Series();
	let t = 1000,
		k = K;
	s.tick(
		'macacct',
		[
			{ id: 'main', rx: 42040, tx: 0 },
			{ id: 'kitchen', rx: k, tx: 0 }
		],
		t
	);
	for (let i = 0; i < 40; i++) {
		t += 5;
		k += 5_000_000;
		const kitchenUp = i < 10 || i >= 22;
		s.tick(
			'macacct',
			[
				{ id: 'main', rx: 42040, tx: 0 },
				...(kitchenUp ? [{ id: 'kitchen', rx: k, tx: 0 }] : [])
			],
			t
		);
	}
	close(s.bytes(), 40 * 5_000_000);
	close(s.peak(), 1_000_000);
	for (const r of s.rows) close(r.rx, 1_000_000);
	for (const [, v] of [...s.rollup1m()].slice(1, -1)) close(v, 1_000_000); // full minutes
}
// 2. Same scenario, OLD algorithm (sum first, then diff): the spike.
{
	let prev: number | null = null,
		max = 0;
	const seq = [42040 + K, ...Array(60).fill(42040), 42040 + K + 1e6];
	for (const v of seq) {
		if (prev !== null && v >= prev) max = Math.max(max, (v - prev) / 5);
		prev = v;
	}
	assert.ok(max * 8 > 100e9);
	console.log(`old algorithm peak: ${((max * 8) / 1e9).toFixed(1)} Gb/s`);
}
// 3. Client only on kitchen, kitchen silent for 60 s: backdated rows fill the
//    gap at the average rate; bytes conserved, rollup per minute correct.
{
	const s = new Series();
	let t = 600,
		k = 0;
	s.tick('macacct', [{ id: 'kitchen', rx: k, tx: 0 }], t);
	for (let i = 0; i < 36; i++) {
		t += 5;
		k += 2_000_000;
		if (i >= 10 && i < 22) continue; // missed polls
		s.tick('macacct', [{ id: 'kitchen', rx: k, tx: 0 }], t);
	}
	close(s.bytes(), 36 * 2_000_000);
	for (const r of s.rows) close(r.rx, 400_000);
	assert.ok(s.rows.every((r) => r.intervalSec <= 5));
	for (const [, v] of s.rollup1m()) assert.ok(v <= 400_000 + 1e-6);
}
// 4. Outage longer than MAX_SPAN: counter restarts, no spike, no backfill.
{
	const s = new Series();
	s.tick('macacct', [{ id: 'a', rx: 0, tx: 0 }], 0);
	s.tick('macacct', [{ id: 'a', rx: 1000, tx: 0 }], 5);
	s.tick('macacct', [{ id: 'a', rx: 9e10, tx: 0 }], 1000); // 1000 s later
	s.tick('macacct', [{ id: 'a', rx: 9e10 + 500, tx: 0 }], 1005);
	assert.ok(s.peak() < MAX_PLAUSIBLE_BYTES_PER_SEC);
	close(s.bytes(), 1500);
}
// 5. Counter reset on one node only drops that node's delta.
{
	const s = new Series();
	s.tick(
		'macacct',
		[
			{ id: 'a', rx: 100, tx: 0 },
			{ id: 'b', rx: 1000, tx: 0 }
		],
		0
	);
	s.tick(
		'macacct',
		[
			{ id: 'a', rx: 10, tx: 0 },
			{ id: 'b', rx: 1500, tx: 0 }
		],
		5
	);
	s.tick(
		'macacct',
		[
			{ id: 'a', rx: 60, tx: 0 },
			{ id: 'b', rx: 1500, tx: 0 }
		],
		10
	);
	close(s.bytes(), 550);
}
// 6. Roaming: stale entry at the old AP stays frozen, new AP's counter counts.
{
	const s = new Series();
	s.tick('wifi', [{ id: 'kitchen|ap0', rx: 9e9, tx: 0 }], 0);
	s.tick(
		'wifi',
		[
			{ id: 'kitchen|ap0', rx: 9e9, tx: 0 },
			{ id: 'main|ap0', rx: 1000, tx: 0 }
		],
		5
	);
	s.tick(
		'wifi',
		[
			{ id: 'kitchen|ap0', rx: 9e9, tx: 0 },
			{ id: 'main|ap0', rx: 6000, tx: 0 }
		],
		10
	);
	close(s.bytes(), 5000);
	assert.ok(s.peak() < 2000);
}
// 7. Basis change starts over; switching back never diffs against stale counters.
{
	const s = new Series();
	s.tick('macacct', [{ id: 'a', rx: 0, tx: 0 }], 0);
	s.tick('wifi', [{ id: 'a|ap0', rx: 5e9, tx: 0 }], 5);
	s.tick('macacct', [{ id: 'a', rx: 9e9, tx: 0 }], 10);
	assert.equal(s.rows.length, 0);
}
// 8. Glitch above link rate dropped; next tick resumes.
{
	const s = new Series();
	s.tick('macacct', [{ id: 'a', rx: 0, tx: 0 }], 0);
	s.tick('macacct', [{ id: 'a', rx: 50e9, tx: 0 }], 5);
	s.tick('macacct', [{ id: 'a', rx: 50e9 + 500, tx: 0 }], 10);
	close(s.bytes(), 500);
}
// 9. Partial presence: a client active for 10 s of a minute must roll up to
//    10 s worth of bytes, not its 10-s rate for the whole minute.
{
	const s = new Series();
	s.tick('macacct', [{ id: 'a', rx: 0, tx: 0 }], 120);
	s.tick('macacct', [{ id: 'a', rx: 5e6, tx: 0 }], 125);
	s.tick('macacct', [{ id: 'a', rx: 10e6, tx: 0 }], 130);
	close([...s.rollup1m().values()].reduce((a, b) => a + b, 0) * 60, 10e6);
}
console.log('counterDiff: all tests passed');
