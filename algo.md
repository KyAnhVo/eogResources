# Algorithms

How the app finds pump failures, pipeline leaks and worn pumps from telemetry alone (task 1), how it works out the countdown and the cheapest response to each pump failure (task 2), how the pieces fit, and how well it scores against the answer keys.

## Running it

```
make demo     # installs deps, backend on :8000, frontend on http://localhost:5173
make score    # detection and plans vs every answer_key.json under data/
```

`make demo` runs `uv sync` + `npm install`, then starts both servers in parallel; Ctrl-C stops both. The Vite dev server forwards `/api/*` to the backend, so the browser only talks to `:5173`.

## Layout

```
backend/                     FastAPI + uv, Python ≥ 3.12
  app/dataset.py             parse the 3 files into a time × series frame + facility index
  app/detect.py              the three detectors (task 1)
  app/plan.py                countdown, truck/shut-in planner, alert order, simulator (task 2)
  app/main.py                HTTP API: upload a dataset once, then ask for its state at any "now"
  app/score.py               scoring harness (reads answer keys; the app never does)
frontend/                    Vite + React + TypeScript
  src/api.ts                 types, folder → files, upload, state requests, stable event keys
  src/telemetry.ts           parse the raw CSV into one series per asset+metric; value at a time
  src/layout.ts              map positions from network.json coordinates
  src/status.ts              each facility's state at "now" (events + readings)
  src/MapView.tsx            React Flow map: tank-gauge facilities, pipes, wells, yards, truck routes
  src/SystemTabs.tsx         Overview + one tab per system, with live badges
  src/HoverCard.tsx          readings + 6 h sparkline for whatever the mouse is over
  src/Timeline.tsx           "now" slider, play/step controls, event lanes per system
  src/panels.tsx             alert list, event detail (plan, evidence, charts), facility detail
  src/LineChart.tsx          dependency-free SVG chart
  src/App.tsx                folder picker, replay state, layout of the console
Makefile                     install / demo / score / typecheck
```

## Data flow

```
OS folder picker (any folder holding the 3 files)                 frontend/src/App.tsx
        │  network.json, ops.json, telemetry.csv
        ├─────────────────────────────────────┐
        │ POST /api/datasets (once)           │ read locally in the browser
        ▼                                     ▼
parse_dataset ──▶ kept in memory, id          parseTelemetry(csv) ──▶ map gauges, hover cards, charts
        │
        │ GET /api/datasets/{id}/state?now=t  (every time "now" moves; latest wins)
        ▼
truncate(ds, t) ──▶ detect ──▶ plan_failures ──▶ events + plans as known at t ──▶ map, panels
```

- **Choosing a dataset.** "Choose folder" opens the OS folder dialog (`<input webkitdirectory>`, which works in Chrome, Edge, Firefox and Safari). The three files must sit directly in the chosen folder. Picking a parent such as `data/history/` is rejected with a message naming the missing files, rather than the app guessing which subfolder you meant. At judging, choose `test/` wherever it lives on disk. Chrome asks once to confirm "upload N files to this site". That only hands them to the page; they go no further than the local backend.
- **The backend keeps the uploaded dataset for the session.** It parses the files once, keeps the result in memory under a random id, and holds at most the 4 most recently used datasets. A restart forgets them; the UI then asks you to choose the folder again. The backend never reads paths, so it can't be pointed at arbitrary files.
- **Live recompute per "now".** Each state request cuts the telemetry at `now` and reruns detection and planning on what's left: 30–80 ms for a full week. Results at `t` therefore never use readings after `t`.
- **Now.** By default, "now" is the last `ts_unix` in the telemetry. The timeline moves it to any reading in the recording.
- **Bad input.** Invalid JSON, a CSV without the expected columns, or a `network.json` without the systems/facilities layout returns 400 with a message, which the UI shows.
- **Topology** comes only from walking `network.json`. IDs are never parsed to guess what belongs to what.

## What the readings look like

Measured on `history/full_week` over pump-running samples (pump `status == 1`), split by the answer-key label. Residuals are against the healthy values SPEC.md gives:

