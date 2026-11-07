// Where every edge in a model runs, in that model's own coordinates. This is the geometry
// pass that precedes painting: it reads display rects and writes one EdgeGeometry per edge
// into a caller-owned map, which painting, hit-testing, the label anchor and the edit popup
// all read back. Nothing here touches a canvas context — the shape of an edge is settled
// before anything is drawn, so it can be computed and tested without a renderer.

import { DEFAULT_NODE_SHAPE, type NodeShape } from '../../shared/canvas-layer.js';
import { anchorDirectionOf, type EdgeBend, type EdgeStyle } from '../../shared/canvas-edge-style.js';
import type { FlowNode, Rect } from '../../shared/flow-format.js';
import {
  displayRectOf,
  edgeIdentityOf,
  type EdgeIdentity,
  type FlowModel,
  type GhostNode,
  type ModelEdge,
} from '../flow-doc.js';
import { edgeStyleIn } from '../model-visuals.js';
import {
  boundsOfPoints,
  halfExtentAlong,
  midpointOf,
  offsetAlong,
  perpendicular,
  rectCenter,
  rectContains,
  unitVectorBetween,
  type Point,
} from '../geometry.js';
import { bendPointOf } from './edge-bend.js';
import { createEdgeGeometry, type EdgeGeometry } from './edge-path.js';
import { transformRect } from './expansion.js';
import { shapeBorderPointFrom, shapeBorderPointToward } from './node-shapes.js';

export type EdgeGeometryMap = Map<ModelEdge, EdgeGeometry>;

// Parallel edges between one pair of nodes are separated into lanes: every point of an edge is
// displaced across the run by its lane offset, so the anchors and arrowheads land on distinct
// border points rather than stacking. Lane indices are centred on zero, so a lone edge runs
// straight down the middle between its nodes.
const LANE_SPACING = 26;
// Each lane away from the middle also bows outward, opening a bundle into a lens so its edges
// are widest apart where labels sit.
const BASE_BOW_FRACTION = 0.1;
const MAX_BASE_BOW = 34;
// An anchor can only slide while its lane offset stays inside the node, so lane spacing is
// scaled down to fit within this fraction of the border's half-extent across the run.
const MAX_LANE_OFFSET_FRACTION = 0.5;
// Below this the frame has barely opened, so an edge aimed at a node inside it would point
// into a sliver — it stays on the host's border until the subgraph is actually legible.
const MIN_INNER_TARGET_ALPHA = 0.15;
const SELF_LOOP_START_INSET = 30;
const SELF_LOOP_END_DROP = 24;
const SELF_LOOP_APEX_OFFSET = { x: 42, y: -40 };
const SELF_LOOP_NEST_STEP = 16;

// The outline an edge end meets: where it is, and what shape is drawn there.
export interface Endpoint {
  rect: Rect;
  shape: NodeShape;
}

interface Lane {
  /** Signed position across the bundle, in the node pair's canonical orientation. */
  index: number;
  /** The largest `index` in this bundle, which lane spacing is scaled to fit inside the nodes. */
  extent: number;
}

function isGhost(target: FlowNode | GhostNode): target is GhostNode {
  return 'ghost' in target && target.ghost === true;
}

// What an edge's route is drawn from: its bend and the angles its ends are pinned to.
export type EdgeRoute = Pick<EdgeStyle, 'bend' | 'startAngle' | 'endAngle'>;

// A drag in progress, by edge: the part of the route it would write (a field set to null takes
// that part away), or `hidden` for an edge the drag is turning into something else. Keyed by
// identity rather than by ModelEdge, so a model rebuilt mid-drag still finds it.
export type EdgeRouteOverride = Partial<EdgeRoute> & { hidden?: true };
export type EdgeRouteOverrides = ReadonlyMap<EdgeIdentity, EdgeRouteOverride>;

export function layOutModelEdges(model: FlowModel, geometry: EdgeGeometryMap, routeOverrides: EdgeRouteOverrides | null = null): void {
  const routeOf = (edge: ModelEdge): EdgeRoute | null => {
    const override = routeOverrides?.get(edgeIdentityOf(edge));
    if (override?.hidden) return null;
    const { bend, startAngle, endAngle } = edgeStyleIn(model, edge);
    return { bend, startAngle, endAngle, ...override };
  };
  for (const bundle of bundleEdgesByNodePair(model.edges, geometry).values()) {
    layOutBundle(model, bundle, routeOf, geometry);
  }
}

