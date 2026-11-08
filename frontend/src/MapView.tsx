// The network map at "now": React Flow canvas, positions from layout.ts, one custom component per
// kind of thing. Facilities are tank gauges coloured by their worst state; pipes animate while
// their pump runs and turn red on a leak; trucks a plan dispatches show as routes from the yard.

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getStraightPath,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Network, Ops } from "./api";
import { HoverCard, type HoverTarget } from "./HoverCard";
import type { Layout, Point } from "./layout";
import { PUMP_FAULT, PUMP_RUNNING, STATUS_LABEL, hhmm, shortName, type FacilityStatus, type FacilityView } from "./status";
import { valueAt, type Telemetry } from "./telemetry";

// ---------------------------------------------------------------- icons

function TruckIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M2 6h11v9H2zM13 9h4l3 3v3h-7z" fill="currentColor" />
      <circle cx="6" cy="17" r="2" fill="currentColor" />
      <circle cx="17" cy="17" r="2" fill="currentColor" />
    </svg>
  );
}

function DisposalIcon() {
  return (
    <svg viewBox="0 0 24 24" width={30} height={30} aria-hidden="true">
      <path d="M12 3v10M7 9l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M3 18h18M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function DropIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
      <path d="M12 3C9 8 6 11 6 15a6 6 0 0 0 12 0c0-4-3-7-6-12z" fill="currentColor" />
    </svg>
  );
}

/** Edges join node centres; handles are invisible points there. */
function CenterHandles() {
  return (
    <>
      <Handle type="source" position={Position.Top} className="center-handle" isConnectable={false} />
      <Handle type="target" position={Position.Top} className="center-handle" isConnectable={false} />
    </>
  );
}

// ---------------------------------------------------------------- nodes

type FacilityNode = Node<{ view: FacilityView; warningPct: number; shutdownPct: number; selected: boolean }, "facility">;
type WellNode = Node<{ producing: boolean | undefined }, "well">;
type DisposalNode = Node<{ label: string }, "disposal">;
type YardNode = Node<{ systemId: string; fleet: number; out: number }, "yard">;
type RegionNode = Node<{ systemId: string; radius: number; alerts: number; worst: FacilityStatus | "leak" }, "region">;

const GAUGE = 60;
const TANK = { x: 21, y: 14, w: 18, h: 32 };
const RING_R = 27;

function FacilityNodeView({ data }: NodeProps<FacilityNode>) {
  const { view, warningPct, shutdownPct, selected } = data;
  const level: number = Math.max(0, Math.min(100, view.levelPct ?? 0)) / 100;
  const limitY = (pct: number): number => TANK.y + TANK.h * (1 - pct / 100);
  // Countdown ring: the share of the time left until the repair that the tank can still hold out.
  let ringFraction: number | null = null;
  if (view.plan && !view.plan.tripped && view.plan.trips_at_unix !== null) {
    const repairLeft: number = (view.plan.repair_end_unix - view.plan.planned_at_unix) / 3600;
    ringFraction = Math.max(0, Math.min(1, view.plan.hours_to_limit.p50 / repairLeft));
  }
  const circumference: number = 2 * Math.PI * RING_R;
  let chip: string | null = null;
  if (view.status === "tripped") chip = "SHUT IN";
  else if (view.plan && view.plan.trips_at_unix !== null) chip = `${view.plan.hours_to_limit.p50.toFixed(1)} h`;
  return (
    <div className={`facility-node status-${view.status} ${selected ? "selected" : ""}`} style={{ width: GAUGE, height: GAUGE }}>
      <CenterHandles />
      <svg viewBox={`0 0 ${GAUGE} ${GAUGE}`} width={GAUGE} height={GAUGE}>
        <circle className="ring" cx={GAUGE / 2} cy={GAUGE / 2} r={RING_R} />
        {ringFraction !== null && (
          <circle
            className="countdown-ring"
            cx={GAUGE / 2}
            cy={GAUGE / 2}
            r={RING_R}
            strokeDasharray={`${ringFraction * circumference} ${circumference}`}
            transform={`rotate(-90 ${GAUGE / 2} ${GAUGE / 2})`}
          />
        )}
        <rect className="tank-shell" x={TANK.x} y={TANK.y} width={TANK.w} height={TANK.h} rx={3} />
        <rect className="tank-fill" x={TANK.x} y={TANK.y + TANK.h * (1 - level)} width={TANK.w} height={TANK.h * level} />
        <line className="tank-warning" x1={TANK.x - 3} x2={TANK.x + TANK.w + 3} y1={limitY(warningPct)} y2={limitY(warningPct)} />
        <line className="tank-limit" x1={TANK.x - 4} x2={TANK.x + TANK.w + 4} y1={limitY(shutdownPct)} y2={limitY(shutdownPct)} />
      </svg>
      <div className="node-label">
        {shortName(view.facility.id)}
        {chip && <span className="node-chip">{chip}</span>}
      </div>
    </div>
  );
}

function WellNodeView({ data }: NodeProps<WellNode>) {
  return (
    <div className={`well-node ${data.producing === false ? "off" : ""}`}>
      <CenterHandles />
    </div>
  );
}

