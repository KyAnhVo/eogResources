// /live: a view-only page for phones. It follows the presenter's console (the dataset loaded on the
// laptop and its replay position, published to /api/live) and shows the solution feed, the alerts in
// progress and the incident report. No upload, no controls, no notifications sent from here.

import { useEffect, useRef, useState } from "react";
import { fetchContacts, fetchLive, fetchState, withoutEarly, type Contact, type EventsResponse, type LiveInfo } from "./api";
import { SolutionFeed } from "./AutoNotify";
import { IncidentDashboard } from "./Incidents";
import { Logo } from "./Logo";
import { noticesFor, type Notice } from "./Notify";
import { AlertList } from "./panels";

const POLL_MS = 1000;
const noop = (): void => undefined;

export function LiveView() {
  const [live, setLive] = useState<LiveInfo | null>(null);
  const [checked, setChecked] = useState<boolean>(false); // first poll answered
  const [offline, setOffline] = useState<boolean>(false);
  const [state, setState] = useState<EventsResponse | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tab, setTab] = useState<"live" | "report">("live");
  const inflight = useRef<boolean>(false);

  useEffect(() => {
    fetchContacts().then(setContacts).catch(() => setContacts([]));
    let stop = false;
    const poll = (): void => {
      fetchLive()
        .then((l) => {
          if (stop) return;
          setLive(l);
          setOffline(false);
        })
        .catch(() => !stop && setOffline(true))
        .finally(() => !stop && setChecked(true));
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  // A new dataset on the console: start from its own state.
  const datasetId: string | null = live?.dataset_id ?? null;
  useEffect(() => {
    setState(null);
  }, [datasetId]);

  // The state at the presenter's "now"; skipped while a request is out (the next poll catches up).
  useEffect(() => {
    if (!live || inflight.current || state?.now_unix === live.now) return;
    inflight.current = true;
    fetchState(live.dataset_id, live.now)
      .then(setState)
      .catch(() => undefined)
      .finally(() => {
        inflight.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.dataset_id, live?.now]);

  const early: boolean = live?.early ?? true;
  const shown: EventsResponse | null = state && (early ? state : withoutEarly(state));
  const notices: Notice[] = state && contacts.length ? state.events.flatMap((e) => noticesFor(e, contacts, early)) : [];
  const progress: number = live ? ((live.now - live.start_unix) / Math.max(1, live.end_unix - live.start_unix)) * 100 : 0;

  return (
    <div className="live">
      <header className="live-head">
        <span className="brand">
          <Logo size={24} />
          Oilgorithm
        </span>
        <span className={`live-pill ${live && !offline ? "on" : ""}`}>{offline ? "offline" : live ? "● LIVE" : "waiting"}</span>
      </header>

      {!checked && <p className="muted live-msg">Connecting…</p>}
      {checked && !live && !offline && (
        <div className="live-wait">
          <Logo size={56} />
          <p>Waiting for the presenter to load a dataset on the console.</p>
          <p className="muted">This page updates by itself.</p>
        </div>
      )}
      {offline && <p className="error live-msg">Can't reach the server. Retrying…</p>}

      {live && (
        <>
          <section className="live-status">
            <div className="ls-row">
              <strong>{live.name}</strong>
              <span className={`ls-mode ${early ? "on" : "off"}`}>{early ? "⚠ With our early alerts" : "Without (standard only)"}</span>
            </div>
            <div className="ls-row muted">
              <span>{new Date(live.now * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
              {shown && <span>{shown.alert_order.length} in progress</span>}
            </div>
            <div className="ls-bar" aria-label="Replay position">
              <span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
            </div>
          </section>

          <nav className="live-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "live"} className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
              Live
            </button>
            <button role="tab" aria-selected={tab === "report"} className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>
              Incident report
            </button>
          </nav>

          {tab === "live" && (
            <>
              <div className="live-feed">
                <SolutionFeed notices={notices} now={live.now} note="crew notified automatically · placeholder sender" />
                {!notices.some((n) => n.at <= live.now && live.now - n.at <= 3 * 3600) && (
                  <p className="muted live-msg">No actions in the last 3 hours of the replay.</p>
                )}
              </div>
              <section className="live-alerts">
                {shown ? <AlertList state={shown} early={early} selectedKey={null} onSelect={noop} /> : <p className="muted">Loading…</p>}
              </section>
            </>
          )}
          {tab === "report" &&
            (state ? <IncidentDashboard state={state} onSelect={noop} earlyMode={early} /> : <p className="muted live-msg">Loading report…</p>)}
        </>
      )}
    </div>
  );
}
