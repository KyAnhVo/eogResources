// Replay controls: drag along the track (or use the buttons / arrow keys) to move "now"; play
// advances it. Each system gets a lane of event bars from the full recording, so interesting
// moments are easy to find; the part after "now" is dimmed because the app at "now" can't know it.
// Clicking a bar jumps to the moment that event was first detected and selects it. A lane on top
// shows early warnings: each worn-pump alarm, spanning to the failure it preceded. A hollow ring on
// a leak or wear bar marks where the fast rule raised the alarm ahead of confirmation.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { eventKey, type DetectedEvent } from "./api";
import { earlyWarnings, hoursText, soonerMinutes, type Warning } from "./early";

interface Props {
  start: number;
  end: number;
  step: number; // seconds between telemetry rows
  now: number;
  onNow: (t: number) => void;
  history: DetectedEvent[]; // events detected over the whole recording
  systems: string[];
  selectedKey: string | null;
  onSelectEvent: (e: DetectedEvent) => void;
  activeSystem: string | null; // the open map tab's system, highlighted
  onSelectSystem: (systemId: string) => void;
  busy: boolean; // a state request for "now" is still running
}

const SPEEDS: { label: string; hoursPerSecond: number }[] = [
  { label: "1 h/s", hoursPerSecond: 1 },
  { label: "4 h/s", hoursPerSecond: 4 },
  { label: "12 h/s", hoursPerSecond: 12 },
];
const TICK_MS = 100;
const ROW_H = 7;
const WARN_ROW_H = 15;
const DAY = 86400;

/** Greedy interval packing so overlapping spans get their own sub-row. */
function pack<T>(items: T[], from: (x: T) => number, to: (x: T) => number, key: (x: T) => string): Map<string, number> {
  const rowEnds: number[] = [];
  const rows = new Map<string, number>();
  for (const x of [...items].sort((a, b) => from(a) - from(b))) {
    let row: number = rowEnds.findIndex((t) => t <= from(x));
    if (row === -1) row = rowEnds.push(0) - 1;
    rowEnds[row] = to(x);
    rows.set(key(x), row);
  }
  return rows;
}

const packRows = (events: DetectedEvent[], end: number): Map<string, number> =>
  pack(events, (e) => e.onset_unix, (e) => e.end_unix ?? end, eventKey);

/** A warning spans from the wear alarm to the failure it preceded (or to the wear's end). */
const warnEnd = (w: Warning, end: number): number => w.failure?.onset_unix ?? w.wear.end_unix ?? end;

const stamp = (unix: number): string => new Date(unix * 1000).toISOString().slice(5, 16).replace("T", " ");

const label = (unix: number): string => {
  const d = new Date(unix * 1000);
  return `${d.toUTCString().slice(0, 3)} ${d.toISOString().slice(5, 10)}`;
};

