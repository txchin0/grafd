// Dragging the dot at one end of a selected edge. Let go on (or just around) its own node, the dot
// pins the angle that end meets the node at; let go on empty canvas, it pulls the end off the node
// and the edge becomes a free arrow, leaving the .flow; let go on another node, it does nothing.
// Pure — the view converts the pointer into the edge's model coordinates and says what is under
// it; this decides what the gesture means.

import { EDGE_ARROW_WIDTH, type ArrowDrawing } from '../../shared/canvas-arrow.js';
import { angleFieldOf, angleToward, ERROR_EDGE_COLOR, snapAnchorAngle, type EdgeEnd, type EdgeStyle } from '../../shared/canvas-edge-style.js';
import { padRect } from '../../shared/rect-math.js';
import { edgeIdentityOf, type ModelEdge } from '../flow-doc.js';
import { distanceBetween, rectCenter, rectContains, type Point } from '../geometry.js';
import type { EdgeRouteOverrides, Endpoint } from './edge-layout.js';

// Screen pixels: how near the dot a press must land to grab it, and how far outside its node the
// dot still pins rather than pulling the end off.
export const EDGE_END_HIT_RADIUS_PX = 10;
const PIN_CAPTURE_PX = 12;

export type EdgeEndDrop =
  // Pinned to this angle around the end's own node.
  | { kind: 'pin'; angle: number }
  // Pulled off onto empty canvas at `point`, in the edge's model coordinates.
  | { kind: 'detach'; point: Point }
  // Over another node, or not yet dragged: lets go without a change.
  | { kind: 'none' };

export interface EdgeEndGesture {
  type: 'edge-end';
  edge: ModelEdge;
  end: EdgeEnd;
  // The outline this end meets, measured once at the press: nothing the drag does moves a node.
  endpoint: Endpoint;
  // Where the other end is drawn, which a detached edge's arrow keeps. Measured at the press: once
  // pulled off, the edge is no longer laid out.
  keptPoint: Point;
  startScreen: Point;
  moved: boolean;
  drop: EdgeEndDrop;
}

export function beginEdgeEnd(
  edge: ModelEdge,
  end: EdgeEnd,
  measured: Pick<EdgeEndGesture, 'endpoint' | 'keptPoint'>,
  screen: Point,
): EdgeEndGesture {
  return { type: 'edge-end', edge, end, ...measured, startScreen: screen, moved: false, drop: { kind: 'none' } };
}

// Whether the move changed what the gesture would write. `local` is in the edge's model
// coordinates, drawn at `screenScale`; `overOtherNode` says whether a node other than this end's
// own is under the pointer.
export function extendEdgeEnd(
  gesture: EdgeEndGesture,
  local: Point,
  screenScale: number,
  screen: Point,
  dragThresholdPx: number,
  overOtherNode: boolean,
): boolean {
  if (!gesture.moved && distanceBetween(screen, gesture.startScreen) < dragThresholdPx) return false;
  gesture.moved = true;
  gesture.drop = edgeEndDropAt(gesture.endpoint, local, screenScale, overOtherNode);
  return true;
}

export function edgeEndDropAt(endpoint: Endpoint, local: Point, screenScale: number, overOtherNode: boolean): EdgeEndDrop {
  if (rectContains(padRect(endpoint.rect, PIN_CAPTURE_PX / screenScale), local)) {
    const angle = angleToward(rectCenter(endpoint.rect), local);
    return angle == null ? { kind: 'none' } : { kind: 'pin', angle: snapAnchorAngle(angle) };
  }
  return overOtherNode ? { kind: 'none' } : { kind: 'detach', point: local };
}

// What to paint before anything is written: the edge re-routed through a pinned end, or hidden
// while the free arrow it would become is drawn in its place.
export function edgeEndOverridesOf(gesture: EdgeEndGesture): EdgeRouteOverrides | null {
  if (!gesture.moved) return null;
  const identity = edgeIdentityOf(gesture.edge);
  if (gesture.drop.kind === 'pin') return new Map([[identity, { [angleFieldOf(gesture.end)]: gesture.drop.angle }]]);
  if (gesture.drop.kind === 'detach') return new Map([[identity, { hidden: true as const }]]);
  return null;
}

// How the free arrow a detached edge becomes is drawn: as the edge was. An error edge left in its
// default colour is drawn in the theme's error colour, which an arrow left in its own default is not,
// so it is written in the error slot.
export function detachedArrowStyle(edge: ModelEdge, style: EdgeStyle): Omit<ArrowDrawing, 'kind' | 'id' | 'graph' | 'points'> {
  const color = style.color ?? (edge.kind === 'error' ? ERROR_EDGE_COLOR : null);
  return { color, width: EDGE_ARROW_WIDTH, line: style.line, startHead: style.startHead, endHead: style.endHead };
}

// The free arrow a detach would leave, start to end in the edge's own direction.
export function detachedArrowPoints(gesture: EdgeEndGesture, dropped: Point): [Point, Point] {
  return gesture.end === 'start' ? [dropped, gesture.keptPoint] : [gesture.keptPoint, dropped];
}
