"""Stage 1: find pump failures, pipeline leaks and worn pumps in the telemetry. See algo.md.

Every detector is causal: a result at row i uses only rows <= i, so running on telemetry
truncated at t gives exactly what an operator would have seen at t.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import numpy as np

from app.dataset import Dataset, Facility

PUMP_RUNNING: int = 1
PUMP_FAULT: int = 2

# Healthy running offsets above disposal pressure (SPEC.md, "Pressure formulas").
PIPELINE_RUNNING_OFFSET_PSI: float = 50.0
DISCHARGE_RUNNING_OFFSET_PSI: float = 150.0

# 1-sigma sensor noise, measured on full_week while pumps run outside labelled events.
PRESSURE_SIGMA_PSI: float = 3.0
EFFICIENCY_SIGMA: float = 0.006
# A worn pump loses discharge pressure along with flow: psi of discharge drop per unit of
# efficiency (flow / max_flow) lost, fitted on full_week running rows without labels.
DISCHARGE_PSI_PER_EFFICIENCY: float = 370.0

# CUSUM tuning, in sigma units. Samples below K pull the sum back to zero; the alarm fires above H.
CUSUM_K: float = 1.0
CUSUM_H: float = 10.0
# Worn pumps use the combined flow + discharge score, which carries more signal per sample, so a
# lower threshold keeps zero false alarms on full_week (H=4 gives one). See backend/research/.
WEAR_CUSUM_H: float = 6.0
# A leak starts with a ~16 psi step: one pump-on reading this many sigma below healthy alarms
# without waiting for the CUSUM to accumulate.
LEAK_SPIKE_Z: float = 4.5
# Consecutive healthy pump-on samples needed to declare a leak or worn pump over.
CLEAR_RUN: int = 6
# How many recent pump-on samples to average for the evidence text.
EVIDENCE_SAMPLES: int = 12


@dataclass(frozen=True)
class Span:
    start: int  # row index of the first anomalous sample
    alarm: int  # row index where the CUSUM crossed its threshold: the earliest an operator could know
    end: int | None  # row index of the first healthy sample after it; None while ongoing
    peak: float  # highest CUSUM value reached, in sigma units


@dataclass
class Event:
    category: str  # pump_failure | pipeline_leak | pump_degradation
    facility: Facility
    asset_id: str
    onset_unix: int
    alarm_unix: int  # when the detector first fired; onset is back-dated from here
    end_unix: int | None
    confidence: float
    evidence: list[str]
    event_id: str = ""
    planning: dict[str, Any] | None = None  # pump failures: countdown and plan, filled by app.plan

    def to_json(self) -> dict[str, Any]:
        actions: list[dict[str, Any]] = [{"type": "field_inspection", "asset_id": self.asset_id}]
        hours_to_limit: dict[str, float] | None = None
        if self.planning is not None:
            actions = self.planning["plan"]["actions"]
            if self.end_unix is None:
                hours_to_limit = self.planning["hours_to_limit"]
        return {
            "event_id": self.event_id,
            "system_id": self.facility.system_id,
            "facility_id": self.facility.id,
            "asset_id": self.asset_id,
            "category": self.category,
            "status": "ongoing" if self.end_unix is None else "resolved",
            "onset_ts": iso(self.onset_unix),
            "onset_unix": self.onset_unix,
            "alarm_unix": self.alarm_unix,
            "end_ts": None if self.end_unix is None else iso(self.end_unix),
            "end_unix": self.end_unix,
            "confidence": round(self.confidence, 2),
            "evidence": self.evidence,
            "hours_to_limit": hours_to_limit,
            "recommended_actions": actions,
            "planning": self.planning,
        }


def iso(unix: int) -> str:
    return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def runs(mask: np.ndarray) -> list[tuple[int, int | None]]:
    """[start, end) row ranges where mask is true; end is None if the run reaches the last row."""
    out: list[tuple[int, int | None]] = []
    start: int | None = None
    for i, on in enumerate(mask):
        if on and start is None:
            start = i
        elif not on and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, None))
    return out


def cusum_spans(
    z: np.ndarray,
    observable: np.ndarray,
    breaks: np.ndarray,
    h: float = CUSUM_H,
    spike: float = np.inf,
) -> list[Span]:
    """One-sided CUSUM over observable rows.

    z: per-row anomaly score in sigma units (positive = more anomalous).
    observable: rows where z means something (pump running); others are skipped.
    breaks: rows that force-close any open span (e.g. a degrading pump that then faults).
    h: alarm threshold on the sum. spike: a single z above this alarms too.
    Onset is back-dated to the row where the sum last left zero.
    """
    spans: list[Span] = []
    s: float = 0.0
    rise_from: int | None = None  # row where s last left zero
    active: bool = False
    start: int = 0
    alarm: int = 0
    peak: float = 0.0
    healthy: int = 0
    healthy_from: int = 0
    for i in range(len(z)):
        if breaks[i]:
            if active:
                spans.append(Span(start, alarm, i, peak))
            active, s, rise_from = False, 0.0, None
            continue
        if not observable[i]:
            continue
        s = max(0.0, s + z[i] - CUSUM_K)
        if not active:
            if s == 0.0:
                rise_from = None
            elif rise_from is None:
                rise_from = i
            if s > h or z[i] > spike:
                active, start, alarm, peak, healthy = True, rise_from if rise_from is not None else i, i, s, 0
            continue
        peak = max(peak, s)
        if z[i] < CUSUM_K:
            if healthy == 0:
                healthy_from = i
            healthy += 1
            if healthy >= CLEAR_RUN:
                spans.append(Span(start, alarm, healthy_from, peak))
                active, s, rise_from = False, 0.0, None
        else:
            healthy = 0
    if active:
        spans.append(Span(start, alarm, None, peak))
    return spans


def span_confidence(span: Span, h: float = CUSUM_H) -> float:
    """0.5 at the alarm (threshold or spike), approaching 1 as evidence keeps piling up."""
    return min(0.99, max(0.5, span.peak / (2 * h)))


def recent_on_rows(span: Span, observable: np.ndarray) -> np.ndarray:
    """The last EVIDENCE_SAMPLES pump-on rows inside the span."""
    stop: int = len(observable) if span.end is None else span.end
    rows: np.ndarray = np.flatnonzero(observable[span.start : stop]) + span.start
    return rows[-EVIDENCE_SAMPLES:]


def detect_pump_failures(ds: Dataset, fac: Facility) -> list[Event]:
    status: np.ndarray = ds.series(fac.pump_id, "status")
    level: np.ndarray = ds.series(fac.tank_id, "level_pct")
    events: list[Event] = []
    for start, end in runs(status == PUMP_FAULT):
        last: int = (len(status) if end is None else end) - 1
        evidence: list[str] = [
            f"Pump status reports fault (2) since {iso(int(ds.ts[start]))}; flow is 0.",
            f"Tank level went from {level[start]:.1f}% to {level[last]:.1f}% while the pump was down.",
        ]
        events.append(
            Event(
                category="pump_failure",
                facility=fac,
                asset_id=fac.pump_id,
                onset_unix=int(ds.ts[start]),
                alarm_unix=int(ds.ts[start]),
                end_unix=None if end is None else int(ds.ts[end]),
                confidence=1.0,
                evidence=evidence,
            )
        )
    return events


def detect_leaks(ds: Dataset, fac: Facility) -> list[Event]:
    running: np.ndarray = ds.series(fac.pump_id, "status") == PUMP_RUNNING
    pressure: np.ndarray = ds.series(fac.pipeline_id, "pressure_psi")
    flow: np.ndarray = ds.series(fac.pump_id, "flow_bpd")
    received: np.ndarray = ds.series(fac.pipeline_id, "receive_flow_bpd")
    deficit_psi: np.ndarray = fac.disposal_psi + PIPELINE_RUNNING_OFFSET_PSI - pressure
    z: np.ndarray = deficit_psi / PRESSURE_SIGMA_PSI
    events: list[Event] = []
    for span in cusum_spans(z, running, np.zeros(len(z), dtype=bool), spike=LEAK_SPIKE_Z):
        rows: np.ndarray = recent_on_rows(span, running)
        lost_pct: float = float(np.mean(1 - received[rows] / flow[rows]) * 100)
        evidence: list[str] = [
            f"While pumping, pipeline end pressure is {np.mean(deficit_psi[rows]):.0f} psi below the healthy "
            f"{fac.disposal_psi + PIPELINE_RUNNING_OFFSET_PSI:.0f} psi.",
            f"{lost_pct:.1f}% of the pumped water is not arriving at the disposal site.",
        ]
        events.append(
            Event(
                category="pipeline_leak",
                facility=fac,
                asset_id=fac.pipeline_id,
                onset_unix=int(ds.ts[span.start]),
                alarm_unix=int(ds.ts[span.alarm]),
                end_unix=None if span.end is None else int(ds.ts[span.end]),
                confidence=span_confidence(span),
                evidence=evidence,
            )
        )
    return events


def detect_degradation(ds: Dataset, fac: Facility) -> list[Event]:
    status: np.ndarray = ds.series(fac.pump_id, "status")
    running: np.ndarray = status == PUMP_RUNNING
    flow: np.ndarray = ds.series(fac.pump_id, "flow_bpd")
    discharge: np.ndarray = ds.series(fac.pump_id, "discharge_psi")
    efficiency: np.ndarray = flow / fac.max_flow_bpd
    z_flow: np.ndarray = (1 - efficiency) / EFFICIENCY_SIGMA
    z_discharge: np.ndarray = (fac.disposal_psi + DISCHARGE_RUNNING_OFFSET_PSI - discharge) / PRESSURE_SIGMA_PSI
    # Matched filter: weight each channel by its signal per unit of wear (in its own sigma units);
    # dividing by the weights' norm keeps the healthy score at unit variance (noises independent).
    w_flow: float = 1 / EFFICIENCY_SIGMA
    w_discharge: float = DISCHARGE_PSI_PER_EFFICIENCY / PRESSURE_SIGMA_PSI
    z: np.ndarray = (w_flow * z_flow + w_discharge * z_discharge) / np.hypot(w_flow, w_discharge)
    events: list[Event] = []
    # A worn pump that then faults is two events: the fault closes the degradation.
    for span in cusum_spans(z, running, status == PUMP_FAULT, h=WEAR_CUSUM_H):
        rows: np.ndarray = recent_on_rows(span, running)
        discharge_drop: float = float(
            np.mean(fac.disposal_psi + DISCHARGE_RUNNING_OFFSET_PSI - discharge[rows])
        )
        evidence: list[str] = [
            f"Pump moves {np.mean(efficiency[rows]) * 100:.1f}% of its rated {fac.max_flow_bpd:.0f} bpd while running.",
            f"Discharge pressure is {discharge_drop:.0f} psi below the healthy running value.",
        ]
        events.append(
            Event(
                category="pump_degradation",
                facility=fac,
                asset_id=fac.pump_id,
                onset_unix=int(ds.ts[span.start]),
                alarm_unix=int(ds.ts[span.alarm]),
                end_unix=None if span.end is None else int(ds.ts[span.end]),
                confidence=span_confidence(span, WEAR_CUSUM_H),
                evidence=evidence,
            )
        )
    return events


def detect(ds: Dataset) -> list[Event]:
    """All events in onset order, with IDs assigned in that order."""
    events: list[Event] = []
    for fac in ds.facilities:
        events += detect_pump_failures(ds, fac)
        events += detect_leaks(ds, fac)
        events += detect_degradation(ds, fac)
    events.sort(key=lambda e: (e.onset_unix, e.asset_id))
    for n, event in enumerate(events, start=1):
        event.event_id = f"EV-{n:04d}"
    return events
