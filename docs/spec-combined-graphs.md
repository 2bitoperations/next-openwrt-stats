# Spec: combined WAN / LAN / Mesh graphs (2026-10-07)

## Questions the three "Combined" cards answer
- **WAN**: how loaded is the internet uplink? (download / upload)
- **LAN**: of all traffic on the network, how much is LAN-local vs internet-bound?
- **Mesh**: how busy are the mesh links (shared channel airtime)?

Worked example. Router <-mesh-> AP; client1, client2 on the AP; NAS on the router.
client1 <-> Netflix 10 Mb/s; client2 -> client1 2 Mb/s; client2 -> NAS 5 Mb/s.
Expected: WAN 10; LAN 17 (local 7 + internet 10); Mesh 15 (10 + 5 cross the mesh; the
client2 -> client1 stream never leaves the AP).

## Counting rules (each byte once)
- **WAN** = sum over routers of the netdev named `wan`, but only where `wan` is NOT a
  member of a bridge (swamp-ap-kitchen bridges its `wan` port into br-lan as its uplink;
  counting it doubled Combined WAN). Download/upload kept.
- **LAN** = from macacct >= 2 per-client counters (already polled every 5 s and diffed in
  `computeClientAndRadioSampleRows`): local = sum over clients of LAN rx (bytes delivered
  to a client from another LAN device - each LAN-local frame counted once, at its
  destination); internet = sum over clients of WAN rx + WAN tx (both directions of
  internet traffic). Total = local + internet. No upload/download split - instead a
  LAN-local / Internet split and the internet share in %.
- **Mesh** = sum over all mesh radio netdevs (wifi interfaces in mesh mode, e.g.
  `phy0.1-mesh0`, `phy1-mesh0`, `halow-mesh0`; NOT `bat0`) of their **tx** only - every
  over-the-air transmission counted once, per hop (correct for airtime). Stacked by router.

## Implementation (lib/server/metrics.ts collector; existing patterns)
A. WAN: `getNetworkDeviceStats` (lib/server/routerInterfaces.ts) also returns
   `bridgeMembers: string[]` = union of every device's `bridge-members` array from
   `network.device status` (add `'bridge-members': z.array(z.string()).optional()` to the
   per-device object in `networkDeviceStatusSchema`, types/ubusCalls.ts). In
   `computeInterfaceSampleRows`, store device `wan` under key `wan-bridged` when it is a
   bridge member (so the per-router WAN tab and Combined WAN see only real WANs; the
   per-interface breakdown still shows the port).
B. LAN: new scope `network` (add to `metricScope` in drizzle/schema/schema.ts,
   `MetricScopeName`, the history API's scope check, `useMetricHistory` /
   `BandwidthHistoryChart` scope types). After the existing LAN/Internet per-client loop,
   push ONE row per client tick: scope `network`, routerId null, key `lan`,
   **rxAvg = LAN-local B/s, txAvg = internet B/s** (document this column reuse). Only sum
   clients whose deltas were valid this tick (prev exists, dt > 0, no negative delta).
   The history route must not require displayName for scope `network`.
C. Mesh: `queryMeshHistory({ from, to })` in metrics.ts: mesh netdevs per router from the
   cached radio snapshot (`getCachedWifiRadios()`: entries with `mode === 'mesh'` and an
   `ifname`); read their `interface` series at `pickTier(to - from)`; return
   `{ routers: [{ displayName, points: [{ timestamp, txAvg, txMax }] }] }` with a router's
   mesh netdevs summed per timestamp. Route `GET /api/metrics/mesh-history?from&to`.
D. UI (components/BandwidthHistory.tsx):
   - Combined WAN: unchanged (key `wan`).
   - Combined LAN: `BandwidthHistoryChart` with scope `network`, key `lan`, new optional
     prop `seriesLabels={{ rx: 'LAN-local', tx: 'Internet' }}` (used by tooltip and
     legend instead of Download/Upload) and the legend also shows the internet share in
     % of the total. Remove `towardDevices` from this card (no longer br-lan). Always
     rendered.
   - Combined Mesh: new `components/MeshHistoryChart.tsx`: recharts stacked area, one
     area per router, values are tx bytes/s formatted with `formatBitrate` (it takes
     BYTES per second), legend with each router's and the total bytes transferred over
     the range; range precedence like BandwidthHistoryChart (prop > `useTimeRange()` >
     own state + picker). Card subtitle: "sum of what every mesh radio transmits".
     Rendered when the API returns at least one router.
   - Per-router cards: unchanged.