// One rect per drawn edge, from its laid-out path. A bend can carry an edge far outside the nodes
// it joins, so framing a model has to measure its edges as well as its nodes.
export function edgePathBounds(model: FlowModel): Rect[] {
  const geometry: EdgeGeometryMap = new Map();
  layOutModelEdges(model, geometry);
  return [...geometry.values()]
    .map((edge) => boundsOfPoints(edge.path))
    .filter((rect): rect is Rect => rect != null);
}

// A bent or pinned edge leaves its bundle: it runs where the user put it, and the edges still laid
// out automatically share the lanes among themselves. So while one edge of three is being bent, the
// other two re-lane as a pair — live, because the drag's route is laid out like a stored one.
// Self-loops are never bent or pinned, whatever their entry says, so their nesting never shifts.
// A null route is an edge hidden for the moment, which is laid out nowhere.
function layOutBundle(
  model: FlowModel,
  bundle: ModelEdge[],
  routeOf: (edge: ModelEdge) => EdgeRoute | null,
  geometry: EdgeGeometryMap,
): void {
  const shown = bundle.filter((edge) => {
    const isShown = routeOf(edge) != null;
    if (!isShown) geometry.delete(edge);
    return isShown;
  });
  if (shown.length === 0) return;
  if (shown[0].to === shown[0].from) {
    shown.forEach((edge, occurrence) => geometry.set(edge, selfLoopGeometry(model, edge.from, occurrence)));
    return;
  }
  const unbent: ModelEdge[] = [];
  for (const edge of shown) {
    const route = routeOf(edge)!;
    const routed = isRouted(route) ? routedGeometry(endpointsOf(model, edge, edge.to!), route) : null;
    if (routed) geometry.set(edge, routed);
    else unbent.push(edge);
  }
  unbent.forEach((edge, occurrence) => {
    const target = edge.to!;
    const lane = inCanonicalOrientation(laneOf(occurrence, unbent.length), edge.from, target);
    geometry.set(edge, lanedGeometry(endpointsOf(model, edge, target), lane));
  });
}

// Edges are laid out per unordered node pair, because how far one is displaced depends on how
// many others share that pair. Edges whose endpoints have no position yet cannot be drawn at
// all, and any stale geometry they left behind is dropped here.
function bundleEdgesByNodePair(edges: ModelEdge[], geometry: EdgeGeometryMap): Map<string, ModelEdge[]> {
  const bundles = new Map<string, ModelEdge[]>();
  for (const edge of edges) {
    if (!edge.from?.pos || !edge.to?.pos) {
      geometry.delete(edge);
      continue;
    }
    const key = nodePairKey(edge.from, edge.to);
    const bundle = bundles.get(key);
    if (bundle) bundle.push(edge);
    else bundles.set(key, [edge]);
  }
  return bundles;
}

function nodePairKey(from: FlowNode, to: FlowNode | GhostNode): string {
  return [from.name, to.name].sort().join(' ');
}

// Lanes are centred on zero so a bundle stays balanced about the line between its nodes: two
// edges take ±0.5, three take -1, 0 and +1.
function laneOf(occurrence: number, edgesInBundle: number): Lane {
  const extent = (edgesInBundle - 1) / 2;
  return { index: occurrence - extent, extent };
}

// A lane is measured in the pair's canonical orientation rather than each edge's own. Reversing
// an edge negates the normal its offset is applied along, which would otherwise cancel the
// lane's sign and drop `A -> B` and `B -> A` onto exactly the same curve.
function inCanonicalOrientation(lane: Lane, from: FlowNode, to: FlowNode | GhostNode): Lane {
  return from.name <= to.name ? lane : { index: -lane.index, extent: lane.extent };
}

function isRouted(route: EdgeRoute): boolean {
  return route.bend != null || route.startAngle != null || route.endAngle != null;
}

