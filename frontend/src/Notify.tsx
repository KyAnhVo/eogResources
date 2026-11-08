// Crew notifications are mandatory and automatic: every incident produces a fixed schedule of messages,
// each sent the moment it is needed, to the people who must act. Nobody chooses whether to notify.
// - Early alert up (leak, worn pump): supervisor + the inspector / pump technician of that system.
// - Leak confirmed, or pump fault: supervisor + inspector, or pump technician (+ field operator).
// - Trucks needed (failure plan): the drivers the plan sends + supervisor, with where and when.
// - Shut-in needed: the field operator + supervisor, at the minute the well must be shut in.
// The backend sender is a placeholder for now (backend/app/notify.py): nothing is delivered.

import type { Contact, DetectedEvent } from "./api";
import { eventKey } from "./api";
import { hhmm } from "./status";

export type Stage = "alert" | "confirmed" | "failure" | "dispatch" | "shut_in";

export interface Notice {
  key: string; // event key + stage (+ well): sent once
  event: DetectedEvent;
  stage: Stage;
  at: number; // when it must go out
  title: string; // what the screen shows
  message: string; // what the crew receives
  to: Contact[];
}

const STAGE_ICON: Record<Stage, string> = { alert: "⚠", confirmed: "✓", failure: "✕", dispatch: "🚚", shut_in: "⛔" };
export const stageIcon = (s: Stage): string => STAGE_ICON[s];

const day = (unix: number): string => new Date(unix * 1000).toISOString().slice(5, 16).replace("T", " ");

/** Every notification an incident needs, in time order. `early` false: a standard-check-only console
 * (no early alerts; leaks reach the crew at confirmation, worn pumps never). */
export function noticesFor(e: DetectedEvent, contacts: Contact[], early: boolean): Notice[] {
  const sys = (role: Contact["role"]): Contact[] => contacts.filter((c) => c.role === role && c.system === e.system_id);
  const sup: Contact[] = contacts.filter((c) => c.role === "supervisor");
  const k: string = eventKey(e);
  const out: Notice[] = [];
  const add = (stage: Stage, at: number | null, title: string, message: string, to: Contact[], suffix = ""): void => {
    if (at === null || !to.length) return;
    out.push({ key: `${k}|${stage}${suffix}`, event: e, stage, at, title, message: `[Oilgorithm ${day(at)} UTC] ${message}`, to });
  };

  if (e.category === "pipeline_leak") {
    if (early) {
      add("alert", e.alarm_unix, `Suspected leak · ${e.asset_id}`, `Suspected leak on ${e.asset_id} (${e.facility_id}): pressure dropped while pumping. Inspect now.`, [...sys("inspector"), ...sup]);
    }
    add("confirmed", e.confirmed_unix, `Leak confirmed · ${e.asset_id}`, `Leak confirmed on ${e.asset_id} (${e.facility_id}). Water is not reaching the disposal site: isolate and repair.`, [...sys("inspector"), ...sup]);
  } else if (e.category === "pump_degradation") {
    if (!early) return out;
    add("alert", e.alarm_unix, `Pump wearing out · ${e.asset_id}`, `${e.asset_id} (${e.facility_id}) is losing flow. Inspect and repair before it fails.`, [...sys("maintenance"), ...sup]);
    const v = e.verification;
    if (v?.status === "verified") {
      const fc: string = v.forecast_fail_unix ? ` Expected to fail around ${day(v.forecast_fail_unix)} UTC if not repaired.` : "";
      add("confirmed", v.check_unix, `Wear verified · ${e.asset_id}`, `Wear on ${e.asset_id} verified over 6 h.${fc}`, [...sys("maintenance"), ...sup]);
    }
  } else {
    const p = e.planning;
    add("failure", e.onset_unix, `Pump failed · ${e.asset_id}`, `${e.asset_id} (${e.facility_id}) has faulted; the tank is filling. Repair crew to site.`, [...sys("maintenance"), ...sup]);
    if (p && p.plan.trucks > 0) {
      const drivers: Contact[] = sys("driver").slice(0, p.plan.trucks);
      const arrive: string = p.plan.truck_arrivals_unix.length ? `, first load by ${hhmm(p.plan.truck_arrivals_unix[0])}` : "";
      add(
        "dispatch",
        e.onset_unix,
        `Trucks dispatched · ${e.facility_id}`,
        `Drive to ${e.facility_id}: ${p.plan.trucks} truck${p.plan.trucks > 1 ? "s" : ""}, ${p.plan.trips_per_truck} trip${p.plan.trips_per_truck > 1 ? "s" : ""} each${arrive}.`,
        [...drivers, ...sup],
      );
    }
    for (const s of p?.plan.shut_ins ?? []) {
      add("shut_in", s.start_unix, `Shut in ${s.well_id}`, `Shut in ${s.well_id} at ${e.facility_id} now (${hhmm(s.start_unix)}) to keep the tank below shutdown.`, [...sys("operator"), ...sup], `|${s.well_id}`);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function CrewDirectory({ contacts }: { contacts: Contact[] }) {
  return (
    <section className="inc-card">
      <h3>Crew directory ({contacts.length})</h3>
      <p className="muted note">Placeholder contacts: fictional names, example.com emails, and 555-01xx numbers reserved for fiction, so nobody real is messaged.</p>
      <div className="inc-table-wrap">
        <table className="options inc-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>System</th>
              <th>Phone</th>
              <th>Email</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.title}</td>
                <td>{c.system ?? "All"}</td>
                <td>{c.phone}</td>
                <td>{c.email}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
