// Types mirror backend/app/detect.py Event.to_json and the parts of network.json the UI reads.

export type Category = "pump_failure" | "pipeline_leak" | "pump_degradation";

export interface Action {
  type: string;
  asset_id?: string;
}

export interface PlanOption {
  summary: string;
  est_cost: number;
  trucks: number;
  trips_per_truck: number;
  truck_arrivals_unix: number[];
  shut_ins: { well_id: string; start_after_min: number; start_unix: number; cost: number }[];
  accept_trip: boolean;
  actions: Action[];
}

// Mirrors backend/app/plan.py FailurePlan.to_json.
export interface Planning {
  plan_mode: "at_onset" | "joint_now";
  planned_at_unix: number;
  level_pct: number;
  hours_to_limit: { p50: number };
  trips_at_unix: number | null; // null: stays under shutdown until the repair
  repair_end_unix: number;
  tripped: boolean;
  lost_revenue_per_hour: number;
  trucks_available: number;
  fleet_size: number;
  shares_with: string[];
  plan: PlanOption;
  alternatives: (PlanOption & { label: string })[];
}

export interface DetectedEvent {
  event_id: string;
  system_id: string;
  facility_id: string;
  asset_id: string;
  category: Category;
  status: "ongoing" | "resolved";
  onset_ts: string;
  onset_unix: number;
  alarm_unix: number; // when the detector first fired, "suspected" (onset is back-dated from here)
  confirmed_unix: number | null; // when the evidence reached the standard threshold; null: not (yet)
  end_ts: string | null;
  end_unix: number | null;
  confidence: number;
  evidence: string[];
  hours_to_limit: { p50: number } | null;
  recommended_actions: Action[];
  planning: Planning | null; // pump failures only
}

export interface EventsResponse {
  dataset: string;
  start_unix: number;
  now_unix: number;
  now_ts: string;
  alert_order: string[]; // ongoing event IDs in alerts-view order
  events: DetectedEvent[];
}

export interface NetworkWell {
  id: string;
  baseline_water_bpd: number;
  oil_bpd: number;
  gas_mcfd: number;
}

export interface NetworkFacility {
  id: string;
  lat: number;
  lon: number;
  tank: { id: string; capacity_bbl: number };
  pump: { id: string; max_flow_bpd: number; start_level_pct: number; stop_level_pct: number };
  pipeline: { id: string };
  wells: NetworkWell[];
}

export interface NetworkSystem {
  id: string;
  center: [number, number]; // [lat, lon]
  truck_yard: [number, number]; // [lat, lon]
  disposal_site: { id: string; lat: number; lon: number; pressure_psi: number };
  facilities: NetworkFacility[];
}

export interface Network {
  defaults: { tank_limits_pct: { warning: number; shutdown: number } };
  systems: NetworkSystem[];
}

export interface Ops {
  prices: { oil_per_bbl: number; gas_per_mcf: number };
  systems: Record<string, { emergency_fleet_size: number }>;
}

/** A dataset the backend has parsed and keeps for this session. */
export interface DatasetInfo {
  dataset_id: string;
  name: string;
  start_unix: number;
  end_unix: number;
  step_s: number;
}

/**
 * Event IDs are numbered in onset order as of "now", so they can shift while scrubbing (a slow
 * problem detected later may have an earlier, back-dated onset). Asset + category + onset is stable.
 */
export const eventKey = (e: DetectedEvent): string => `${e.asset_id}|${e.category}|${e.onset_unix}`;

/** The three files of one dataset folder, as chosen in the OS folder picker. */
export interface DatasetFiles {
  name: string; // the chosen folder's name
  network: File;
  ops: File;
  telemetry: File;
}

const REQUIRED = ["network.json", "ops.json", "telemetry.csv"] as const;

/**
 * Pick the three files out of a folder selection. Only files directly inside the chosen folder count
 * (webkitRelativePath is "<folder>/<file>"), so choosing a parent like data/ is rejected rather than guessed.
 */
export function datasetFromFolder(files: FileList): DatasetFiles {
  const top = new Map<string, File>();
  let name = "";
  for (const file of Array.from(files)) {
    const parts: string[] = file.webkitRelativePath.split("/");
    name = parts[0];
    if (parts.length === 2) top.set(parts[1], file);
  }
  const missing: string[] = REQUIRED.filter((f) => !top.has(f));
  if (missing.length) {
    throw new Error(`"${name}" must directly contain ${REQUIRED.join(", ")} (missing: ${missing.join(", ")}).`);
  }
  return { name, network: top.get("network.json")!, ops: top.get("ops.json")!, telemetry: top.get("telemetry.csv")! };
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const body: { detail?: unknown } = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `${what} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** Upload the folder's files once; the backend keeps the parsed dataset for replay. */
export async function uploadDataset(ds: DatasetFiles): Promise<DatasetInfo> {
  const form = new FormData();
  form.append("name", ds.name);
  form.append("network", ds.network);
  form.append("ops", ds.ops);
  form.append("telemetry", ds.telemetry);
  return readJson<DatasetInfo>(await fetch("/api/datasets", { method: "POST", body: form }), "upload");
}

/** Detection and plans as an operator would have seen them at `now`. */
export async function fetchState(datasetId: string, now: number): Promise<EventsResponse> {
  return readJson<EventsResponse>(await fetch(`/api/datasets/${datasetId}/state?now=${now}`), "analysis");
}