| Signal (pump running) | Normal | Leak | Worn pump |
|---|---|---|---|
| pipeline `pressure_psi` − (disposal + 50) | 0 ± 3 psi | −8 → −110 psi | 0 ± 3 |
| pump `flow_bpd` / `max_flow_bpd` | 1.000 ± 0.006 | 1.000 | drifts to 0.85 |
| pump `discharge_psi` − (disposal + 150) | 0 ± 3 psi | 0 | 0 → −62 psi |
| 1 − `receive_flow_bpd` / `flow_bpd` | 0 ± 0.8 % | 1 → 13 % | 0 |

Three facts drive the design:

1. **Each problem moves its own signals and leaves the others at normal.** A leak shows between the pump and the disposal site (pressure, flow lost). A worn pump shows at the pump (flow vs rating, discharge). So each problem gets its own detector on its own signal, and the two can't be confused.
2. **References come from the files.** Disposal pressure and `max_flow_bpd` are in `network.json`, so residuals work on any network (S1 sits at 1050 psi, S3 at 950). There is no learned baseline and no need for a clean warm-up period.
3. **Leaks and wear are only visible while the pump runs.** With the pump off, pipeline and discharge pressure both read disposal pressure whatever is wrong. Pumps run about two thirds of the time, so off-pump rows are skipped, not treated as healthy.

# Task 1: detection

## Detector 1: pump failure

Pump `status == 2` is a fault, reported directly by the sensor.

- Onset: the first row with status 2.
- End: the first row after it with status ≠ 2. If the fault reaches the last row, the event is `ongoing` (`end = null`).
- Confidence: 1.0.

## Detectors 2 and 3: leak and worn pump (CUSUM)

Both run the same one-sided CUSUM, just on different inputs.

**Per-row anomaly score `z`, in units of sensor noise (σ):**

| Detector | Score | σ |
|---|---|---|
| Leak | `(disposal_psi + 50 − pipeline pressure) / σ` | 3 psi |
| Worn pump | `(w_f·z_flow + w_d·z_discharge) / ‖w‖`, with `z_flow = (1 − flow / max_flow_bpd) / 0.006` and `z_discharge = (disposal_psi + 150 − discharge) / 3` | 1 (combined) |

Positive means "more anomalous". A healthy row has z ≈ N(0, 1).

The worn-pump score is a matched filter. Wear moves flow and discharge together, by about 370 psi of
discharge per unit of efficiency lost (fitted without labels). The noise on the two channels is
independent, so each channel is weighted by its signal per unit of wear, in its own σ:
`w_f = 1/0.006 ≈ 167` and `w_d = 370/3 ≈ 123`. Dividing by ‖w‖ keeps healthy rows at unit variance.
The result carries about 25% more signal per sample than flow alone.

**CUSUM** (`cusum_spans` in `detect.py`), over pump-running rows only:

```
S ← max(0, S + z − K)          K = 1σ   (slack: healthy rows drain S)
alarm when S > H               H = 10σ (leak), 6σ (worn pump)
   or z > 4.5σ                 (leak only: one reading 13.5 psi below healthy)
onset = the row where S last left 0
```

Why the extra leak rule: a leak starts with a step of about 16 psi (about 5σ), so the first pump-on
reading already stands out. The CUSUM would need 2–3 readings to pass H. The single-reading test
catches the step and the CUSUM still catches slow leaks. Both thresholds come from
`backend/research/` (see "Early detection" below).

Why CUSUM rather than a plain threshold on each row:

- **It catches slow problems.** A worn pump loses about 0.4 % of flow per hour, which is under one σ per sample. A per-row threshold would either miss it for hours or fire on noise. CUSUM adds up small, steady excesses until they are clearly more than noise.
- **It back-dates the onset.** The alarm fires after the evidence piles up, but the event's onset is reported as the row where the sum *started* rising. That gives a better onset estimate than the alarm time.
- **It's causal.** S at row i depends only on rows ≤ i.

**Closing an event.** While an event is active, it ends after `CLEAR_RUN = 6` consecutive pump-running rows (30 min of pumping) with z < K. The end time is the first of those healthy rows. An event still active at the last row is `ongoing`.

