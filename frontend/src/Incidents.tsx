// Incidents tab: a log of every incident detected as of "now", and how much time detection saved.
// - Early detection: a leak or worn pump whose fast rule fired before the standard threshold
//   confirmed it; time saved is alarm → confirmation.
// - Confirmation: the evidence reached the standard threshold (pump faults are reported by the
//   pump, so they are confirmed when detected).
// - Early warning: a worn-pump alarm that preceded the same pump's failure; lead is alarm → fault.
// Shown as its own page for the whole recording (the state as of the last reading).

import { useEffect, useMemo, useState } from "react";
import { eventKey, fetchContacts, type Category, type Contact, type DetectedEvent, type EventsResponse } from "./api";
import { CrewDirectory, noticesFor, stageIcon } from "./Notify";
import type { Sent } from "./AutoNotify";
import { earlyWarnings, hoursText, warningIndex, type Warning } from "./early";

const VERIFY_LABEL = { verified: "✓ Verified", not_verified: "✗ Not verified", pending: "Verifying…", ended_before_check: "Ended early" } as const;
import { CATEGORY_LABEL } from "./panels";
import { money } from "./status";

type Stage = "suspected" | "early" | "confirmed";

interface Incident {
  event: DetectedEvent;
  stage: Stage;
  savedMin: number; // alarm → confirmation, early detections only
  leadHours: number | undefined; // worn-pump alarm → failure, for both ends of the link
  cost: number | undefined; // pump-failure response plan
}

const CATEGORIES: Category[] = ["pump_failure", "pipeline_leak", "pump_degradation"];

const STAGE_LABEL: Record<Stage, string> = {
  suspected: "◌ Suspected",
  early: "● Early → confirmed",
  confirmed: "● Confirmed",
};

const when = (unix: number | null): string =>
  unix === null ? "—" : new Date(unix * 1000).toISOString().slice(5, 16).replace("T", " ");

function toIncident(e: DetectedEvent, now: number, links: Map<string, Warning>): Incident {
  const confirmed: boolean = e.confirmed_unix !== null && e.confirmed_unix <= now;
  const savedMin: number = confirmed ? Math.max(0, Math.round(((e.confirmed_unix ?? 0) - e.alarm_unix) / 60)) : 0;
  const stage: Stage = !confirmed ? "suspected" : savedMin > 0 ? "early" : "confirmed";
  return { event: e, stage, savedMin, leadHours: links.get(eventKey(e))?.leadHours, cost: e.planning?.plan.est_cost };
}

