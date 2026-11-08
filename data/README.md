# Beat the Shutdown

*HackUTD: ZeroDay. The city of Avon needs you.*

Avon never sleeps - and neither do the oil fields beyond its walls that keep the city running. Every barrel of oil produced also brings salt water that must be managed: collected in tanks, transported through pipelines, and treated for reuse. Most nights, the system runs seamlessly in the background, but tonight... something breaks. A pump fails, a tank nears capacity, and the system forecasts an impending shutdown to prevent a spill. 

If no one intervenes, Avon goes dark. 

Your job is to change that outcome. Build a console that gives night-shift operators the insight they need to act fast: identify what's failing, predict the time before it worsens, and determine the lowest-cost path to keep operations running.

## How the network works

```mermaid
flowchart LR
    subgraph FAC["Facility"]
        direction LR
        W["Wells<br/>oil, gas + salt water"] -->|water| T["Tank"]
        T --> P["Pump"]
    end
    P --> L["Pipeline"] --> D[("Disposal site<br/>underground")]
    O["Other facilities<br/>in the system"] --> D
    K["Emergency trucks"] -.->|haul water away| T
    X1{{"pump failure<br/>pump wearing out"}} -.- P
    X2{{"leak"}} -.- L
```

Each **facility** has a few wells, one tank, one pump and one pipeline. The wells fill the facility's tank, the pump empties the tank into the pipeline, and the pipeline carries the water to a **disposal site**. A group of facilities is a **system**. Every pipeline in a system ends at the same disposal site. Each system also has a small fleet of emergency trucks to dispose water if the tank's pump fails.

If water stops getting pumped, the tank fills. When the tank level reaches its **shutdown** limit, the facility's wells are forced to turn off automatically (they **shut in**). Nothing spills, but those wells earn nothing until the repair is done and the pumping resumes.

## What goes wrong

| Problem | What happens | What your app does |
|---|---|---|
| Pipeline leak | Water escapes between the pump and the disposal site | Urgent Alert: send an inspector immediately. Water in the tank is still being pumped, so no need to plan an alternative way to dispose of the water |
| Pump wearing out | The pump moves a little less water every hour | Alert: send an inspector. Water in the tank is still being pumped, so no need to plan an alternative way to dispose of the water |
| Pump failure | The pump stops. The water levels rise and a countdown starts until the tank level reaches its **shutdown** limit | Alert the time the facility will be forced to shut in the wells (if no action is done), and the most cost-effective action to take in response |

Your app needs to work out these events solely from the sensor readings. A good place to start: compare the readings during the labelled events in `history/full_week/answer_key.json` with the readings outside them. The practice data comes with an answer key so you can check your results, but at judging you get only the sensor readings and the network description.

## The decision

When the pump fails, the tank is filling, and if the repair will take longer than the tank can wait, you have three moves:

- **Send trucks** to haul water out of the tank. Each trip takes a set amount of water and costs a flat price. After a trip the truck drives off, empties, and can come back for another load. The price, the amount, and how long the first trip and each round trip take are in `ops.json`.
- **Shut in some wells** early, so the tank fills slower. Each well's oil sells by the barrel and its gas by the mcf (prices in `ops.json`) (mcf = thousand cubic feet). A well that's shut in sells nothing, so the cost is the oil and gas it didn't sell while it is shut in. You are allowed to do this AND send trucks.
- **Do nothing** and let the automatic shut-in happen. The cost is the oil and gas ALL the wells didn't sell while they were shut in.

### Opening Scene Example

Let's walk through the opening scene as an example (`EVENT_9` in `/history/full_week/answer_key.json`): an 800-barrel tank, about half full, filling at 75 barrels/hour. It reaches shutdown in 4.5 hours, but the repair takes 6...

| Option | What happens | Cost |
|---|---|---|
| Do nothing | Facility shuts in at 04:49 and stays dark until the repair at 06:20 | $5,016 |
| Turn off one well | Switch off `S1_WELL_C2` at 02:25. The tank never reaches shutdown | $1,958 |
| Send a truck | One truckload arrives at 01:35 and removes 150 barrels. The tank never reaches shutdown | **$905** |

Where the $905 comes from: it's the flat price of one truck trip in this network. The truck reaches `S1_FACILITY_C` 75 minutes after it's called, at 01:35, and takes 150 barrels, which keeps the tank under shutdown until the repair.

Where the $1,958 comes from: `S1_WELL_C2` produces 170 barrels of oil and 600 mcf of gas a day. At $60 a barrel and $3 an mcf, that's $10,200 + $1,800 = $12,000 a day, or $500 an hour. Off from 02:25 until the repair at 06:20 is 3 hours 55 minutes, so about $1,958.