// The outlines a drawn edge meets at either end, as the layout measures them — what a pinned end's
// angle is measured around. Null for a self-loop or an edge not drawn.
export function edgeEndpointsOf(model: FlowModel, edge: ModelEdge): { from: Endpoint; to: Endpoint } | null {
  if (!edge.from?.pos || !edge.to?.pos || edge.to === edge.from) return null;
  return endpointsOf(model, edge, edge.to);
}

// An edge normally spans its two nodes' borders, but either end is redirected onto a named
// node inside an unfolded frame when the `{Inner}` form names one (spec §5.7, §5.8).
function endpointsOf(model: FlowModel, edge: ModelEdge, target: FlowNode | GhostNode): { from: Endpoint; to: Endpoint } {
  const innerFrom = edge.kind === 'flow' && edge.spec.innerSource
    ? innerNodeEndpoint(model, edge.from, edge.spec.innerSource)
    : null;
  const innerTo = edge.kind === 'flow' && edge.spec.innerTarget && !isGhost(target)
    ? innerNodeEndpoint(model, target, edge.spec.innerTarget)
    : null;
  return {
    from: innerFrom ?? nodeEndpoint(model, edge.from),
    to: innerTo ?? (isGhost(target) ? { rect: target.pos, shape: DEFAULT_NODE_SHAPE } : nodeEndpoint(model, target)),
  };
}

function nodeEndpoint(model: FlowModel, node: FlowNode): Endpoint {
  return { rect: displayRectOf(model, node), shape: drawnShapeOf(model, node) };
}

// An unfolded node is drawn as its frame, a plain rectangle, whatever shape it has collapsed.
export function drawnShapeOf(model: FlowModel, node: FlowNode): NodeShape {
  if (model.display?.expansions.has(node)) return DEFAULT_NODE_SHAPE;
  return model.visuals?.shapeOf(node) ?? DEFAULT_NODE_SHAPE;
}

function lanedGeometry(ends: { from: Endpoint; to: Endpoint }, lane: Lane): EdgeGeometry {
  const fromCenter = rectCenter(ends.from.rect);
  const toCenter = rectCenter(ends.to.rect);
  const towardTarget = unitVectorBetween(fromCenter, toCenter);
  const towardSource = unitVectorBetween(toCenter, fromCenter);
  const across = perpendicular(towardTarget);
  const offset = laneOffset(lane, { from: ends.from.rect, to: ends.to.rect }, across);

  const start = shapeBorderPointFrom(ends.from.shape, ends.from.rect, offsetAlong(fromCenter, across, offset), towardTarget);
  const end = shapeBorderPointFrom(ends.to.shape, ends.to.rect, offsetAlong(toCenter, across, offset), towardSource);
  const mid = offsetAlong(midpointOf(start, end), across, outwardBow(start, end, lane));
  return createEdgeGeometry([start, mid, end], { chord: { from: fromCenter, to: toCenter } });
}

// A pinned end sits where its angle leaves the node's outline; the line runs straight from it, to
// the bend if there is one, or to the other end. An end left free faces whatever comes next along
// the line: the bend, the other end's pinned point, or the other node's centre. Null when nothing
// is left to route by — a bend on a chord of no length, with neither end pinned — which leaves the
// edge to its lane.
function routedGeometry(ends: { from: Endpoint; to: Endpoint }, route: EdgeRoute): EdgeGeometry | null {
  const chord = { from: rectCenter(ends.from.rect), to: rectCenter(ends.to.rect) };
  const bendPoint = route.bend ? bendPointOf(route.bend, chord) : null;
  if (!bendPoint && route.startAngle == null && route.endAngle == null) return null;
  const pinnedStart = route.startAngle != null ? pinnedEndPoint(ends.from, route.startAngle) : null;
  const pinnedEnd = route.endAngle != null ? pinnedEndPoint(ends.to, route.endAngle) : null;
  const start = pinnedStart ?? freeEndPoint(ends.from, bendPoint ?? pinnedEnd, chord.to);
  const end = pinnedEnd ?? freeEndPoint(ends.to, bendPoint ?? pinnedStart, chord.from);
  const through = bendPoint ?? midpointOf(start, end);
  return createEdgeGeometry([start, through, end], { grip: through, chord });
}

export function pinnedEndPoint(endpoint: Endpoint, angle: number): Point {
  return shapeBorderPointFrom(endpoint.shape, endpoint.rect, rectCenter(endpoint.rect), anchorDirectionOf(angle));
}