function DisposalNodeView({ data }: NodeProps<DisposalNode>) {
  return (
    <div className="disposal-node">
      <CenterHandles />
      <DisposalIcon />
      <div className="node-label">{data.label}</div>
    </div>
  );
}

function YardNodeView({ data }: NodeProps<YardNode>) {
  return (
    <div className="yard-node">
      <CenterHandles />
      <TruckIcon size={22} />
      <div className="node-label">
        {data.systemId} yard · {data.fleet - data.out}/{data.fleet} free
      </div>
    </div>
  );
}

/** Tinted disc behind a system with its name on top. Only the name takes clicks (zoom to the
 * system); the disc lets the mouse through to the pipes and nodes it sits behind. */
function RegionNodeView({ data }: NodeProps<RegionNode>) {
  return (
    <div className={`region worst-${data.worst}`} style={{ width: data.radius * 2, height: data.radius * 2 }}>
      <div className="region-label" title={`Open the ${data.systemId} tab`}>
        {data.systemId}
        {data.alerts > 0 && <span className="system-alerts">{data.alerts}</span>}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  facility: FacilityNodeView,
  well: WellNodeView,
  disposal: DisposalNodeView,
  yard: YardNodeView,
  region: RegionNodeView,
};

// ---------------------------------------------------------------- edges

type PipeEdge = Edge<{ running: boolean; leak: boolean; failed: boolean; lostPct: number | undefined }, "pipe">;
type WellEdge = Edge<{ producing: boolean | undefined }, "wellLink">;
type RouteEdge = Edge<{ label: string }, "route">;

function PipeEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<PipeEdge>) {
  const [path, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const state: string = data?.leak ? "leak" : data?.failed ? "failed" : data?.running ? "running" : "idle";
  return (
    <>
      <BaseEdge id={id} path={path} className={`pipe pipe-${state}`} interactionWidth={18} />
      {data?.running && <path d={path} className={`pipe-flow ${data.leak ? "leak" : ""}`} />}
      {data?.leak && (
        <EdgeLabelRenderer>
          <div className="leak-badge" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <DropIcon />
            {data.lostPct !== undefined ? `−${data.lostPct.toFixed(1)}%` : "leak"}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function WellEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<WellEdge>) {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return <BaseEdge id={id} path={path} className={`well-link ${data?.producing === false ? "off" : ""}`} interactionWidth={10} />;
}

function RouteEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<RouteEdge>) {
  const [path, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return (
    <>
      <BaseEdge id={id} path={path} className="truck-route" interactionWidth={10} />
      <EdgeLabelRenderer>
        <div className="route-badge" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
          <TruckIcon size={14} />
          {data?.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes: EdgeTypes = { pipe: PipeEdgeView, wellLink: WellEdgeView, route: RouteEdgeView };

// ---------------------------------------------------------------- canvas

export const OVERVIEW = "overview";

export const SEVERITY: Record<FacilityStatus | "leak", number> = { tripped: 5, failure: 4, leak: 3, wear: 2, warning: 1, ok: 0 };

interface Props {
  network: Network;
  ops: Ops | null;
  layout: Layout;
  views: Map<string, FacilityView>;
  telemetry: Telemetry | null;
  now: number;
  scope: string; // "overview" or a system id: which systems this canvas draws
  selectedFacility: string | null;
  onOpenSystem: (systemId: string) => void;
  onOpenFacility: (facilityId: string, component?: "pipeline" | string) => void; // component: "pipeline" or a well id
  onClearSelection: () => void;
}

function MapCanvas(props: Props) {
  const { network, ops, layout, views, telemetry, now, scope, selectedFacility } = props;
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const overview: boolean = scope === OVERVIEW;

  const at = (p: Point | undefined): Point => p ?? { x: 0, y: 0 };
  const shutdownPct: number = network.defaults.tank_limits_pct.shutdown;
  const warningPct: number = network.defaults.tank_limits_pct.warning;

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    for (const sys of network.systems.filter((s) => overview || s.id === scope)) {
      const sysViews: FacilityView[] = sys.facilities.flatMap((f) => views.get(f.id) ?? []);
      const trucksOut: number = sysViews.reduce((n, v) => n + (v.plan?.plan_mode === "joint_now" ? v.plan.plan.trucks : 0), 0);
      const worst: FacilityStatus | "leak" = sysViews
        .flatMap((v): (FacilityStatus | "leak")[] => (v.leak ? [v.status, "leak"] : [v.status]))
        .reduce<FacilityStatus | "leak">((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "ok");
      const alerts: number = sysViews.reduce((n, v) => n + v.events.length, 0);
      const region = layout.regions.get(sys.id);
      if (region && overview) {
        nodes.push({
          id: `region:${sys.id}`,
          type: "region",
          position: region.center,
          data: { systemId: sys.id, radius: region.radius, alerts, worst },
          zIndex: -1,
        });
      }
      nodes.push({ id: sys.disposal_site.id, type: "disposal", position: at(layout.positions.get(sys.disposal_site.id)), data: { label: `${sys.id} disposal` } });
      nodes.push({
        id: `yard:${sys.id}`,
        type: "yard",
        position: at(layout.positions.get(`yard:${sys.id}`)),
        data: { systemId: sys.id, fleet: ops?.systems[sys.id]?.emergency_fleet_size ?? 0, out: trucksOut },
      });
      for (const fac of sys.facilities) {
        const view: FacilityView | undefined = views.get(fac.id);
        if (!view) continue;
        nodes.push({
          id: fac.id,
          type: "facility",
          position: at(layout.positions.get(fac.id)),
          data: { view, warningPct, shutdownPct, selected: fac.id === selectedFacility },
          zIndex: 2,
        });
        const running: boolean = view.pumpStatus === PUMP_RUNNING;
        let lostPct: number | undefined;
        if (telemetry && running) {
          const flow: number | undefined = valueAt(telemetry, fac.pump.id, "flow_bpd", now);
          const recv: number | undefined = valueAt(telemetry, fac.pipeline.id, "receive_flow_bpd", now);
          if (flow && recv !== undefined) lostPct = (1 - recv / flow) * 100;
        }
        edges.push({
          id: fac.pipeline.id,
          type: "pipe",
          source: fac.id,
          target: sys.disposal_site.id,
          data: { running, leak: Boolean(view.leak), failed: view.pumpStatus === PUMP_FAULT, lostPct },
        });
        for (const well of fac.wells) {
          const producing: boolean | undefined = telemetry ? valueAt(telemetry, well.id, "status", now) === 1 : undefined;
          nodes.push({ id: well.id, type: "well", position: at(layout.positions.get(well.id)), data: { producing } });
          edges.push({ id: `link:${well.id}`, type: "wellLink", source: well.id, target: fac.id, data: { producing } });
        }
        const plan = view.plan;
        if (plan?.plan_mode === "joint_now" && plan.plan.trucks > 0) {
          const first: number | undefined = plan.plan.truck_arrivals_unix[0];
          edges.push({
            id: `route:${fac.id}`,
            type: "route",
            source: `yard:${sys.id}`,
            target: fac.id,
            data: { label: `${plan.plan.trucks} × ${plan.plan.trips_per_truck} trip${plan.plan.trips_per_truck > 1 ? "s" : ""}${first ? ` · ${hhmm(first)}` : ""}` },
          });
        }
      }
    }
    return { nodes, edges };
  }, [network, ops, layout, views, telemetry, now, overview, scope, selectedFacility, shutdownPct, warningPct]);

  function track(kind: HoverTarget["kind"], id: string, e: ReactMouseEvent): void {
    const box: DOMRect | undefined = container.current?.getBoundingClientRect();
    if (box) setHover({ kind, id, x: e.clientX - box.left, y: e.clientY - box.top, width: box.width, height: box.height });
  }

  return (
    <div className="map" ref={container}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodeOrigin={[0.5, 0.5]}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        colorMode="system"
        minZoom={0.15}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: overview ? 0.03 : 0.06 }}
        proOptions={{ hideAttribution: true }}
        onNodeMouseEnter={(e, n) => n.type !== "region" && track(n.type as HoverTarget["kind"], n.id, e)}
        onNodeMouseMove={(e, n) => n.type !== "region" && track(n.type as HoverTarget["kind"], n.id, e)}
        onNodeMouseLeave={() => setHover(null)}
        onEdgeMouseEnter={(e, ed) => ed.type === "pipe" && track("pipe", ed.id, e)}
        onEdgeMouseMove={(e, ed) => ed.type === "pipe" && track("pipe", ed.id, e)}
        onEdgeMouseLeave={() => setHover(null)}
        onNodeClick={(_, n) => {
          if (n.type === "facility") props.onOpenFacility(n.id);
          if (n.type === "well") {
            const fac = network.systems.flatMap((s) => s.facilities).find((f) => f.wells.some((w) => w.id === n.id));
            if (fac) props.onOpenFacility(fac.id, n.id);
          }
          if (n.type === "region") props.onOpenSystem((n.data as RegionNode["data"]).systemId);
        }}
        onPaneClick={props.onClearSelection}
        onEdgeClick={(_, ed) => {
          if (ed.type === "pipe" && typeof ed.source === "string") props.onOpenFacility(ed.source, "pipeline");
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={32} size={1} color="var(--border)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="map-legend">
        <span className="lg lg-failure">pump failed</span>
        <span className="lg lg-tripped">shut in</span>
        <span className="lg lg-wear">pump wearing</span>
        <span className="lg lg-warning">tank &gt; warning</span>
        <span className="lg lg-leak">leak</span>
        <span className="lg lg-running">pumping</span>
      </div>
      {hover && (
        <HoverCard target={hover} network={network} views={views} telemetry={telemetry} now={now} statusLabel={STATUS_LABEL} />
      )}
    </div>
  );
}

/** Each tab gets a fresh canvas, so it opens fitted to what it draws. */
export function MapView(props: Props) {
  return (
    <ReactFlowProvider key={props.scope}>
      <MapCanvas {...props} />
    </ReactFlowProvider>
  );
}
