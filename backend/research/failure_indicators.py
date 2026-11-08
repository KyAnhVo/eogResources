"""Which reading, after a worn-pump alarm, signals that the pump will actually fail?

Run from backend/:  uv run python research/failure_indicators.py

Every candidate is computed causally every 15 min from the alarm to the end of the wear span
(fault or repair), using only readings up to that moment. An indicator passes if one threshold
  - fires before the fault on every pump that faulted,
  - never fires on a worn pump that was repaired instead, and
  - never fires on healthy pumps (rows outside any event, same rolling computation).
Reported: the separating threshold range, the margin in noise units, and the warning it gives.
All history/ folders are the same week, so this is 5 worn pumps (3 faulted, 2 repaired).
"""

from __future__ import annotations

import sys
from collections.abc import Callable

import numpy as np

sys.path.insert(0, ".")
from app.dataset import Dataset, Facility, discover_datasets, load_dataset  # noqa: E402
from app.detect import PUMP_FAULT, PUMP_RUNNING, detect  # noqa: E402

WIN = 12  # pump-on rows (1 h) averaged for level-type features
STEP = 3  # evaluate every 15 min

ds: Dataset = load_dataset("full_week", discover_datasets()["history/full_week"])
events = detect(ds)
faults = {(e.asset_id, e.onset_unix) for e in events if e.category == "pump_failure"}


class Ctx:
    """Signals of one facility plus the wear alarm row (None for healthy rows)."""

    def __init__(self, fac: Facility):
        self.fac = fac
        st = ds.series(fac.pump_id, "status")
        self.run = st == PUMP_RUNNING
        self.fault = st == PUMP_FAULT
        self.eff = ds.series(fac.pump_id, "flow_bpd") / fac.max_flow_bpd
        self.dis = ds.series(fac.pump_id, "discharge_psi") - fac.disposal_psi - 150
        self.lvl = ds.series(fac.tank_id, "level_pct")
        self.inflow = ds.series(fac.id, "inflow_bpd")
        self.alarm: int | None = None
        self.base_eff: float = 1.0

    def on_rows(self, lo: int, t: int) -> np.ndarray:
        return np.flatnonzero(self.run[lo : t + 1]) + lo


def last_on(c: Ctx, t: int, n: int = WIN, since: int = 0) -> np.ndarray:
    r = c.on_rows(max(since, t - 12 * 24), t)
    return r[-n:]


def hours(c: Ctx, rows: np.ndarray) -> np.ndarray:
    return (ds.ts[rows] - ds.ts[rows[0]]) / 3600


def f_eff(c, t):
    r = last_on(c, t); return float(c.eff[r].mean()) if len(r) >= 6 else None
def f_dis(c, t):
    r = last_on(c, t); return float(c.dis[r].mean()) if len(r) >= 6 else None
def f_drop(c, t):
    v = f_eff(c, t); return None if v is None else c.base_eff - v
def f_hours_worn(c, t):
    return None if c.alarm is None else (ds.ts[t] - ds.ts[c.alarm]) / 3600
def f_slope6(c, t):
    r = last_on(c, t, n=72)
    return float(np.polyfit(hours(c, r), c.eff[r], 1)[0] * 100) if len(r) >= 24 and hours(c, r)[-1] > 2 else None
def f_noise(c, t):
    r = last_on(c, t); return float(np.std(c.eff[r] - np.polyval(np.polyfit(hours(c, r), c.eff[r], 1), hours(c, r)))) if len(r) >= 6 else None
def f_dis_noise(c, t):
    r = last_on(c, t); return float(np.std(c.dis[r])) if len(r) >= 6 else None
def f_jump(c, t):
    r = last_on(c, t); return float(np.abs(np.diff(c.eff[r])).max()) if len(r) >= 6 else None
def current_run(c, t, n=WIN):
    """The last n rows of the pump run in progress at t (one continuous run, so the level is continuous)."""
    if not c.run[t]: return np.array([], int)
    s = t
    while s > 0 and c.run[s - 1] and t - s < n - 1: s -= 1
    return np.arange(s, t + 1)
def f_drain(c, t):  # tank %/h while pumping, last hour of the current run
    r = current_run(c, t); return float(-np.polyfit(hours(c, r), c.lvl[r], 1)[0]) if len(r) >= 6 else None
def f_drain_norm(c, t):  # what the tank says the pump moves: drain + inflow, as a fraction of rated flow
    d = f_drain(c, t)
    if d is None: return None
    r = current_run(c, t)
    return (d / 100 * c.fac.capacity_bbl * 24 + float(c.inflow[r].mean())) / c.fac.max_flow_bpd
