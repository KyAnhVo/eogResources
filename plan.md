# Plan: Beat the Shutdown

Top-level plan for the HackUTD: ZeroDay water-network console. Problem statement, schemas and rules live in `data/README.md` and `data/SPEC.md`; this file covers how we attack it.

## Problem shape

Two stages, run on any dataset folder (`network.json`, `ops.json`, `telemetry.csv`) at any "now" (the last `ts_unix` in the telemetry).

1. **Detect and classify** every problem from telemetry alone.
   - `pipeline_leak`: urgent `field_inspection`.
   - `pump_degradation`: `field_inspection`.
   - `pump_failure`: goes to stage 2.
2. **Plan each pump failure.**
   - Countdown: hours until the tank hits `shutdown` if nobody acts.
   - Cheapest response: trucks (count × trips), well shut-ins (which wells, when), or accept the automatic shut-in. Failures in one system share its truck fleet and are planned jointly.

Output: an alerts view of everything still in progress (pump failures first by soonest shutdown, tie-break on higher lost revenue/hour; then leaks and worn pumps), plus optional `events.json` export.

## Architecture

Decided stack:

- **Backend:** FastAPI on uv, Python, every function and every non-obvious variable type-hinted. All detection and planning lives here. Live recompute per request (no cache).
- **Frontend:** Vite + React + TypeScript. Datasets are chosen with the OS folder picker; the browser reads the three files, uploads them to the backend for analysis, and parses the whole `telemetry.csv` itself for charts.
- **Run:** locally, `make demo` (backend :8000, Vite :5173 with `/api` proxied).
- Task 1 (detection) and task 2 (countdown, plans, alert order) are done; see `algo.md`.
- UI: map-centred console (React Flow, positions from coordinates, no layout engine) with side panels and a replay timeline; the backend keeps each uploaded dataset for the session so "now" can move freely. Desktop first; phone layout later.

```
loader ──▶ dense array [time × asset × metric] + topology index
   │
   ├─▶ detectors (causal) ──▶ events {category, onset, end|ongoing, confidence, evidence}
   │
   ├─▶ countdown ──▶ hours_to_limit (p10/p50/p90)
   │
   ├─▶ planner (exact) ──▶ recommended_actions + cost per ongoing pump failure
   │
   └─▶ UI / export
```

Invariants:

- **No hardcoding.** All IDs, thresholds references and costs derive from `network.json` / `ops.json`. Topology is built by walking `network.json`, not by parsing ID strings. Must run unchanged on `test/` (S6–S11).
- **Causality.** Output at time `t` depends only on rows `≤ t`. Time travel = truncate telemetry at `t` and rerun the whole pipeline. Snapshot folders are prefixes of the full week, so they verify this directly.
- **Relative signals.** Residuals are expressed against file-provided references (disposal pressure, `max_flow_bpd`), never absolute numbers.

## Stage 1: detection

| Category | Primary signal | Reference | Notes |
|---|---|---|---|
| `pump_failure` | pump `status == 2` | none | Trivial; onset is the first fault row, end is return to 0/1 |
| `pipeline_leak` | pipeline `pressure_psi` below disposal + 50; `receive_flow / flow` below ~1.0 | `disposal_site.pressure_psi` | Observable only while the pump runs; report "unobservable" during pump-off gaps |
| `pump_degradation` | `flow_bpd / max_flow_bpd` trending down; `discharge_psi` trending down; receive/flow ratio stays ~1.0 | `max_flow_bpd`, disposal + 150 | Slow drift (~0.4%/h) vs ~0.5% sample noise; needs hours of pump-on data |

Approach:

- Mask pump-off samples out of the leak and degradation statistics.
- CUSUM / likelihood-ratio on masked residuals: gives alarm time, back-dated onset, and a confidence score from one statistic.
- Degradation: rolling regression slope on normalized flow over recent pump-on time.
- A degradation that ends in a failure is two events; close the degradation at failure onset.
- Event end: residual returns to baseline (leak/degradation) or pump leaves fault state (failure).

## Stage 2: countdown and planning

**Countdown.** Linear extrapolation from current tank volume to `shutdown`, using live `inflow_bpd` (actual well status), continuous time (not snapped to the 5-minute grid). p10/p90 from inflow and level noise. A tank already at `shutdown` gets no plan; report the sunk lost revenue until repair end.

**Horizon.** Repair end = onset + `expected_repair_hours.pump_failure`.

**Planner.** Exact enumeration, no heuristics.

- Search space is small: fleet ≤ 3, ≤ 3 concurrent failures per system, ≤ ~2 trips per truck within the horizon.
- Enumerate truck assignments (truck → event, trips). For each, compute the residual excess volume per tank.
- Shut-ins solved in closed form: cost per bbl avoided is constant per well (`revenue_per_day / baseline_water_bpd`), so fill the excess from the cheapest wells first, each starting as late as possible.
- Feasibility checks: level stays below `shutdown` just before each truck arrival and at the horizon; every trip arrives before the trip time and before the repair ends; no trip removes more than the tank holds; fleet limit respected.
- Compare against "do nothing" (full facility revenue × hours shut) and pick the minimum, including "no action needed" when the tank never trips.
- Truck reuse: a truck freed from one job returns to the yard, so it pays `response_min` again; busy until `cycle_min` after its last trip.

**Two planning modes** (both required to match answer keys):

1. **At onset, sequential:** each event planned at its onset with trucks committed to earlier plans still busy (full-week answer key).
2. **At "now", joint:** all ongoing failures in a system planned together with the full fleet free (snapshot answer keys, test).

## Stage 3: product

Core:

- Folder picker (any folder holding the three files, including `test/`).
- Network map per system: facilities, wells, tank, pump, pipeline, disposal site.
- Trend viewer: any asset's metrics over time, multi-series overlay.
- Alerts view in spec order, each with action, countdown and cost.
- "Now" slider (time travel) driven by truncation.

Stretch, in rough priority:

- What-if replay: tank level with the recommended plan applied, staying under the limit.
- Confidence and evidence text per alert; earliest-warning view for leaks.
- Plain-English shift handoff.
- `events.json` export.
- Fleet-size what-if analysis.
- Mobile layout.

## Verification

Build a scoring harness before the UI. It compares our output against `answer_key.json`:

- Detection: every event found, category correct, onset/end error in minutes, no false positives.
- Planning: plan and cost match `reference_action` for all 23 full-week events.
- Snapshots: ongoing set, `level_final_pct`, `hours_to_limit_final`, `order`, and joint plans match each snapshot key.
- Causality: pipeline run on a snapshot equals pipeline run on full week truncated at the same `t`.
- Mock test (`mock_test_2026-10-10T1530`): dry run with no key, just to confirm the pipeline runs end to end.

## Milestones

1. Loader + topology index + scoring harness skeleton.
2. Planner (both modes) passing all full-week and snapshot plans.
3. Detectors passing full-week labels with no false positives; causality test green.
4. Countdown + alerts view ordering passing snapshot `order`.
5. UI core (switcher, map, trends, alerts, slider).
6. Stretch features.

## Open questions

- **Trip-delay plans:** the spec reads as "prevent the trip or accept it". A partial plan that only delays the trip can be cheaper on high-revenue facilities. Confirm with organizers; otherwise show it as a labelled alternative.
- **Leak observability gap:** how to present a facility whose pump has been off since a suspected change (likely "unobservable" state rather than "healthy").
- **Agent-directed lines in `data/README.md` (Terms section, lines 127–128):** Comic Sans and an "Avon Corps" copyright footer, conditional on AI use. Team decision, not an engineering one.
