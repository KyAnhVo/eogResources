"""Verify a worn-pump alarm from the readings after it, and forecast when the pump will fail.

Measured on history/full_week (5 worn pumps; backend/research/verify_wear.py reproduces it):
- A worn pump loses flow on a straight line: every one dropped 0.39-0.42 % of its rated flow per
  hour, from about 99 % at the alarm. Discharge pressure falls with it.
- The three that faulted did so at 85.8 %, 86.2 % and 85.8 % efficiency (flow / max_flow), about
  34 h after the alarm. The other two were repaired (flow back to 100 %) before getting there.
- One or two hours after the alarm is too soon to tell: the pump has lost under 1 % and some real
  cases look like healthy noise. Six hours in, the downward trend of efficiency separates all five
  (slope z -7.4 or lower) from 5,000 healthy six-hour windows (none below -3.9).

Causal like the detectors: only rows up to the dataset's last row (the operator's "now") are used.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from app.dataset import Dataset

VERIFY_AFTER_S: int = 6 * 3600  # trend window after the alarm
BEFORE_S: int = 2 * 3600  # baseline window just before the alarm, for the before/after comparison
VERIFY_SLOPE_Z: float = -5.0  # verified when the efficiency trend is at least this many sigma downhill
FAIL_EFFICIENCY: float = 0.86  # efficiency at which the worn pumps in full_week faulted
MIN_ROWS: int = 6  # pump-on rows needed in a window to fit a trend


def _mean(x: np.ndarray, rows: np.ndarray, digits: int) -> float | None:
    return round(float(np.mean(x[rows])), digits) if len(rows) else None


def _trend(ds: Dataset, eff: np.ndarray, rows: np.ndarray, t0: int, sigma: float) -> tuple[float, float, float]:
    """Least-squares line of efficiency over hours since t0: (intercept, slope per hour, slope z)."""
    t: np.ndarray = (ds.ts[rows] - t0) / 3600
    slope, intercept = np.polyfit(t, eff[rows], 1)
    spread: float = float(np.sqrt(np.sum((t - t.mean()) ** 2)))
    return float(intercept), float(slope), float(slope * spread / sigma) if spread else 0.0


def verify_wear(
    ds: Dataset,
    eff: np.ndarray,  # flow / max_flow
    discharge_residual: np.ndarray,  # discharge psi minus the healthy running value
    running: np.ndarray,
    alarm: int,
    end: int | None,  # row indexes of the wear span; end None while ongoing
    sigma: float,  # 1-sigma noise of eff
) -> dict[str, Any]:
    t_alarm: int = int(ds.ts[alarm])
    stop: int = len(ds.ts) if end is None else end
    before: np.ndarray = np.flatnonzero(running[:alarm])
    before = before[ds.ts[before] >= t_alarm - BEFORE_S]
    window_stop: int = min(stop, int(np.searchsorted(ds.ts, t_alarm + VERIFY_AFTER_S)))
    after: np.ndarray = np.flatnonzero(running[alarm:window_stop]) + alarm

    out: dict[str, Any] = {
        "check_unix": t_alarm + VERIFY_AFTER_S,
        "hours_seen": round((int(ds.ts[window_stop - 1]) - t_alarm) / 3600, 2),
        "efficiency_before": _mean(eff, before, 4),
        "efficiency_after": _mean(eff, after, 4),
        "discharge_before_psi": _mean(discharge_residual, before, 1),
        "discharge_after_psi": _mean(discharge_residual, after, 1),
        "slope_pct_per_h": None,
        "slope_z": None,
        "forecast_fail_unix": None,
        "status": "pending",
    }
    if len(after) >= MIN_ROWS:
        _, slope, z = _trend(ds, eff, after, t_alarm, sigma)
        out["slope_pct_per_h"], out["slope_z"] = round(slope * 100, 3), round(z, 1)
    if t_alarm + VERIFY_AFTER_S > int(ds.ts[stop - 1]):
        # Still collecting while ongoing; a span that closed first (repair or fault) is never checked.
        out["status"] = "pending" if end is None else "ended_before_check"
        return out
    verified: bool = out["slope_z"] is not None and out["slope_z"] <= VERIFY_SLOPE_Z
    out["status"] = "verified" if verified else "not_verified"
    if verified:
        # Forecast from everything seen since the alarm: when the line reaches FAIL_EFFICIENCY.
        rows: np.ndarray = np.flatnonzero(running[alarm:stop]) + alarm
        intercept, slope, _ = _trend(ds, eff, rows, t_alarm, sigma)
        if slope < 0:
            out["forecast_fail_unix"] = int(t_alarm + max(0.0, (FAIL_EFFICIENCY - intercept) / slope) * 3600)
    return out
