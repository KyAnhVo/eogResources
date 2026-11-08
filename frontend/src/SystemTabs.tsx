// Tab strip above the map: Overview plus one tab per system. Every tab carries a live badge
// (alerts in progress, worst problem, soonest shutdown) so a problem in a system you're not
// looking at stays visible; a tab flashes when a new alert appears in it while it isn't open.

import { useEffect, useRef, useState } from "react";
import { eventKey, type Network } from "./api";
import { OVERVIEW, SEVERITY } from "./MapView";
import type { FacilityStatus, FacilityView } from "./status";

interface Props {
  network: Network;
  views: Map<string, FacilityView>;
  active: string;
  onSelect: (scope: string) => void;
}

interface TabSummary {
  id: string;
  alerts: number;
  worst: FacilityStatus | "leak";
  countdown: string | null; // soonest shutdown among failing tanks, or "shut in"
  keys: string; // ongoing event keys, to spot new ones
}

const FLASH_MS = 4000;

function summarize(id: string, facilities: FacilityView[]): TabSummary {
  const events = facilities.flatMap((v) => v.events);
  const worst: FacilityStatus | "leak" = facilities
    .flatMap((v): (FacilityStatus | "leak")[] => (v.leak ? [v.status, "leak"] : [v.status]))
    .reduce<FacilityStatus | "leak">((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "ok");
  let countdown: string | null = null;
  if (facilities.some((v) => v.plan?.tripped)) countdown = "shut in";
  else {
    const hours: number[] = facilities.flatMap((v) => (v.plan && v.plan.trips_at_unix !== null ? [v.plan.hours_to_limit.p50] : []));
    if (hours.length) countdown = `${Math.min(...hours).toFixed(1)} h`;
  }
  return { id, alerts: events.length, worst, countdown, keys: events.map(eventKey).sort().join(",") };
}

export function SystemTabs({ network, views, active, onSelect }: Props) {
  const tabs: TabSummary[] = network.systems.map((sys) =>
    summarize(sys.id, sys.facilities.flatMap((f) => views.get(f.id) ?? [])),
  );
  const overview: TabSummary = summarize(OVERVIEW, [...views.values()]);

  const seen = useRef<Map<string, Set<string>>>(new Map());
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const signature: string = tabs.map((t) => `${t.id}:${t.keys}`).join("|");
  useEffect(() => {
    const fresh: string[] = [];
    for (const t of tabs) {
      const now = new Set<string>(t.keys ? t.keys.split(",") : []);
      const before: Set<string> | undefined = seen.current.get(t.id);
      if (before && t.id !== active && [...now].some((k) => !before.has(k))) fresh.push(t.id);
      seen.current.set(t.id, now);
    }
    if (!fresh.length) return;
    setFlashing((f) => new Set([...f, ...fresh]));
    const timer = window.setTimeout(() => {
      setFlashing((f) => new Set([...f].filter((id) => !fresh.includes(id))));
    }, FLASH_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const tab = (t: TabSummary, label: string) => (
    <button
      key={t.id}
      role="tab"
      aria-selected={t.id === active}
      className={`tab worst-${t.worst} ${t.id === active ? "active" : ""} ${flashing.has(t.id) ? "flash" : ""}`}
      onClick={() => {
        setFlashing((f) => new Set([...f].filter((id) => id !== t.id)));
        onSelect(t.id);
      }}
    >
      <span className="tab-name">{label}</span>
      {t.alerts > 0 && <span className="tab-count">{t.alerts}</span>}
      {t.countdown && <span className="tab-countdown">{t.countdown}</span>}
    </button>
  );

  return (
    <div className="tabs" role="tablist" aria-label="Map view">
      {tab(overview, "Overview")}
      {tabs.map((t) => tab(t, t.id))}
    </div>
  );
}