**Worn pump that then fails.** SPEC.md treats them as two events. Fault rows (status 2) are "break" rows for the degradation detector: they close any open degradation at the fault onset. That way EVENT_5's degradation ends exactly where EVENT_9's failure begins.

**Confidence** = `min(0.99, max(0.5, peak S / 2H))`: 0.5 at the moment of the alarm (threshold or single reading), rising toward 0.99 as evidence keeps accumulating. This is a heuristic, not a calibrated probability.

**Evidence text.** Averaged over the last 12 pump-running rows of the event, so an operator can read why it fired:
- Leak: pressure deficit in psi, and the percentage of pumped water not arriving.
- Worn pump: percentage of rated flow, and the discharge pressure deficit.

## Detection constants

All in `backend/app/detect.py`. None is specific to a dataset.

| Constant                       | Value  | Source                                                                     |
| ------------------------------ | ------ | -------------------------------------------------------------------------- |
| `PIPELINE_RUNNING_OFFSET_PSI`  | 50     | SPEC.md pressure formulas                                                  |
| `DISCHARGE_RUNNING_OFFSET_PSI` | 150    | SPEC.md pressure formulas                                                  |
| `PRESSURE_SIGMA_PSI`           | 3.0    | Measured noise, full_week healthy rows                                     |
| `EFFICIENCY_SIGMA`             | 0.006  | Measured noise, full_week healthy rows                                     |
| `DISCHARGE_PSI_PER_EFFICIENCY` | 370    | Unsupervised fit, full_week running rows                                   |
| `CUSUM_K`                      | 1.0 σ  | Tuning                                                                     |
| `CUSUM_H`                      | 10 σ   | Leak CUSUM threshold, tuning                                               |
| `WEAR_CUSUM_H`                 | 6 σ    | backend/research/sweep.py: 0 false alarms; H=4 gives 1                     |
| `LEAK_SPIKE_Z`                 | 4.5 σ  | backend/research/sweep.py: 0 false alarms; 4.0 to 5.0 give the same delays |
| `CLEAR_RUN`                    | 6 rows | Tuning                                                                     |

## Detection results

`make score`, against all four answer keys (full week + three snapshots):

```
TOTAL matched 72  missed 0  false positives 0
```

| Category | Onset error | End error |
|---|---|---|
| Pump failure | 0 min (all) | 0 min (all) |
| Pipeline leak | −5 to +60 min | +40 to +370 min |
| Worn pump | −155 to +145 min | 0 to +45 min |

Ongoing/resolved status matches every snapshot key except one: EVENT_17 at `snapshot_2026-10-10T0900`, explained below.

## Detection limits

- **A leak can't be confirmed over while the pump is off.** If a leak is repaired during a pump-off stretch, the data shows nothing until the pump next runs. EVENT_17 ended at 06:00, but S2_PUMP_C didn't run again until 09:30, so at the 09:00 snapshot the app still says "ongoing". The same effect causes the large leak end errors (+370 min on EVENT_16). It can't be fixed without inventing data. The UI could add an "unconfirmed, pump idle since …" state later.
- **A leak that starts while the pump is off** is dated from the first pump-running row (EVENT_1: +60 min).
- **Worn-pump onset is loose.** The drift starts at ~0 and grows, so CUSUM starts rising somewhere in the noise: −155 min (too early, noise happened to start the rise) to +145 min (late). Fitting a "flat then sloping" line over the run would tighten this.
- **The pressure offsets (+50 / +150) are placeholders per SPEC.md.** If the test network used different offsets, the leak detector's reference would be off by a constant. A fallback would be learning each pipeline's running median from the data seen so far.
- **Noise σ is measured on the history week.** If the test week's sensors were noisier, false positives would rise. Measuring σ per series (robust MAD over pump-running rows) is a cheap upgrade.

## Early detection (backend/research/)

The question: can leaks, worn pumps or failures be flagged at least 2 intervals (10 min) sooner by
combining the sensors around a facility? Run from `backend/`:

```
uv run python research/profiles.py                       # does anything move before onset?
uv run --with scikit-learn python research/evaluate.py   # method comparison, held-out calibration
uv run --with scikit-learn python research/sweep.py      # threshold trade-offs + check of detect.py
```

