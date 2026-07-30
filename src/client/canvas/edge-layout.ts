// Where every edge in a model runs, in that model's own coordinates. This is the geometry
// pass that precedes painting: it reads display rects and writes one EdgeGeometry per edge
// into a caller-owned map, which painting, hit-testing, the label anchor and the edit popup
// all read back. Nothing here touches a canvas context — the shape of an edge is settled
// before anything is drawn, so it can be computed and tested without a renderer.

import type { FlowNode, Rect } from '../../shared/flow-format.js';
import { displayRectOf, type FlowModel, type GhostNode, type ModelEdge } from '../flow-doc.js';
import {
  halfExtentAlong,
  midpointOf,
  offsetAlong,
  perpendicular,
  rectBorderPointFrom,
  rectCenter,
  unitVectorBetween,
  type Point,
} from '../geometry.js';
import { createEdgeGeometry, type EdgeGeometry } from './edge-path.js';
import { transformRect } from './expansion.js';

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

interface Lane {
  /** Signed position across the bundle, in the node pair's canonical orientation. */
  index: number;
  /** The largest `index` in this bundle, which lane spacing is scaled to fit inside the nodes. */
  extent: number;
}

function isGhost(target: FlowNode | GhostNode): target is GhostNode {
  return 'ghost' in target && target.ghost === true;
}

export function layOutModelEdges(model: FlowModel, geometry: EdgeGeometryMap): void {
  for (const bundle of bundleEdgesByNodePair(model.edges, geometry).values()) {
    bundle.forEach((edge, occurrence) => {
      geometry.set(edge, geometryOfEdge(model, edge, laneOf(occurrence, bundle.length), occurrence));
    });
  }
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

function geometryOfEdge(model: FlowModel, edge: ModelEdge, lane: Lane, occurrence: number): EdgeGeometry {
  const target = edge.to!;
  if (target === edge.from) return selfLoopGeometry(model, edge.from, occurrence);
  return lanedGeometry(endpointRects(model, edge, target), inCanonicalOrientation(lane, edge.from, target));
}

// An edge normally spans its two nodes' borders, but either end is redirected onto a named
// node inside an unfolded frame when the `{Inner}` form names one (spec §5.7, §5.8).
function endpointRects(model: FlowModel, edge: ModelEdge, target: FlowNode | GhostNode): { from: Rect; to: Rect } {
  const innerFrom = edge.kind === 'flow' && edge.spec.innerSource
    ? innerNodeRect(model, edge.from, edge.spec.innerSource)
    : null;
  const innerTo = edge.kind === 'flow' && edge.spec.innerTarget && !isGhost(target)
    ? innerNodeRect(model, target, edge.spec.innerTarget)
    : null;
  return {
    from: innerFrom ?? displayRectOf(model, edge.from),
    to: innerTo ?? (isGhost(target) ? target.pos : displayRectOf(model, target)),
  };
}

function lanedGeometry(rects: { from: Rect; to: Rect }, lane: Lane): EdgeGeometry {
  const fromCenter = rectCenter(rects.from);
  const toCenter = rectCenter(rects.to);
  const towardTarget = unitVectorBetween(fromCenter, toCenter);
  const towardSource = unitVectorBetween(toCenter, fromCenter);
  const across = perpendicular(towardTarget);
  const offset = laneOffset(lane, rects, across);

  const start = rectBorderPointFrom(rects.from, offsetAlong(fromCenter, across, offset), towardTarget);
  const end = rectBorderPointFrom(rects.to, offsetAlong(toCenter, across, offset), towardSource);
  const mid = offsetAlong(midpointOf(start, end), across, outwardBow(start, end, lane));
  return createEdgeGeometry([start, mid, end]);
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
function selfLoopGeometry(model: FlowModel, node: FlowNode, occurrence: number): EdgeGeometry {
  const { x, y, w } = displayRectOf(model, node);
  const nesting = occurrence * SELF_LOOP_NEST_STEP;
  const start = { x: x + w - SELF_LOOP_START_INSET - nesting, y };
  const end = { x: x + w, y: y + SELF_LOOP_END_DROP + nesting };
  const apex = { x: x + w + SELF_LOOP_APEX_OFFSET.x + nesting, y: y + SELF_LOOP_APEX_OFFSET.y - nesting };
  return createEdgeGeometry([start, apex, end]);
}

// A host frame's named inner node mapped into this model's coordinates, so an edge can start
// or end on it. Null when the frame is collapsed, still opening, or holds no such name — in
// which case the edge meets the host's own border instead.
export function innerNodeRect(model: FlowModel, host: FlowNode, innerName: string): Rect | null {
  const expansion = model.display?.expansions.get(host);
  if (!expansion || expansion.alpha <= MIN_INNER_TARGET_ALPHA) return null;
  const innerNode = expansion.subModel.nodesByName.get(innerName);
  if (!innerNode) return null;
  return transformRect(displayRectOf(expansion.subModel, innerNode), expansion.transform);
}

// Edges with an end inside an unfolded frame are painted after the nodes, so the frame's own
// fill cannot occlude them (spec §5.7 expanded display).
export function edgeReachesInsideOpenFrame(model: FlowModel, edge: ModelEdge): boolean {
  if (edge.kind !== 'flow') return false;
  if (edge.spec.innerSource && innerNodeRect(model, edge.from, edge.spec.innerSource)) return true;
  if (!edge.spec.innerTarget || !edge.to || isGhost(edge.to)) return false;
  return innerNodeRect(model, edge.to, edge.spec.innerTarget) != null;
}
