"""Step 3: fixed thresholds instead of calibrated ones, so the false-alarm / delay trade-off is
explicit, plus the leak rule 'old CUSUM (H=10) OR one reading > Z'. Ends by checking that
app/detect.py (which adopted the winners) reproduces them."""
import numpy as np
import pandas as pd

import evaluate as ev  # reuses channels, scores and helpers (prints its own report first)

ts, ch, keys, slow, fac_of_asset = ev.ts, ev.ch, ev.keys, ev.slow, ev.fac_of_asset
HOUR = 3600
MARGIN_AFTER = 16 * HOUR  # longer than any capped CUSUM needs to drain after an event


def normal(fid):
    m = ch[fid]["run"].copy()
    for k in keys:
        if fac_of_asset.get(k["asset"]) == fid:
            m &= ~((ts >= k["onset_unix"] - HOUR) & (ts < k["end_unix"] + MARGIN_AFTER))
    return m


normals = {fid: normal(fid) for fid in ch}
normal_hours = sum(m.sum() for m in normals.values()) * 5 / 60


def evaluate_alarm(alarm_of, cat):
    """alarm_of(fid) -> bool array. Returns (false-alarm episodes, {event: delay min})."""
    fa = sum(ev.episodes(alarm_of(fid) & normals[fid]) for fid in ch)
    delays = {}
    for k in (k for k in slow if k["category"] == cat):
        fid = fac_of_asset[k["asset"]]
        hit = np.flatnonzero((ts >= k["onset_unix"]) & (ts < k["end_unix"]) & alarm_of(fid))
        delays[k["id"]] = (ts[hit[0]] - k["onset_unix"]) / 60 if len(hit) else None
    return fa, delays


def row(label, fa, delays, base):
    cells = " ".join(f"{'miss' if d is None else int(d):>5}" for d in delays.values())
    gains = [base[e] - d for e, d in delays.items() if d is not None]
    print(f"  {label:44} FA {fa:>2}   {cells}   median {np.median([d for d in delays.values() if d is not None]):>4.0f}   "
          f"earlier by {np.median(gains):+.0f} min (each: {', '.join(f'{g:+.0f}' for g in gains)})")


base = {}
for k in slow:
    b = ev.baseline_alarm(k)
    base[k["id"]] = None if b is None else (b - k["onset_unix"]) / 60

print(f"\n\n==== fixed thresholds; normal data = {normal_hours:.0f} pump-on facility-hours (~1 week x 15 facilities)")
cus_p = {fid: ev.cusum(f["zp"], f["run"], f["fault"], 1.0) for fid, f in ch.items()}
print("\npipeline_leak   events:", " ".join(k["id"] for k in slow if k["category"] == "pipeline_leak"))
print(f"  {'old detector (CUSUM pressure, H=10)':44}        " + " ".join(f"{int(base[k['id']]):>5}" for k in slow if k["category"] == "pipeline_leak"))
for z in (4.0, 4.5, 5.0):
    fa, d = evaluate_alarm(lambda fid: (cus_p[fid] > 10) | (np.nan_to_num(ch[fid]["zp"], nan=-np.inf) > z), "pipeline_leak")
    row(f"CUSUM H=10  OR  one reading > {z}σ ({z * 3:.1f} psi)", fa, d, base)
    zc = {fid: np.nan_to_num(f["zc"], nan=-np.inf) for fid, f in ch.items()}
    fa, d = evaluate_alarm(lambda fid: (cus_p[fid] > 10) | (zc[fid] > z), "pipeline_leak")
    row(f"CUSUM H=10  OR  pressure+loss reading > {z}σ", fa, d, base)
for H in (5, 7):
    fa, d = evaluate_alarm(lambda fid: cus_p[fid] > H, "pipeline_leak")
    row(f"CUSUM pressure H={H}", fa, d, base)

print("\npump_degradation   events:", " ".join(k["id"] for k in slow if k["category"] == "pump_degradation"))
print(f"  {'old detector (CUSUM flow, H=10)':44}        " + " ".join(f"{int(base[k['id']]):>5}" for k in slow if k["category"] == "pump_degradation"))
cus_e = {fid: ev.cusum(f["ze"], f["run"], f["fault"], 1.0) for fid, f in ch.items()}
cus_w = {fid: ev.cusum(f["zw"], f["run"], f["fault"], 1.0) for fid, f in ch.items()}
for H in (10, 8, 6, 5, 4):
    fa, d = evaluate_alarm(lambda fid: cus_e[fid] > H, "pump_degradation")
    row(f"CUSUM flow H={H}", fa, d, base)
    fa, d = evaluate_alarm(lambda fid: cus_w[fid] > H, "pump_degradation")
    row(f"CUSUM flow+discharge H={H}", fa, d, base)

print("\napp/detect.py now (leak: H=10 OR one reading > 4.5σ; wear: flow+discharge H=6):")
for cat in ("pipeline_leak", "pump_degradation"):
    d = {k["id"]: (None if (a := ev.app_alarm(k)) is None else (a - k["onset_unix"]) / 60) for k in slow if k["category"] == cat}
    app_fa = sum(1 for e in ev.app_events if e.category == cat
                 and not any(k["category"] == cat and k["asset"] == e.asset_id
                             and e.alarm_unix < k["end_unix"] and e.alarm_unix >= k["onset_unix"] - 6 * HOUR for k in keys))
    row(f"{cat}", app_fa, d, base)