These scripts read `full_week/answer_key.json` to score detectors. The app never reads it.
Delays are minutes from the true onset to the alarm. A false alarm (FA) is an alarm episode on
pump-on rows away from any labelled event: about 1,218 facility-hours.

**1. Nothing moves before onset** (`profiles.py`). All 23 events were aligned on their onset, and
each residual was averaged from 6 h before to 2 h after. The residuals were pressure, flow lost,
flow vs rating, discharge, pump-off pressure and receive flow, the tank mass balance, and the
pump-to-disposal pressure drop. Before onset everything stays at noise level. The generator starts
problems abruptly, so "earlier" can only mean alarming sooner after onset.

**2. Results** (`sweep.py`, fixed thresholds, 0 FA):

| Problem | Old detector | Now | Gain per event |
|---|---|---|---|
| Leak | CUSUM H=10: 65 / 10 / 20 / 10 / 10 | + one reading > 4.5σ: 60 / 0 / 10 / 5 / 0 | +5, +10, +10, +5, +10 |
| Worn pump | CUSUM flow H=10: 190 / 180 / 190 / 155 / 180 | flow + discharge H=6: 155 / 140 / 130 / 115 / 165 | +35, +40, +60, +40, +15 |
| Pump failure | status = 2: 0 | the same | 0 |

- **Leaks:** 4 of 5 are now caught at the first reading where a leak can physically show.
  EVENT_1 and EVENT_10 began with the pump off, and the leak is invisible until the pump runs.
  Adding the flow-lost channel to pressure gains nothing, because pressure already shows the step at 5σ.
- **Worn pumps:** combining the two signals alone saves 25 min at H=10. Lowering H to 6 brings it
  to 40 min. H=5 also gives 0 FA (+45 min). H=4 gives 1 FA. H=6 keeps a margin.
- **Pump failures:** status flips to 2 on the onset row; no sensor moves earlier. EVENT_9, 14 and
  15 had a worn-pump alarm still active 33–34 h before the fault. For those, the worn-pump alert
  is the early warning. The other 10 have no precursor.

**3. Methods that lost** (`evaluate.py`; thresholds calibrated with one system held out at a time):

| Method | Leak median | Worn-pump median | Why |
|---|---|---|---|
| Isolation Forest on 4 residuals (unsupervised) | 200 min | 560 min | Scores one reading at a time, so it can't accumulate a slow drift. Its threshold is set by the noise tail of all 4 channels |
| Hotelling T² + CUSUM (unsupervised) | 30 | 295 | Watches every direction, so the one direction a fault moves in is diluted by 3 noise-only channels |
| GLR linear-drift test | – | 835 | The drift model is right, but the max over start times inflates the null, so the threshold ends up high |
| EWMA (λ = 0.05) | – | 145, 4 FA | Weaker than CUSUM for a step or ramp, and noisier |

The noise is independent Gaussian on each channel, and each fault's signature is known from
physics. Under those conditions a statistic aimed at the signature (matched filter + CUSUM) is
close to optimal. Unsupervised models have to discover the signature, and they pay for it in delay.

**Caveats.** Only 5 leaks and 5 worn pumps. Thresholds are tuned in-sample; the held-out check gave
the same per-event gains. If test-network leaks start with a smaller step, the single-reading rule
doesn't fire and the CUSUM catches them as before, so the change costs nothing. `make score` is
unchanged: 72 matched, 0 missed, 0 FP, plans 36/36.

# Task 2: countdown and plans

Only pump failures get a plan. Leaks and worn pumps get `field_inspection`; the pump still moves water, so no tank is filling.

## The levers

| Lever | Choice | Cost |
|---|---|---|
| Send trucks | How many trucks (≤ what's free in the system's fleet), and how many trips each | `cost_per_trip` per trip |
| Shut in wells | Which wells, and the minute each one goes off. Each stays off until the repair | That well's oil + gas revenue × hours off |
| Do nothing | Let the tank reach `shutdown`; every well at the facility goes off until the repair | All the facility's revenue × hours from the trip to the repair |

The repair itself is not a lever. It always ends `expected_repair_hours` after onset, which fixes the planning horizon. Coordinates are not used: truck travel times come straight from `ops.json` (`response_min`, `cycle_min`).

