import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  datasetFromFolder,
  eventKey,
  clearLive,
  fetchContacts,
  fetchState,
  publishLive,
  inScenario,
  withoutEarly,
  uploadDataset,
  type Contact,
  type DatasetFiles,
  type DatasetInfo,
  type DetectedEvent,
  type EventsResponse,
  type Network,
  type Ops,
  type Scenario,
} from "./api";
import { computeLayout, computeSystemLayout, type Layout } from "./layout";
import { MapView, OVERVIEW } from "./MapView";
import { FacilityPage, SUMMARY, type ComponentId } from "./FacilityPage";
import { ActionBar, AlertList, PendingBar, WhatIfSummary } from "./panels";
import { facilityViews, type FacilityView } from "./status";
import { parseTelemetry, type Telemetry } from "./telemetry";
import { SystemTabs } from "./SystemTabs";
import { IncidentDashboard } from "./Incidents";
import { AlertToasts } from "./AlertToasts";
import { HomePage } from "./Home";
import { Logo } from "./Logo";
import { SponsorStrip } from "./Sponsors";
import { SolutionFeed, useAutoNotify } from "./AutoNotify";
import { Timeline } from "./Timeline";

/** Folder picker button. `webkitdirectory` isn't in React's input typings, so it is set through the ref. */
function FolderPicker({ onPick, label }: { onPick: (files: FileList) => void; label: string }) {
  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files?.length) onPick(e.target.files);
    e.target.value = ""; // allow re-picking the same folder to reload it
  };
  return (
    <label className="folder-button">
      {label}
      <input type="file" ref={(el) => el?.setAttribute("webkitdirectory", "")} onChange={onChange} hidden />
    </label>
  );
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Selection = { kind: "event"; key: string } | null;

/** The component that shows an event best on the facility page. */
const COMPONENT_OF: Record<DetectedEvent["category"], ComponentId> = {
  pump_failure: "pump",
  pump_degradation: "pump",
  pipeline_leak: "pipeline",
};

