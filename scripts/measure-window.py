# /// script
# requires-python = ">=3.11"
# ///
"""Integrate dashboard series (raw tier) over a window, baseline-subtracted.

Each raw sample is the average rate over its intervalSec (older rows: since the
series' previous sample). Bytes in [t0, t1] = sum over samples with
t0 < t_i <= t1 of rate_i * (t_i - t_{i-1}). Baseline = same over [b0, t0]
scaled to the window length. Raw retention is 5 min: run right after a test.

usage: measure.py T0 T1 [--baseline SECONDS] [--mac MAC ...]
"""
import argparse, json, subprocess, collections

ap = argparse.ArgumentParser()
ap.add_argument("t0", type=int)
ap.add_argument("t1", type=int)
ap.add_argument("--baseline", type=int, default=60)
ap.add_argument("--mac", action="append", default=[])
a = ap.parse_args()
b0 = a.t0 - 10 - a.baseline  # baseline ends 10 s before t0 (backfill can start early)

sql = f"""
select s.scope, coalesce(r.displayName,'') router, s.key, m.timestamp t, m.rxAvg rx, m.txAvg tx, m.intervalSec iv
from metric_sample m join metric_series s on s.id=m.seriesId left join routers r on r.id=s.routerId
where m.tier='raw' and m.timestamp > {b0 - 30} and m.timestamp <= {a.t1}
and ( (s.scope='network')
   or (s.scope='interface' and (s.key='wan' or s.key like '%mesh0'))
   or (s.scope in ('client','client_lan','client_wan') and s.key in ({','.join("'"+m.upper()+"'" for m in a.mac) or "''"})) )
order by s.id, m.timestamp
"""
out = subprocess.run(
    ["ssh", "devnull", f'sqlite3 -readonly -json /volume1/docker/next-openwrt-stats/db/local.db "{sql}"'],
    capture_output=True, text=True, check=True).stdout
rows = json.loads(out or "[]")
series = collections.defaultdict(list)
for r in rows:
    series[(r["scope"], r["router"], r["key"])].append(r)

def integrate(pts, lo, hi):
    rx = tx = 0.0
    for prev, cur in zip(pts, pts[1:]):
        if lo < cur["t"] <= hi:
            dt = cur["iv"] if cur.get("iv") else cur["t"] - prev["t"]
            rx += cur["rx"] * dt
            tx += cur["tx"] * dt
    return rx, tx

w = a.t1 - a.t0
res = {}
for k, pts in sorted(series.items()):
    rx, tx = integrate(pts, a.t0, a.t1)
    brx, btx = integrate(pts, b0, a.t0 - 10)
    scale = w / a.baseline
    res[k] = (rx - brx * scale, tx - btx * scale, max(max(p["rx"], p["tx"]) for p in pts))

MB = 1e6
mesh_tx = 0.0
print(f"window {a.t0}..{a.t1} ({w}s), baseline {a.baseline}s; MB = 1e6 bytes, net of baseline")
for (scope, router, key), (rx, tx, peak) in res.items():
    label = {"network": "Combined LAN (rx=LAN-local, tx=internet)"}.get(scope, f"{scope} {router} {key}")
    print(f"  {label:58s} rx {rx/MB:9.1f}  tx {tx/MB:9.1f}  peak {peak*8/1e6:9.1f} Mb/s")
    if scope == "interface" and key.endswith("mesh0"):
        mesh_tx += tx
wan = [v for (s, r, k), v in res.items() if s == "interface" and k == "wan"]
print(f"  => Combined WAN rx+tx {sum(v[0]+v[1] for v in wan)/MB:.1f} MB; Combined Mesh tx {mesh_tx/MB:.1f} MB")
