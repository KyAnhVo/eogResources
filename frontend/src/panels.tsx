// Alert list (left panel), the action strip above the map, and the event details shown on the
// facility page.

import {
  eventKey,
  type Category,
  type DetectedEvent,
  type EarlyFix,
  type EventsResponse,
  type Planning,
} from "./api";
import { earlyWarnings, hoursText, isSuspected, soonerMinutes, stageText, warningIndex, type Warning } from "./early";
import { hhmm, money, shortName } from "./status";

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
/** Strip above the map: what to do and by when for the selected alert, nothing else. */
export function ActionBar({ event, now, onOpenFacility, onClose }: {
  event: DetectedEvent;
  now: number;
  onOpenFacility?: () => void;
  onClose: () => void;
}) {
  const p: Planning | null = event.planning;
  const ongoing: boolean = event.status === "ongoing";
  const suspected: boolean = event.category !== "pump_failure" && isSuspected(event, now);
  const sooner: number | null = soonerMinutes(event);
  return (
    <section className={`action-bar ${event.category} ${ongoing ? "" : "resolved"}`}>
      <div className="action-what">
        <strong>
          {CATEGORY_LABEL[event.category]} · {event.asset_id}
          {suspected && <span className="stage-chip suspected" title="The fast rule fired; the standard threshold hasn't been reached yet">◌ Suspected</span>}
          {!suspected && event.category !== "pump_failure" && sooner !== null && sooner > 0 && (
            <span className="stage-chip confirmed" title={`Suspected ${hhmm(event.alarm_unix)}, confirmed ${hhmm(event.confirmed_unix ?? 0)}`}>
              ● Confirmed · flagged {sooner} min sooner
            </span>
          )}
        </strong>
        {p && <span className="countdown">{countdownText(p, ongoing)}</span>}
      </div>
      <div className="action-do">
        <span className="action-label">{ongoing ? "Action required" : `Resolved ${event.end_ts?.slice(5, 16).replace("T", " ")} · was planned`}</span>
        <span className="action">{actionText(event)}</span>
      </div>
      {onOpenFacility && (
        <button className="link-button small" onClick={onOpenFacility}>
          Open {shortName(event.facility_id)} →
        </button>
      )}
      <button className="action-close" onClick={onClose} title="Deselect (Esc)" aria-label="Deselect">
        ×
      </button>
    </section>
  );
}

/** Same strip for an alert picked on the timeline that isn't known yet at `now`. */
export function PendingBar({ event, onJump, onClose }: { event: DetectedEvent; onJump: () => void; onClose: () => void }) {
  return (
    <section className="action-bar resolved">
      <div className="action-what">
        <strong>
          {CATEGORY_LABEL[event.category]} · {event.asset_id}
        </strong>
        <span className="muted">
          Not known at this time: first detected {new Date(event.alarm_unix * 1000).toISOString().slice(5, 10)} at {hhmm(event.alarm_unix)}
        </span>
      </div>
      <button className="link-button small" onClick={onJump}>
        Jump to detection
      </button>
      <button className="action-close" onClick={onClose} title="Deselect (Esc)" aria-label="Deselect">
        ×
      </button>
    </section>
  );
}

