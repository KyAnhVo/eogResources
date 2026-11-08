// Map positions from network.json coordinates (no layout engine: geography is the layout).
//
// Systems sit 40-100 km apart while a system's facilities span ~10 km, so one true scale would
// squash each system into a dot. Two layouts, both derived from the network itself:
// - Overview (every system): inside a system, facilities and the disposal site keep their true
//   relative positions, scaled so the widest system spans OVERVIEW.systemRadius px; systems keep
//   their true relative positions, scaled just enough that no two regions overlap.
// - System tab (one system): the same placement with roomier spacing, scaled to that system alone,
//   so a two-facility system fills the canvas as well as a four-facility one.
// Truck yards keep their true direction from the system but sit just outside it, and wells
// (which have no coordinates) fan out around their facility, facing away from the disposal site.

import type { Network, NetworkSystem } from "./api";

export interface Point {
  x: number;
  y: number;
}

export interface Region {
  center: Point;
  radius: number; // px, encloses everything drawn for the system
}

export interface Layout {
  positions: Map<string, Point>; // facility, disposal site, well and yard ids
  regions: Map<string, Region>; // per system
}

interface Spacing {
  systemRadius: number; // px from a system's anchor to its farthest facility or disposal site
  wellDistance: number; // px from a facility to its wells
  yardDistance: number; // px from a system's anchor to its truck yard (direction only is real)
  labelRoom: number; // room inside the top of a region for the system name
}

// Overview sizes are tuned so the whole network reads at ~0.6x zoom; a system tab opens near 1x.
const OVERVIEW: Spacing = { systemRadius: 145, wellDistance: 44, yardDistance: 180, labelRoom: 40 };
const DETAIL: Spacing = { systemRadius: 230, wellDistance: 66, yardDistance: 290, labelRoom: 0 };
const WELL_ARC = (140 * Math.PI) / 180; // spread of a facility's wells
const NODE_MARGIN = 46; // room for a node and its label beyond its centre
const SYSTEM_GAP = 36; // px between neighbouring regions in the overview

/** Local equirectangular projection in degrees: x east, y south (screen y grows downward). */
function project(lat: number, lon: number, cosLat: number): Point {
  return { x: lon * cosLat, y: -lat };
}

