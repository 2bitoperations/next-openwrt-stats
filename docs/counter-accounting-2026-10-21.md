# Counter spikes and time-weighted rollups (2026-10-21)

## Symptoms
- A single client (Fancypants, `80:6D:97:28:A3:E4`, behind the Wi-Fi mesh) showed up to 60 Gb/s on
  the 1-day chart. Raw samples reached 110-200 Gb/s; ~8 clients were affected (Fancypants,
  smudgefinder-mini, useless, ...) and every spike also landed in Combined LAN (`network/lan`, up to
  201 Gb/s).
- The aggregate graphs didn't "add up": a day's totals for the same series differed by tier (1h tier
  up to +30 % vs 1m for some clients).

## Root causes
1. **Counters summed across nodes before being diffed** (`hostTraffic.ts` + collector). macacct keeps a
   MAC's counters on every node that ever counted it (roaming, or frames flooded to it at another node),
   e.g. Fancypants: kitchen 82.76 GB, main 42 kB. When one node missed a poll, the sum dropped (skipped
   as a "reset"); when it answered again, its whole lifetime counter became one 5 s delta. Measured live:
   the 19:08:33 sample was 110,346 Mb/s × 6 s / 8 = 82.76 GB = exactly kitchen's counter.
   hostapd station counters had the same flaw (highest-signal AP picked per tick, flips while roaming).
2. **One timeout dropped a node for 5 minutes.** An 8 s request timeout puts the router in a 15 s
   backoff; the macacct read failed inside it, `routerTotals` forgot the router's source, the no-retry
   re-probe failed too (still backing off), and the router was cached as "no source" for 300 s. That
   made the gaps in (1) long and frequent (19:03-19:08: every kitchen-only client had no samples).
   The timeouts hit main, kitchen and both relays at the same moments (e.g. 14:49, 16:27, 19:03), so
   they look devnull-side (event loop / NAS load), not a node problem. Not fixed here; now harmless.
3. **Rollups were plain averages of whatever samples a bucket had.** A series present for 10 s of a
   minute (or 1 of 60 minutes) got that partial average stretched over the whole bucket (over-count),
   and a sample that averaged a long gap was weighted like a 5 s one (under-count).

## Fix
- `lib/server/counterDiff.ts`: every node's counter is diffed against its own previous reading
  (`ClientCounterTracker`, keyed per router for macacct/nlbw and per `router|ifname` for hostapd), giving
  a rate over that node's own span. `SeriesRowBuilder` turns a series' spans into raw rows that record
  the seconds they cover (`metric_sample.intervalSec`, migration 0008). A node returning after missed
  polls has its rate added to the rows already written for its gap (UPDATE, by overlap share); a
  series with no rows at all over a gap gets backdated 5 s rows at the gap's average. Spans over
  120 s, decreases and rates above 10 Gb/s restart that counter instead of producing a sample.
- `hostTraffic.ts`: per-router totals (no summing); a known source is kept until it has failed for 5
  minutes.
- Rollups are time-weighted (bytes / bucket length; gauges stay plain averages) and wait 150 s after a
  bucket ends so late updates land first. The rollup cursor resumes after the newest existing bucket on
  restart (no duplicate or skipped buckets).
- Trade-off: the 1m/5m/1h tiers (charts with a range > 10 min) lag real time by ~2.5-3.5 min.

## Test plan (rerun after any change to collection or rollups)
Tools: `npx tsx lib/server/counterDiff.test.ts` (unit, includes the 2026-10-21 failure replay) and
`scripts/measure-window.py T0 T1 --mac ...` (integrates raw-tier series by `intervalSec` over a
window, minus a baseline ending 10 s before T0; raw retention is 5 min, so run it right after).
Leave >= 70 s of quiet before each test so the baseline is clean. Transfer sizes: 150-300 MB (the
network's background traffic is ~5-35 Mb/s). Expected = bytes on the wire (+2-8 % headers/ssh).

| # | Test | Machines | Expect |
|---|---|---|---|
| T1 | Internet download, wired client behind the mesh | replicator (kitchen lan2) | client +N, client_wan +N, Combined LAN internet ~+N, WAN rx ~+N, main mesh tx ~+N |
| T2 | Internet download, Wi-Fi client behind the mesh | fatso-linux (kitchen Wi-Fi) | same as T1 |
| T3 | Internet download, Wi-Fi client on main | smudgefinder-mini (main ap0) | as T1 but Mesh ~0 |
| T4 | LAN copy across the mesh | fatso-linux -> devnull (main lan2), `ssh cat` | Combined LAN-local +N, internet ~0, WAN ~0, kitchen-relay mesh tx +N |
| T5 | LAN copy within one node | fatso-linux -> replicator, iperf3 | LAN-local +N (once, at the destination), Mesh ~0, WAN ~0 |
| T6 | Node outage mid-transfer | replicator download; on kitchen drop `ip saddr <devnull> tcp dport 80` for 30 s (inet table, remove by hand: a backgrounded `sleep` dies with the ssh session) | client total ~N, no sample above the link rate |
| T7 | Roam mid-transfer | a Wi-Fi client moved between APs during a download | no spike, client total ~N |
| T8 | Tier conservation | DB: raw vs 1m, 1m vs 5m, 5m vs 1h bytes per series and bucket | equal (float noise) |
| T9 | Invariants (passive) | DB | no client/network sample > 2.5 Gb/s; Combined LAN internet 85-105 % of WAN rx+tx per 10 min+ |

## Results (2026-10-21, live)
- Unit tests: pass (old algorithm replays the failure as a 132 Gb/s spike; new one keeps every row at
  the true rate and conserves bytes).
- T1 300 MB -> client 307.8 MB, peak 70 Mb/s. T2 300 MB -> 304.6 MB. T4 150 MB -> client LAN tx
  162.1 MB, Combined LAN-local +165.4 MB, Mesh +172.8 MB (relay tx), WAN rx +1.9 MB. T5 209.7 MB ->
  213.0 MB at both ends, LAN-local +215.9 MB, Mesh -0.6 MB, WAN ~0.
- T6 before this fix (counter-per-node only): client 57.5 MB of 300 MB (gap bytes squeezed into one
  5 s sample). After: 308.0 MB, flat 34 Mb/s across the ~1 min outage, peak 67.4 Mb/s (curl limit
  67.1 Mb/s).
- T8: raw vs 1m and 1m vs 5m identical for every series (worst bucket difference 0.0 kB).
- T9: max client sample since deploy 120 Mb/s; Combined LAN internet = 100.5 % of WAN over 10 min.
- Not run: T3 (smudgefinder-mini's SSH host key changed - not overridden), T7 (needs someone to move
  a device).
