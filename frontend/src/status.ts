// What each facility, pipe and well looks like at "now": backend events (detected as of now)
// combined with the raw readings at now from the telemetry parsed in the browser.

import type { DetectedEvent, EventsResponse, Network, NetworkFacility, NetworkSystem, Planning } from "./api";
import { valueAt, type Telemetry } from "./telemetry";

/** Worst first; a facility shows its worst state. Leaks belong to the pipe, not the facility. */
export type FacilityStatus = "tripped" | "failure" | "wear" | "warning" | "ok";

export const PUMP_RUNNING = 1;
export const PUMP_FAULT = 2;

export interface FacilityView {
  facility: NetworkFacility;
  system: NetworkSystem;
  status: FacilityStatus;
  levelPct: number | undefined;
  pumpStatus: number | undefined;
  leak: DetectedEvent | undefined; // ongoing leak on this facility's pipeline
  events: DetectedEvent[]; // every ongoing event at this facility, alert order
  plan: Planning | undefined; // ongoing pump failure's plan
}

export function facilityViews(
  network: Network,
  state: EventsResponse | null,
  telemetry: Telemetry | null,
  now: number,
): Map<string, FacilityView> {
  const ongoing: DetectedEvent[] = [];
  if (state) {
    const byId = new Map<string, DetectedEvent>(state.events.map((e) => [e.event_id, e]));
    for (const id of state.alert_order) {
      const e: DetectedEvent | undefined = byId.get(id);
      if (e) ongoing.push(e);
    }
  }
  const warningPct: number = network.defaults.tank_limits_pct.warning;
  const out = new Map<string, FacilityView>();
  for (const system of network.systems) {
    for (const facility of system.facilities) {
      const events: DetectedEvent[] = ongoing.filter((e) => e.facility_id === facility.id);
      const failure: DetectedEvent | undefined = events.find((e) => e.category === "pump_failure");
      const levelPct: number | undefined = telemetry ? valueAt(telemetry, facility.tank.id, "level_pct", now) : undefined;
      let status: FacilityStatus = "ok";
      if (failure?.planning?.tripped) status = "tripped";
      else if (failure) status = "failure";
      else if (events.some((e) => e.category === "pump_degradation")) status = "wear";
      else if (levelPct !== undefined && levelPct >= warningPct) status = "warning";
      out.set(facility.id, {
        facility,
        system,
        status,
        levelPct,
        pumpStatus: telemetry ? valueAt(telemetry, facility.pump.id, "status", now) : undefined,
        leak: events.find((e) => e.category === "pipeline_leak"),
        events,
        plan: failure?.planning ?? undefined,
      });
    }
  }
  return out;
}

export const STATUS_LABEL: Record<FacilityStatus, string> = {
  tripped: "Shut in",
  failure: "Pump failed",
  wear: "Pump wearing out",
  warning: "Tank above warning",
  ok: "Normal",
};

export const shortName = (id: string): string => id.replace(/^[^_]+_/, "").replace(/_/g, " ");

export const hhmm = (unix: number): string => new Date(unix * 1000).toISOString().slice(11, 16);

export const money = (usd: number): string => `$${Math.round(usd).toLocaleString("en-US")}`;
