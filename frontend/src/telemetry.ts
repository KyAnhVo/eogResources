// Parse the raw telemetry.csv (timestamp,ts_unix,asset_id,metric,value) into one series per asset+metric.

export interface Series {
  t: number[]; // unix seconds, ascending
  v: number[];
}

export type Telemetry = Map<string, Series>;

export const seriesKey = (assetId: string, metric: string): string => `${assetId}|${metric}`;

export function parseTelemetry(csv: string): Telemetry {
  const out: Telemetry = new Map();
  const lines: string[] = csv.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line: string = lines[i];
    if (!line) continue;
    const [, ts, asset, metric, value] = line.split(",");
    const key: string = seriesKey(asset, metric);
    let s: Series | undefined = out.get(key);
    if (!s) {
      s = { t: [], v: [] };
      out.set(key, s);
    }
    s.t.push(Number(ts));
    s.v.push(Number(value));
  }
  return out;
}

/**
 * Replace values with NaN where `gate` fails (e.g. pump not running), so charts show gaps there.
 * Every sensor reports every interval, so series line up index for index.
 */
export function gated(s: Series, gate: Series, keep: (gateValue: number) => boolean): Series {
  if (gate.t.length !== s.t.length) return s;
  return { t: s.t, v: s.v.map((v, i) => (keep(gate.v[i]) ? v : NaN)) };
}

/** First index with t > x (series are ascending). */
function firstAfter(t: number[], x: number): number {
  let lo = 0;
  let hi: number = t.length;
  while (lo < hi) {
    const mid: number = (lo + hi) >> 1;
    if (t[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the latest reading at or before `t`; -1 if there is none. */
export function indexAt(s: Series, t: number): number {
  return firstAfter(s.t, t) - 1;
}

/** The part of a series inside [from, to]. */
export function slice(s: Series, from: number, to: number): Series {
  const i: number = indexAt(s, from - 1e-6) + 1;
  const j: number = firstAfter(s.t, to);
  return { t: s.t.slice(i, j), v: s.v.slice(i, j) };
}

/** The latest reading at or before `t` (every series is on the same 5-minute grid). */
export function valueAt(tel: Telemetry, assetId: string, metric: string, t: number): number | undefined {
  const s: Series | undefined = tel.get(seriesKey(assetId, metric));
  const i: number = s ? indexAt(s, t) : -1;
  return s && i >= 0 ? s.v[i] : undefined;
}
