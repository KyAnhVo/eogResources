// Side panels: alert list, the right panel (action required, network navigation), and the event
// details shown on the facility page.

import {
  eventKey,
  type Category,
  type DetectedEvent,
  type EventsResponse,
  type Network,
  type Ops,
  type Planning,
} from "./api";
import { STATUS_LABEL, hhmm, money, shortName, type FacilityView } from "./status";

export const CATEGORY_LABEL: Record<Category, string> = {
  pump_failure: "Pump failure",
  pipeline_leak: "Pipeline leak",
  pump_degradation: "Pump wearing out",
};



function actionText(e: DetectedEvent): string {
  if (e.planning) return e.planning.plan.summary;
  const urgent: string = e.category === "pipeline_leak" ? "Urgent: send" : "Send";
  return `${urgent} an inspector to ${e.asset_id}`;
}

/** One line on when the tank shuts in if nobody acts. */
function countdownText(p: Planning, ongoing: boolean): string {
  if (p.tripped) return `Shut in now; wells restart at the repair (${hhmm(p.repair_end_unix)})`;
  if (p.trips_at_unix === null) return `Stays under shutdown until the repair at ${hhmm(p.repair_end_unix)}`;
  const lead: string = ongoing ? `Shutdown in ${p.hours_to_limit.p50.toFixed(1)} h, at` : "Would have shut down at";
  return `${lead} ${hhmm(p.trips_at_unix)} if nothing is done; repair at ${hhmm(p.repair_end_unix)}`;
}

function fleetText(p: Planning): string {
  if (p.plan_mode === "at_onset") return `Planned at onset with ${p.trucks_available} of ${p.fleet_size} trucks free`;
  if (p.shares_with.length === 0) return `Planned from now with the system's ${p.fleet_size} trucks`;
  const others: string = p.shares_with.join(", ");
  return `Planned from now together with ${others} (fleet of ${p.fleet_size}; ${p.trucks_available} could go here, ${p.plan.trucks} sent)`;
}