## Inputs for one failing tank (`build_situation`)

| Input | Where it comes from |
|---|---|
| Plan start `t0` | Onset for a resolved event; "now" (the last telemetry row) for an ongoing one |
| Repair end `R` | onset + `expected_repair_hours.pump_failure` |
| Volume at `t0` | Level % × `capacity_bbl`, de-noised by a straight-line fit (below) |
| Shutdown volume `L` | `tank_limits_pct.shutdown` × capacity |
| Producing wells | Wells with `status == 1` at `t0` |
| Each well's water rate | `baseline_water_bpd` from network.json. Live readings are the baseline plus ~0.7 % noise with no drift. If a well's last-hour average ever drifted more than 3 % from its baseline, the live average would be used instead |
| Each well's revenue/hour | (`oil_bpd` × oil price + `gas_mcfd` × gas price) / 24 |
| Inflow | Sum of the producing wells' rates |
| Truck terms | `truck_capacity_bbl`, `cost_per_trip`, and this facility's `response_min` / `cycle_min` |

**De-noising the level.** One reading carries about 0.1 % of noise. That's about 1 bbl, which shifts a 25 bbl/h well's shut-in by a couple of minutes. The level moves in a straight line within each regime, so the planner fits a line over up to an hour of readings from one regime and reads it at `t0`:
- **Pump down (after onset):** fit the readings since onset.
- **At onset:** fit the readings since the pump last switched on or off, up to the onset row. The onset row sits on both lines.

Neither fit uses readings after `t0`.

**Already tripped.** A tank at `shutdown` with every well off at `t0` can't be saved; it shows as "already shut in" with the sunk cost.

## Countdown

- `hours_to_limit = (L − V) / inflow`: when the tank reaches shutdown if nothing changes. 0 if already tripped.
- `trips_at` is that moment, or `null` if it comes after the repair: the tank never trips, so no action is needed (EVENT_6).
- Only p50 is reported. p10/p90 would come from the inflow and level noise, but the noise is small enough that the band would be a few minutes wide.

## Is a plan feasible?

With the pump down, the tank only gains water between truck arrivals. So a plan is safe if the level is at or under `L`:
- just before every truck arrival (counting only earlier pickups), and
- at the repair end.

Also:
- Every trip must arrive before the repair ends.
- A pickup can't take more than the tank holds at that moment (checked after shut-ins).
- Trucks used must not exceed those available.

Truck rules (SPEC.md plus the task 2 defaults):
- All trucks in a plan are called at `t0` and arrive together at `t0 + response_min`, then every `cycle_min`.
- Every truck makes the same number of trips.
- A truck stays busy until `cycle_min` after its last trip.
- A truck is never redirected to another tank mid-plan.

A plan either keeps the tank from tripping or accepts the trip with nothing done. Spending money only to delay a trip is not considered.

## Cheapest plan for one tank (`plan_with_trucks`, `best_by_trucks`)

**1. Try every truck option.** 0 to the available trucks × 1 to `max_trips` trips per truck. `max_trips` is how many arrivals fit before the repair, usually 1 or 2.

**2. For each truck option, work out the cheapest shut-ins.** Start from the excess at each check point, i.e. how far over `L` the tank would be. Then, taking wells in order of cost per barrel (revenue/hour ÷ water/hour), cheapest first:
- Turn the well off at the **latest whole minute** that clears every remaining excess: `min over check points of (time − excess / well rate)`, rounded down to the minute.
- If that would be before `t0`, turn it off at `t0` and move on to the next well with what's left.

Why this greedy works: turning a well off one hour earlier costs its revenue/hour and keeps out its water/hour at every later check point. So cheaper barrels always beat dearer ones, and later is always cheaper.

A one-off brute-force check (not kept in the repo) tested this: every subset of wells × every start minute (3-minute steps for pairs, 20-minute steps for three wells) × every truck option, on the full week and both multi-failure snapshots. That's 94 truck options. The greedy matched the brute-force optimum on every one, and the two always agreed on whether a plan was feasible.

**3. Compare with doing nothing.** The cost is all the facility's revenue/hour × (repair end − trip time), or $0 if the tank never trips.

