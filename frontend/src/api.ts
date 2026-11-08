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
  verification: Verification | null; // worn pumps only
}

// Mirrors backend/app/verify.py verify_wear: is the pump really wearing out, and when will it fail?
export interface Verification {
  status: "pending" | "verified" | "not_verified" | "ended_before_check";
  check_unix: number; // alarm + 6 h: when the verdict is given
  hours_seen: number; // hours of readings after the alarm so far (capped at 6)
  efficiency_before: number | null; // flow / max_flow, 2 h before the alarm
  efficiency_after: number | null; // same, alarm .. alarm + 6 h
  discharge_before_psi: number | null; // below (−) the healthy running value
  discharge_after_psi: number | null;
  slope_pct_per_h: number | null; // efficiency trend after the alarm
  slope_z: number | null;
  forecast_fail_unix: number | null; // when the trend reaches 86 % efficiency (verified only)
}

export interface EventsResponse {
  dataset: string;
  start_unix: number;
  now_unix: number;
  now_ts: string;
  alert_order: string[]; // ongoing event IDs in alerts-view order
  events: DetectedEvent[];
  early_fix: EarlyFix;
}

// Mirrors backend/app/whatif.py EarlyFix.to_json: the same "now" if every leak and worn pump had been
// fixed when first flagged. Event keys match the recorded events.
export interface EarlyFix {
  alert_order: string[];
  events: DetectedEvent[];
  prevented: {
    failure_id: string;
    asset_id: string;
    wear_id: string;
    fixed_unix: number;
    failure_unix: number;
    lead_hours: number;
    cost_avoided: number; // the recorded failure's plan cost
  }[];
  leaks: { event_id: string; bbl_saved: number }[];
  cost_recorded: number; // every failure plan's cost, as recorded
  cost_early_fix: number; // the same after re-planning without the prevented failures
}

export type Scenario = "recorded" | "early_fix";

/**
 * The same state as a console without our early signals would show it: leaks and worn pumps only
 * appear once the standard threshold confirms them (no "suspected" stage), and a worn pump is never
 * shown at all (no early warning), so failures arrive unannounced.
 */
export function withoutEarly(s: EventsResponse): EventsResponse {
  const events: DetectedEvent[] = s.events
    .filter((e) => e.category !== "pump_degradation")
    .filter((e) => e.category === "pump_failure" || (e.confirmed_unix !== null && e.confirmed_unix <= s.now_unix))
    .map((e) => (e.category === "pump_failure" ? e : { ...e, alarm_unix: e.confirmed_unix ?? e.alarm_unix }));
  const kept = new Set<string>(events.map((e) => e.event_id));
  return { ...s, events, alert_order: s.alert_order.filter((id) => kept.has(id)) };
}

/** The state as the UI shows it: as recorded, or the early-fix what-if in the same shape. */
export const inScenario = (s: EventsResponse, scenario: Scenario): EventsResponse =>
  scenario === "recorded" ? s : { ...s, events: s.early_fix.events, alert_order: s.early_fix.alert_order };

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

/** One crew member (backend/contacts.json; placeholder data for now). */
export interface Contact {
  id: string;
  name: string;
  role: "supervisor" | "driver" | "inspector" | "maintenance" | "operator";
  title: string;
  system: string | null;
  phone: string;
  email: string;
}

export interface NotifyResult {
  event_id: string;
  sent_unix: number;
  message: string;
  results: { to: string; phone: string; email: string; status: string }[];
  unknown: string[];
}

export async function fetchContacts(): Promise<Contact[]> {
  return (await readJson<{ contacts: Contact[] }>(await fetch("/api/contacts"), "contacts")).contacts;
}

/** Send a decision to crew members. The backend sender is a placeholder: nothing is delivered yet. */
export async function sendNotify(eventId: string, contactIds: string[], message: string): Promise<NotifyResult> {
  const res: Response = await fetch("/api/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event_id: eventId, contact_ids: contactIds, message }),
  });
  return readJson<NotifyResult>(res, "notify");
}

/** What the presenter's console is showing, for phones on /live (backend /api/live). */
export interface LiveInfo {
  dataset_id: string;
  name: string;
  start_unix: number;
  end_unix: number;
  step_s: number;
  now: number;
  early: boolean;
}

export async function fetchLive(): Promise<LiveInfo | null> {
  return (await readJson<{ live: LiveInfo | null }>(await fetch("/api/live"), "live")).live;
}

/** Presenter: publish the dataset and replay position. Failures are ignored (viewers just lag). */
export function publishLive(datasetId: string, now: number, early: boolean): void {
  fetch("/api/live", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataset_id: datasetId, now, early }),
  }).catch(() => undefined);
}

export function clearLive(): void {
  fetch("/api/live", { method: "DELETE" }).catch(() => undefined);
}