def f_run_len(c, t):  # hours of the current pump run so far
    if not c.run[t]: return None
    s = t
    while s > 0 and c.run[s - 1]: s -= 1
    return (t - s) * 5 / 60
def f_tank(c, t):
    return float(c.lvl[t])
def f_duty(c, t):
    lo = max(0, t - 144); return float(c.run[lo : t + 1].mean())
def f_eff_x_dis(c, t):  # both pump signals together, in noise units
    e, d = f_eff(c, t), f_dis(c, t)
    return None if e is None else ((1 - e) / 0.006 + (-d) / 3.0) / 2

# (name, function, fires when value is "low" or "high")
CANDIDATES: list[tuple[str, Callable, str]] = [
    ("Flow % of rated (1 h avg)", f_eff, "low"),
    ("Discharge psi vs healthy (1 h avg)", f_dis, "low"),
    ("Flow + discharge combined score", f_eff_x_dis, "high"),
    ("Flow lost since alarm", f_drop, "high"),
    ("Tank outflow (from level + inflow)", f_drain_norm, "low"),
    ("Tank drain %/h while pumping", f_drain, "low"),
    ("Hours since wear alarm", f_hours_worn, "high"),
    ("Current pump run length h", f_run_len, "high"),
    ("Flow trend last 6 h %/h", f_slope6, "low"),
    ("Pump on-time last 12 h", f_duty, "high"),
    ("Tank level %", f_tank, "high"),
    ("Flow noise (1 h)", f_noise, "high"),
    ("Discharge noise (1 h)", f_dis_noise, "high"),
    ("Largest 5-min flow jump (1 h)", f_jump, "high"),
]

# Wear spans and healthy rows per facility.
spans = []
for w in (e for e in events if e.category == "pump_degradation"):
    c = Ctx(w.facility); c.alarm = ds.row(w.alarm_unix)
    pre = np.flatnonzero(c.run[max(0, c.alarm - 24) : c.alarm]) + max(0, c.alarm - 24)
    c.base_eff = float(c.eff[pre].mean()) if len(pre) else 1.0
    spans.append((w.asset_id, (w.asset_id, w.end_unix) in faults, c, c.alarm, ds.row(w.end_unix)))
healthy = []
for fac in ds.facilities:
    c = Ctx(fac); bad = np.zeros(len(ds.ts), bool)
    for e in events:
        if e.facility.id == fac.id:
            lo = ds.row(e.onset_unix) - 24; hi = len(ds.ts) if e.end_unix is None else ds.row(e.end_unix) + 24
            bad[max(0, lo) : hi] = True
    healthy.append((c, [t for t in range(36, len(ds.ts), STEP) if not bad[t - 36 : t + 1].any()]))

print(f"{'indicator':38} {'faulted pumps fire at':>24} {'repaired worst':>14} {'healthy worst':>13}  verdict")
results = []
for name, fn, side in CANDIDATES:
    sign = 1 if side == "high" else -1  # compare sign*value: higher = closer to failure
    fail_vals, rep_vals = [], []
    for asset, failed, c, a, end in spans:
        vals = [(t, fn(c, t)) for t in range(a, end, STEP)]
        vals = [(t, sign * v) for t, v in vals if v is not None]
        (fail_vals if failed else rep_vals).append((asset, end, vals))
    hv = [sign * v for c, ts in healthy for t in ts if (v := fn(c, t)) is not None] if name != "Hours since wear alarm" else []
    # Threshold must sit above every repaired value and every healthy value; each faulted pump must exceed it.
    ceiling = max([max(v for _, v in vals) for _, _, vals in rep_vals] + ([max(hv)] if hv else []))
    peaks = [max(v for _, v in vals) for _, _, vals in fail_vals]
    lo_fail = min(peaks)
    ok = lo_fail > ceiling
    rep_worst = max(max(v for _, v in vals) for _, _, vals in rep_vals)
    h_worst = max(hv) if hv else float("nan")
    fmt = lambda x: f"{sign * x:.3f}" if abs(x) < 10 else f"{sign * x:.1f}"
    line = f"{name:38} {', '.join(fmt(p) for p in peaks):>24} {fmt(rep_worst):>14} {fmt(h_worst) if hv else 'n/a':>13}  "
    if ok:
        th = (lo_fail + ceiling) / 2
        leads = [(end - next(t for t, v in vals if v >= th)) * 5 / 60 for _, end, vals in fail_vals]
        line += f"PASS  threshold {fmt(th)}, warning {', '.join(f'{x:.1f}' for x in leads)} h before fault"
    else:
        why = "repaired pumps reach it" if lo_fail <= rep_worst else "healthy pumps reach it"
        line += f"fail  ({why})"
    print(line)
