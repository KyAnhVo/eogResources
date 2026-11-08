"""Score detection against every answer_key.json under the data dir.

    uv run python -m app.score [dataset-name ...]

The answer key is read here only; the app itself never loads it.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from app.dataset import discover_datasets, load_dataset
from app.detect import Event, detect
from app.plan import FailurePlan, Plan, Situation, alert_order, plan_failures, simulate


def overlaps(event: Event, key: dict[str, Any], now_unix: int) -> bool:
    ev_end: int = now_unix if event.end_unix is None else event.end_unix
    key_end: int = now_unix if key["end_unix"] is None else key["end_unix"]
    return event.onset_unix < key_end and key["onset_unix"] < ev_end


def minutes(a: int | None, b: int | None) -> str:
    if a is None or b is None:
        return "-" if a is None and b is None else "n/a"
    return f"{(a - b) / 60:+.0f}"


def parse_reference(text: str) -> tuple[float, tuple[int, int], dict[str, int]]:
    """Answer-key `reference_action` -> (cost, (trucks, trips per truck), {well: start_after_min})."""
    cost_match: re.Match[str] | None = re.search(r"~\$([\d,]+)", text)
    cost: float = float(cost_match.group(1).replace(",", "")) if cost_match else 0.0
    trucks_match: re.Match[str] | None = re.search(r"(\d+) trucks?, (\d+) trips?", text)
    trucks: tuple[int, int] = (int(trucks_match.group(1)), int(trucks_match.group(2))) if trucks_match else (0, 0)
    shut_ins: dict[str, int] = {w: int(m) for w, m in re.findall(r"shut in (\S+) at \+(\d+) min", text)}
    return cost, trucks, shut_ins


def score_plans(keys: list[dict[str, Any]], matches: dict[str, Event], plans: dict[str, FailurePlan], order: list[str]) -> tuple[int, int]:
    """Compare every pump-failure plan with the key; return (plans matching, plans compared)."""
    print(f"\n{'key':9} {'mode':9} {'cost Δ$':>8} {'plan':5} {'trip Δmin':>9} {'h2l Δ':>6} {'order':5}  ours | key")
    good: int = 0
    total: int = 0
    for key in keys:
        event: Event | None = matches.get(key["id"])
        if key["category"] != "pump_failure" or event is None:
            continue
        fp: FailurePlan = plans[event.event_id]
        sit: Situation = fp.situation
        plan: Plan = fp.plan
        ref_cost, ref_trucks, ref_shut = parse_reference(key["reference_action"])
        ours_shut: dict[str, int] = {s.well_id: round(s.start_h * 60) for s in plan.shut_ins}
        same_plan: bool = (
            (plan.trucks, plan.trips) == ref_trucks
            and ours_shut.keys() == ref_shut.keys()
            and all(abs(ours_shut[w] - ref_shut[w]) <= 1 for w in ref_shut)
        )
        trip_h: float | None = sit.trip_h()
        ours_trip: int | None = None if trip_h is None else sit.t0 + round(trip_h * 3600)
        h2l: str = "-"
        if "hours_to_limit_final" in key:
            h2l = f"{sit.hours_to_limit() - key['hours_to_limit_final']:+.2f}"
        order_ok: str = "-"
        if "order" in key:
            order_ok = "ok" if order.index(event.event_id) + 1 == key["order"] else f"{order.index(event.event_id) + 1}!"
        # Independent check: the minute-by-minute replay must never pass shutdown under a non-trip plan.
        peak: float = max(v for _, v in simulate(sit, plan))
        sim_ok: bool = plan.accept_trip or peak <= sit.limit_bbl + 0.5
        total += 1
        # Same trucks, trips and wells with starts within a minute: the leftover minute is level-sensor
        # noise (the key uses the simulator's exact level), so cost Δ is reported but not judged.
        good += same_plan and sim_ok
        print(
            f"{key['id']:9} {fp.mode:9} {plan.cost - ref_cost:>+8.0f} {'ok' if same_plan else 'DIFF':5} "
            f"{minutes(ours_trip, key.get('trips_at_unix')):>9} {h2l:>6} {order_ok:5}  "
            f"{fp.summary()}{'' if sim_ok else '  SIM-TRIPS'} | {key['reference_action']}"
        )
    return good, total


def score(name: str) -> tuple[int, int, int, int, int]:
    """Print per-event tables; return (matched, missed, false positives, plans ok, plans compared)."""
    folder = discover_datasets()[name]
    key_file = folder / "answer_key.json"
    keys: list[dict[str, Any]] = json.loads(key_file.read_text())
    ds = load_dataset(name, folder)
    events: list[Event] = detect(ds)
    plans: dict[str, FailurePlan] = plan_failures(ds, events)
    matches: dict[str, Event] = {}
    used: set[str] = set()
    missed: int = 0
    print(f"\n== {name}  (now {ds.now_unix})")
    print(f"{'key':9} {'category':17} {'asset':15} {'status':9} {'onset Δmin':>10} {'end Δmin':>9} {'conf':>5}")
    for key in keys:
        match: Event | None = next(
            (
                e
                for e in events
                if e.event_id not in used
                and e.asset_id == key["asset"]
                and e.category == key["category"]
                and overlaps(e, key, ds.now_unix)
            ),
            None,
        )
        if match is None:
            missed += 1
            print(f"{key['id']:9} {key['category']:17} {key['asset']:15} MISSED")
            continue
        used.add(match.event_id)
        matches[key["id"]] = match
        status_ok: bool = (match.end_unix is None) == (key["status"] == "ongoing")
        status: str = ("ongoing" if match.end_unix is None else "resolved") + ("" if status_ok else "!")
        print(
            f"{key['id']:9} {key['category']:17} {key['asset']:15} {status:9} "
            f"{minutes(match.onset_unix, key['onset_unix']):>10} {minutes(match.end_unix, key['end_unix']):>9} "
            f"{match.confidence:>5.2f}"
        )
    false_pos: list[Event] = [e for e in events if e.event_id not in used]
    for e in false_pos:
        print(f"FALSE POS {e.category:17} {e.asset_id:15} onset {e.onset_unix} end {e.end_unix}")
    plans_ok, plans_total = score_plans(keys, matches, plans, alert_order(events, plans))
    return len(keys) - missed, missed, len(false_pos), plans_ok, plans_total


def main(argv: list[str]) -> None:
    names: list[str] = argv or [n for n, p in discover_datasets().items() if (p / "answer_key.json").is_file()]
    totals: list[tuple[int, int, int, int, int]] = [score(n) for n in names]
    print(
        f"\nTOTAL matched {sum(t[0] for t in totals)}  missed {sum(t[1] for t in totals)}  "
        f"false positives {sum(t[2] for t in totals)}  plans matching key {sum(t[3] for t in totals)}/{sum(t[4] for t in totals)}"
    )


if __name__ == "__main__":
    main(sys.argv[1:])
