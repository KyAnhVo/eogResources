"""Worn-pump verification research (numbers quoted in app/verify.py).

Run from backend/:  uv run python research/verify_wear.py
For each worn pump in history/full_week: linear fit of efficiency over the whole span, the before/after
and trend z-scores 2-6 h after the alarm, and what happened at the end (fault or repair); then the same
scores over healthy windows, to set thresholds with no false verifications.
"""
import json
import sys

import numpy as np

sys.path.insert(0, ".")
from app.dataset import discover_datasets, load_dataset
from app.detect import detect, PUMP_RUNNING
folder = discover_datasets()["history/full_week"]
ds = load_dataset("full_week", folder); ev = detect(ds)
key = json.loads((folder/"answer_key.json").read_text()); key = key["events"] if isinstance(key, dict) else key
for k in key:
    if k["category"] in ("pump_degradation","pump_failure"): print(k["id"], k["asset"], k["category"], k["onset"], k.get("end"), k.get("reference_action"))
print()
def z_after(eff, dis, run, a, hours):
    b=slice(max(0,a-24),a); f=slice(a,min(len(eff),a+hours*12)); rb,rf=run[b],run[f]
    if rb.sum()<3 or rf.sum()<3: return None
    se=np.sqrt(1/rb.sum()+1/rf.sum())
    return ((eff[f][rf].mean()-eff[b][rb].mean())/0.0058/se + (dis[f][rf].mean()-dis[b][rb].mean())/2.99/se)/np.sqrt(2)
def slope_z(eff, run, a, hours):
    f=np.arange(a,min(len(eff),a+hours*12)); f=f[run[f]]
    if len(f)<6: return None, None
    t=(f-a)*5/60; s,_=np.polyfit(t,eff[f],1)
    se=0.0058/np.sqrt(((t-t.mean())**2).sum()); return s, s/se
null={h:[] for h in (2,3,4,6)}; nulls={h:[] for h in (2,3,4,6)}
for fac in ds.facilities:
    st=ds.series(fac.pump_id,"status"); run=st==PUMP_RUNNING
    eff=ds.series(fac.pump_id,"flow_bpd")/fac.max_flow_bpd; dis=ds.series(fac.pump_id,"discharge_psi")-fac.disposal_psi-150
    bad=np.zeros(len(st),bool)
    for e in ev:
        if e.facility.id!=fac.id: continue
        lo=ds.row(e.onset_unix)-80; hi=len(st) if e.end_unix is None else ds.row(e.end_unix)+80; bad[max(0,lo):hi]=True
    for a in range(24,len(st)-72,3):
        if bad[a-24:a+72].any(): continue
        for h in null:
            z=z_after(eff,dis,run,a,h); s,sz=slope_z(eff,run,a,h)
            if z is not None: null[h].append(z)
            if sz is not None: nulls[h].append(sz)
    for e in ev:
        if e.category!="pump_degradation" or e.asset_id!=fac.pump_id: continue
        a=ds.row(e.alarm_unix); stop=len(st) if e.end_unix is None else ds.row(e.end_unix)
        rows=np.flatnonzero(run[a:stop])+a; t=(rows-a)*5/60
        s_all,i_all=np.polyfit(t,eff[rows],1); resid=eff[rows]-(s_all*t+i_all)
        print(f"{e.asset_id}: whole-span linear fit eff = {i_all:.3f} {s_all*100:+.3f}%/h, resid sd {resid.std():.4f} | " +
              " ".join(f"{h}h: diff z {z_after(eff,dis,run,a,h):+.1f} slope {slope_z(eff,run,a,h)[0]*100:+.2f}%/h z {slope_z(eff,run,a,h)[1]:+.1f}" for h in (2,3,4,6)))
        # wells/tank: after wear end, what happened (pump status at end row)
        if e.end_unix: print(f"     at end: status={st[stop]:.0f} eff_last={eff[rows[-6:]].mean():.3f}; next hour status set={set(st[stop:stop+12].astype(int))} eff={np.nanmean(np.where(run[stop:stop+24],eff[stop:stop+24],np.nan)):.3f}")
print()
for h in null:
    n=np.array(null[h]); ns=np.array(nulls[h])
    print(f"{h}h: healthy diff-z min {n.min():+.2f} p0.1 {np.percentile(n,0.1):+.2f} | healthy slope-z min {ns.min():+.2f} p0.1 {np.percentile(ns,0.1):+.2f} (n={len(n)})")
