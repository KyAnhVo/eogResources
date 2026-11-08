// Floating card for whatever the mouse is over on the map: readings at "now" plus a 6-hour sparkline.

import type { ReactNode } from "react";
import type { Network, NetworkFacility, NetworkSystem } from "./api";
import { PUMP_RUNNING, hhmm, shortName, type FacilityStatus, type FacilityView } from "./status";
import { gated, seriesKey, slice, valueAt, type Series, type Telemetry } from "./telemetry";

export interface HoverTarget {
  kind: "facility" | "well" | "disposal" | "yard" | "pipe";
  id: string;
  x: number; // px inside the map container
  y: number;
  width: number; // map container size, to keep the card on screen
  height: number;
}

const SPARK_HOURS = 6;
const CARD_W = 260; // matches .hover-card width
const PIPELINE_RUNNING_OFFSET_PSI = 50; // SPEC.md pressure formulas

function Sparkline({ series, reference }: { series: Series | undefined; reference?: number }) {
  if (!series) return null;
  const values: number[] = series.v.filter(Number.isFinite);
  if (values.length < 2) return <div className="spark-empty">no readings in the last {SPARK_HOURS} h</div>;
  if (reference !== undefined) values.push(reference);
  const lo: number = Math.min(...values);
  const hi: number = Math.max(...values) === lo ? lo + 1 : Math.max(...values);
  const t0: number = series.t[0];
  const t1: number = series.t[series.t.length - 1];
  const W = 200;
  const H = 34;
  const x = (t: number): number => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number): number => 2 + (1 - (v - lo) / (hi - lo)) * (H - 4);
  const segments: string[] = [];
  let current: string[] = [];
  series.t.forEach((t, i) => {
    if (Number.isFinite(series.v[i])) current.push(`${x(t).toFixed(1)},${y(series.v[i]).toFixed(1)}`);
    else if (current.length) {
      segments.push(current.join(" "));
      current = [];
    }
  });
  if (current.length) segments.push(current.join(" "));
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      {reference !== undefined && <line className="spark-ref" x1={0} x2={W} y1={y(reference)} y2={y(reference)} />}
      {segments.map((pts, i) => (
        <polyline key={i} points={pts} />
      ))}
    </svg>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="hc-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const PUMP_TEXT: Record<number, string> = { 0: "off", 1: "running", 2: "FAULT" };
const fmt = (v: number | undefined, digits = 0): string => (v === undefined ? "–" : v.toFixed(digits));

interface Props {
  target: HoverTarget;
  network: Network;
  views: Map<string, FacilityView>;
  telemetry: Telemetry | null;
  now: number;
  statusLabel: Record<FacilityStatus, string>;
}

