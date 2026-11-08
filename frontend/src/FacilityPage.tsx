// One facility's inner components as a fixed process diagram (wells → tank → pump → pipeline →
// disposal site, in the direction the water flows), and raw-reading charts for whichever component
// is selected. Charts end at "now" and share one time axis and crosshair.

import { useState, type ReactNode } from "react";
import type { Category, DetectedEvent, Network, NetworkFacility, NetworkWell } from "./api";
import { LineChart, type Band, type Line, type Marker, type Reference } from "./LineChart";
import { CATEGORY_LABEL, EventInfo } from "./panels";
import { PUMP_FAULT, PUMP_RUNNING, STATUS_LABEL, hhmm, shortName, type FacilityView } from "./status";
import { seriesKey, slice, valueAt, type Series, type Telemetry } from "./telemetry";

/** "summary", "tank", "pump", "pipeline", or a well id. */
export type ComponentId = string;
export const SUMMARY: ComponentId = "summary";

const HOUR = 3600;
const WINDOWS: { label: string; hours: number | null }[] = [
  { label: "6 h", hours: 6 },
  { label: "24 h", hours: 24 },
  { label: "3 d", hours: 72 },
  { label: "All", hours: null },
];
// Healthy running offsets above disposal pressure (SPEC.md); the backend detectors use the same.
const PIPELINE_RUNNING_OFFSET_PSI = 50;
const DISCHARGE_RUNNING_OFFSET_PSI = 150;
const COLORS: string[] = ["var(--line-1)", "var(--line-2)"];
const PUMP_TEXT: Record<number, string> = { 0: "off", 1: "running", 2: "fault" };

const fmt = (v: number | undefined, digits = 0): string =>
  v === undefined ? "–" : v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

interface ChartSpec {
  title: string;
  lines: [string, string, string][]; // [asset, metric, legend label]
  references?: Reference[];
  step?: boolean;
  domain?: [number, number];
  pumpShade?: boolean; // shade pump-off and fault stretches: pressure and flow only mean much while pumping
  events: Category[]; // which event spans to shade
}

function chartSpecs(component: ComponentId, network: Network, view: FacilityView): ChartSpec[] {
  const f: NetworkFacility = view.facility;
  const disposal: number = view.system.disposal_site.pressure_psi;
  const limits = network.defaults.tank_limits_pct;
  const level: ChartSpec = {
    title: "Tank level (%)",
    lines: [[f.tank.id, "level_pct", "level"]],
    references: [
      { label: `shutdown ${limits.shutdown}`, value: limits.shutdown },
      { label: `warning ${limits.warning}`, value: limits.warning },
    ],
    events: ["pump_failure"],
  };
  const inOut: ChartSpec = {
    title: "Into the tank vs pumped out (bpd)",
    lines: [[f.id, "inflow_bpd", "inflow"], [f.pump.id, "flow_bpd", "pumped"]],
    pumpShade: true,
    events: ["pump_failure"],
  };
  const pressure: ChartSpec = {
    title: "Pipeline pressure at the disposal site (psi)",
    lines: [[f.pipeline.id, "pressure_psi", "pressure"]],
    references: [{ label: `healthy pumping ${disposal + PIPELINE_RUNNING_OFFSET_PSI}`, value: disposal + PIPELINE_RUNNING_OFFSET_PSI }],
    pumpShade: true,
    events: ["pipeline_leak"],
  };
  const discharge: ChartSpec = {
    title: "Pump discharge pressure (psi)",
    lines: [[f.pump.id, "discharge_psi", "discharge"]],
    references: [{ label: `healthy pumping ${disposal + DISCHARGE_RUNNING_OFFSET_PSI}`, value: disposal + DISCHARGE_RUNNING_OFFSET_PSI }],
    pumpShade: true,
    events: ["pump_degradation", "pump_failure"],
  };
  switch (component) {
    case SUMMARY:
      return [level, inOut, pressure, discharge];
    case "tank":
      return [
        {
          ...level,
          references: [
            ...(level.references ?? []),
            { label: `pump starts ${f.pump.start_level_pct}`, value: f.pump.start_level_pct },
            { label: `pump stops ${f.pump.stop_level_pct}`, value: f.pump.stop_level_pct },
          ],
        },
        inOut,
      ];
    case "pump":
      return [
        { title: "Pump status (0 off, 1 running, 2 fault)", lines: [[f.pump.id, "status", "status"]], step: true, domain: [0, 2], events: ["pump_failure", "pump_degradation"] },
        {
          title: "Pump flow (bpd)",
          lines: [[f.pump.id, "flow_bpd", "flow"]],
          references: [{ label: `rated ${f.pump.max_flow_bpd}`, value: f.pump.max_flow_bpd }],
          pumpShade: true,
          events: ["pump_degradation", "pump_failure"],
        },
        discharge,
      ];
    case "pipeline":
      return [
        pressure,
        {
          title: "Pumped vs received at the disposal site (bpd)",
          lines: [[f.pump.id, "flow_bpd", "pumped"], [f.pipeline.id, "receive_flow_bpd", "received"]],
          pumpShade: true,
          events: ["pipeline_leak"],
        },
      ];
    default: {
      const well: NetworkWell | undefined = f.wells.find((w) => w.id === component);
      if (!well) return [];
      return [
        {
          title: "Water rate (bpd)",
          lines: [[well.id, "water_bpd", "water"]],
          references: [{ label: `baseline ${well.baseline_water_bpd}`, value: well.baseline_water_bpd }],
          events: ["pump_failure"],
        },
        { title: "Well status (1 producing, 0 shut in)", lines: [[well.id, "status", "status"]], step: true, domain: [0, 1], events: ["pump_failure"] },
      ];
    }
  }
}