function anchorOf(sys: NetworkSystem, cosLat: number): Point {
  const pts: { lat: number; lon: number }[] = [...sys.facilities, sys.disposal_site];
  const lat: number = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const lon: number = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
  return project(lat, lon, cosLat);
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

function cosLatOf(network: Network): number {
  const lats: number[] = network.systems.flatMap((s) => s.facilities.map((f) => f.lat));
  return Math.cos(((lats.reduce((a, b) => a + b, 0) / Math.max(1, lats.length)) * Math.PI) / 180);
}

/** Degrees from a system's anchor to its farthest facility or disposal site. */
function extentDeg(sys: NetworkSystem, anchor: Point, cosLat: number): number {
  return Math.max(1e-9, ...[...sys.facilities, sys.disposal_site].map((p) => dist(project(p.lat, p.lon, cosLat), anchor)));
}

/** Region radius once placed: farthest well or the yard, plus room for nodes and the name. */
function regionRadius(sys: NetworkSystem, anchor: Point, cosLat: number, inner: number, sp: Spacing): number {
  let r: number = sp.yardDistance;
  for (const f of sys.facilities) r = Math.max(r, dist(project(f.lat, f.lon, cosLat), anchor) * inner + sp.wellDistance);
  return r + NODE_MARGIN + sp.labelRoom / 2;
}

/** Place one system's disposal site, yard, facilities and wells around `center`. */
function placeSystem(
  sys: NetworkSystem,
  anchor: Point,
  center: Point,
  inner: number,
  cosLat: number,
  sp: Spacing,
  positions: Map<string, Point>,
): void {
  // Shift the content down a little so the name at the top of the region has room.
  const content: Point = { x: center.x, y: center.y + sp.labelRoom / 2 };
  const place = (lat: number, lon: number): Point => {
    const q: Point = project(lat, lon, cosLat);
    return { x: content.x + (q.x - anchor.x) * inner, y: content.y + (q.y - anchor.y) * inner };
  };
  const disposal: Point = place(sys.disposal_site.lat, sys.disposal_site.lon);
  positions.set(sys.disposal_site.id, disposal);

  const yard: Point = project(sys.truck_yard[0], sys.truck_yard[1], cosLat);
  const yardAngle: number = Math.atan2(yard.y - anchor.y, yard.x - anchor.x);
  positions.set(`yard:${sys.id}`, {
    x: content.x + Math.cos(yardAngle) * sp.yardDistance,
    y: content.y + Math.sin(yardAngle) * sp.yardDistance,
  });

  for (const fac of sys.facilities) {
    const f: Point = place(fac.lat, fac.lon);
    positions.set(fac.id, f);
    // Wells face away from the disposal site so they don't sit on the pipeline.
    const away: number = Math.atan2(f.y - disposal.y, f.x - disposal.x);
    const n: number = fac.wells.length;
    fac.wells.forEach((w, i) => {
      const angle: number = away + (n === 1 ? 0 : -WELL_ARC / 2 + (WELL_ARC * i) / (n - 1));
      positions.set(w.id, { x: f.x + Math.cos(angle) * sp.wellDistance, y: f.y + Math.sin(angle) * sp.wellDistance });
    });
  }
}

/** Every system on one canvas. */
export function computeLayout(network: Network): Layout {
  const cosLat: number = cosLatOf(network);
  const anchors = new Map<string, Point>(network.systems.map((s) => [s.id, anchorOf(s, cosLat)]));

  // Inner scale: the widest system's farthest point lands OVERVIEW.systemRadius px from its anchor.
  const widest: number = Math.max(...network.systems.map((s) => extentDeg(s, anchors.get(s.id)!, cosLat)));
  const inner: number = OVERVIEW.systemRadius / widest;
  const radius = new Map<string, number>(
    network.systems.map((s) => [s.id, regionRadius(s, anchors.get(s.id)!, cosLat, inner, OVERVIEW)]),
  );

  // Outer scale: smallest that keeps every pair of regions SYSTEM_GAP apart.
  let outer = 1;
  const ids: string[] = network.systems.map((s) => s.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d: number = dist(anchors.get(ids[i])!, anchors.get(ids[j])!);
      if (d > 0) outer = Math.max(outer, (radius.get(ids[i])! + radius.get(ids[j])! + SYSTEM_GAP) / d);
    }
  }

  const positions = new Map<string, Point>();
  const regions = new Map<string, Region>();
  for (const sys of network.systems) {
    const a: Point = anchors.get(sys.id)!;
    const center: Point = { x: a.x * outer, y: a.y * outer };
    regions.set(sys.id, { center, radius: radius.get(sys.id)! });
    placeSystem(sys, a, center, inner, cosLat, OVERVIEW, positions);
  }
  return { positions, regions };
}

/** One system on its own canvas, scaled to that system so it fills the view. */
export function computeSystemLayout(network: Network, systemId: string): Layout {
  const positions = new Map<string, Point>();
  const regions = new Map<string, Region>();
  const sys: NetworkSystem | undefined = network.systems.find((s) => s.id === systemId);
  if (!sys) return { positions, regions };
  const cosLat: number = cosLatOf(network);
  const anchor: Point = anchorOf(sys, cosLat);
  const inner: number = DETAIL.systemRadius / extentDeg(sys, anchor, cosLat);
  const center: Point = { x: 0, y: 0 };
  regions.set(sys.id, { center, radius: regionRadius(sys, anchor, cosLat, inner, DETAIL) });
  placeSystem(sys, anchor, center, inner, cosLat, DETAIL, positions);
  return { positions, regions };
}