export function HoverCard({ target, network, views, telemetry, now, statusLabel }: Props) {
  const from: number = now - SPARK_HOURS * 3600;
  const at = (asset: string, metric: string): number | undefined => (telemetry ? valueAt(telemetry, asset, metric, now) : undefined);
  const recent = (asset: string, metric: string): Series | undefined => {
    const s: Series | undefined = telemetry?.get(seriesKey(asset, metric));
    return s ? slice(s, from, now) : undefined;
  };
  const facilities: NetworkFacility[] = network.systems.flatMap((s) => s.facilities);
  const systemOf = (fac: NetworkFacility): NetworkSystem => network.systems.find((s) => s.facilities.includes(fac))!;

  let body: ReactNode = null;
  if (target.kind === "facility") {
    const view: FacilityView | undefined = views.get(target.id);
    if (!view) return null;
    const f: NetworkFacility = view.facility;
    const level: number | undefined = view.levelPct;
    const flow: number | undefined = at(f.pump.id, "flow_bpd");
    const producing: number = f.wells.filter((w) => at(w.id, "status") === 1).length;
    body = (
      <>
        <div className="hc-title">
          {view.system.id} · {shortName(f.id)} <span className={`hc-status status-${view.status}`}>{statusLabel[view.status]}</span>
        </div>
        <Row label="Tank" value={`${fmt(level, 1)}% · ${level === undefined ? "–" : Math.round((level / 100) * f.tank.capacity_bbl)} / ${f.tank.capacity_bbl} bbl`} />
        <Row label="Inflow" value={`${fmt(at(f.id, "inflow_bpd"))} bpd · ${producing}/${f.wells.length} wells on`} />
        <Row label="Pump" value={`${PUMP_TEXT[view.pumpStatus ?? -1] ?? "–"} · ${fmt(flow)} / ${f.pump.max_flow_bpd} bpd`} />
        <Row label="Discharge" value={`${fmt(at(f.pump.id, "discharge_psi"))} psi`} />
        {view.plan && !view.plan.tripped && view.plan.trips_at_unix !== null && (
          <Row label="Shutdown" value={`in ${view.plan.hours_to_limit.p50.toFixed(1)} h (${hhmm(view.plan.trips_at_unix)})`} />
        )}
        {view.plan && <div className="hc-plan">{view.plan.plan.summary}</div>}
        <div className="hc-spark-label">Tank level, last {SPARK_HOURS} h</div>
        <Sparkline series={recent(f.tank.id, "level_pct")} reference={network.defaults.tank_limits_pct.shutdown} />
      </>
    );
  } else if (target.kind === "pipe") {
    const f: NetworkFacility | undefined = facilities.find((x) => x.pipeline.id === target.id);
    if (!f) return null;
    const sys: NetworkSystem = systemOf(f);
    const view: FacilityView | undefined = views.get(f.id);
    const running: boolean = view?.pumpStatus === PUMP_RUNNING;
    const pumped: number | undefined = at(f.pump.id, "flow_bpd");
    const received: number | undefined = at(f.pipeline.id, "receive_flow_bpd");
    const healthy: number = sys.disposal_site.pressure_psi + PIPELINE_RUNNING_OFFSET_PSI;
    const pressure: Series | undefined = recent(f.pipeline.id, "pressure_psi");
    const status: Series | undefined = recent(f.pump.id, "status");
    body = (
      <>
        <div className="hc-title">
          {shortName(f.pipeline.id)} → {sys.id} disposal{" "}
          <span className={`hc-status ${view?.leak ? "status-failure" : "status-ok"}`}>{view?.leak ? "Leak" : running ? "Flowing" : "Idle"}</span>
        </div>
        {running ? (
          <>
            <Row label="Pumped" value={`${fmt(pumped)} bpd`} />
            <Row label="Received" value={`${fmt(received)} bpd`} />
            <Row label="Lost" value={pumped && received !== undefined ? `${((1 - received / pumped) * 100).toFixed(1)}%` : "–"} />
            <Row label="Pressure" value={`${fmt(at(f.pipeline.id, "pressure_psi"))} psi (healthy ${healthy})`} />
          </>
        ) : (
          <Row label="Pump" value={`${PUMP_TEXT[view?.pumpStatus ?? -1] ?? "–"}: no flow, leaks can't show until it runs`} />
        )}
        {view?.leak && <Row label="Leak detected" value={hhmm(view.leak.alarm_unix)} />}
        <div className="hc-spark-label">Pressure while pumping, last {SPARK_HOURS} h</div>
        <Sparkline series={pressure && status ? gated(pressure, status, (s) => s === PUMP_RUNNING) : pressure} reference={healthy} />
      </>
    );
  } else if (target.kind === "well") {
    const f: NetworkFacility | undefined = facilities.find((x) => x.wells.some((w) => w.id === target.id));
    const well = f?.wells.find((w) => w.id === target.id);
    if (!f || !well) return null;
    const on: boolean = at(well.id, "status") === 1;
    body = (
      <>
        <div className="hc-title">
          {shortName(well.id)} <span className={`hc-status ${on ? "status-ok" : "status-tripped"}`}>{on ? "Producing" : "Shut in"}</span>
        </div>
        <Row label="Water" value={`${fmt(at(well.id, "water_bpd"))} bpd (baseline ${well.baseline_water_bpd})`} />
        <Row label="Oil · gas" value={`${well.oil_bpd} bpd · ${well.gas_mcfd} mcfd`} />
      </>
    );
  } else if (target.kind === "disposal") {
    const sys: NetworkSystem | undefined = network.systems.find((s) => s.disposal_site.id === target.id);
    if (!sys) return null;
    body = (
      <>
        <div className="hc-title">{sys.id} disposal site</div>
        <Row label="Pressure" value={`${sys.disposal_site.pressure_psi} psi (fixed)`} />
        <Row label="Pipelines in" value={`${sys.facilities.length}`} />
      </>
    );
  } else if (target.kind === "yard") {
    const sys: NetworkSystem | undefined = network.systems.find((s) => `yard:${s.id}` === target.id);
    if (!sys) return null;
    const plans = sys.facilities.flatMap((f) => views.get(f.id)?.plan ?? []).filter((p) => p.plan_mode === "joint_now" && p.plan.trucks > 0);
    body = (
      <>
        <div className="hc-title">{sys.id} truck yard</div>
        {plans.length === 0 ? (
          <Row label="Dispatch" value="no trucks needed now" />
        ) : (
          plans.map((p, i) => <Row key={i} label={`${p.plan.trucks} truck${p.plan.trucks > 1 ? "s" : ""}`} value={p.plan.summary} />)
        )}
        <div className="hc-note">Drawn in its true direction; distance not to scale.</div>
      </>
    );
  }
  if (!body) return null;
  return (
    <div
      className="hover-card"
      style={{
        left: target.x > target.width - CARD_W - 24 ? target.x - CARD_W - 16 : target.x + 16,
        top: target.y > target.height * 0.6 ? undefined : target.y + 16,
        bottom: target.y > target.height * 0.6 ? target.height - target.y + 16 : undefined,
      }}
    >
      {body}
    </div>
  );
}
