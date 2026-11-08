# Data examples

Columns: `timestamp,ts_unix,asset_id,metric,value`. Rows are from `history/full_week/telemetry.csv`.
`ts_unix` for `2026-10-05T00:00:00Z` is 1791158400, and each 5-minute step adds 300.

## 1. Normal operation: tank rising, pump off

S1_FACILITY_A: 1,200 bbl tank, about 2,400 bpd inflow. Level rises about 0.69 points per 5 minutes. With the pump off, its discharge and the pipeline both read the disposal site's pressure (`S1_DISPOSAL`, 1,050 psi).

```
2026-10-05T06:15:00Z,1791180900,S1_WELL_A1,water_bpd,992.7
2026-10-05T06:15:00Z,1791180900,S1_WELL_A1,status,1
2026-10-05T06:15:00Z,1791180900,S1_WELL_A2,water_bpd,800.4
2026-10-05T06:15:00Z,1791180900,S1_WELL_A2,status,1
2026-10-05T06:15:00Z,1791180900,S1_WELL_A3,water_bpd,597.5
2026-10-05T06:15:00Z,1791180900,S1_WELL_A3,status,1
2026-10-05T06:15:00Z,1791180900,S1_FACILITY_A,inflow_bpd,2390.6
2026-10-05T06:15:00Z,1791180900,S1_TANK_A,level_pct,30.42
2026-10-05T06:15:00Z,1791180900,S1_PUMP_A,status,0
2026-10-05T06:15:00Z,1791180900,S1_PUMP_A,flow_bpd,0.0
2026-10-05T06:15:00Z,1791180900,S1_PUMP_A,discharge_psi,1046.1
2026-10-05T06:15:00Z,1791180900,S1_PIPELINE_A,receive_flow_bpd,0.0
2026-10-05T06:15:00Z,1791180900,S1_PIPELINE_A,pressure_psi,1048.7
2026-10-05T06:20:00Z,1791181200,S1_TANK_A,level_pct,31.28
2026-10-05T06:25:00Z,1791181500,S1_TANK_A,level_pct,32.0
```

Only the first timestamp lists every series, to save space. The real file repeats every series at every timestamp.

## 2. Pump starts

The tank crosses 70%, so the pump starts at about 3,600 bpd. The level now falls about 0.35 points per 5 minutes. Discharge rises to about 1,050 + 150 = 1,200 psi and the pipeline to about 1,050 + 50 = 1,100.

```
2026-10-05T10:55:00Z,1791197700,S1_TANK_A,level_pct,69.42
2026-10-05T10:55:00Z,1791197700,S1_PUMP_A,status,0
2026-10-05T10:55:00Z,1791197700,S1_PUMP_A,flow_bpd,0.0
2026-10-05T10:55:00Z,1791197700,S1_PUMP_A,discharge_psi,1055.3
2026-10-05T10:55:00Z,1791197700,S1_PIPELINE_A,receive_flow_bpd,0.0
2026-10-05T10:55:00Z,1791197700,S1_PIPELINE_A,pressure_psi,1049.7
2026-10-05T11:00:00Z,1791198000,S1_TANK_A,level_pct,70.19
2026-10-05T11:00:00Z,1791198000,S1_PUMP_A,status,1
2026-10-05T11:00:00Z,1791198000,S1_PUMP_A,flow_bpd,3588.6
2026-10-05T11:00:00Z,1791198000,S1_PUMP_A,discharge_psi,1194.6
2026-10-05T11:00:00Z,1791198000,S1_PIPELINE_A,receive_flow_bpd,3622.3
2026-10-05T11:00:00Z,1791198000,S1_PIPELINE_A,pressure_psi,1101.0
2026-10-05T11:05:00Z,1791198300,S1_TANK_A,level_pct,69.83
```

## 3. Automatic shut-in

S2_TANK_B (`EVENT_11`, nobody acted) reaches `shutdown` (92). In the same row the wells stop and inflow goes to 0, and the level holds until the repair ends.

```
2026-10-08T13:20:00Z,1791465600,S2_TANK_B,level_pct,91.37
2026-10-08T13:20:00Z,1791465600,S2_WELL_B1,status,1
2026-10-08T13:25:00Z,1791465900,S2_TANK_B,level_pct,92.0
2026-10-08T13:25:00Z,1791465900,S2_FACILITY_B,inflow_bpd,0.0
2026-10-08T13:25:00Z,1791465900,S2_WELL_B1,water_bpd,0.0
2026-10-08T13:25:00Z,1791465900,S2_WELL_B1,status,0
2026-10-08T13:30:00Z,1791466200,S2_TANK_B,level_pct,92.0
2026-10-08T15:00:00Z,1791471600,S2_WELL_B1,status,1
2026-10-08T15:00:00Z,1791471600,S2_WELL_B1,water_bpd,398.2
2026-10-08T15:00:00Z,1791471600,S2_FACILITY_B,inflow_bpd,1595.6
```

The last three rows show the wells resuming when the 6-hour repair ends at 15:00.

## 4. Truck cost

What three truck plans would do at S1_FACILITY_C (`EVENT_9`, pump fails at 00:20). From `ops.json`: response 75 min, round trip 230 min, 150 bbl per trip, $905 per trip.

| Plan             | What happens                                         | Cost   |
| ---------------- | ---------------------------------------------------- | ------ |
| 1 truck, 1 trip  | Arrives 01:35, removes 150 bbl. Free again at 05:25  | $905   |
| 1 truck, 2 trips | Arrives 01:35 and 05:25, removes 300 bbl             | $1,810 |
| 2 trucks, 1 trip | Both arrive 01:35, remove 300 bbl                    | $1,810 |

The same rules apply to every plan. Finding the cheapest one is up to you. See [SPEC.md](SPEC.md#plans).
