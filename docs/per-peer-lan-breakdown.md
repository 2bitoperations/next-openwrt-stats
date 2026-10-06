# Design: per-peer LAN breakdown ("who did this client talk to?")

Status: **proposed, not implemented** (2026-10-06). Written as a self-contained
spec so it can be implemented later (possibly by a local LLM as an experiment);
everything it builds on exists today.

## Goal

In a client's history dialog, under the LAN chart, show which other devices
that client exchanged LAN traffic with over the selected range, e.g. for
devnull: "laptop-a 12.4 GB down / 1.1 GB up, tv 3.2 GB / 40 MB, ...", with a
small chart per top peer or a stacked chart of the top N peers + "other".

Internet traffic is out of scope (that would need conntrack / DNS correlation
on the router - deliberately not done).

## What exists today (build on this, don't duplicate it)

- **Router side: `macacct` >= 2** (OpenWrt package, source in the
  heltec-halow-adapters project, `firmware/port-25.12/feed-heltec/macacct/`).
  An nftables bridge-family table `bridge macacct` with dynamic per-element-counter
  sets `tx`, `rx`, `tx_wan`, `rx_wan` keyed by `ether_addr`, updated from chains
  `count_tx` / `count_rx` that are entered once per frame from the `forward`,
  `input`, `output` hooks, only for frames on client-facing ports (set
  `transit` lists the ports that are not counted). `macacct show` (ucode,
  `/usr/sbin/macacct`) prints `{"columns": [...], "data": [[...]]}`.
- **Dashboard side**: `lib/server/hostTraffic.ts` reads `macacct show` per
  router (probed + cached), `lib/server/metrics.ts` diffs cumulative counters
  into rates every client poll (5 s) and stores them as series
  (`metric_series` scope + key, `metric_sample` rows) that are rolled up into
  tiers raw -> 1m -> 5m -> 1h automatically for every scope. Scopes in use:
  `interface`, `client`, `client_lan`, `client_wan`, `radio`
  (`drizzle/schema/schema.ts` `metricScope`). History API:
  `GET /api/metrics/history?scope=&key=&from=&to=`. Charts:
  `components/BandwidthHistoryChart.tsx`, dialog `components/ClientHistoryDialog.tsx`.

## Router side: macacct 3

Add two sets keyed by the concatenation of both MACs, counted only for LAN
frames (the other end is not the router):

```
set pair_tx { type ether_addr . ether_addr; size 8192; flags dynamic; counter; }
# in chain count_tx, after the existing rules:
ether daddr != @gw ether daddr & 01:00:00:00:00:00 == 00:00:00:00:00:00 update @pair_tx { ether saddr . ether daddr }
```

`pair_tx[(client, peer)]` = bytes the client sent to that peer, counted where
the client's frame enters a client-facing port. The reverse direction
(peer -> client) is the peer's own `pair_tx` entry if the peer is also a
counted client, and otherwise is visible as `count_rx` frames on the client's
node; for a first version **only count `pair_tx`** and derive "received from
peer P" as `pair_tx[(P, client)]` when P is a counted client anywhere on the
network (the dashboard sums across routers). Frames between two clients of the
same switch that no node sees are invisible by nature (document, don't fix).

Notes for the implementer:
- Multicast/broadcast destinations are excluded by the unicast mask; keep it.
- Cost: one more dynamic-set update per LAN unicast frame. Benchmark on an
  HT-HD01-V2 (575 MHz MT7628) with the existing harness
  (`firmware/port-25.12/acct-benchmark/run.sh`, "mixed" profile, interleaved
  with baselines; noise is about +-1 CPU point). macacct 2 costs about +3
  points over no accounting; reject the design if pairs add more than ~2 more.
- Set size: entries grow with (clients x peers actually talked to). 8192 is
  plenty for a home network; when the set is full nft silently stops adding
  new pairs (existing ones keep counting) - surface that in the readout.
- `macacct pairs` (new subcommand, ucode): prints
  `{"columns": ["mac", "peer", "tx_bytes", "tx_pkts"], "data": [...]}`.
  Add `"/usr/sbin/macacct pairs": ["exec"]` to the package's rpcd ACL
  (`files/macacct.acl.json`).
- Bump `PKG_VERSION` to 3; keep `macacct show` output unchanged.

## Dashboard side

- `hostTraffic.ts`: `getHostPairTotals()` - same probe/cache pattern, calls
  `macacct pairs` only on routers whose `macacct show` already worked; sum
  per `(mac, peer)` across routers. Poll it less often than totals (every 60 s
  is enough; this is a breakdown, not a live rate).
- Storage - pick one, the second is simpler and probably enough:
  1. Full series: scope `client_peer`, key `"<mac>|<peer>"`, diffed like the
     other client series. Gives per-peer history charts; costs one series per
     active pair (thousands of rows per hour on a busy LAN).
  2. **Rollup table only**: `client_peer_hourly (mac, peer, hour, txBytes)`,
     upserted from 60 s deltas. The dialog then shows "top peers in range" as
     a table/bar chart rather than time series. Much cheaper; matches the goal.
- API: `GET /api/metrics/peers?key=<mac>&from=&to=` -> top 10 peers by bytes in
  each direction (`sent to`: rows where mac = client; `received from`: rows
  where peer = client), with peer display names resolved the same way client
  names are (DHCP leases / known clients).
- UI: in `ClientHistoryDialog.tsx`, below the LAN chart, a "Top LAN peers"
  list for the dialog's selected range (`rangeSeconds` is already shared by the
  three traffic charts), each row: name, sent, received. Empty state: "needs
  macacct 3 on the client's node".

## Acceptance checks

1. Controlled test: from a wired client, copy 20 MB to devnull's IPv4 address
   (not its hostname - it also resolves to Tailscale/IPv6 and may leave via
   another interface/MAC); the pair (client, devnull) must grow by ~20 MB
   (+~1 % overhead) and nothing else by more than noise.
2. Sum check: for any client over an hour, sum of its `pair_tx` rows ~= its
   `client_lan` tx total (allowing for broadcast/multicast, which pairs
   exclude).
3. Benchmark as above; no dashboard error log lines, no re-login storms.