function PlanPanel({ event }: { event: DetectedEvent }) {
  const p: Planning | null = event.planning;
  if (!p) return null;
  return (
    <div className="plan">
      <p className="meta">
        {fleetText(p)} · level {p.level_pct}% · lost revenue if shut in {money(p.lost_revenue_per_hour)}/h
      </p>
      {p.alternatives.length > 0 && (
        <table className="options">
          <thead>
            <tr>
              <th>Option</th>
              <th>What happens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {p.alternatives.map((alt) => (
              <tr key={alt.label} className={alt.summary === p.plan.summary ? "chosen" : ""}>
                <td>{alt.label}</td>
                <td>{alt.summary.replace(/ \(~\$[\d,]+\)$/, "")}</td>
                <td>{money(alt.est_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Right panel: only what to do and by when, plus a way to the details. */
export function EventAction({ event, onOpenFacility }: { event: DetectedEvent; onOpenFacility?: () => void }) {
  const p: Planning | null = event.planning;
  const ongoing: boolean = event.status === "ongoing";
  return (
    <section className="detail action-card">
      <h2>
        {CATEGORY_LABEL[event.category]} · {event.asset_id}
      </h2>
      {p && <p className="countdown">{countdownText(p, ongoing)}</p>}
      <p className="action-label">{ongoing ? "Action required" : `Resolved ${event.end_ts?.slice(5, 16).replace("T", " ")} · was planned`}</p>
      <p className="action">{actionText(event)}</p>
      {onOpenFacility && (
        <button className="link-button" onClick={onOpenFacility}>
          Open {shortName(event.facility_id)} →
        </button>
      )}
    </section>
  );
}

/** Facility page: why the event fired and how the plan was chosen. */
export function EventInfo({ event }: { event: DetectedEvent }) {
  return (
    <section className="event-info">
      <h3>
        {CATEGORY_LABEL[event.category]} · {event.asset_id}
      </h3>
      <p className="meta">
        {event.status} · onset {event.onset_ts.slice(5, 16).replace("T", " ")} · detected {hhmm(event.alarm_unix)}
        {event.end_ts && ` · ended ${event.end_ts.slice(5, 16).replace("T", " ")}`} · confidence {Math.round(event.confidence * 100)}%
      </p>
      <ul>
        {event.evidence.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <PlanPanel event={event} />
    </section>
  );
}

export function EventRow({ event, selected, onSelect }: { event: DetectedEvent; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button className={`row ${event.category} ${selected ? "selected" : ""}`} onClick={onSelect}>
        <span className="cat">{CATEGORY_LABEL[event.category]}</span>
        <span className="asset">{event.asset_id}</span>
        <span className="when">{event.onset_ts.slice(5, 16).replace("T", " ")}</span>
        {event.status === "ongoing" && event.planning && (
          <span className={`countdown-chip ${event.planning.trips_at_unix === null ? "safe" : ""}`}>
            {event.planning.tripped
              ? "shut in"
              : event.planning.trips_at_unix === null
                ? "no trip"
                : `${event.hours_to_limit?.p50.toFixed(1)} h`}
          </span>
        )}
      </button>
    </li>
  );
}


export function AlertList({ state, selectedKey, onSelect }: {
  state: EventsResponse;
  selectedKey: string | null;
  onSelect: (e: DetectedEvent) => void;
}) {
  const byId = new Map<string, DetectedEvent>(state.events.map((e) => [e.event_id, e]));
  const ongoing: DetectedEvent[] = state.alert_order.flatMap((id) => byId.get(id) ?? []);
  const resolved: DetectedEvent[] = state.events
    .filter((e) => e.status === "resolved")
    .sort((a, b) => (b.end_unix ?? 0) - (a.end_unix ?? 0));
  const row = (e: DetectedEvent) => (
    <EventRow key={eventKey(e)} event={e} selected={eventKey(e) === selectedKey} onSelect={() => onSelect(e)} />
  );
  return (
    <>
      <h2>In progress ({ongoing.length})</h2>
      {ongoing.length === 0 && <p className="muted">Nothing in progress.</p>}
      <ul>{ongoing.map(row)}</ul>
      <h2>Resolved ({resolved.length})</h2>
      <ul>{resolved.map(row)}</ul>
    </>
  );
}

const STATUS_RANK: Record<FacilityView["status"], number> = { tripped: 4, failure: 3, wear: 2, warning: 1, ok: 0 };

/** Right panel when nothing is selected: one card per system, most urgent first. */
export function NetworkSummary({ network, ops, views, onSystem, onFacility, onSelect }: {
  network: Network;
  ops: Ops | null;
  views: Map<string, FacilityView>;
  onSystem: (systemId: string) => void;
  onFacility: (facilityId: string) => void;
  onSelect: (e: DetectedEvent) => void;
}) {
  const cards = network.systems.map((sys) => {
    const facilities: FacilityView[] = sys.facilities.flatMap((f) => views.get(f.id) ?? []);
    const events: DetectedEvent[] = facilities.flatMap((v) => v.events);
    const leaks: number = facilities.filter((v) => v.leak).length;
    const worst: number = Math.max(0, ...facilities.map((v) => STATUS_RANK[v.status]), leaks ? 2.5 : 0);
    const fleet: number = ops?.systems[sys.id]?.emergency_fleet_size ?? 0;
    const out: number = facilities.reduce((n, v) => n + (v.plan?.plan_mode === "joint_now" ? v.plan.plan.trucks : 0), 0);
    return { sys, facilities, events, worst, fleet, out };
  });
  cards.sort((a, b) => b.worst - a.worst || b.events.length - a.events.length || a.sys.id.localeCompare(b.sys.id));
  return (
    <section className="summary">
      <h2>Network</h2>
      <p className="muted">Open a system map or a facility.</p>
      {cards.map(({ sys, facilities, events, fleet, out }) => (
        <div key={sys.id} className={`system-card ${events.length ? "has-alerts" : ""}`}>
          <button className="system-card-head" onClick={() => onSystem(sys.id)}>
            <span className="system-card-name">{sys.id}</span>
            <span className="muted">
              {events.length ? `${events.length} in progress` : "all normal"} · trucks {fleet - out}/{fleet} free
            </span>
          </button>
          <div className="system-card-facilities">
            {facilities.map((v) => (
              <button
                key={v.facility.id}
                className={`fac-pill status-${v.status} ${v.leak ? "leak" : ""}`}
                title={`${STATUS_LABEL[v.status]}${v.leak ? " · leak" : ""}`}
                onClick={() => onFacility(v.facility.id)}
              >
                {shortName(v.facility.id).replace("FACILITY ", "")}
              </button>
            ))}
          </div>
          {events.map((e) => (
            <button key={eventKey(e)} className="system-card-event" onClick={() => onSelect(e)}>
              {CATEGORY_LABEL[e.category]} · {e.asset_id}
              {e.planning && !e.planning.tripped && e.planning.trips_at_unix !== null && ` · shutdown in ${e.planning.hours_to_limit.p50.toFixed(1)} h`}
              {e.planning?.tripped && " · shut in"}
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}
