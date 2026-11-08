"""Step 2: can a different detector alarm >= 10 min earlier than the current one, at the same
false-alarm rate? Scores are causal per facility; thresholds are calibrated leave-one-system-out
(zero false alarms on the other systems' normal rows), then delays and false alarms are measured
on the held-out system."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

from features import load  # puts backend/ on sys.path
from app.detect import detect  # noqa: E402

OLD_H = 10.0  # the detector before this study: CUSUM H=10 on pressure (leaks) / flow alone (wear)

ds, frames, keys = load()
ts: np.ndarray = ds.ts
HOUR = 3600
SIG_P, SIG_L, SIG_E, SIG_D = 3.0, 0.008, 0.006, 3.0  # per-sample noise (step 0 of the task 1 analysis)

# ---------------------------------------------------------------- per-facility channels (pump-on rows)
ch: dict[str, dict[str, np.ndarray]] = {}
for fr in frames:
    d = fr.df
    run = d["running"].to_numpy()
    nan = lambda x: np.where(run, x, np.nan)
    ch[fr.fac.id] = {
        "run": run,
        "fault": d["fault"].to_numpy(),
        "zp": nan(-d["r_press"].to_numpy() / SIG_P),  # leak: pressure deficit
        "zl": nan(d["r_loss"].to_numpy() / SIG_L),  # leak: water not arriving
        "ze": nan(-d["r_eff"].to_numpy() / SIG_E),  # wear: flow below rating
        "zd": nan(-d["r_dis"].to_numpy() / SIG_D),  # wear: discharge below healthy
    }

# Discharge-vs-flow slope, estimated without labels over all running rows (wear moves both together).
allE = np.concatenate([-frames[i].df["r_eff"].to_numpy()[ch[fr.fac.id]["run"]] for i, fr in enumerate(frames)])
allD = np.concatenate([-frames[i].df["r_dis"].to_numpy()[ch[fr.fac.id]["run"]] for i, fr in enumerate(frames)])
slope = float(np.polyfit(allE, allD, 1)[0])
w_e, w_d = 1 / SIG_E, slope / SIG_D  # z units per unit of efficiency loss, per channel
print(f"discharge drop per unit efficiency loss (unsupervised fit): {slope:.0f} psi; weights e={w_e:.0f} d={w_d:.0f}")
for f in ch.values():
    f["zw"] = (f["ze"] * w_e + f["zd"] * w_d) / np.hypot(w_e, w_d)  # matched combination, unit variance
    f["zc"] = (f["zp"] + f["zl"]) / np.sqrt(2)  # leak combination (equal weights)


# ---------------------------------------------------------------- causal scores
def cusum(z: np.ndarray, run: np.ndarray, fault: np.ndarray, k: float, cap: float = 60.0) -> np.ndarray:
    s, out = 0.0, np.full(len(z), np.nan)
    for i in range(len(z)):
        if fault[i]:
            s = 0.0
        elif run[i]:
            s = min(cap, max(0.0, s + z[i] - k))
        out[i] = s
    return out


def shewhart(z: np.ndarray) -> np.ndarray:
    return np.where(np.isnan(z), -np.inf, z)


def ewma(z: np.ndarray, run: np.ndarray, fault: np.ndarray, lam: float) -> np.ndarray:
    e, out = 0.0, np.full(len(z), np.nan)
    for i in range(len(z)):
        if fault[i]:
            e = 0.0
        elif run[i]:
            e = (1 - lam) * e + lam * z[i]
        out[i] = e / np.sqrt(lam / (2 - lam))  # in units of its own stationary std
    return out


def glr_drift(z: np.ndarray, run: np.ndarray, fault: np.ndarray, window_h: float = 18.0) -> np.ndarray:
    """Max over start times tau of the GLR statistic for a linear upward drift in z starting at tau
    (time in hours, pump-on rows only, unit noise). Returned as sqrt so it reads like a z-score."""
    out = np.full(len(z), np.nan)
    idx: list[int] = []  # running rows since the last fault
    for i in range(len(z)):
        if fault[i]:
            idx = []
            continue
        if run[i]:
            idx.append(i)
        if not idx:
            out[i] = 0.0
            continue
        t_now = ts[i]
        while ts[idx[0]] < t_now - window_h * HOUR:
            idx.pop(0)
        tt = (ts[idx] - ts[idx[0]]) / HOUR
        zz = z[idx]
        # suffix sums for every candidate start tau (each running row)
        S_z = np.cumsum(zz[::-1])[::-1]
        S_tz = np.cumsum((tt * zz)[::-1])[::-1]
        S_t = np.cumsum(tt[::-1])[::-1]
        S_tt = np.cumsum((tt * tt)[::-1])[::-1]
        n = np.arange(len(tt), 0, -1)
        num = S_tz - tt * S_z
        den = S_tt - 2 * tt * S_t + n * tt * tt
        with np.errstate(invalid="ignore", divide="ignore"):
            g = np.where((den > 1e-9) & (num > 0), num * num / den, 0.0)
        out[i] = float(np.sqrt(g.max()))
    return out


# Unsupervised multivariate: robust-standardised 4-d residual vector on running rows.
def feature_matrix(f: dict[str, np.ndarray]) -> np.ndarray:
    return np.column_stack([f["zp"], f["zl"], f["ze"], f["zd"]])


X_all = np.vstack([feature_matrix(f)[f["run"]] for f in ch.values()])
med = np.median(X_all, axis=0)
mad = np.median(np.abs(X_all - med), axis=0) * 1.4826
iso = IsolationForest(n_estimators=200, random_state=0).fit((X_all - med) / mad)  # no labels used

scores: dict[str, dict[str, np.ndarray]] = {}
for fid, f in ch.items():
    run, fault = f["run"], f["fault"]
    Xs = (feature_matrix(f) - med) / mad
    t2 = np.where(run, np.nansum(Xs**2, axis=1), np.nan)
    iso_s = np.full(len(run), -np.inf)
    iso_s[run] = -iso.score_samples(Xs[run])
    scores[fid] = {
        # leaks
        "L cusum pressure k=1": cusum(f["zp"], run, fault, 1.0),
        "L cusum pressure+loss k=1": cusum(f["zc"], run, fault, 1.0),
        "L single reading pressure": shewhart(f["zp"]),
        "L single reading pressure+loss": shewhart(f["zc"]),
        # (the union 'old CUSUM OR single reading' is evaluated with fixed thresholds in sweep.py)
        # wear
        "W cusum flow k=1 (old)": cusum(f["ze"], run, fault, 1.0),
        "W cusum flow+discharge k=1": cusum(f["zw"], run, fault, 1.0),
        "W cusum flow+discharge k=0.5": cusum(f["zw"], run, fault, 0.5),
        "W ewma flow+discharge l=0.05": ewma(f["zw"], run, fault, 0.05),
        "W GLR drift flow+discharge": glr_drift(f["zw"], run, fault),
        # unsupervised, category-agnostic
        "U cusum Hotelling T2 k=8": cusum(np.where(run, t2, np.nan), run, fault, 8.0, cap=400.0),
        "U isolation forest (1 reading)": iso_s,
    }

# ---------------------------------------------------------------- evaluation
fac_of_asset = {f.pipeline_id: f.id for f in ds.facilities} | {f.pump_id: f.id for f in ds.facilities}
sys_of_fac = {f.id: f.system_id for f in ds.facilities}
slow = [k for k in keys if k["category"] in ("pipeline_leak", "pump_degradation")]
NORMAL_MARGIN_AFTER = 10 * HOUR  # let scores drain after an event before counting false alarms


def normal_mask(fid: str) -> np.ndarray:
    m = ch[fid]["run"].copy()
    for k in keys:
        if fac_of_asset.get(k["asset"]) == fid:
            m &= ~((ts >= k["onset_unix"] - HOUR) & (ts < k["end_unix"] + NORMAL_MARGIN_AFTER))
    return m


normals = {fid: normal_mask(fid) for fid in ch}


def episodes(alarm: np.ndarray) -> int:
    return int(np.sum(alarm[1:] & ~alarm[:-1]) + alarm[0])


def first_alarm(score: np.ndarray, thr: float, a: int, b: int) -> int | None:
    m = np.flatnonzero((ts >= a) & (ts < b) & (np.nan_to_num(score, nan=-np.inf) > thr))
    return int(ts[m[0]]) if len(m) else None


app_events = detect(ds)  # the app as it is now
baseline = {(e.asset_id, e.category, e.onset_unix): e.alarm_unix for e in app_events}
old_score = {fid: {"pipeline_leak": cusum(f["zp"], f["run"], f["fault"], 1.0),
                   "pump_degradation": cusum(f["ze"], f["run"], f["fault"], 1.0)} for fid, f in ch.items()}


def baseline_alarm(k: dict) -> int | None:
    """First alarm of the old rule (CUSUM H=10) inside the labelled event."""
    return first_alarm(old_score[fac_of_asset[k["asset"]]][k["category"]], OLD_H, k["onset_unix"], k["end_unix"])


def app_alarm(k: dict) -> int | None:
    """First alarm of app/detect.py (current rules) overlapping the labelled event."""
    cands = [al for (a, c, on), al in baseline.items() if a == k["asset"] and c == k["category"] and on < k["end_unix"] and al >= k["onset_unix"] - 6 * HOUR]
    return min(cands) if cands else None


systems = sorted(set(sys_of_fac.values()))
rows = []
for name in next(iter(scores.values())):
    cat = {"L": "pipeline_leak", "W": "pump_degradation", "U": None}[name[0]]
    fps = 0
    delays: dict[str, float | None] = {}
    for held in systems:
        calib = [fid for fid in ch if sys_of_fac[fid] != held]
        thr = max(np.nanmax(np.where(normals[fid], np.nan_to_num(scores[fid][name], nan=-np.inf), -np.inf)) for fid in calib)
        for fid in (f for f in ch if sys_of_fac[f] == held):
            al = np.nan_to_num(scores[fid][name], nan=-np.inf) > thr
            fps += episodes(al & normals[fid])
        for k in slow:
            fid = fac_of_asset[k["asset"]]
            if sys_of_fac[fid] != held or (cat and k["category"] != cat):
                continue
            t = first_alarm(scores[fid][name], thr, k["onset_unix"], k["end_unix"])
            delays[k["id"]] = None if t is None else (t - k["onset_unix"]) / 60
    rows.append((name, fps, delays))

# In-sample zero-FA thresholds (every method held to exactly zero false alarms on the whole week).
zero_fa = {}
for name in next(iter(scores.values())):
    cat = {"L": "pipeline_leak", "W": "pump_degradation", "U": None}[name[0]]
    thr = max(np.nanmax(np.where(normals[fid], np.nan_to_num(scores[fid][name], nan=-np.inf), -np.inf)) for fid in ch)
    zero_fa[name] = {}
    for k in slow:
        if cat and k["category"] != cat:
            continue
        fid = fac_of_asset[k["asset"]]
        t = first_alarm(scores[fid][name], thr, k["onset_unix"], k["end_unix"])
        zero_fa[name][k["id"]] = None if t is None else (t - k["onset_unix"]) / 60

# Where are the held-out false alarms?
print("held-out false-alarm episodes (detector, facility, time, score / threshold):")
for name in next(iter(scores.values())):
    for held in systems:
        calib = [fid for fid in ch if sys_of_fac[fid] != held]
        thr = max(np.nanmax(np.where(normals[fid], np.nan_to_num(scores[fid][name], nan=-np.inf), -np.inf)) for fid in calib)
        for fid in (f for f in ch if sys_of_fac[f] == held):
            sc = np.nan_to_num(scores[fid][name], nan=-np.inf)
            al = (sc > thr) & normals[fid]
            for i in np.flatnonzero(al[1:] & ~al[:-1]) + 1 if al.any() else []:
                print(f"  {name:34} {fid:15} {pd.Timestamp(ts[i], unit='s')}  {sc[i]:.2f} / {thr:.2f}")

print("\nIn-sample, zero false alarms for every method (median delay, minutes):")
for name, d in zero_fa.items():
    got = [v for v in d.values() if v is not None]
    print(f"  {name:34} median {np.median(got) if got else float('nan'):6.0f}   misses {sum(v is None for v in d.values())}   " + " ".join(f"{k}:{'miss' if v is None else int(v)}" for k, v in d.items()))

print("\nDelay after true onset (minutes), thresholds calibrated leave-one-system-out at zero false alarms.")
print("'FA' = false-alarm episodes on held-out normal data (whole week, 15 facilities).")
for cat, prefix in (("pipeline_leak", "L"), ("pump_degradation", "W")):
    evs = [k for k in slow if k["category"] == cat]
    hdr = f"{'detector':34} {'FA':>3} " + " ".join(f"{k['id']:>9}" for k in evs) + "   median  Δ vs old"
    print(f"\n{cat}\n{hdr}")
    base = {k["id"]: (None if (b := baseline_alarm(k)) is None else (b - k["onset_unix"]) / 60) for k in evs}
    print(f"{'old detector (CUSUM H=10)':34} {'0':>3} " + " ".join(f"{base[k['id']]:>9.0f}" for k in evs) + f"   {np.median(list(base.values())):>6.0f}")
    for name, fps, delays in rows:
        if name[0] not in (prefix, "U"):
            continue
        ds_ = [delays.get(k["id"]) for k in evs]
        cells = " ".join(f"{'miss' if d is None else f'{d:.0f}':>9}" for d in ds_)
        got = [d for d in ds_ if d is not None]
        gains = [base[k["id"]] - d for k, d in zip(evs, ds_) if d is not None]
        med_s = f"{np.median(got):>6.0f}" if got else "     -"
        gain_s = f"  {np.median(gains):+.0f} (min {min(gains):+.0f})" if gains else ""
        print(f"{name:34} {fps:>3} {cells}   {med_s}{gain_s}")

# Pump failures: lead time given by an earlier wear alarm on the same pump.
print("\npump_failure: precursor = an ongoing 'pump wearing out' alarm on the same pump before the fault")
active = {(e.asset_id, e.onset_unix): e.end_unix for e in app_events if e.category == "pump_degradation"}
for k in (k for k in keys if k["category"] == "pump_failure"):
    prev = [al for (a, c, on), al in baseline.items() if a == k["asset"] and c == "pump_degradation" and al <= k["onset_unix"]
            and (active.get((a, on)) is None or active[(a, on)] >= k["onset_unix"])]
    lead = (k["onset_unix"] - max(prev)) / HOUR if prev else None
    print(f"  {k['id']:9} {k['asset']:10} " + (f"wear alarm {lead:.1f} h before the fault" if lead else "no precursor (fault detected at onset, 0 min)"))