**4. Pick the cheapest, breaking ties by fewer trucks, then fewer trips, then fewer shut-in wells.** The key confirms "fewer trucks" first: EVENT_15 at onset is "1 truck, 2 trips", not the equal-cost "2 trucks, 1 trip each". That keeps a truck free for the next failure.

## Shared fleets: two planning modes (`plan_failures`)

| Mode | Used for | How |
|---|---|---|
| `at_onset` | Resolved failures | Planned at their own onset, in onset order. Trucks sent to earlier failures in the same system stay busy until free again, so a later failure may have fewer trucks (EVENT_13: "0 of 2 trucks free" → shut-in) |
| `joint_now` | Failures ongoing at "now" | All of a system's ongoing failures are planned together from "now". Nothing has been dispatched yet, so the whole fleet is available |

**Joint search (`joint_plan`).** For each tank, take the cheapest plan for each exact truck count. Then try every combination of truck counts whose total fits the fleet, and pick the combination with the lowest total cost, with the same tie-breaks summed. Three tanks × at most 4 truck counts is at most 64 combinations.

## Alternatives shown to the operator

For each failure, using the trucks it could actually get in the chosen plan:
- **Do nothing**
- **Shut in wells only**
- **Trucks only**
- **Trucks + shut-in**, when the recommended plan mixes them

The recommended row is highlighted. This mirrors the README's opening-scene table.

## Alert order (`alert_order`)

SPEC.md's alerts view:
1. Ongoing pump failures, smallest `hours_to_limit` first, ties going to higher lost revenue/hour.
2. Then ongoing leaks and worn pumps, in onset order.

## Simulator (`simulate`)

A minute-by-minute replay of one tank with a plan applied. It doesn't use the check-point maths above, so it serves as an independent check: the scorer runs every recommended plan through it and flags any that would trip. It is also the basis for a future what-if chart.

## Planning results

`make score` compares each failure's plan with the key's `reference_action`:

```
TOTAL matched 72  missed 0  false positives 0  plans matching key 36/36
```

- **All 36 plans match:** same trucks, trips per truck and wells, with shut-in starts within one minute. That covers all 13 full-week failures and every failure in the three snapshots, at onset and jointly from "now", including the mixed plan "1 truck + shut in S4_WELL_A2" (EVENT_21 at 10-10 09:00).
- **Cost differences** are at most $19, i.e. one minute of one well's revenue. The leftover minute is level-sensor noise: the key uses the simulator's exact level.
- **Trip times** match within 1 minute.
- **Snapshot countdowns** (`hours_to_limit_final`) match within 0.02 h.
- **Alert order** matches the key's `order` in every snapshot.
- **No recommended plan trips** in the simulator.

## Planning limits

- **Repairs are assumed to take exactly `expected_repair_hours`,** as SPEC.md states. A longer real repair would need a re-plan.
- **The rules match the answer key, so some cheaper plans are excluded:** trucks with different trip counts, re-dispatching a truck once it's free, and delay-only plans. Each could be added as a labelled alternative.
- **Shut-in starts are rounded down to whole minutes,** so plans err on the safe side by under a minute of revenue.

# Interfaces

## API

| Endpoint | Returns |
|---|---|
| `POST /api/datasets` (multipart: files `network`, `ops`, `telemetry`; field `name`) | `{dataset_id, name, start_unix, end_unix, step_s}`, or 400 with a message on malformed files |
| `GET /api/datasets/{dataset_id}/state?now=` | `{dataset, start_unix, now_unix, now_ts, alert_order[], events[]}` as known at `now` (default: the last reading); 404 if the id is unknown, 400 if `now` is before the first reading |

Each event follows the SPEC.md `events.json` shape: `event_id` (EV-0001… in onset order), `system_id`, `facility_id`, `asset_id`, `category`, `status`, `onset_ts/unix`, `end_ts/unix`, `alarm_unix` (when the detector first fired; onset is back-dated from it), `confidence`, `evidence[]`, `hours_to_limit` (ongoing pump failures only), `recommended_actions[]`. Leaks and worn pumps carry `field_inspection`. Pump failures carry their plan as `dispatch_truck` / `shut_in_wells` actions, or `none`. They also carry `planning`:
- `plan_mode`, `planned_at_unix`, `level_pct`
- `hours_to_limit`, `trips_at_unix`, `repair_end_unix`, `tripped`
- `lost_revenue_per_hour`
- `trucks_available`, `fleet_size`, `shares_with`
- `plan`: summary, cost, trucks, truck arrival times, shut-ins with times and costs, actions
- `alternatives[]`