export default function App() {
  const [files, setFiles] = useState<DatasetFiles | null>(null);
  const [info, setInfo] = useState<DatasetInfo | null>(null);
  const [network, setNetwork] = useState<Network | null>(null);
  const [ops, setOps] = useState<Ops | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [history, setHistory] = useState<EventsResponse | null>(null); // as of the last reading
  const [now, setNow] = useState<number>(0);
  const [state, setState] = useState<EventsResponse | null>(null); // as of `now`
  const [busy, setBusy] = useState<boolean>(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<string>(OVERVIEW); // map tab: "overview" or a system id
  const [facility, setFacility] = useState<string | null>(null); // facility page open inside the system tab
  const [component, setComponent] = useState<ComponentId>(SUMMARY);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<Scenario>("recorded");
  const [early, setEarly] = useState<boolean>(true); // our early alerts + warnings on, or standard check only
  const [page, setPage] = useState<"console" | "report">("console"); // the incident report is its own page
  const [replayed, setReplayed] = useState<boolean>(false); // "now" has left the end since loading
  const [hideDone, setHideDone] = useState<boolean>(false); // "replay complete" banner dismissed
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadId, setLoadId] = useState<number>(0); // bumps per loaded folder: each incident is notified once per load
  useEffect(() => {
    fetchContacts().then(setContacts).catch(() => setContacts([]));
  }, []);
  function chooseEarly(on: boolean): void {
    setEarly(on);
    if (!on) setScenario("recorded"); // the fix-at-first-flag what-if needs the early flags
  }
  const loadCount = useRef<number>(0); // results from a folder picked earlier are ignored

  /** Back to the homepage: forget the loaded folder (results still in flight are ignored). */
  function goHome(): void {
    loadCount.current++;
    clearLive();
    for (const reset of [setFiles, setInfo, setNetwork, setOps, setTelemetry, setHistory, setState, setSelection, setError]) {
      reset(null);
    }
    setPage("console");
    setTab(OVERVIEW);
    setFacility(null);
    setReplayed(false);
    setHideDone(false);
    setLoadId((n) => n + 1);
  }

  function pickFolder(picked: FileList): void {
    const load: number = ++loadCount.current;
    const current = (): boolean => loadCount.current === load;
    for (const reset of [setInfo, setNetwork, setOps, setTelemetry, setHistory, setState, setSelection, setError]) {
      reset(null);
    }
    let ds: DatasetFiles;
    try {
      ds = datasetFromFolder(picked);
    } catch (err) {
      setFiles(null);
      setError(message(err));
      return;
    }
    setFiles(ds);
    setPage("console");
    setReplayed(false);
    setHideDone(false);
    setLoadId((n) => n + 1);
    setTab(OVERVIEW);
    setFacility(null);
    const fail = (err: unknown): void => {
      if (current()) setError(message(err));
    };
    uploadDataset(ds)
      .then(async (uploaded) => {
        // The whole recording (timeline bars, report), and the console starting at the first reading.
        const [latest, first] = await Promise.all([
          fetchState(uploaded.dataset_id, uploaded.end_unix),
          fetchState(uploaded.dataset_id, uploaded.start_unix),
        ]);
        if (!current()) return;
        setInfo(uploaded);
        setHistory(latest);
        setState(first);
        setNow(uploaded.start_unix);
      })
      .catch(fail);
    ds.network.text().then((t) => current() && setNetwork(JSON.parse(t) as Network)).catch(fail);
    ds.ops.text().then((t) => current() && setOps(JSON.parse(t) as Ops)).catch(fail);
    ds.telemetry.text().then((csv) => current() && setTelemetry(parseTelemetry(csv))).catch(fail);
  }

  // Latest-wins: while a request is out, only the newest `now` is remembered and sent next.
  const inflight = useRef<boolean>(false);
  const wanted = useRef<number | null>(null);
  useEffect(() => {
    if (!info || state?.now_unix === now) return;
    wanted.current = now;
    const load: number = loadCount.current;
    const pump = (): void => {
      if (inflight.current || wanted.current === null) return;
      const t: number = wanted.current;
      wanted.current = null;
      inflight.current = true;
      setBusy(true);
      fetchState(info.dataset_id, t)
        .then((s) => loadCount.current === load && setState(s))
        .catch((err: unknown) => loadCount.current === load && setError(message(err)))
        .finally(() => {
          inflight.current = false;
          if (wanted.current === null) setBusy(false);
          pump();
        });
    };
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, info]);

  // What the console shows: the recording, or the early-fix what-if in the same shape.
  // With our early alerts and warnings (default), or as a console with only the standard check would show it.
  const view = (s: EventsResponse): EventsResponse => (early ? inScenario(s, scenario) : withoutEarly(s));
  const shown: EventsResponse | null = useMemo(() => state && view(state), [state, scenario, early]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownHistory: EventsResponse | null = useMemo(() => history && view(history), [history, scenario, early]); // eslint-disable-line react-hooks/exhaustive-deps

  const overviewLayout: Layout | null = useMemo(() => (network ? computeLayout(network) : null), [network]);
  const systemLayouts: Map<string, Layout> = useMemo(
    () => new Map(network ? network.systems.map((s) => [s.id, computeSystemLayout(network, s.id)]) : []),
    [network],
  );
  const layout: Layout | null = tab === OVERVIEW ? overviewLayout : (systemLayouts.get(tab) ?? overviewLayout);
  const views: Map<string, FacilityView> = useMemo(
    () => (network ? facilityViews(network, shown, telemetry, now) : new Map()),
    [network, shown, telemetry, now],
  );

  const selectedEvent: DetectedEvent | undefined =
    selection?.kind === "event" ? shown?.events.find((e) => eventKey(e) === selection.key) : undefined;
  const pendingEvent: DetectedEvent | undefined =
    selection?.kind === "event" && !selectedEvent ? shownHistory?.events.find((e) => eventKey(e) === selection.key) : undefined;
  const selectedFacility: string | null = (selectedEvent ?? pendingEvent)?.facility_id ?? null;

  /** Tabs, timeline lanes and summary cards: a map level, so any open facility page closes. */
  function openTab(scope: string): void {
    setTab(scope);
    setFacility(null);
  }

  /** An alert picked anywhere opens its facility page (where its details are) on the component that shows it. */
  function selectEvent(e: DetectedEvent): void {
    setSelection({ kind: "event", key: eventKey(e) });
    showFacility(e.system_id, e.facility_id, COMPONENT_OF[e.category]);
  }

  function showFacility(systemId: string, facilityId: string, part: ComponentId): void {
    setTab(systemId);
    setFacility(facilityId);
    setComponent(part);
  }

  /** Map click: open the facility's page; its most urgent alert (if any) fills the right panel. */
  function openFacility(facilityId: string, part: ComponentId = SUMMARY): void {
    const view: FacilityView | undefined = views.get(facilityId);
    if (!view) return;
    const prefer: DetectedEvent | undefined = part === "pipeline" ? view.leak : undefined;
    const event: DetectedEvent | undefined = prefer ?? view.events[0];
    setSelection(event ? { kind: "event", key: eventKey(event) } : null);
    showFacility(view.system.id, facilityId, part);
  }

  // Esc goes up one level: the selected alert first, then the facility page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (selection) setSelection(null);
      else setFacility(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  const facilityView: FacilityView | undefined = facility ? views.get(facility) : undefined;

  // Loading starts "now" at the last reading; once it moves back, reaching the end again means the replay ran.
  useEffect(() => {
    if (!info) return;
    if (now < info.end_unix) {
      setReplayed(true);
      setHideDone(false);
    }
  }, [now, info]);
  const replayDone: boolean = Boolean(info && replayed && !hideDone && now === info.end_unix);
  // Phones on /live follow this console: publish the dataset and replay position as they change.
  useEffect(() => {
    if (info) publishLive(info.dataset_id, now, early);
  }, [info, now, early]);

  const autoSent = useAutoNotify(state, contacts, early, loadId); // mandatory: every notice goes out when needed

  /** From the report: back to the console, on the incident's moment and facility. */
  function openFromReport(e: DetectedEvent): void {
    setPage("console");
    setNow(e.alarm_unix);
    selectEvent(e);
  }

  const ready: boolean = Boolean(info && network && layout && shown && shownHistory);
  return (
    <div className={`app ${ready && page === "console" ? "console" : ""} ${page === "report" ? "report" : ""}`}>
      <header>
        <h1 className="brand">
          <button className="brand-link" onClick={goHome} disabled={!files} title={files ? "Back to the main page" : undefined}>
            <Logo size={26} />
            Oilgorithm
          </button>
        </h1>
        {files && (
          <button className="home-button" onClick={goHome} title="Back to the main page">
            ⌂ Main page
          </button>
        )}
        <SponsorStrip />
        {files && <span className="dataset-name">{files.name}</span>}
        {shown && (
          <span className="now">
            now {shown.now_ts.slice(0, 16).replace("T", " ")} UTC · {shown.alert_order.length} in progress
            {scenario === "early_fix" && " · what-if"}
          </span>
        )}
        {ready && (
          <button className={`report-button ${page === "report" ? "active" : ""}`} onClick={() => setPage(page === "report" ? "console" : "report")}>
            {page === "report" ? "← Back to console" : "📋 Incident report"}
          </button>
        )}
        {shown && page === "console" && (
          <div className={`mode-toggle ${early ? "on" : "off"}`} role="group" aria-label="Early alerts">
            <button className={!early ? "active" : ""} onClick={() => chooseEarly(false)} title="Only the standard check: leaks appear when confirmed, no worn-pump warnings">
              Without (standard only)
            </button>
            <button className={early ? "active" : ""} onClick={() => chooseEarly(true)} title="Our early alerts (suspected stage) and worn-pump warnings">
              ⚠ With our early alerts
            </button>
          </div>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      {!files && <HomePage picker={<FolderPicker onPick={pickFolder} label="Choose dataset folder" />} />}
      {files && !ready && !error && <p className="muted">Loading {files.name}…</p>}
      {ready && page === "report" && history && (
        <div className="report-page">
          <button className="back-button" onClick={() => setPage("console")}>
            ← Back to console
          </button>
          <IncidentDashboard state={history} onSelect={openFromReport} sent={autoSent} earlyMode={early} />
        </div>
      )}
      {ready && page === "console" && info && network && layout && state && shown && history && shownHistory && (
        <>
          <nav className="panel left">
            {scenario === "early_fix" && <WhatIfSummary fix={state.early_fix} />}
            <AlertList state={shown} early={early} selectedKey={selection?.kind === "event" ? selection.key : null} onSelect={selectEvent} />
          </nav>
          <div className="map-area">
            <AlertToasts state={state} early={early} onSelect={selectEvent} />
            <SolutionFeed notices={[...autoSent.values()].map((x) => x.notice)} now={now} />
            {replayDone && (
              <div className="replay-done" role="status">
                <span>✓ Replay complete: {history.events.length} incidents over the recording</span>
                <button className="folder-button" onClick={() => setPage("report")}>
                  View incident report →
                </button>
                <button className="action-close" onClick={() => setHideDone(true)} aria-label="Dismiss">
                  ×
                </button>
              </div>
            )}
            <SystemTabs network={network} views={views} active={tab} onSelect={openTab} />
            {selectedEvent ? (
              <ActionBar
                event={selectedEvent}
                now={now}
                onOpenFacility={
                  facility === selectedEvent.facility_id
                    ? undefined
                    : () => showFacility(selectedEvent.system_id, selectedEvent.facility_id, COMPONENT_OF[selectedEvent.category])
                }
                onClose={() => setSelection(null)}
              />
            ) : (
              pendingEvent && (
                <PendingBar event={pendingEvent} onJump={() => setNow(pendingEvent.alarm_unix)} onClose={() => setSelection(null)} />
              )
            )}
            {facilityView ? (
              <FacilityPage
                view={facilityView}
                network={network}
                telemetry={telemetry}
                events={shown.events.filter((e) => e.facility_id === facilityView.facility.id)}
                selected={selectedEvent?.facility_id === facilityView.facility.id ? selectedEvent : undefined}
                now={now}
                start={info.start_unix}
                component={component}
                onComponent={setComponent}
                onBack={() => setFacility(null)}
              />
            ) : (
              <MapView
                network={network}
                ops={ops}
                layout={layout}
                views={views}
                telemetry={telemetry}
                now={now}
                scope={tab}
                selectedFacility={selectedFacility}
                onOpenSystem={openTab}
                onOpenFacility={openFacility}
                onClearSelection={() => setSelection(null)}
              />
            )}
          </div>
          <Timeline
            start={info.start_unix}
            end={info.end_unix}
            step={info.step_s}
            now={now}
            onNow={setNow}
            recorded={history.events}
            early={early}
            onScenario={setScenario}
            systems={network.systems.map((s) => s.id)}
            selectedKey={selection?.kind === "event" ? selection.key : null}
            onSelectEvent={selectEvent}
            activeSystem={tab === OVERVIEW ? null : tab}
            onSelectSystem={openTab}
            busy={busy}
          />
        </>
      )}
    </div>
  );
}