/** Pump-off and fault stretches inside the window, as chart bands. */
function pumpBands(status: Series | undefined, from: number, to: number): Band[] {
  if (!status) return [];
  const s: Series = slice(status, from, to);
  const out: Band[] = [];
  for (let i = 0; i < s.t.length; ) {
    const v: number = s.v[i];
    let j: number = i + 1;
    while (j < s.t.length && s.v[j] === v) j++;
    if (v !== PUMP_RUNNING) out.push({ from: s.t[i], to: j < s.t.length ? s.t[j] : to, className: v === PUMP_FAULT ? "fault-band" : "off-band" });
    i = j;
  }
  return out;
}

function componentLabel(component: ComponentId, f: NetworkFacility): string {
  if (component === SUMMARY) return "Facility summary";
  if (component === "tank") return `Tank ${f.tank.id}`;
  if (component === "pump") return `Pump ${f.pump.id}`;
  if (component === "pipeline") return `Pipeline ${f.pipeline.id}`;
  return `Well ${component}`;
}

interface Props {
  view: FacilityView;
  network: Network;
  telemetry: Telemetry | null;
  events: DetectedEvent[]; // every event at this facility known as of now (ongoing and resolved)
  selected: DetectedEvent | undefined; // the alert picked in the side panels, if it is at this facility
  now: number;
  start: number;
  component: ComponentId;
  onComponent: (c: ComponentId) => void;
  onBack: () => void;
}

