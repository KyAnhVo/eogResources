import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  datasetFromFolder,
  eventKey,
  fetchState,
  uploadDataset,
  type DatasetFiles,
  type DatasetInfo,
  type DetectedEvent,
  type EventsResponse,
  type Network,
  type Ops,
} from "./api";
import { computeLayout, computeSystemLayout, type Layout } from "./layout";
import { MapView, OVERVIEW } from "./MapView";
import { FacilityPage, SUMMARY, type ComponentId } from "./FacilityPage";
import { ActionBar, AlertList, PendingBar } from "./panels";
import { facilityViews, type FacilityView } from "./status";
import { parseTelemetry, type Telemetry } from "./telemetry";
import { SystemTabs } from "./SystemTabs";
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
  const loadCount = useRef<number>(0); // results from a folder picked earlier are ignored

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
    setTab(OVERVIEW);
    setFacility(null);
    const fail = (err: unknown): void => {
      if (current()) setError(message(err));
    };
    uploadDataset(ds)
      .then(async (uploaded) => {
        const latest: EventsResponse = await fetchState(uploaded.dataset_id, uploaded.end_unix);
        if (!current()) return;
        setInfo(uploaded);
        setHistory(latest);
        setState(latest);
        setNow(uploaded.end_unix);
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

  const overviewLayout: Layout | null = useMemo(() => (network ? computeLayout(network) : null), [network]);
  const systemLayouts: Map<string, Layout> = useMemo(
    () => new Map(network ? network.systems.map((s) => [s.id, computeSystemLayout(network, s.id)]) : []),
    [network],
  );
  const layout: Layout | null = tab === OVERVIEW ? overviewLayout : (systemLayouts.get(tab) ?? overviewLayout);
  const views: Map<string, FacilityView> = useMemo(
    () => (network ? facilityViews(network, state, telemetry, now) : new Map()),
    [network, state, telemetry, now],
  );

  const selectedEvent: DetectedEvent | undefined =
    selection?.kind === "event" ? state?.events.find((e) => eventKey(e) === selection.key) : undefined;
  const pendingEvent: DetectedEvent | undefined =
    selection?.kind === "event" && !selectedEvent ? history?.events.find((e) => eventKey(e) === selection.key) : undefined;
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

  const ready: boolean = Boolean(info && network && layout && state && history);
  return (
    <div className={`app ${ready ? "console" : ""}`}>
      <header>
        <h1>Beat the Shutdown</h1>
        {files && (
          <>
            <span className="dataset-name">{files.name}</span>
            <FolderPicker onPick={pickFolder} label="Change folder" />
          </>
        )}
        {state && (
          <span className="now">
            now {state.now_ts.slice(0, 16).replace("T", " ")} UTC · {state.alert_order.length} in progress
          </span>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      {!files && (
        <section className="empty">
          <p>Choose a dataset folder containing network.json, ops.json and telemetry.csv.</p>
          <FolderPicker onPick={pickFolder} label="Choose folder" />
        </section>
      )}
      {files && !ready && !error && <p className="muted">Loading {files.name}…</p>}
      {ready && info && network && layout && state && history && (
        <>
          <nav className="panel left">
            <AlertList state={state} selectedKey={selection?.kind === "event" ? selection.key : null} onSelect={selectEvent} />
          </nav>
          <div className="map-area">
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
                events={state.events.filter((e) => e.facility_id === facilityView.facility.id)}
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
            history={history.events}
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