function durationText(min: number): string {
  if (min < 60) return `${min} min`;
  const h: number = min / 60;
  return h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} h`;
}

/** The response chosen for one incident, and why. Pump failures come from the planner (backend/app/plan.py:
 * every truck / trip / shut-in combination is costed and the cheapest that keeps the tank below shutdown
 * wins); leaks and worn pumps get a field inspection at the alarm. Rule-based, not a learned model. */
export interface Decision {
  at: number; // when it was decided
  action: string;
  why: string[];
  cost: number | null;
  options: { label: string; summary: string; cost: number; chosen: boolean }[];
}

export const clock = (unix: number): string => new Date(unix * 1000).toISOString().slice(5, 16).replace("T", " ");

/** The crew message for a decision (manual and automatic notifications use the same text). */
export function decisionMessage(e: DetectedEvent): string {
  const d: Decision = decisionOf(e);
  return `[Oilgorithm] ${CATEGORY_LABEL[e.category]} at ${e.asset_id} (${clock(d.at)} UTC). Action: ${d.action}. ${d.why[0] ?? ""}`;
}

export function decisionOf(e: DetectedEvent): Decision {
  const p = e.planning;
  if (p) {
    const why: string[] = [];
    why.push(
      p.trips_at_unix === null
        ? "Tank stays below shutdown until the repair even with no action"
        : p.tripped
          ? "Tank was already at shutdown when planned"
          : `Without action the tank shuts in at ${clock(p.trips_at_unix)} (${p.hours_to_limit.p50.toFixed(1)} h after planning)`,
    );
    why.push(
      p.plan_mode === "joint_now" && p.shares_with.length
        ? `Planned together with ${p.shares_with.join(", ")}: ${p.trucks_available} of ${p.fleet_size} trucks could go here`
        : `${p.trucks_available} of ${p.fleet_size} trucks free in ${e.system_id}`,
    );
    const others = p.alternatives.filter((a) => a.summary !== p.plan.summary);
    if (others.length) {
      const next = others.reduce((a, b) => (a.est_cost < b.est_cost ? a : b));
      why.push(`Cheapest of ${p.alternatives.length} options; next best "${next.label}" costs ${money(next.est_cost)}`);
    } else {
      why.push("Only workable option");
    }
    return {
      at: p.planned_at_unix,
      action: p.plan.summary.replace(/ \(~\$[\d,]+\)$/, ""),
      why,
      cost: p.plan.est_cost,
      options: p.alternatives.map((a) => ({ label: a.label, summary: a.summary.replace(/ \(~\$[\d,]+\)$/, ""), cost: a.est_cost, chosen: a.summary === p.plan.summary })),
    };
  }
  if (e.category === "pipeline_leak") {
    const sooner: number | null = e.confirmed_unix === null ? null : Math.round((e.confirmed_unix - e.alarm_unix) / 60);
    return {
      at: e.alarm_unix,
      action: `Urgent: send an inspector to ${e.asset_id}`,
      why: [
        "Pipeline pressure dropped below the healthy level while pumping; water is not reaching the disposal site",
        sooner ? `Sent at the early alert, ${sooner} min before the standard check confirmed it` : "Sent at the first alert",
      ],
      cost: null,
      options: [],
    };
  }
  if (e.category === "pump_degradation") {
    const v = e.verification;
    const why: string[] = ["Pump flow and discharge pressure falling below rated while running"];
    if (v?.status === "verified") why.push(`Verified after 6 h: flow falling ${Math.abs(v.slope_pct_per_h ?? 0).toFixed(2)}%/h`);
    if (v?.forecast_fail_unix) why.push(`Trend reaches the failure point (~86% flow) around ${clock(v.forecast_fail_unix)}`);
    return { at: e.alarm_unix, action: `Inspect / repair ${e.asset_id} before it fails`, why, cost: null, options: [] };
  }
  return { at: e.alarm_unix, action: "No action", why: [], cost: null, options: [] };
}

function downloadCsv(rows: Incident[], dataset: string): void {
  const header = ["event_id", "system", "facility", "asset", "type", "status", "stage", "onset", "suspected", "confirmed", "ended", "time_saved_min", "early_warning_lead_h", "plan_cost", "decided_at", "decision", "decision_reason"];
  const cell = (v: string | number | undefined | null): string => {
    const s: string = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const iso = (u: number | null): string => (u === null ? "" : new Date(u * 1000).toISOString());
  const lines: string[] = [
    header.join(","),
    ...rows.map((r) =>
      [
        r.event.event_id, r.event.system_id, r.event.facility_id, r.event.asset_id, CATEGORY_LABEL[r.event.category],
        r.event.status, r.stage, iso(r.event.onset_unix), iso(r.event.alarm_unix), iso(r.event.confirmed_unix),
        iso(r.event.end_unix), r.savedMin || "", r.leadHours?.toFixed(2), r.cost?.toFixed(0),
        ...((d: Decision) => [iso(d.at), d.action, d.why.join("; ")])(decisionOf(r.event)),
      ].map(cell).join(","),
    ),
  ];
  const url: string = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `incidents_${dataset}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