## Test plan (executed against the live deployment)
Topology for the tests: the Mac (wired, MAC 80:6d:97:28:a3:e4, 192.168.86.201) is on the
office switch -> swamp-ap-kitchen lan3 (macacct client port) -> kitchen `wan` (bridged,
transit) -> swamp-ap-kitchen-relay eth0 -> relay mesh `phy1-mesh0` <-> main mesh
`phy0.1-mesh0` -> swamp-ap-main -> internet via main `wan`; devnull (192.168.86.17) is on
main lan2.
Method: for each test, measure a 60 s baseline immediately before, run the transfer,
then integrate each series over the transfer window (sum of avg x bucket seconds;
network/lan samples are every ~5 s, interface raw samples every 1 s) and subtract
baseline rate x window. Tolerances allow L2/L3/TLS overhead (+0..10 %).
- T0 WAN de-duplication: after deploy, Combined WAN over 5 min ~= swamp-ap-main `wan`
  alone (+-5 %), and no new `wan` samples for swamp-ap-kitchen (`wan-bridged` instead).
- T1 internet download: Mac downloads 30 MB over HTTPS. Expect Combined WAN download +30
  MB (+0..10 %); Combined LAN internet +30 MB; LAN-local ~0; Combined Mesh +30 MB (main's
  mesh radio transmits it toward the relay).
- T2 LAN copy: Mac copies 20 MB to devnull's IPv4 (scp/ssh cat, pinned to the wired
  interface). Expect LAN-local +20 MB; internet ~0; WAN ~0; Mesh +20 MB (relay's mesh
  radio transmits it toward main).
- T3 consistency: over a quiet 10 min, Combined LAN internet ~= Combined WAN download +
  upload (router-originated traffic and overhead make WAN slightly higher; flag > 15 %).
- T4 regressions: dashboard logs show no new errors; per-router cards and client
  dialogs still render; type check passes.

## Results (2026-10-07, executed against the live deployment)
Implementation drafted by a local Qwen3.8-27B (LM Studio) from this spec; review found
and fixed 6 defects before deploy: (1) bridged `wan` renamed only in the lookup key, not
the stored key (double counting would have continued); (2) Combined LAN summed deltas
after the per-client loop had already overwritten the previous counters (always 0);
(3) queryMeshHistory anchored on a bare `}`; (4) `seriesLabels` never destructured +
malformed legend JSX; (5) MeshHistoryChart plotted the same total under every router;
(6) an `import` pasted into JSX. Bridged = member of any bridge (spec), not only br-lan.
Kitchen's mis-recorded `wan` series (1229 samples since the 2026-10-06 wipe) deleted.

Measurement: dashboard APIs integrated per sample over the gap BEFORE it (each sample is
the average since the previous one), with a 30 s lead-in; 60 s baseline subtracted.
- T0 PASS: kitchen records `wan-bridged`, no new kitchen `wan`; `network/lan` series
  present; mesh-history lists main, kitchen-relay, workshop-relay (+ offline lab HD01s
  with no points). Combined WAN == swamp-ap-main `wan` exactly in T1/T2.
- T1 PASS (2 x 50 MB HTTPS download from the Mac on kitchen lan3): Combined WAN download
  +110.0 MB; LAN internet +113.1 MB, LAN-local -0.3 MB (noise); Mesh +116.1 MB (main's
  mesh radio transmitting toward the relay).
- T2 PASS (100 MB copy Mac -> devnull IPv4): LAN-local +103.9 MB; internet -1.5 MB, WAN
  -0.8 MB (noise); Mesh +111.5 MB (kitchen relay's radio +109.8 MB toward main).
  (First evaluation read 60-88 MB: a bug in the test's integrator - forward-held
  samples / no lead-in - not in the dashboard; the relay's raw counters confirmed
  +54.6 MB for a 50 MB copy.)
- T3 FLAG -> PASS after macacct 2-r3. First run: LAN internet 308.1 MB vs WAN rx+tx 268.7 MB
  over 10 min (+14.7 %); temporary nft counters on swamp-ap-main showed devnull <-> main
  HTTP (the dashboard polling main's ubus) 2.57 MB/min + LAN DNS 0.13 MB/min counted as
  "internet" (frames to the router's MAC). macacct 2-r3: internet only when the IP peer is
  public (not 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 127/8, multicast,
  broadcast; not fc00::/7, fe80::/10, ff00::/8, ::1). Verified on kitchen (20 MB download
  -> wan_rx +20.86 MB; 1.8 MB from main's LuCI -> lan). Rerun (10 min, all reachable nodes
  on 2-r3): LAN internet 376.8 MB vs WAN 394.8 MB = 95.4 % (slightly below WAN, as
  expected: router-originated traffic + overhead appear only on WAN).
- T4 PASS: type check; no new error types in the dashboard log (only the two unplugged lab
  HD01s, throttled); Combined LAN shows LAN-local / Internet + share; Combined Mesh
  stacked per router; AP cards open on "Per interface".
- Later: Combined LAN drawn as stacked areas (LAN-local + Internet = total). A first
  version wrapped the series in React fragments, which recharts 2 ignores - every
  BandwidthHistoryChart rendered no series for ~5 min; fixed (5d12f18) and checked in a
  browser.
