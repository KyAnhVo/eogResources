# Spec

Everything the [README](README.md) leaves out: file schemas, how the equipment behaves, and the rules for plans. Worked data samples are in [examples.md](examples.md).

## Files

| File | What it holds |
|---|---|
| `network.json` | Systems, disposal sites, facilities, wells, tanks, pumps, pipelines, and the default tank limits |
| `ops.json` | Prices, repair times, truck costs, and each system's truck fleet and travel times |
| `telemetry.csv` | Every sensor reading, every 5 minutes. The only source for the time range |
| `answer_key.json` | Practice folders only, never loaded by your app: every event with onset, end and the plan that should have been used. See [history/README.md](history/README.md) |

**Time range.** No file states the time range. Take it from the telemetry: the first and last `ts_unix` in `telemetry.csv`. The last one is "now". `network.json` and `ops.json` are the same in every `history/` folder.

### network.json

| Level | Contains |
|---|---|
| System | Facilities, one disposal site, truck yard, map center |
| Disposal site | Where every pipeline in the system ends and the water goes underground. Location and `pressure_psi` only. It has no sensors and never goes down |
| Facility | Lat/long, wells, one tank, one pump, and one pipeline to its system's disposal site |

Key fields: `capacity_bbl` (tank size), `start_level_pct` / `stop_level_pct` (pump setpoints), `max_flow_bpd` (a healthy pump's flow while running), `warning` / `shutdown` (tank limits in `defaults.tank_limits_pct`, the same for every tank), and each well's `baseline_water_bpd`, `oil_bpd`, `gas_mcfd`.

### telemetry.csv

Columns `timestamp, ts_unix, asset_id, metric, value`. Every series has a row every 5 minutes, and every sensor reports every interval.

| Asset | Metric | Meaning |
|---|---|---|
| Facility | `inflow_bpd` | Sum of its wells' water. This is the tank's inflow |
| Well | `water_bpd` | Live water rate (bbl/day) |
| Well | `status` | 1 producing, 0 shut in |
| Tank | `level_pct` | Fill %. Volume = `level_pct / 100 × capacity_bbl` |
| Pump | `status` | 0 stopped, 1 running, 2 fault |
| Pump | `flow_bpd` | Flow out of the tank into the pipeline |
| Pump | `discharge_psi` | Pressure at the pump outlet |
| Pipeline | `receive_flow_bpd` | Flow arriving at the disposal site |
| Pipeline | `pressure_psi` | Pressure at the disposal site end |

Readings have small random noise, so values won't match formulas exactly.

## Normal behavior

The tank level makes a sawtooth. The pump starts at `start_level_pct`, stops at `stop_level_pct`, and keeps its state in between. Level change per hour is `(inflow − pump flow) ÷ 24 ÷ capacity × 100`.

## The three problems

| Category | What happens |
|---|---|
| `pipeline_leak` | Water escapes from the pipeline. Doesn't fill a tank, so no countdown. Gets `field_inspection` |
| `pump_degradation` | The pump wears out and moves less water over time. Doesn't fill a tank, so no countdown. Gets `field_inspection` |
| `pump_failure` | The pump stops working. Its tank fills until the repair is done or the tank reaches `shutdown` |

**How each one shows up in the readings is for you to work out.** Start by comparing the readings during the labelled events in `history/full_week/answer_key.json` with the readings outside them.

- **Several at once:** two or three pumps in the same system can fail within hours of each other. Each is its own event, but they share the system's trucks (see [Shared trucks](#plans)).
- **Automatic shut-in:** when a tank reaches `shutdown`, the facility's wells go to `status` 0 and `water_bpd` 0, and the level holds. The facility stays shut until the repair ends, then the wells resume immediately. Nothing overflows in the data.
- **Repairs** last exactly `expected_repair_hours` (in `ops.json`) from onset.
- **Countdown:** `hours_to_limit` is how many hours until the tank reaches `shutdown` if nothing changes. It is null for leaks and degradation.
- A degrading pump that later fails is two separate events.

## Plans

For each pump failure, recommend the cheapest plan that keeps the tank from tripping, or accept the trip. Leaks and degradation get `field_inspection`.

**Trucks.** All trucks in a plan are called when the plan starts and arrive together `response_min` later. Each trip removes `truck_capacity_bbl` and costs `cost_per_trip`. A truck can come back for more trips, one every `cycle_min`. It's busy until it has emptied its last trip and is back, `cycle_min` after that trip.

- `response_min` is the drive from the system's truck yard to that facility. It's a travel time, not a minimum, and it only applies to a truck's first trip.
- A busy truck can't be pulled away mid-job to another facility.
- A truck that finishes one job starts the next from the truck yard, so it takes the new facility's `response_min` again.

| Field | Where in `ops.json` | Meaning |
|---|---|---|
| `response_min` | `systems.<system>.facilities.<facility>` | Minutes from the call until a truck first reaches that facility from the truck yard |
| `cycle_min` | `systems.<system>.facilities.<facility>` | Minutes for one round trip: haul the water away, empty, and come back |
| `truck_capacity_bbl` | `emergency_trucking` | Barrels removed per trip |
| `cost_per_trip` | `emergency_trucking` | Price of one trip |
| `emergency_fleet_size` | `systems.<system>` | How many trucks the system has |

```
trip arrivals = response_min, response_min + cycle_min, response_min + 2 × cycle_min, ...
bbl removed   = trucks × trips × truck_capacity_bbl
truck cost    = trucks × trips × cost_per_trip
```

Water is removed only when a trip arrives, so a trip that arrives after the tank trips doesn't prevent it. Every trip must arrive before the repair ends, a trip can't remove more water than is in the tank, and a plan can't use more than the system's `emergency_fleet_size`.

**Shut-in.** Instant, can start late, lasts until the repair ends.

```
lost revenue per day = oil_bpd × prices.oil_per_bbl + gas_mcfd × prices.gas_per_mcf
shut-in cost         = lost revenue per hour × hours shut in
cost per bbl avoided = lost revenue per day ÷ baseline_water_bpd
```

**Doing nothing** is allowed. The automatic shut-in then costs the facility's total lost revenue per hour for as long as it is shut. Plans can mix, for example one truck now plus a late shut-in of a cheap well.

**Horizon:** `expected_repair_hours.pump_failure`. For an ongoing event, it is the repair time remaining at "now".

**Shared trucks.** A system's `emergency_fleet_size` covers every problem in that system at once.

- At "now", nothing has been dispatched yet (the data is a recording with no operator actions), so all of a system's ongoing pump failures share its whole fleet. Plan them together: a truck sent to one tank can't help another.
- In `full_week/answer_key.json`, each event's `reference_action` is planned at its onset, assuming earlier reference plans were followed. A truck sent to an earlier event stays busy until it's back from its last trip, so a later event in the same system may find no trucks free.

## Alerts view

One view across all systems showing every problem still in progress, each with its action: the plan for a pump failure, an inspection for a leak or a worn pump.

1. Pump failures first, soonest to reach `shutdown` (smallest `hours_to_limit`) first. Ties go to higher lost revenue per hour.
2. Then leaks and worn pumps, in any order.

## events.json (optional)

An export is a [Go further](README.md#what-to-build) idea. If you build one, this shape works.

```json
{
  "event_id": "EV-0107",
  "system_id": "S8",
  "facility_id": "S8_FACILITY_B",
  "asset_id": "S8_PUMP_B",
  "category": "pump_failure",
  "status": "ongoing",
  "onset_ts": "2026-10-11T21:00:00Z",
  "onset_unix": 1791752400,
  "end_ts": null,
  "end_unix": null,
  "confidence": 0.86,
  "evidence": ["Plain-English reasons your app gives for this event"],
  "level_pct": 81,
  "hours_to_limit": {"p50": 1.9, "p10": 1.6, "p90": 2.2},
  "recommended_actions": [
    {"type": "dispatch_truck", "facility_id": "S8_FACILITY_B", "trucks": 1, "trips_per_truck": 1},
    {"type": "shut_in_wells", "wells": ["S8_WELL_B1"], "start_after_min": 330}
  ]
}
```

- `category`: `pump_degradation`, `pump_failure`, `pipeline_leak`, `other`.
- `status`: `resolved` or `ongoing`. Resolved events need `end_ts`.
- `hours_to_limit`: `p50` required, `p10`/`p90` optional. Null for leaks and degradation. Only for ongoing events.
- Action `type`: `dispatch_truck` (`facility_id`, `trucks`, `trips_per_truck`), `shut_in_wells` (`wells`, optional `start_after_min` from plan start, default 0), `field_inspection` (`asset_id`), or `none`.
- `est_cost` is optional and informational. Values above are illustrative.

## Pressure formulas

Each system's disposal site holds a fixed `pressure_psi` (in `network.json`). These are healthy readings; problems change them.

| Reading | Pump running | Pump off or failed |
|---|---|---|
| Pipeline `pressure_psi` | Disposal pressure + 50 | Disposal pressure |
| Pump `discharge_psi` | Disposal pressure + 150 | Disposal pressure |

The pressure offsets are placeholders.