`alert_order` lists the ongoing event IDs in alerts-view order.

## Frontend: the console

Desktop layout: header across the top, alerts on the left, the map in the centre, details on the right, and the timeline along the bottom. Phone support comes later.

### Replay ("now")

- **Moving "now".** The timeline sets "now" to any reading in the recording. You can drag along the track, use ±5 min and ±1 h, use the arrow keys (Shift for hours), press "Latest", or press play at 1, 4 or 12 hours per second.
- **What the app knows at "now".** Every move asks the backend for the state at "now". Requests are latest-wins: while one is running, only the newest "now" is remembered and sent next. So dragging and playing never queue up a backlog, and "updating…" shows while one is out.
- **Event lanes.** Each system gets a lane of event bars, taken from the whole recording so interesting moments are easy to find. The part after "now" is dimmed: the bars are a navigation aid, not knowledge the app had. Clicking a bar jumps to the moment that event was **first detected** (`alarm_unix`) and selects it.
- **Stable selection while scrubbing.** Event IDs are numbered in onset order as of "now", so they can shift. A worn pump detected later can have an earlier, back-dated onset. Selection therefore uses asset + category + onset, which is stable.
- **Selecting a future event.** If you select an event that hasn't been detected yet at "now", the detail panel says so and offers to jump to its detection.

### Map tabs (`SystemTabs.tsx`)

The map has an **Overview** tab with every system, and **one tab per system**.
- **A system tab draws only that system**, laid out with roomier spacing and scaled to that system alone. A two-facility system fills the canvas as well as a four-facility one, at about 1.4× zoom on a laptop screen.
- **Every tab carries a live badge:** alerts in progress (coloured by the worst problem), plus the soonest shutdown countdown or "shut in". That way a problem in a system you're not looking at stays visible.
- **A tab flashes for a few seconds** when a new alert appears in it while another tab is open. The app never switches tabs on its own.
- **Opening a tab:** click it, a system's name on the Overview, its card in the network summary, or its timeline lane label. Picking an alert anywhere (left list, summary card, timeline bar) opens that alert's facility page inside its system tab.
- **Each tab gets a fresh canvas fitted to what it draws.** The alert list on the left stays global, because the spec's alert order covers all systems; the open tab's timeline lane is highlighted.

### Facility page (`FacilityPage.tsx`)

A third map level under a system tab (Overview › S4 › FACILITY A). It replaces the map canvas, because time-series charts need more width than the right panel has.

- **Process diagram.** Wells → tank → pump → pipeline → disposal site, left to right in the direction the water flows. The layout is fixed: no coordinates, nothing moves. Each card shows its live readings at "now" and its state: well producing or shut in, tank fill against the warning and shutdown lines, pump running/off/fault, pipeline flow and % lost. Components with an ongoing event carry a badge. Links animate while water moves through them and turn orange on a leak. The disposal site is shown but can't be selected; it has no sensors of its own.
- **Charts for the selected component**, raw readings only. With nothing selected, a facility summary shows tank level, inflow vs pumped, pipeline pressure and discharge pressure. Clicking a component again goes back to the summary.

| Component | Charts | Reference lines |
|---|---|---|
| Well | water rate, status | baseline rate |
| Tank | level, inflow vs pumped | shutdown, warning, pump start/stop levels |
| Pump | status, flow, discharge | rated flow, healthy discharge (disposal + 150) |
| Pipeline | pressure at the disposal site, pumped vs received | healthy pressure (disposal + 50) |