function freeEndPoint(endpoint: Endpoint, nextPoint: Point | null, otherCenter: Point): Point {
  const facing = nextPoint ? aimFrom(endpoint.rect, nextPoint, otherCenter) : otherCenter;
  return shapeBorderPointToward(endpoint.shape, endpoint.rect, facing);
}

// An end leaves its node facing the bend — unless the bend was dragged inside that node, where
// facing it would point the end back into the node; it faces the other end instead.
function aimFrom(rect: Rect, bendPoint: Point, otherCenter: Point): Point {
  return rectContains(rect, bendPoint) ? otherCenter : bendPoint;
}

// The whole ladder is scaled by one factor rather than clamped lane by lane, so a short edge
// between small nodes tightens its lanes instead of collapsing the outer ones onto each other.
// The narrower of the two nodes governs, since both ends carry the same offset.
function laneOffset(lane: Lane, rects: { from: Rect; to: Rect }, across: Point): number {
  if (lane.extent === 0) return 0;
  const narrowestHalfExtent = Math.min(halfExtentAlong(rects.from, across), halfExtentAlong(rects.to, across));
  const spacing = Math.min(LANE_SPACING, MAX_LANE_OFFSET_FRACTION * narrowestHalfExtent / lane.extent);
  return lane.index * spacing;
}

// Every lane bows away from the middle of its bundle. Lane 0 is the bundle's own axis and has no
// outward direction, so it stays straight — which is also what a lone edge gets.
function outwardBow(start: Point, end: Point, lane: Lane): number {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  return Math.min(MAX_BASE_BOW, length * BASE_BOW_FRACTION) * Math.sign(lane.index);
}

// Repeated self-loops nest rather than share a lane: each one clears the loop drawn inside it.
// The loop is aimed at the rectangle's upper-right corner and lands where those aims cross the
// node's outline, so on a rounded or pointed shape it still leaves and returns on the ink.
function selfLoopGeometry(model: FlowModel, node: FlowNode, occurrence: number): EdgeGeometry {
  const { rect, shape } = nodeEndpoint(model, node);
  const { x, y, w } = rect;
  const nesting = occurrence * SELF_LOOP_NEST_STEP;
  const start = shapeBorderPointToward(shape, rect, { x: x + w - SELF_LOOP_START_INSET - nesting, y });
  const end = shapeBorderPointToward(shape, rect, { x: x + w, y: y + SELF_LOOP_END_DROP + nesting });
  const apex = { x: x + w + SELF_LOOP_APEX_OFFSET.x + nesting, y: y + SELF_LOOP_APEX_OFFSET.y - nesting };
  return createEdgeGeometry([start, apex, end], { chord: null });
}

// A host frame's named inner node mapped into this model's coordinates, so an edge can start
// or end on it. Null when the frame is collapsed, still opening, or holds no such name — in
// which case the edge meets the host's own border instead.
export function innerNodeRect(model: FlowModel, host: FlowNode, innerName: string): Rect | null {
  return innerNodeEndpoint(model, host, innerName)?.rect ?? null;
}

function innerNodeEndpoint(model: FlowModel, host: FlowNode, innerName: string): Endpoint | null {
  const expansion = model.display?.expansions.get(host);
  if (!expansion || expansion.alpha <= MIN_INNER_TARGET_ALPHA) return null;
  const innerNode = expansion.subModel.nodesByName.get(innerName);
  if (!innerNode) return null;
  return {
    rect: transformRect(displayRectOf(expansion.subModel, innerNode), expansion.transform),
    shape: drawnShapeOf(expansion.subModel, innerNode),
  };
}

// Edges with an end inside an unfolded frame are painted after the nodes, so the frame's own
// fill cannot occlude them (spec §5.7 expanded display).
export function edgeReachesInsideOpenFrame(model: FlowModel, edge: ModelEdge): boolean {
  if (edge.kind !== 'flow') return false;
  if (edge.spec.innerSource && innerNodeRect(model, edge.from, edge.spec.innerSource)) return true;
  if (!edge.spec.innerTarget || !edge.to || isGhost(edge.to)) return false;
  return innerNodeRect(model, edge.to, edge.spec.innerTarget) != null;
}
