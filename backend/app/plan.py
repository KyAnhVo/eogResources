"""Stage 2: countdown and cheapest response for every pump failure. See algo.md, "Task 2".

Rules (SPEC.md "Plans", plus the defaults chosen for task 2):
- Trucks in a plan are all called at plan start, arrive together `response_min` later, then every
  `cycle_min`; every truck in a plan makes the same number of trips.
- A truck is busy until `cycle_min` after its last trip; no truck is redirected mid-plan.
- Shut-ins start at any minute and last until the repair ends.
- A plan either keeps the tank at or below `shutdown` until the repair ends, or accepts the trip
  with no trucks or shut-ins at all. Plans that merely delay the trip are not considered.
- Ties go to fewer trucks, then fewer trips, then fewer shut-in wells.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from app.dataset import Dataset, Facility, Well
from app.detect import Event, iso

HOUR: int = 3600
# A well's live rate is replaced by its file baseline when they agree this closely (live readings
# carry ~0.7% noise around the baseline; the baseline gives exact timings).
BASELINE_TOLERANCE: float = 0.03
RATE_SAMPLES: int = 12  # last hour of readings used for a well's live rate
LEVEL_FIT_SAMPLES: int = 12  # last hour of level readings fitted to estimate the level "now"
EPS_BBL: float = 1e-6


@dataclass(frozen=True)
class WellRate:
    id: str
    water_bph: float  # bbl/hour of water this well adds to the tank
    revenue_ph: float  # $/hour of oil and gas it sells while producing

    @property
    def cost_per_bbl(self) -> float:
        return self.revenue_ph / self.water_bph


@dataclass(frozen=True)
class Situation:
    """One failing tank at the moment a plan starts. Times are hours after `t0`."""

    event_id: str
    facility: Facility
    t0: int  # unix seconds the plan starts (onset, or "now" for an ongoing event)
    horizon_h: float  # hours from t0 until the repair ends
    volume_bbl: float
    limit_bbl: float
    inflow_bph: float
    wells: tuple[WellRate, ...]  # producing wells at t0
    total_revenue_ph: float  # every well's revenue: the cost rate of an automatic shut-in
    tripped: bool  # already at shutdown at t0; wells are off until the repair
    capacity_per_trip: float
    cost_per_trip: float
    response_h: float
    cycle_h: float

    @property
    def repair_end(self) -> int:
        return self.t0 + round(self.horizon_h * HOUR)

    def trip_h(self) -> float | None:
        """Hours until shutdown if nothing is done; None if it never trips before the repair."""
        if self.tripped:
            return 0.0
        hours: float = (self.limit_bbl - self.volume_bbl) / self.inflow_bph if self.inflow_bph > 0 else math.inf
        return hours if hours < self.horizon_h else None

    def hours_to_limit(self) -> float:
        """Countdown to shutdown if nothing changes, ignoring the repair."""
        if self.tripped:
            return 0.0
        return max(0.0, (self.limit_bbl - self.volume_bbl) / self.inflow_bph) if self.inflow_bph > 0 else math.inf


@dataclass(frozen=True)
class ShutIn:
    well_id: str
    start_h: float  # hours after t0, whole minutes
    cost: float


@dataclass(frozen=True)
class Plan:
    trucks: int
    trips: int  # per truck
    arrivals_h: tuple[float, ...]
    shut_ins: tuple[ShutIn, ...]
    accept_trip: bool  # do nothing and let the tank trip
    cost: float

    def rank(self) -> tuple[float, int, int, int]:
        return (round(self.cost, 2), self.trucks, self.trucks * self.trips, len(self.shut_ins))


@dataclass
class FailurePlan:
    """Everything the UI and events.json need for one pump failure."""

    situation: Situation
    mode: str  # "at_onset" (resolved events) or "joint_now" (ongoing events)
    trucks_available: int
    fleet_size: int
    plan: Plan
    alternatives: list[tuple[str, Plan]]
    shares_with: list[str] = field(default_factory=list)

    def summary(self) -> str:
        return describe(self.situation, self.plan)

    def to_json(self) -> dict[str, Any]:
        sit: Situation = self.situation
        trip: float | None = sit.trip_h()
        return {
            "plan_mode": self.mode,
            "planned_at_unix": sit.t0,
            "level_pct": round(sit.volume_bbl / sit.facility.capacity_bbl * 100, 1),
            "hours_to_limit": {"p50": round(sit.hours_to_limit(), 2)},
            "trips_at_unix": None if trip is None else sit.t0 + round(trip * HOUR),
            "repair_end_unix": sit.repair_end,
            "tripped": sit.tripped,
            "lost_revenue_per_hour": round(sit.total_revenue_ph, 2),
            "trucks_available": self.trucks_available,
            "fleet_size": self.fleet_size,
            "shares_with": self.shares_with,
            "plan": plan_json(sit, self.plan),
            "alternatives": [{"label": label, **plan_json(sit, p)} for label, p in self.alternatives],
        }


def plan_json(sit: Situation, plan: Plan) -> dict[str, Any]:
    return {
        "summary": describe(sit, plan),
        "est_cost": round(plan.cost, 2),
        "trucks": plan.trucks,
        "trips_per_truck": plan.trips,
        "truck_arrivals_unix": [sit.t0 + round(a * HOUR) for a in plan.arrivals_h],
        "shut_ins": [
            {"well_id": s.well_id, "start_after_min": round(s.start_h * 60), "start_unix": sit.t0 + round(s.start_h * HOUR), "cost": round(s.cost, 2)}
            for s in plan.shut_ins
        ],
        "accept_trip": plan.accept_trip,
        "actions": actions(sit, plan),
    }


def actions(sit: Situation, plan: Plan) -> list[dict[str, Any]]:
    """SPEC.md events.json `recommended_actions`."""
    out: list[dict[str, Any]] = []
    if plan.trucks:
        out.append({"type": "dispatch_truck", "facility_id": sit.facility.id, "trucks": plan.trucks, "trips_per_truck": plan.trips})
    for s in plan.shut_ins:
        out.append({"type": "shut_in_wells", "wells": [s.well_id], "start_after_min": round(s.start_h * 60)})
    return out or [{"type": "none"}]


def describe(sit: Situation, plan: Plan) -> str:
    if sit.tripped:
        return f"Already shut in; wells restart when the repair ends (~${plan.cost:,.0f} lost)"
    if plan.accept_trip:
        trip: float | None = sit.trip_h()
        if trip is None:
            return "No action: the tank stays under shutdown until the repair"
        return f"Do nothing: trips after {trip:.1f} h, shut until the repair (~${plan.cost:,.0f})"
    def clock(hours: float) -> str:
        return iso(sit.t0 + round(hours * HOUR))[11:16]

    parts: list[str] = []
    if plan.trucks:
        trips: str = f"{plan.trips} trip{'s' if plan.trips > 1 else ''}"
        arrive: str = ", ".join(clock(a) for a in plan.arrivals_h)
        parts.append(
            f"{plan.trucks} truck{'s' if plan.trucks > 1 else ''}, {trips}{' each' if plan.trucks > 1 else ''} (arriving {arrive})"
        )
    parts += [f"shut in {s.well_id} at {clock(s.start_h)} (+{round(s.start_h * 60)} min)" for s in plan.shut_ins]
    text: str = " + ".join(parts) or "No action needed"
    return f"{text[0].upper()}{text[1:]} (~${plan.cost:,.0f})"


# ---------------------------------------------------------------- building situations


def well_rate(ds: Dataset, well: Well, row: int, revenue_ph: float) -> WellRate:
    readings: np.ndarray = ds.series(well.id, "water_bpd")[max(0, row - RATE_SAMPLES + 1) : row + 1]
    live: float = float(np.mean(readings)) if len(readings) else well.baseline_water_bpd
    agrees: bool = abs(live / well.baseline_water_bpd - 1) < BASELINE_TOLERANCE
    return WellRate(id=well.id, water_bph=(well.baseline_water_bpd if agrees else live) / 24, revenue_ph=revenue_ph)


def level_at(ds: Dataset, fac: Facility, row: int, onset_row: int) -> float:
    """Tank level % at `row`, de-noised with a straight-line fit over the last hour of readings
    that share one regime, using no readings after `row`:
    - after onset the pump is down and the level rises linearly, so fit the rows since onset;
    - at onset, fit the rows since the pump last switched (also linear) up to the onset row,
      which sits on both lines."""
    level: np.ndarray = ds.series(fac.tank_id, "level_pct")
    if row > onset_row:
        start: int = max(onset_row, row - LEVEL_FIT_SAMPLES + 1)
    else:
        status: np.ndarray = ds.series(fac.pump_id, "status")
        start = row - 1
        while start > max(0, row - LEVEL_FIT_SAMPLES + 1) and status[start - 1] == status[row - 1]:
            start -= 1
    if row - start < 2:
        return float(level[row])
    x: np.ndarray = ds.ts[start : row + 1].astype(float)
    slope, intercept = np.polyfit(x, level[start : row + 1], 1)
    return float(slope * ds.ts[row] + intercept)


def build_situation(ds: Dataset, event: Event, t0: int) -> Situation:
    fac: Facility = event.facility
    ops: dict[str, Any] = ds.ops
    prices: dict[str, float] = ops["prices"]
    trucking: dict[str, Any] = ops["emergency_trucking"]
    terms: dict[str, Any] = ops["systems"][fac.system_id]["facilities"][fac.id]
    shutdown_pct: float = float(ds.network["defaults"]["tank_limits_pct"]["shutdown"])
    repair_end: int = event.onset_unix + round(float(ops["expected_repair_hours"]["pump_failure"]) * HOUR)
    row: int = ds.row(t0)

    def revenue(w: Well) -> float:
        return (w.oil_bpd * prices["oil_per_bbl"] + w.gas_mcfd * prices["gas_per_mcf"]) / 24

    producing: tuple[WellRate, ...] = tuple(
        well_rate(ds, w, row, revenue(w)) for w in fac.wells if ds.series(w.id, "status")[row] == 1
    )
    level_pct: float = level_at(ds, fac, row, ds.row(event.onset_unix))
    tripped: bool = not producing and level_pct >= shutdown_pct - 0.5
    return Situation(
        event_id=event.event_id,
        facility=fac,
        t0=t0,
        horizon_h=(repair_end - t0) / HOUR,
        volume_bbl=min(level_pct, shutdown_pct) / 100 * fac.capacity_bbl,
        limit_bbl=shutdown_pct / 100 * fac.capacity_bbl,
        inflow_bph=sum(w.water_bph for w in producing),
        wells=producing,
        total_revenue_ph=sum(revenue(w) for w in fac.wells),
        tripped=tripped,
        capacity_per_trip=float(trucking["truck_capacity_bbl"]),
        cost_per_trip=float(trucking["cost_per_trip"]),
        response_h=float(terms["response_min"]) / 60,
        cycle_h=float(terms["cycle_min"]) / 60,
    )


# ---------------------------------------------------------------- single-tank planning


def do_nothing(sit: Situation) -> Plan:
    trip: float | None = sit.trip_h()
    cost: float = 0.0 if trip is None else sit.total_revenue_ph * (sit.horizon_h - trip)
    return Plan(trucks=0, trips=0, arrivals_h=(), shut_ins=(), accept_trip=True, cost=cost)


def plan_with_trucks(sit: Situation, trucks: int, trips: int, allow_shut_ins: bool = True) -> Plan | None:
    """Cheapest plan using exactly `trucks` × `trips`, adding shut-ins if needed; None if infeasible."""
    arrivals: tuple[float, ...] = tuple(sit.response_h + i * sit.cycle_h for i in range(trips)) if trucks else ()
    if any(a >= sit.horizon_h for a in arrivals):
        return None
    removed: float = trucks * sit.capacity_per_trip

    # Check points: just before each arrival (water removed by earlier arrivals only) and the repair end.
    checkpoints: list[float] = [*arrivals, sit.horizon_h]
    excess: list[float] = [
        sit.volume_bbl + sit.inflow_bph * c - removed * sum(1 for a in arrivals if a < c) - sit.limit_bbl
        for c in checkpoints
    ]
    shut_ins: list[ShutIn] = []
    # Cheapest barrels first: turning a well off one hour earlier costs its revenue/hour and keeps
    # out its water/hour at every later check point, so the lowest $/bbl well goes first and as late as possible.
    for well in sorted(sit.wells, key=lambda w: w.cost_per_bbl):
        if all(e <= EPS_BBL for e in excess):
            break
        if not allow_shut_ins:
            return None
        latest: float = min(c - e / well.water_bph for c, e in zip(checkpoints, excess) if e > EPS_BBL)
        start: float = max(0.0, math.floor(latest * 60 + 1e-9) / 60)
        shut_ins.append(ShutIn(well.id, start, well.revenue_ph * (sit.horizon_h - start)))
        excess = [e - well.water_bph * max(0.0, c - start) for c, e in zip(checkpoints, excess)]
    if any(e > EPS_BBL for e in excess):
        return None

    # A trip can't take more water than is in the tank when it arrives.
    for a in arrivals:
        if volume_at(sit, a, arrivals, removed, shut_ins) < removed - EPS_BBL:
            return None
    cost: float = trucks * trips * sit.cost_per_trip + sum(s.cost for s in shut_ins)
    return Plan(trucks, trips, arrivals, tuple(shut_ins), accept_trip=False, cost=cost)


def volume_at(sit: Situation, t: float, arrivals: tuple[float, ...], removed: float, shut_ins: list[ShutIn] | tuple[ShutIn, ...]) -> float:
    """Tank volume just before time t (hours after t0)."""
    rates: dict[str, float] = {w.id: w.water_bph for w in sit.wells}
    avoided: float = sum(rates[s.well_id] * max(0.0, t - s.start_h) for s in shut_ins)
    return sit.volume_bbl + sit.inflow_bph * t - avoided - removed * sum(1 for a in arrivals if a < t)


def max_trips(sit: Situation) -> int:
    if sit.response_h >= sit.horizon_h:
        return 0
    return 1 + int((sit.horizon_h - sit.response_h - 1e-9) // sit.cycle_h)


def best_by_trucks(sit: Situation, available: int) -> dict[int, Plan]:
    """Cheapest plan for each exact truck count 0..available (0 = shut-ins only, or do nothing)."""
    if sit.tripped or sit.trip_h() is None:
        return {0: do_nothing(sit)}
    best: dict[int, Plan] = {}
    for trucks in range(0, available + 1):
        candidates: list[Plan] = [do_nothing(sit)] if trucks == 0 else []
        for trips in [0] if trucks == 0 else range(1, max_trips(sit) + 1):
            plan: Plan | None = plan_with_trucks(sit, trucks, trips)
            if plan is not None:
                candidates.append(plan)
        if candidates:
            best[trucks] = min(candidates, key=Plan.rank)
    return best


def alternatives(sit: Situation, available: int, chosen: Plan) -> list[tuple[str, Plan]]:
    """Do nothing / shut-ins only / trucks only / recommended, for the operator to compare."""
    if sit.tripped or sit.trip_h() is None:
        return []
    out: list[tuple[str, Plan]] = [("Do nothing", do_nothing(sit))]
    shut_only: Plan | None = plan_with_trucks(sit, 0, 0)
    if shut_only is not None:
        out.append(("Shut in wells only", shut_only))
    trucks_only: list[Plan] = [
        p
        for k in range(1, available + 1)
        for n in range(1, max_trips(sit) + 1)
        if (p := plan_with_trucks(sit, k, n, allow_shut_ins=False)) is not None
    ]
    if trucks_only:
        out.append(("Trucks only", min(trucks_only, key=Plan.rank)))
    if all(p != chosen for _, p in out):
        out.append(("Trucks + shut-in", chosen))
    return out


# ---------------------------------------------------------------- whole dataset


def joint_plan(situations: list[Situation], fleet: int) -> list[tuple[Plan, int]]:
    """Cheapest combined plan for tanks sharing one fleet: (plan, trucks left for the others) per tank."""
    options: list[dict[int, Plan]] = [best_by_trucks(s, fleet) for s in situations]
    best: tuple[tuple[float, int, int, int], tuple[int, ...]] | None = None
    for combo in itertools.product(*(sorted(o) for o in options)):
        if sum(combo) > fleet:
            continue
        plans: list[Plan] = [o[k] for o, k in zip(options, combo)]
        key: tuple[float, int, int, int] = (
            round(sum(p.cost for p in plans), 2),
            sum(p.trucks for p in plans),
            sum(p.trucks * p.trips for p in plans),
            sum(len(p.shut_ins) for p in plans),
        )
        if best is None or key < best[0]:
            best = (key, combo)
    assert best is not None  # truck count 0 is always available
    combo = best[1]
    return [(o[k], fleet - (sum(combo) - k)) for o, k in zip(options, combo)]


def plan_failures(ds: Dataset, events: list[Event]) -> dict[str, FailurePlan]:
    """Resolved failures are planned at their onset in onset order, with trucks still busy on earlier
    plans; ongoing failures are planned together from "now" with each system's whole fleet."""
    failures: list[Event] = sorted((e for e in events if e.category == "pump_failure"), key=lambda e: e.onset_unix)
    out: dict[str, FailurePlan] = {}
    busy_until: dict[str, list[int]] = {}  # system -> unix time each committed truck is free again

    for event in (e for e in failures if e.end_unix is not None):
        system: str = event.facility.system_id
        fleet: int = int(ds.ops["systems"][system]["emergency_fleet_size"])
        sit: Situation = build_situation(ds, event, event.onset_unix)
        busy: list[int] = [t for t in busy_until.get(system, []) if t > sit.t0]
        available: int = fleet - len(busy)
        plan: Plan = min(best_by_trucks(sit, available).values(), key=Plan.rank)
        free_at: int = sit.t0 + round((sit.response_h + plan.trips * sit.cycle_h) * HOUR)
        busy_until[system] = busy + [free_at] * plan.trucks
        out[event.event_id] = FailurePlan(sit, "at_onset", available, fleet, plan, alternatives(sit, available, plan))

    ongoing: list[Event] = [e for e in failures if e.end_unix is None]
    for system in sorted({e.facility.system_id for e in ongoing}):
        group: list[Event] = [e for e in ongoing if e.facility.system_id == system]
        fleet = int(ds.ops["systems"][system]["emergency_fleet_size"])
        situations: list[Situation] = [build_situation(ds, e, ds.now_unix) for e in group]
        for event, sit, (plan, available) in zip(group, situations, joint_plan(situations, fleet)):
            out[event.event_id] = FailurePlan(
                sit,
                "joint_now",
                available,
                fleet,
                plan,
                alternatives(sit, available, plan),
                shares_with=[e.event_id for e in group if e is not event],
            )
    return out


