"""What-if: the same telemetry, but every leak and worn pump is fixed the moment it is first flagged.
See algo.md, "What-if: fix at first flag".

- The fix happens at `alarm_unix` (the "suspected" stage) and costs nothing: ops.json prices no repair.
- Nothing looks ahead. The decision uses only what the detectors knew at the alarm, and the
  detectors are causal, so the same alarm fires on telemetry truncated at any later "now".
- One modelling assumption, about consequences only: a pump fault that ends a wear span (same pump,
  fault at the row the wear closed, wear flagged before the fault) was caused by that wear, so fixing
  the wear first means the fault never happens. Faults with no wear before them happen as recorded.
- The remaining failures are re-planned with the same rules, so trucks a prevented failure would have
  tied up are free for later ones.
- Readings are not rewritten: leaked water avoided is measured from the recorded flows.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from app.dataset import Dataset
from app.detect import Event, iso
from app.plan import FailurePlan, alert_order, plan_failures

FIXABLE: tuple[str, ...] = ("pump_degradation", "pipeline_leak")


@dataclass
class EarlyFix:
    events: list[Event]  # the what-if's events: fixable ones end at their alarm, prevented failures are gone
    plans: dict[str, FailurePlan]  # re-planned failures, by event_id
    prevented: dict[str, tuple[Event, Event]]  # failure event_id -> (failure, the wear whose fix prevented it)
    leak_bbl_saved: dict[str, float]  # leak event_id -> bbl that would have stayed in the pipeline

    def to_json(self, recorded: dict[str, FailurePlan]) -> dict[str, Any]:
        """`recorded`: the plans for the telemetry as recorded, for the cost comparison."""
        return {
            "alert_order": alert_order(self.events, self.plans),
            "events": [e.to_json() for e in self.events],
            "prevented": [
                {
                    "failure_id": failure.event_id,
                    "asset_id": failure.asset_id,
                    "wear_id": wear.event_id,
                    "fixed_unix": wear.alarm_unix,
                    "failure_unix": failure.onset_unix,
                    "lead_hours": round((failure.onset_unix - wear.alarm_unix) / 3600, 2),
                    "cost_avoided": round(recorded[failure.event_id].plan.cost, 2),
                }
                for failure, wear in self.prevented.values()
            ],
            "leaks": [{"event_id": k, "bbl_saved": round(v, 1)} for k, v in self.leak_bbl_saved.items()],
            "cost_recorded": round(sum(p.plan.cost for p in recorded.values()), 2),
            "cost_early_fix": round(sum(p.plan.cost for p in self.plans.values()), 2),
        }


def leaked_bbl(ds: Dataset, leak: Event, from_unix: int) -> float:
    """Pumped water that didn't reach the disposal site between `from_unix` and the leak's end (or now)."""
    fac = leak.facility
    lo: int = ds.row(from_unix)
    hi: int = len(ds.ts) if leak.end_unix is None else ds.row(leak.end_unix)
    lost_bpd = ds.series(fac.pump_id, "flow_bpd")[lo:hi] - ds.series(fac.pipeline_id, "receive_flow_bpd")[lo:hi]
    step_days: float = float(ds.ts[1] - ds.ts[0]) / 86400 if len(ds.ts) > 1 else 0.0
    return max(0.0, float(lost_bpd.sum()) * step_days)


def early_fix(ds: Dataset, events: list[Event]) -> EarlyFix:
    """`events`: detect(ds). Returns copies; the inputs are not modified."""
    wears: list[Event] = [e for e in events if e.category == "pump_degradation"]
    prevented: dict[str, tuple[Event, Event]] = {}
    for failure in (e for e in events if e.category == "pump_failure"):
        for wear in wears:
            if wear.asset_id == failure.asset_id and wear.end_unix == failure.onset_unix and wear.alarm_unix < failure.onset_unix:
                prevented[failure.event_id] = (failure, wear)

    out: list[Event] = []
    leak_bbl_saved: dict[str, float] = {}
    for e in events:
        if e.event_id in prevented:
            continue
        if e.category not in FIXABLE:
            out.append(replace(e, planning=None))
            continue
        if e.category == "pipeline_leak":
            leak_bbl_saved[e.event_id] = leaked_bbl(ds, e, e.alarm_unix)
        out.append(
            replace(
                e,
                end_unix=e.alarm_unix,
                planning=None,
                evidence=[f"What-if: fixed when first flagged at {iso(e.alarm_unix)}.", *e.evidence],
            )
        )
    return EarlyFix(events=out, plans=plan_failures(ds, out), prevented=prevented, leak_bbl_saved=leak_bbl_saved)
