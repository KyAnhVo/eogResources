// Minimal dependency-free SVG line chart: shaded bands (event spans, pump-off stretches), dashed
// reference lines, markers, and an optional crosshair shared between charts on the same time axis.
// NaN values break the line (used to hide pump-off samples).

import type { MouseEvent as ReactMouseEvent } from "react";
import { indexAt, type Series } from "./telemetry";

export interface Line {
  label: string;
  color: string;
  series: Series;
}

export interface Reference {
  label: string;
  value: number;
}

export interface Band {
  from: number;
  to: number;
  className: string;
}

export interface Marker {
  t: number;
  label: string;
  className: string;
}

interface Props {
  title: string;
  lines: Line[];
  from: number;
  to: number;
  band?: [number, number]; // shaded [start, end] in unix seconds (the event span)
  bands?: Band[];
  reference?: Reference; // dashed horizontal line, e.g. the healthy value or the shutdown limit
  references?: Reference[];
  markers?: Marker[]; // vertical ticks, e.g. when a detector fired
  step?: boolean; // status readings: hold each value until the next sample
  domain?: [number, number]; // fixed y range (status codes), instead of fitting the data
  cursor?: number | null; // unix seconds; drawn as a vertical line, legend shows values there
  onCursor?: (t: number | null) => void;
}

const W = 600;
const H = 150;
const PAD = { left: 48, right: 8, top: 8, bottom: 20 };

const hhmm = (unix: number): string => new Date(unix * 1000).toISOString().slice(5, 16).replace("T", " ");

/** Split a series into runs of finite values, one polyline each. */
function segments(s: Series, step: boolean): [number, number][][] {
  const out: [number, number][][] = [];
  let current: [number, number][] = [];
  s.t.forEach((t, i) => {
    if (Number.isFinite(s.v[i])) {
      if (step && current.length) current.push([t, current[current.length - 1][1]]);
      current.push([t, s.v[i]]);
    } else if (current.length) {
      out.push(current);
      current = [];
    }
  });
  if (current.length) out.push(current);
  return out;
}

const fmtValue = (v: number | undefined): string =>
  v === undefined || !Number.isFinite(v) ? "–" : Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1);

export function LineChart({ title, lines, from, to, band, bands = [], reference, references = [], markers = [], step = false, domain, cursor, onCursor }: Props) {
  const refs: Reference[] = reference ? [reference, ...references] : references;
  const values: number[] = lines.flatMap((l) => l.series.v).filter(Number.isFinite);
  if (values.length === 0) return <div className="chart-empty">{title}: no data</div>;
  values.push(...refs.map((r) => r.value));
  let lo: number = domain ? domain[0] : Math.min(...values);
  let hi: number = domain ? domain[1] : Math.max(...values);
  if (hi === lo) {
    lo -= 1;
    hi += 1;
  }
  const span: number = Math.max(1, to - from);
  const x = (t: number): number => PAD.left + ((t - from) / span) * (W - PAD.left - PAD.right);
  const y = (v: number): number => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const allBands: Band[] = band ? [{ from: band[0], to: band[1], className: "band" }, ...bands] : bands;
  const shown: number | null = cursor !== undefined && cursor !== null && cursor >= from && cursor <= to ? cursor : null;
  // Legend values: at the crosshair if there is one, otherwise the latest reading.
  const valueOf = (s: Series): number | undefined => {
    const i: number = indexAt(s, shown ?? to);
    return i < 0 ? undefined : s.v[i];
  };

  function move(e: ReactMouseEvent<SVGSVGElement>): void {
    if (!onCursor) return;
    const box: DOMRect = e.currentTarget.getBoundingClientRect();
    const vx: number = ((e.clientX - box.left) / box.width) * W;
    if (vx < PAD.left || vx > W - PAD.right) return onCursor(null);
    onCursor(from + ((vx - PAD.left) / (W - PAD.left - PAD.right)) * span);
  }

  return (
    <figure className="chart">
      <figcaption>
        {title}
        {lines.map((l) => (
          <span key={l.label} className="legend" style={{ color: l.color }}>
            ● {lines.length > 1 ? `${l.label} ` : ""}
            {onCursor ? fmtValue(valueOf(l.series)) : ""}
          </span>
        ))}
        {refs.map((r) => (
          <span key={r.label} className="legend reference-legend">
            ┄ {r.label}
          </span>
        ))}
        {shown !== null && <span className="legend cursor-time">{hhmm(shown)}</span>}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} onMouseMove={move} onMouseLeave={() => onCursor?.(null)}>
        {allBands.map((b, i) => {
          const x0: number = x(Math.max(b.from, from));
          const x1: number = x(Math.min(b.to, to));
          return x1 > x0 ? <rect key={i} className={b.className} x={x0} y={PAD.top} width={x1 - x0} height={H - PAD.top - PAD.bottom} /> : null;
        })}
        <line className="axis" x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} />
        {refs.map((r) => (
          <line key={r.label} className="reference" x1={PAD.left} y1={y(r.value)} x2={W - PAD.right} y2={y(r.value)} />
        ))}
        <text className="tick" x={PAD.left - 4} y={PAD.top + 8} textAnchor="end">{fmtValue(hi)}</text>
        <text className="tick" x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end">{fmtValue(lo)}</text>
        <text className="tick" x={PAD.left} y={H - 4}>{hhmm(from)}</text>
        <text className="tick" x={W - PAD.right} y={H - 4} textAnchor="end">{hhmm(to)}</text>
        {lines.flatMap((l) =>
          segments(l.series, step).map((seg, k) => (
            <polyline
              key={`${l.label}-${k}`}
              fill="none"
              stroke={l.color}
              strokeWidth={1.5}
              points={seg.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
            />
          )),
        )}
        {markers
          .filter((m) => m.t >= from && m.t <= to)
          .map((m, i) => (
            <line key={i} className={m.className} x1={x(m.t)} x2={x(m.t)} y1={PAD.top} y2={H - PAD.bottom}>
              <title>{m.label}</title>
            </line>
          ))}
        {shown !== null && <line className="cursor" x1={x(shown)} x2={x(shown)} y1={PAD.top} y2={H - PAD.bottom} />}
      </svg>
    </figure>
  );
}