export function IncidentDashboard({ state, onSelect, sent, earlyMode = true }: {
  state: EventsResponse;
  onSelect: (e: DetectedEvent) => void;
  sent?: Map<string, Sent>; // notifications already sent this session, by notice key
  earlyMode?: boolean; // with our early alerts (which notices exist)
}) {
  const [filter, setFilter] = useState<Category | "all">("all");
  const [contacts, setContacts] = useState<Contact[]>([]);
  useEffect(() => {
    fetchContacts().then(setContacts).catch(() => setContacts([]));
  }, []);
  const now: number = state.now_unix;

  const incidents: Incident[] = useMemo(() => {
    const links: Map<string, Warning> = warningIndex(earlyWarnings(state.events));
    return state.events.map((e) => toIncident(e, now, links)).sort((a, b) => b.event.alarm_unix - a.event.alarm_unix);
  }, [state, now]);

  const early: Incident[] = incidents.filter((i) => i.stage === "early");
  const confirmed: Incident[] = incidents.filter((i) => i.stage !== "suspected");
  const suspected: number = incidents.length - confirmed.length;
  const savedMin: number = early.reduce((s, i) => s + i.savedMin, 0);
  const warnings: Warning[] = earlyWarnings(state.events).filter((w) => w.failure && w.leadHours !== undefined && w.leadHours > 0);
  const leadHours: number = warnings.reduce((s, w) => s + (w.leadHours ?? 0), 0);
  const fix = state.early_fix;
  const costSaved: number = fix.cost_recorded - fix.cost_early_fix;
  const bblSaved: number = fix.leaks.reduce((s, l) => s + l.bbl_saved, 0);
  const wearChecks = incidents.flatMap((i) => (i.event.verification ? [i.event.verification] : []));
  const wearVerified: number = wearChecks.filter((v) => v.status === "verified").length;
  const wearPending: number = wearChecks.filter((v) => v.status === "pending").length;
  const wearRejected: number = wearChecks.filter((v) => v.status === "not_verified").length;

  const byType = CATEGORIES.map((c) => {
    const rows: Incident[] = incidents.filter((i) => i.event.category === c);
    const e: Incident[] = rows.filter((i) => i.stage === "early");
    return {
      c,
      total: rows.length,
      early: e.length,
      confirmed: rows.filter((i) => i.stage !== "suspected").length,
      suspected: rows.filter((i) => i.stage === "suspected").length,
      saved: e.reduce((s, i) => s + i.savedMin, 0),
    };
  });
  const maxSaved: number = Math.max(1, ...early.map((i) => i.savedMin));
  const shown: Incident[] = filter === "all" ? incidents : incidents.filter((i) => i.event.category === filter);

  return (
    <div className="incidents">
      <div className="inc-head">
        <h2>Incident report</h2>
        <span className="muted">{state.dataset} · whole recording, to {state.now_ts.slice(0, 16).replace("T", " ")} UTC</span>
        <button className="link-button small" onClick={() => downloadCsv(incidents, state.dataset)} disabled={!incidents.length}>
          Download CSV
        </button>
      </div>

      <div className="kpis">
        <Kpi label="Incidents recorded" value={String(incidents.length)} sub={`${incidents.filter((i) => i.event.status === "ongoing").length} ongoing`} />
        <Kpi
          label="Early detections"
          value={String(early.length)}
          sub={`flagged before confirmation${suspected ? ` · ${suspected} still suspected` : ""}`}
          tone="early"
        />
        <Kpi
          label="Confirmations"
          value={String(confirmed.length)}
          sub={`${confirmed.filter((i) => i.event.category !== "pump_failure").length} by threshold · ${confirmed.filter((i) => i.event.category === "pump_failure").length} pump-reported`}
          tone="confirmed"
        />
        <Kpi
          label="Time saved by early detection"
          value={durationText(savedMin)}
          sub={early.length ? `avg ${durationText(Math.round(savedMin / early.length))} sooner per incident` : "none yet"}
          tone="saved"
        />
        <Kpi
          label="Worn pumps verified"
          value={wearChecks.length ? `${wearVerified} / ${wearChecks.length}` : "—"}
          sub={`flow kept falling for 6 h after the alarm${wearPending ? ` · ${wearPending} verifying` : ""}${wearRejected ? ` · ${wearRejected} not verified` : ""}`}
          tone="confirmed"
        />
        <Kpi
          label="Failure warning lead time"
          value={warnings.length ? hoursText(leadHours) : "—"}
          sub={`${warnings.length} failure${warnings.length === 1 ? "" : "s"} warned by a worn-pump alarm`}
          tone="warn"
        />
        <Kpi
          label="Saved if fixed at first flag"
          value={money(Math.max(0, costSaved))}
          sub={`${fix.prevented.length} failures prevented · ${Math.round(bblSaved).toLocaleString("en-US")} bbl not leaked`}
          tone="saved"
        />
      </div>

      <div className="inc-grid">
        <section className="inc-card">
          <h3>By type</h3>
          <table className="options">
            <thead>
              <tr>
                <th>Type</th>
                <th>Total</th>
                <th>Early</th>
                <th>Confirmed</th>
                <th>Suspected</th>
                <th>Time saved</th>
              </tr>
            </thead>
            <tbody>
              {byType.map((r) => (
                <tr key={r.c}>
                  <td><span className={`dot ${r.c}`} />{CATEGORY_LABEL[r.c]}</td>
                  <td>{r.total}</td>
                  <td>{r.early}</td>
                  <td>{r.confirmed}</td>
                  <td>{r.suspected}</td>
                  <td>{r.saved ? durationText(r.saved) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted note">Pump faults are reported by the pump itself, so they are confirmed the moment they're detected and never count as early.</p>
        </section>

        <section className="inc-card">
          <h3>How much sooner each early detection came</h3>
          {early.length === 0 && <p className="muted">No early detections yet.</p>}
          <ul className="saved-bars">
            {early.map((i) => (
              <li key={eventKey(i.event)}>
                <button onClick={() => onSelect(i.event)} title={`Suspected ${when(i.event.alarm_unix)} · confirmed ${when(i.event.confirmed_unix)}`}>
                  <span className="sb-label">{i.event.asset_id}</span>
                  <span className="sb-track">
                    <span className={`sb-bar ${i.event.category}`} style={{ width: `${(i.savedMin / maxSaved) * 100}%` }} />
                  </span>
                  <span className="sb-value">{durationText(i.savedMin)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="inc-card">
        <h3>Response decisions (automated planner)</h3>
        <p className="muted note">
          What the system decided for each incident, why, and who was notified (automatically, at the moment each person is needed). Pump failures: every combination of trucks, trips and well
          shut-ins is costed, and the cheapest one that keeps the tank from shutting down is chosen. Leaks and worn pumps: an
          inspection is sent when first flagged.
        </p>
        <ol className="decisions">
          {[...incidents]
            .sort((a, b) => decisionOf(a.event).at - decisionOf(b.event).at)
            .map((i) => {
              const d: Decision = decisionOf(i.event);
              return (
                <li key={eventKey(i.event)} className={`decision ${i.event.category}`}>
                  <div className="dec-head">
                    <span className="dec-time">{clock(d.at)}</span>
                    <span className="dec-what">
                      <span className={`dot ${i.event.category}`} />
                      {i.event.event_id} · {CATEGORY_LABEL[i.event.category]} · {i.event.asset_id}
                    </span>
                    {d.cost !== null && <span className="dec-cost">{money(d.cost)}</span>}
                    <button className="link-button small" onClick={() => onSelect(i.event)}>
                      Open
                    </button>
                  </div>
                  <div className="dec-action">→ {d.action}</div>
                  <ul className="dec-why">
                    {d.why.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  {contacts.length > 0 && (
                    <ul className="dec-notices">
                      {noticesFor(i.event, contacts, earlyMode).map((n) => {
                        const done = sent?.get(n.key);
                        return (
                          <li key={n.key} className={done ? "sent" : ""}>
                            <span className="dn-time">{clock(n.at)}</span>
                            <span className="dn-title">
                              {stageIcon(n.stage)} {n.title}
                            </span>
                            <span className="dn-to">📨 {n.to.map((c) => `${c.title} (${c.phone})`).join(", ")}</span>
                            <span className="dn-status">{done ? "sent · placeholder" : "notified automatically at this time"}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {d.options.length > 1 && (
                    <details className="dec-options">
                      <summary>{d.options.length} options considered</summary>
                      <table className="options">
                        <tbody>
                          {d.options.map((o) => (
                            <tr key={o.label} className={o.chosen ? "chosen" : ""}>
                              <td>{o.chosen ? "✓ " : ""}{o.label}</td>
                              <td>{o.summary}</td>
                              <td>{money(o.cost)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  )}
                </li>
              );
            })}
        </ol>
      </section>

      <section className="inc-card">
        <div className="inc-log-head">
          <h3>Incident log ({shown.length})</h3>
          <div className="fp-windows">
            {(["all", ...CATEGORIES] as const).map((c) => (
              <button key={c} className={filter === c ? "active" : ""} onClick={() => setFilter(c)}>
                {c === "all" ? "All" : CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>
        </div>
        <div className="inc-table-wrap">
          <table className="options inc-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Asset</th>
                <th>Status</th>
                <th>Suspected</th>
                <th>Confirmed</th>
                <th>Detection</th>
                <th>Time saved</th>
                <th>Wear check (6 h)</th>
                <th>Early warning</th>
                <th>Plan cost</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <tr key={eventKey(i.event)} className={`inc-row ${i.event.category}`} onClick={() => onSelect(i.event)}>
                  <td>{i.event.event_id}</td>
                  <td><span className={`dot ${i.event.category}`} />{CATEGORY_LABEL[i.event.category]}</td>
                  <td>{i.event.asset_id}</td>
                  <td className={i.event.status}>{i.event.status}</td>
                  <td>{when(i.event.alarm_unix)}</td>
                  <td>{i.stage === "suspected" ? "—" : when(i.event.confirmed_unix)}</td>
                  <td><span className={`stage-tag ${i.stage}`}>{STAGE_LABEL[i.stage]}</span></td>
                  <td>{i.savedMin ? durationText(i.savedMin) : "—"}</td>
                  <td>
                    {i.event.verification ? (
                      <span
                        className={`verify-tag ${i.event.verification.status}`}
                        title={`Flow ${((i.event.verification.efficiency_before ?? 0) * 100).toFixed(1)}% before → ${((i.event.verification.efficiency_after ?? 0) * 100).toFixed(1)}% after; trend ${i.event.verification.slope_pct_per_h ?? "?"}%/h`}
                      >
                        {VERIFY_LABEL[i.event.verification.status]}
                        {i.event.verification.status === "pending" && ` ${i.event.verification.hours_seen.toFixed(1)}/6 h`}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {i.leadHours !== undefined && i.leadHours > 0
                      ? i.event.category === "pump_failure"
                        ? `warned ${hoursText(i.leadHours)} ahead`
                        : `failed ${hoursText(i.leadHours)} later`
                      : i.event.status === "ongoing" && i.event.verification?.forecast_fail_unix && i.event.verification.forecast_fail_unix > now
                        ? `may fail in ~${hoursText((i.event.verification.forecast_fail_unix - now) / 3600)}`
                        : "—"}
                  </td>
                  <td>{i.cost !== undefined ? money(i.cost) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {contacts.length > 0 && <CrewDirectory contacts={contacts} />}
    </div>
  );
}