export function Timeline({ start, end, step, now, onNow, history, systems, selectedKey, onSelectEvent, activeSystem, onSelectSystem, busy }: Props) {
  const [playing, setPlaying] = useState<boolean>(false);
  const [speed, setSpeed] = useState<number>(1);
  const track = useRef<HTMLDivElement>(null);
  const nowRef = useRef<number>(now);
  nowRef.current = now;

  const clamp = (t: number): number => Math.min(end, Math.max(start, start + Math.round((t - start) / step) * step));
  const pct = (t: number): number => ((t - start) / (end - start)) * 100;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const next: number = clamp(nowRef.current + (SPEEDS[speed].hoursPerSecond * 3600 * TICK_MS) / 1000);
      onNow(next);
      if (next >= end) setPlaying(false);
    }, TICK_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, end, start, step]);

  function scrub(e: PointerEvent<HTMLDivElement>): void {
    const box: DOMRect | undefined = track.current?.getBoundingClientRect();
    if (!box) return;
    onNow(clamp(start + ((e.clientX - box.left) / box.width) * (end - start)));
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    const jump: number = e.shiftKey ? 3600 : step;
    if (e.key === "ArrowRight") onNow(clamp(now + jump));
    else if (e.key === "ArrowLeft") onNow(clamp(now - jump));
    else return;
    e.preventDefault();
  }

  const lanes = systems.map((sys) => {
    const events: DetectedEvent[] = history.filter((e) => e.system_id === sys);
    const rows: Map<string, number> = packRows(events, end);
    const rowCount: number = Math.max(1, ...[...rows.values()].map((r) => r + 1));
    return { sys, events, rows, height: rowCount * ROW_H + 6 };
  });

  const warnings: Warning[] = earlyWarnings(history);
  const warnRows: Map<string, number> = pack(warnings, (w) => w.wear.alarm_unix, (w) => warnEnd(w, end), (w) => eventKey(w.wear));
  const warnHeight: number = Math.max(1, ...[...warnRows.values()].map((r) => r + 1)) * WARN_ROW_H + 4;
  const pick = (e: DetectedEvent): void => {
    setPlaying(false);
    onNow(clamp(e.alarm_unix));
    onSelectEvent(e);
  };

  const days: number[] = [];
  for (let d = Math.ceil(start / DAY) * DAY; d < end; d += DAY) days.push(d);

  return (
    <section className="timeline">
      <div className="timeline-controls">
        <button onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
          {SPEEDS.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
        <button onClick={() => onNow(clamp(now - 3600))} title="Back 1 hour">−1h</button>
        <button onClick={() => onNow(clamp(now - step))} title="Back one reading">−5m</button>
        <span className="timeline-now">
          {new Date(now * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC{busy && <span className="busy"> · updating…</span>}
        </span>
        <button onClick={() => onNow(clamp(now + step))} title="Forward one reading">+5m</button>
        <button onClick={() => onNow(clamp(now + 3600))} title="Forward 1 hour">+1h</button>
        <button onClick={() => onNow(end)} disabled={now === end} title="Jump to the last reading">Latest</button>
      </div>
      <div className="timeline-body">
        <div className="lane-labels">
          <span className="lane-label warn-label" style={{ height: warnHeight + 1 }} title="Early warnings: worn-pump alarms and the failure each preceded">
            ⚑
          </span>
          {lanes.map((l) => (
            <button
              key={l.sys}
              className={`lane-label ${l.sys === activeSystem ? "active" : ""}`}
              style={{ height: l.height + 1 }}
              onClick={() => onSelectSystem(l.sys)}
              title={`Open the ${l.sys} tab`}
            >
              {l.sys}
            </button>
          ))}
        </div>
        <div
          className="track"
          ref={track}
          tabIndex={0}
          role="slider"
          aria-label="Now"
          aria-valuemin={start}
          aria-valuemax={end}
          aria-valuenow={now}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setPlaying(false);
            scrub(e);
          }}
          onPointerMove={(e) => e.buttons === 1 && scrub(e)}
        >
          {days.map((d) => (
            <div key={d} className="day-tick" style={{ left: `${pct(d)}%` }}>
              <span>{label(d)}</span>
            </div>
          ))}
          <div className="lane warn-lane" style={{ height: warnHeight }}>
            {warnings.map((w) => {
              const key: string = eventKey(w.wear);
              const to: number = warnEnd(w, end);
              // The label only states the outcome once it has happened at "now".
              const known: boolean = to <= now;
              const outcome: string = !known ? "may fail" : w.leadHours !== undefined ? `${hoursText(w.leadHours)} warning` : "no failure";
              const text: string = w.wear.alarm_unix > now ? w.wear.asset_id : `${w.wear.asset_id} · ${outcome}`;
              return (
                <div
                  key={key}
                  className={`warn-span ${!known ? "open" : w.failure ? "hit" : "miss"} ${key === selectedKey || (w.failure && eventKey(w.failure) === selectedKey) ? "selected" : ""}`}
                  style={{ left: `${pct(w.wear.alarm_unix)}%`, width: `${pct(to) - pct(w.wear.alarm_unix)}%`, top: 2 + (warnRows.get(key) ?? 0) * WARN_ROW_H }}
                  title={`${w.wear.asset_id} wearing out, detected ${new Date(w.wear.alarm_unix * 1000).toISOString().slice(5, 16).replace("T", " ")}${!known ? "" : w.failure ? `; failed ${hoursText(w.leadHours ?? 0)} later` : "; no failure followed"}`}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={() => pick(w.wear)}
                >
                  <span>{text}</span>
                </div>
              );
            })}
          </div>
          {lanes.map(({ sys, events, rows, height }) => {
            return (
              <div key={sys} className={`lane ${sys === activeSystem ? "active" : ""}`} style={{ height }}>
                {events.map((e) => {
                  const key: string = eventKey(e);
                  const sooner: number | null = soonerMinutes(e);
                  const early: boolean = e.category !== "pump_failure" && (sooner === null || sooner > 0);
                  const stage: string = !early
                    ? ""
                    : sooner === null
                      ? " · never confirmed"
                      : ` · confirmed ${stamp(e.confirmed_unix ?? 0)}, ${sooner} min after the alarm`;
                  return [
                    early && (
                      <div
                        key={`${key}-ring`}
                        className={`suspect-ring ${e.category}`}
                        style={{ left: `${pct(e.alarm_unix)}%`, top: 1 + (rows.get(key) ?? 0) * ROW_H }}
                      />
                    ),
                    <div
                      key={key}
                      className={`bar ${e.category} ${key === selectedKey ? "selected" : ""}`}
                      style={{
                        left: `${pct(e.onset_unix)}%`,
                        width: `max(3px, ${pct(e.end_unix ?? end) - pct(e.onset_unix)}%)`,
                        top: 3 + (rows.get(key) ?? 0) * ROW_H,
                      }}
                      title={`${e.asset_id} · ${e.category.replace("_", " ")} · ${early ? "suspected" : "detected"} ${stamp(e.alarm_unix)}${stage}`}
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onClick={() => pick(e)}
                    />,
                  ];
                })}
              </div>
            );
          })}
          <div className="future" style={{ left: `${pct(now)}%` }} />
          <div className="playhead" style={{ left: `${pct(now)}%` }} />
        </div>
      </div>
    </section>
  );
}