def alert_order(events: list[Event], plans: dict[str, FailurePlan]) -> list[str]:
    """SPEC.md alerts view: ongoing pump failures soonest-to-shutdown first (ties: higher lost
    revenue/hour), then ongoing leaks and worn pumps in onset order."""
    ongoing: list[Event] = [e for e in events if e.end_unix is None]
    failures: list[Event] = sorted(
        (e for e in ongoing if e.event_id in plans),
        key=lambda e: (plans[e.event_id].situation.hours_to_limit(), -plans[e.event_id].situation.total_revenue_ph),
    )
    others: list[Event] = [e for e in ongoing if e.event_id not in plans]
    return [e.event_id for e in failures + others]


def simulate(sit: Situation, plan: Plan) -> list[tuple[int, float]]:
    """Step the tank minute by minute with the plan applied: (unix, volume_bbl). At a truck arrival
    both the level just before and just after the pickup are listed. Independent of the closed-form
    check points above, so it double-checks them and can drive a what-if replay. An accepted trip
    holds the level at shutdown; a plan that fails to prevent one shows the overshoot instead."""
    rates: dict[str, float] = {w.id: w.water_bph for w in sit.wells}
    removed: float = plan.trucks * sit.capacity_per_trip
    arrival_min: set[int] = {round(a * 60) for a in plan.arrivals_h}
    volume: float = sit.volume_bbl
    tripped: bool = sit.tripped
    out: list[tuple[int, float]] = [(sit.t0, volume)]
    for minute in range(1, math.ceil(sit.horizon_h * 60 - 1e-9) + 1):
        hours: float = min(minute / 60, sit.horizon_h)
        if not tripped:
            shut: float = sum(rates[s.well_id] for s in plan.shut_ins if s.start_h * 60 <= minute - 1 + 1e-9)
            volume += (sit.inflow_bph - shut) * (hours - (minute - 1) / 60)
            if plan.accept_trip and volume >= sit.limit_bbl:
                tripped, volume = True, sit.limit_bbl
        out.append((sit.t0 + round(hours * HOUR), volume))
        if minute in arrival_min:
            volume -= removed
            out.append((sit.t0 + round(hours * HOUR), volume))
    return out
