// Where every edge in a model runs, in that model's own coordinates. This is the geometry
// pass that precedes painting: it reads display rects and writes one EdgeGeometry per edge
// into a caller-owned map, which painting, hit-testing, the label anchor and the edit popup
// all read back. Nothing here touches a canvas context — the shape of an edge is settled
// before anything is drawn, so it can be computed and tested without a renderer.

import type { FlowNode, Rect } from '../../shared/flow-format.js';
import { displayRectOf, type FlowModel, type GhostNode, type ModelEdge } from '../flow-doc.js';
import { rectBorderPointToward, rectCenter } from '../geometry.js';
import { createEdgeGeometry, type EdgeGeometry } from './edge-path.js';
import { transformRect } from './expansion.js';

export type EdgeGeometryMap = Map<ModelEdge, EdgeGeometry>;

// Parallel edges between the same pair fan out instead of stacking: each successive
// occurrence bows further, alternating sides so the pair stays visually balanced.
const BASE_BOW_FRACTION = 0.1;
const MAX_BASE_BOW = 34;
const BOW_STEP = 26;
// Below this the frame has barely opened, so an edge aimed at a node inside it would point
// into a sliver — it stays on the host's border until the subgraph is actually legible.
const MIN_INNER_TARGET_ALPHA = 0.15;
const SELF_LOOP_START_INSET = 30;
const SELF_LOOP_END_DROP = 24;
const SELF_LOOP_APEX_OFFSET = { x: 42, y: -40 };

function isGhost(target: FlowNode | GhostNode): target is GhostNode {
  return 'ghost' in target && target.ghost === true;
}

export function layOutModelEdges(model: FlowModel, geometry: EdgeGeometryMap): void {
  const occurrencesByPair = new Map<string, number>();
  for (const edge of model.edges) {
    const target = edge.to;
    if (!target?.pos || !edge.from?.pos) {
      geometry.delete(edge);
      continue;
    }
    if (target === edge.from) {
      geometry.set(edge, selfLoopGeometry(model, edge.from));
      continue;
    }
    const pairKey = [edge.from.name, target.name].sort().join(' ');
    const occurrence = occurrencesByPair.get(pairKey) ?? 0;
    occurrencesByPair.set(pairKey, occurrence + 1);
    geometry.set(edge, bowedGeometry(endpointRects(model, edge, target), occurrence));
  }
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

function bowedGeometry(rects: { from: Rect; to: Rect }, occurrence: number): EdgeGeometry {
  const start = rectBorderPointToward(rects.from, rectCenter(rects.to));
  const end = rectBorderPointToward(rects.to, rectCenter(rects.from));
  const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const normal = { x: -(end.y - start.y) / length, y: (end.x - start.x) / length };
  const bow = (Math.min(MAX_BASE_BOW, length * BASE_BOW_FRACTION) + Math.floor(occurrence / 2) * BOW_STEP)
    * (occurrence % 2 === 0 ? 1 : -1);
  const mid = {
    x: (start.x + end.x) / 2 + normal.x * bow,
    y: (start.y + end.y) / 2 + normal.y * bow,
  };
  return createEdgeGeometry([start, mid, end]);
}

function selfLoopGeometry(model: FlowModel, node: FlowNode): EdgeGeometry {
  const { x, y, w } = displayRectOf(model, node);
  const start = { x: x + w - SELF_LOOP_START_INSET, y };
  const end = { x: x + w, y: y + SELF_LOOP_END_DROP };
  const apex = { x: x + w + SELF_LOOP_APEX_OFFSET.x, y: y + SELF_LOOP_APEX_OFFSET.y };
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