- **One time axis.** Every chart ends at "now", showing nothing the operator couldn't have seen. The window is 6 h, 24 h (default), 3 d or the whole run. Hovering any chart draws a crosshair on all of them, and each legend shows the values at that moment (the latest values otherwise).
- **Shading.** Grey for pump off and red for pump fault, on the pressure and flow charts, because those readings only mean something while pumping. Events known as of "now" get a tinted span from onset to end, with a dashed tick where the detector fired (`alarm_unix`).
- **Navigation.** Esc first clears the selected alert, then closes the page. "← S4 map" or any tab also closes it. Picking an alert anywhere opens its facility page on the component that shows it: pump for failures and wear, pipeline for leaks.
- **Event card.** The selected alert's details sit between the diagram and the charts: onset, detection time, confidence, the evidence lines and, for pump failures, how the plan was chosen with the options table.

### Map (`MapView.tsx`, `layout.ts`)

- **Positions come from the coordinates; there is no layout engine.** Systems sit 40–100 km apart while a system's facilities span about 10 km, so two scales are used, both derived from the network:
  - **Inside a system:** facilities and the disposal site keep their true relative positions, scaled so the widest system spans about 145 px from its centre.
  - **Between systems:** systems keep their true relative positions, scaled until the closest two discs are 36 px apart.
  - **Truck yards** keep their true direction but sit just outside the system; truck times come from `ops.json`, not from the map.
  - **Sized for the overview.** Node, label and spacing sizes are tuned so the overview of the whole network opens at about 0.6× zoom with labels still readable (15 px facility names, 26 px system names in canvas units). There is no minimap.
  - **Wells** have no coordinates, so they fan out around their facility, facing away from the disposal site.
- **Facility = tank gauge.**
  - The fill shows the current level, with dashed warning and shutdown lines.
  - The ring colour shows the worst state: green normal, amber tank above warning, yellow pump wearing out, red pump failed (pulsing), dark red shut in.
  - A failing tank gets a countdown ring: the share of the remaining repair time the tank can still hold out. It also gets a chip with the hours to shutdown.
- **Pipes**, straight from facility to disposal site:
  - faint while the pump is off;
  - animated blue flow while it runs;
  - dashed grey when the pump has faulted;
  - glowing orange with a "−x %" badge (water not arriving) during a leak.
- **Trucks.** When an ongoing failure's plan sends trucks, a dashed amber route runs from the yard to the facility, labelled with trucks × trips and the first arrival time. The yard shows how many trucks are free.
- **On the Overview, each system sits on a tinted disc** with its name and alert count at the top, tinted by its worst problem: red for a failure, orange for a leak, yellow for a worn pump. Clicking the name opens that system's tab. The disc lets the mouse through to the pipes and nodes behind it.
- **Clicking** a facility, well or pipe opens that facility's page (below), with the well or pipeline already selected. If something is in progress there, its most urgent alert fills the right panel.
- **Hover cards** show readings at "now" plus a 6 h sparkline:
  - **Facility:** tank, inflow and wells on, pump state and flow against rated, discharge, countdown, plan.
  - **Pipe:** pumped against received flow, % lost and pressure against healthy while running, or why a leak can't show while it's idle.
  - **Well:** water rate against baseline, oil and gas.
  - **Disposal site, yard:** pressure; trucks committed.

### Side panels

- **Left:** the alerts list.
  - **In progress**, in the backend's `alert_order`, with countdown chips.
  - **Resolved**, most recently ended first.
- **The right panel holds navigation and required actions only: no readings, no charts.** With nothing selected, it shows one card per system, most urgent first. Each card lists alerts in progress, trucks free, one button per facility coloured by its status (with a leak underline), and the ongoing alerts as links. The system name opens its map tab and a facility button opens its facility page.
- **Right, alert selected:** what to do and by when. That means the countdown (pump failures), the recommended action, and "Open facility →" when its page isn't already open. Evidence, plan details and the options table are on the facility page. "← Network", Esc, or a click on empty map goes back to the summary.
  - **Pump failure:** the plan with clock times, the countdown, how the fleet was shared, and the options table.
  - **Every event:** evidence lines and two charts, from 12 h before onset up to "now", never past it.
  - **Leak and worn-pump charts** show pump-running samples only, with dashed healthy and rated reference lines.
  - **A facility with nothing wrong:** its readings and the last 24 h of tank level.
- **Telemetry for the map and charts** comes from the whole CSV, parsed once in the browser (23 MB, about 393k rows).