/** Facility page: why the event fired and how the plan was chosen. */
export function EventInfo({ event, now }: { event: DetectedEvent; now: number }) {
  const confirmed: string =
    event.category === "pump_failure" || event.confirmed_unix === event.alarm_unix
      ? `detected ${hhmm(event.alarm_unix)}`
      : isSuspected(event, now)
        ? `suspected ${hhmm(event.alarm_unix)}, not confirmed`
        : `suspected ${hhmm(event.alarm_unix)} · confirmed ${hhmm(event.confirmed_unix ?? 0)} (${soonerMinutes(event)} min sooner)`;
  return (
    <section className="event-info">
      <h3>
        {CATEGORY_LABEL[event.category]} · {event.asset_id}
      </h3>
      <p className="meta">
        {event.status} · onset {event.onset_ts.slice(5, 16).replace("T", " ")} · {confirmed}
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

/** Early-warning line under a row: a wear alarm that preceded a failure, seen from either end. */
function warningNote(e: DetectedEvent, w: Warning | undefined, now: number): string | null {
  if (e.category === "pump_degradation" && e.status === "ongoing") {
    return now > e.alarm_unix ? `may fail · worn for ${hoursText((now - e.alarm_unix) / 3600)}` : "may fail · just detected";
  }
  if (!w?.failure || w.leadHours === undefined) return null;
  return e.category === "pump_degradation" ? `failed ${hoursText(w.leadHours)} later` : `warned ${hoursText(w.leadHours)} ahead`;
}

export function EventRow({ event, selected, onSelect, note, stage }: {
  event: DetectedEvent;
  selected: boolean;
  onSelect: () => void;
  note?: string | null; // early warning (worn pump → failure)
  stage?: string | null; // suspected / flagged before confirmation
}) {
  return (
    <li>
      <button className={`row ${event.category} ${selected ? "selected" : ""} ${note ? "early" : ""}`} onClick={onSelect}>
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
        {stage && <span className="stage-note">◌ {stage}</span>}
        {note && <span className="early-note">⚑ {note}</span>}
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
  const inProgress: DetectedEvent[] = state.alert_order.flatMap((id) => byId.get(id) ?? []);
  // Ongoing wear is a forecast, not a breakdown: it gets its own section so it isn't read as one.
  const warnings: DetectedEvent[] = inProgress.filter((e) => e.category === "pump_degradation");
  const ongoing: DetectedEvent[] = inProgress.filter((e) => e.category !== "pump_degradation");
  const resolved: DetectedEvent[] = state.events
    .filter((e) => e.status === "resolved")
    .sort((a, b) => (b.end_unix ?? 0) - (a.end_unix ?? 0));
  const links: Map<string, Warning> = warningIndex(earlyWarnings(state.events)); // only what is known at "now"
  const row = (e: DetectedEvent) => (
    <EventRow
      key={eventKey(e)}
      event={e}
      selected={eventKey(e) === selectedKey}
      onSelect={() => onSelect(e)}
      note={warningNote(e, links.get(eventKey(e)), state.now_unix)}
      stage={stageText(e, state.now_unix)}
    />
  );
  return (
    <>
      <h2>In progress ({ongoing.length})</h2>
      {ongoing.length === 0 && <p className="muted">Nothing in progress.</p>}
      <ul>{ongoing.map(row)}</ul>
      {warnings.length > 0 && (
        <div className="early-section">
          <h2>⚑ Early warnings ({warnings.length})</h2>
          <p className="muted">A worn pump is the only sign seen before a failure: inspect it before it faults.</p>
          <ul>{warnings.map(row)}</ul>
        </div>
      )}
      <h2>Resolved ({resolved.length})</h2>
      <ul>{resolved.map(row)}</ul>
    </>
  );
}

/** Left panel, what-if only: what fixing every early flag at once would have changed by "now". */
export function WhatIfSummary({ fix }: { fix: EarlyFix }) {
  const saved: number = fix.cost_recorded - fix.cost_early_fix;
  const bbl: number = fix.leaks.reduce((sum, l) => sum + l.bbl_saved, 0);
  const day = (unix: number): string => new Date(unix * 1000).toISOString().slice(5, 16).replace("T", " ");
  return (
    <section className="whatif">
      <h2>What-if: fix at first flag</h2>
      <p className="muted">
        Each leak and worn pump is fixed the moment it is first flagged, using only what was known then (repairs are free:
        ops.json prices none). A fault that ends a wear span is treated as caused by it. Remaining failures are re-planned;
        map and chart readings stay as recorded.
      </p>
      <dl>
        <dt>Response cost</dt>
        <dd>
          {money(fix.cost_recorded)} → {money(fix.cost_early_fix)}
          {saved > 0 && <strong> · saves {money(saved)}</strong>}
        </dd>
        <dt>Failures prevented</dt>
        <dd>{fix.prevented.length}</dd>
        <dt>Leaked water avoided</dt>
        <dd>{Math.round(bbl).toLocaleString("en-US")} bbl</dd>
      </dl>
      {fix.prevented.length > 0 && (
        <ul>
          {fix.prevented.map((p) => (
            <li key={p.failure_id}>
              {p.asset_id}: fixed {day(p.fixed_unix)}, {hoursText(p.lead_hours)} before it faulted · {money(p.cost_avoided)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