export function FacilityPage({ view, network, telemetry, events, selected, now, start, component, onComponent, onBack }: Props) {
  const [hours, setHours] = useState<number | null>(24);
  const [cursor, setCursor] = useState<number | null>(null);
  const f: NetworkFacility = view.facility;
  const at = (asset: string, metric: string): number | undefined => (telemetry ? valueAt(telemetry, asset, metric, now) : undefined);
  const limits = network.defaults.tank_limits_pct;

  const ongoing = (cats: Category[]): DetectedEvent | undefined => view.events.find((e) => cats.includes(e.category));
  const pumpEvent: DetectedEvent | undefined = ongoing(["pump_failure", "pump_degradation"]);
  const pumpStatus: number | undefined = view.pumpStatus;
  const running: boolean = pumpStatus === PUMP_RUNNING;
  const pumped: number | undefined = at(f.pump.id, "flow_bpd");
  const received: number | undefined = at(f.pipeline.id, "receive_flow_bpd");
  const level: number = Math.max(0, Math.min(100, view.levelPct ?? 0));

  const card = (id: ComponentId, className: string, body: ReactNode) => (
    <button key={id} className={`pf-card ${className} ${component === id ? "selected" : ""}`} onClick={() => onComponent(component === id ? SUMMARY : id)}>
      {body}
    </button>
  );
  const badge = (e: DetectedEvent | undefined) => e && <span className={`pf-badge ${e.category}`}>{CATEGORY_LABEL[e.category]}</span>;

  const from: number = hours === null ? start : Math.max(start, now - hours * HOUR);
  const to: number = Math.max(now, from + 1);
  const pumpStatusSeries: Series | undefined = telemetry?.get(seriesKey(f.pump.id, "status"));
  const shade: Band[] = pumpBands(pumpStatusSeries, from, to);

  return (
    <div className="facility-page">
      <div className="fp-head">
        <button className="back-button" onClick={onBack} title="Back to the system map (Esc)">
          ← {view.system.id} map
        </button>
        <h2>
          {view.system.id} · {shortName(f.id)}
        </h2>
        <span className={`hc-status status-${view.status}`}>{STATUS_LABEL[view.status]}</span>
        {view.plan && !view.plan.tripped && view.plan.trips_at_unix !== null && (
          <span className="fp-countdown">shutdown in {view.plan.hours_to_limit.p50.toFixed(1)} h</span>
        )}
      </div>

      <div className="process">
        <div className="pf-col pf-wells">
          {f.wells.map((w) => {
            const on: boolean = at(w.id, "status") === 1;
            return card(
              w.id,
              `pf-well ${on ? "" : "off"}`,
              <>
                <span className="pf-name">{shortName(w.id)}</span>
                <span className="pf-value">{fmt(at(w.id, "water_bpd"))} bpd</span>
                <span className="pf-sub">{on ? "producing" : "shut in"}</span>
              </>,
            );
          })}
        </div>
        <div className={`pf-link ${f.wells.some((w) => at(w.id, "status") === 1) ? "flowing" : ""}`} />
        {card(
          "tank",
          `pf-tank status-${view.status}`,
          <>
            <span className="pf-name">Tank</span>
            <svg viewBox="0 0 40 56" width={40} height={56} aria-hidden="true">
              <rect className="tank-shell" x={8} y={2} width={24} height={52} rx={3} />
              <rect className="tank-fill" x={8} y={2 + 52 * (1 - level / 100)} width={24} height={(52 * level) / 100} />
              <line className="tank-warning" x1={4} x2={36} y1={2 + 52 * (1 - limits.warning / 100)} y2={2 + 52 * (1 - limits.warning / 100)} />
              <line className="tank-limit" x1={3} x2={37} y1={2 + 52 * (1 - limits.shutdown / 100)} y2={2 + 52 * (1 - limits.shutdown / 100)} />
            </svg>
            <span className="pf-value">{fmt(view.levelPct, 1)}%</span>
            <span className="pf-sub">
              {view.levelPct === undefined ? "–" : fmt((view.levelPct / 100) * f.tank.capacity_bbl)} / {fmt(f.tank.capacity_bbl)} bbl
            </span>
            <span className="pf-sub">in {fmt(at(f.id, "inflow_bpd"))} bpd</span>
          </>,
        )}
        <div className={`pf-link ${running ? "flowing" : ""}`} />
        {card(
          "pump",
          `pf-pump ${pumpStatus === PUMP_FAULT ? "fault" : running ? "running" : "idle"} ${pumpEvent?.category ?? ""}`,
          <>
            <span className="pf-name">Pump</span>
            <span className="pf-value">{PUMP_TEXT[pumpStatus ?? -1] ?? "–"}</span>
            <span className="pf-sub">
              {fmt(pumped)} / {fmt(f.pump.max_flow_bpd)} bpd
            </span>
            <span className="pf-sub">discharge {fmt(at(f.pump.id, "discharge_psi"))} psi</span>
            {badge(pumpEvent)}
          </>,
        )}
        <div className={`pf-link pipe ${running ? "flowing" : ""} ${view.leak ? "leak" : ""}`} />
        {card(
          "pipeline",
          `pf-pipeline ${view.leak ? "pipeline_leak" : running ? "running" : "idle"}`,
          <>
            <span className="pf-name">Pipeline</span>
            <span className="pf-value">{fmt(at(f.pipeline.id, "pressure_psi"))} psi</span>
            <span className="pf-sub">received {fmt(received)} bpd</span>
            <span className="pf-sub">
              {running && pumped ? `lost ${(((pumped - (received ?? 0)) / pumped) * 100).toFixed(1)}%` : "no flow"}
            </span>
            {badge(view.leak)}
          </>,
        )}
        <div className={`pf-link ${running ? "flowing" : ""}`} />
        <div className="pf-card pf-disposal" title="Shared by every facility in the system; no sensors of its own">
          <span className="pf-name">{view.system.id} disposal</span>
          <span className="pf-value">{fmt(view.system.disposal_site.pressure_psi)} psi</span>
          <span className="pf-sub">fixed</span>
        </div>
      </div>

      {selected && <EventInfo event={selected} />}

      <div className="fp-charts-head">
        <h3>{componentLabel(component, f)}</h3>
        {component !== SUMMARY && (
          <button className="link-button small" onClick={() => onComponent(SUMMARY)}>
            Summary
          </button>
        )}
        <span className="fp-legend">
          <span className="sw off-band" /> pump off <span className="sw fault-band" /> pump fault <span className="sw ev-band" /> detected event
        </span>
        <div className="fp-windows" role="group" aria-label="Chart window">
          {WINDOWS.map((w) => (
            <button key={w.label} className={hours === w.hours ? "active" : ""} onClick={() => setHours(w.hours)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <div className="fp-charts">
        {!telemetry && <p className="muted">Loading telemetry…</p>}
        {telemetry &&
          chartSpecs(component, network, view).map((spec) => {
            const lines: Line[] = spec.lines.flatMap(([asset, metric, label], i) => {
              const s: Series | undefined = telemetry.get(seriesKey(asset, metric));
              return s ? [{ label, color: COLORS[i % COLORS.length], series: slice(s, from, to) }] : [];
            });
            const relevant: DetectedEvent[] = events.filter((e) => spec.events.includes(e.category));
            const bands: Band[] = [
              ...(spec.pumpShade ? shade : []),
              ...relevant.map((e) => ({ from: e.onset_unix, to: e.end_unix ?? now, className: `ev-band ${e.category}` })),
            ];
            const markers: Marker[] = relevant.map((e) => ({
              t: e.alarm_unix,
              label: `${CATEGORY_LABEL[e.category]} detected ${hhmm(e.alarm_unix)}`,
              className: `alarm-marker ${e.category}`,
            }));
            return (
              <LineChart
                key={spec.title}
                title={spec.title}
                lines={lines}
                from={from}
                to={to}
                bands={bands}
                references={spec.references}
                markers={markers}
                step={spec.step}
                domain={spec.domain}
                cursor={cursor}
                onCursor={setCursor}
              />
            );
          })}
      </div>
    </div>
  );
}
