"""Shared loader: per-facility residual features on the 5-minute grid, plus the answer-key events.

Research only: reads history/full_week/answer_key.json to score detectors. The app never does.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

BACKEND: Path = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
from app.dataset import Dataset, Facility, load_dataset  # noqa: E402

DATA: Path = BACKEND.parent / "data" / "history" / "full_week"


@dataclass
class FacFrame:
    fac: Facility
    df: pd.DataFrame  # index ts_unix; residual columns + running/fault masks


def facility_frames(ds: Dataset) -> list[FacFrame]:
    out: list[FacFrame] = []
    for f in ds.facilities:
        s = lambda a, m: ds.series(a, m)
        status = s(f.pump_id, "status")
        flow = s(f.pump_id, "flow_bpd")
        recv = s(f.pipeline_id, "receive_flow_bpd")
        press = s(f.pipeline_id, "pressure_psi")
        disch = s(f.pump_id, "discharge_psi")
        level = s(f.tank_id, "level_pct")
        inflow = s(f.id, "inflow_bpd")
        dlevel = np.r_[np.nan, np.diff(level)]  # % per 5 min, ending at this row
        expected = (inflow - flow) / 24 / f.capacity_bbl * 100 / 12  # % per 5 min from the mass balance
        df = pd.DataFrame(
            {
                "running": status == 1,
                "fault": status == 2,
                "r_press": press - (f.disposal_psi + 50),  # healthy running reference
                "r_press_off": press - f.disposal_psi,  # healthy off reference
                "r_dis": disch - (f.disposal_psi + 150),
                "r_dis_off": disch - f.disposal_psi,
                "r_eff": flow / f.max_flow_bpd - 1,
                "r_loss": np.where(flow > 0, 1 - recv / np.where(flow > 0, flow, 1), np.nan),
                "r_recv_off": recv,  # should be 0 when the pump is off
                "r_tank": dlevel - expected,  # tank mass-balance residual
                "dp": disch - press,  # pump-to-disposal pressure drop
            },
            index=ds.ts,
        )
        out.append(FacFrame(f, df))
    return out


def load() -> tuple[Dataset, list[FacFrame], list[dict]]:
    ds = load_dataset("full_week", DATA)
    keys = json.loads((DATA / "answer_key.json").read_text())
    return ds, facility_frames(ds), keys