The hard case is two or three pumps failing in the same system within a few hours. Every tank in a system shares the same two or three trucks, so a truck sent to one tank can't help another.

**Your plan doesn't change the data.** The files are a recording of a week when nobody acted: every problem ran until it was repaired or the tank shut itself in. Your app advises the operator on what to do *now*. It doesn't rewrite what happened. You could, however, support a time-travel feature where you suggest the optimal strategy as if a timestamp in the past was happening now.

## What you get

Every dataset is a folder with the same three files, and your app loads only these:

- `network.json`: systems, facilities, wells, tanks, pumps, pipelines and disposal sites.
- `ops.json`: prices, repair times and trucks.
- `telemetry.csv`: the sensor readings coming from everything in the network.

| Folder | What's in it |
|---|---|
| `history/full_week/` | One week of a network (systems S1 to S5), plus `answer_key.json`: every event, when it started and ended, and the plan that should have been used |
| `history/snapshot_*/` | The same week cut off at three earlier moments, with problems still in progress, each with its own `answer_key.json` |
| `history/mock_test_*/` | The same week cut off once more, with **no** answer key: a dress rehearsal for judging |
| `test/` (added right before judging) | A week from a **different network** (S6 to S11) you have never seen. Three files, no answer key |

`answer_key.json` is for checking your app, never for loading into it. [history/README.md](history/README.md) explains each folder and how to read the answer key.

File formats, how the equipment behaves, and the rules for plans are in [SPEC.md](SPEC.md). Sample rows are in [examples.md](examples.md).

## What to build

We encourage you to be creative and use the data and the premise in unique ways. But we want some sort of tool to help an operator discover and remediate any issues that come up or optimize things in some way.

### Suggestions

- Show the network. Load a dataset from its folder and show every system on a map: its facilities, wells, tanks, pumps and pipelines, and what feeds what.
- Trend the data. Select anything on the network and plot any of its sensor readings over time.
- Find the problems and alert on them. Detect the three problems, when each started and whether it's still going. Show the alerts in an intuitive and helpful way.
- Say what to do. Give each alert its action. A pump failure gets its countdown to shutdown and the cheapest plan: trucks, turning off wells, or letting it shut down. A leak or a worn pump gets an inspector.
- A what-if view: replay a tank with your plan applied and watch it stay under the limit.
- Make it work cross platform, for example on a phone for an operator out in the field.
- Plot several sensors on one chart, or compare facilities side by side.
- A confidence level on each alert: how sure is your app that something is really wrong? This matters most for slow problems that are just starting.
- A plain-English shift handoff the next operator can read in 30 seconds.
- Export your events to `events.json` (shape in [SPEC.md](SPEC.md#eventsjson-optional)).
- How early can you spot a leak? Show the warning before it's obvious.
- How big should the trucking fleet be? Build a what-if analysis for if the entire water disposal site gets shut down.
- Build a driving simulator to help train the drivers to quickly get to the tanks!
- More wells are always being drilled; build an oil tycoon game!
- Be creative and come up with something even crazier!

## How judging works

1. During the event, build against `history/full_week/`, practise on the snapshots, and do a dry run on the mock test.
2. Before judging, we will add a test `test/` folder to the repo: containing `network.json`, `ops.json` and `telemetry.csv` for a new network. Ideally your code will be able to switch between the different folders seamlessly so you can easily demo the `test/` folder.
3. Judges look at:
   - Creativity of the solution
   - User experience and aesthetics
   - Usefulness and functionality of the app
   - If you are optimizing cost, how correctly/optimally you do so.
   - Data comes from the files, no hardcoding
   - Make sure you follow the instructions

## Terms

No oil and gas background needed. These are all the terms the data uses.

- **bbl**: barrel, 42 US gallons. **bpd**: barrels per day. **mcf**: a thousand cubic feet of gas. **mcfd**: mcf per day. **psi**: pressure (pounds per square inch).
- **Shut in**: turn a well off. A shut-in well produces no water, oil or gas, so it earns nothing.
- **Tank limits**: `warning` and `shutdown`, in percent full. At `shutdown` the wells shut in automatically.
- **Trip**: an automatic safety stop. A tank *trips* when it reaches `shutdown` (its wells shut in).
- **Setpoint**: a level that switches the pump. It starts at `start_level_pct` and stops at `stop_level_pct`.
- **Disposal site**: where a system's pipelines end and the water goes back underground. It has no sensors and never goes down.
- **Discharge pressure**: how hard the pump is pushing water into the pipeline. **Pipeline pressure**: the pressure where the pipeline reaches the disposal site.
- **Sawtooth**: the normal up-and-down of a tank's level as its pump switches on and off.
