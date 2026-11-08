"""Step 1: event-aligned profiles. Does any sensor move BEFORE the labelled onset?"""
import numpy as np
import pandas as pd
from features import load

ds, frames, keys = load()
by_fac = {fr.fac.id: fr for fr in frames}
cols = ["r_press", "r_loss", "r_eff", "r_dis", "r_press_off", "r_dis_off", "r_recv_off", "r_tank", "dp"]
windows = [(-360, -120), (-120, -30), (-30, -5), (0, 0), (5, 30), (30, 120)]  # minutes vs onset

for cat in ["pipeline_leak", "pump_degradation", "pump_failure"]:
    print(f"\n=== {cat}: mean residual by window (pump-on cols use running rows; *_off cols use pump-off rows)")
    rows = []
    for e in (k for k in keys if k["category"] == cat):
        df = by_fac[e["facility"]].df
        t = (df.index.to_numpy() - e["onset_unix"]) // 60
        row = {"id": e["id"]}
        for c in cols:
            mask_state = df["running"] if not c.endswith("_off") else (~df["running"] & ~df["fault"])
            if c == "r_tank":
                mask_state = pd.Series(True, index=df.index)
            for a, b in windows:
                m = (t >= a) & (t <= b) & mask_state.to_numpy()
                row[(c, f"{a}..{b}")] = df[c].to_numpy()[m].mean() if m.any() else np.nan
        rows.append(row)
    r = pd.DataFrame(rows).set_index("id")
    r.columns = pd.MultiIndex.from_tuples(r.columns)
    with pd.option_context("display.width", 250, "display.max_columns", 80, "display.float_format", "{:.3f}".format):
        for c in cols:
            print(f"-- {c}")
            print(r[c].to_string())
