// Where a selection can be resized from, shared by node, region and drawing selection chrome: a
// handle at each corner, and each side's whole length just outside it. Reaches are measured in
// screen pixels and converted by the caller via the view scale.
//
// A side is grabbed only from outside the selection, where its outline is drawn: inside belongs
// to what is selected, which a press there still moves.

import type { Rect } from '../../shared/flow-format.js';
import type { Point } from '../geometry.js';

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
export type ResizeEdge = 'n' | 'e' | 's' | 'w';
export type ResizeHandle = ResizeCorner | ResizeEdge;

export const HANDLE_HIT_RADIUS_PX = 9;
const EDGES: readonly ResizeEdge[] = ['n', 'e', 's', 'w'];
// Where along its side an edge's affordance is reported: clear of the corner handles, and of the
// port a node shows at each side's middle.
const EDGE_AFFORDANCE_FRACTION = 0.25;

// Which side of each axis a handle drags: -1 the near side (west, north), 1 the far side (east,
// south), 0 neither — an edge leaves the axis along it alone.
export type AxisSide = -1 | 0 | 1;

export interface HandleAxes {
  x: AxisSide;
  y: AxisSide;
}

export function axesOf(handle: ResizeHandle): HandleAxes {
  return {
    x: handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0,
    y: handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0,
  };
}

export function isResizeEdge(handle: ResizeHandle): handle is ResizeEdge {
  return handle.length === 1;
}

export interface HandlePoint {
  handle: ResizeHandle;
  x: number;
  y: number;
}

export function resizeCornersOf(rect: Rect): (HandlePoint & { handle: ResizeCorner })[] {
  const { x, y, w, h } = rect;
  return [
    { handle: 'nw', x, y },
    { handle: 'ne', x: x + w, y },
    { handle: 'sw', x, y: y + h },
    { handle: 'se', x: x + w, y: y + h },
  ];
}

// Corners first, so where a corner's handle and a side's reach meet, the corner answers.
export function hitResizeHandle(rect: Rect, world: Point, reach: number): ResizeHandle | null {
  return hitResizeCorner(rect, world, reach) ?? hitResizeEdge(rect, world, reach);
}

function hitResizeCorner(rect: Rect, world: Point, reach: number): ResizeCorner | null {
  const corner = resizeCornersOf(rect).find((candidate) => Math.hypot(world.x - candidate.x, world.y - candidate.y) <= reach);
  return corner?.handle ?? null;
}

// Within `reach` outside a side — on the side itself included — and alongside it.
function hitResizeEdge(rect: Rect, world: Point, reach: number): ResizeEdge | null {
  const alongTopAndBottom = world.x >= rect.x && world.x <= rect.x + rect.w;
  const alongLeftAndRight = world.y >= rect.y && world.y <= rect.y + rect.h;
  const outside = { n: rect.y - world.y, s: world.y - (rect.y + rect.h), w: rect.x - world.x, e: world.x - (rect.x + rect.w) };
  const isWithinReach = (distance: number) => distance >= 0 && distance <= reach;
  if (alongTopAndBottom && isWithinReach(outside.n)) return 'n';
  if (alongTopAndBottom && isWithinReach(outside.s)) return 's';
  if (alongLeftAndRight && isWithinReach(outside.w)) return 'w';
  if (alongLeftAndRight && isWithinReach(outside.e)) return 'e';
  return null;
}

// Every handle a press can reach, at a point a press there lands on it: the corners, then each
// side long enough to be grabbed clear of its corners and its middle.
export function resizeHandlePointsOf(rect: Rect, reach: number): HandlePoint[] {
  const sides = EDGES
    .map((edge) => ({ handle: edge, ...edgeAffordancePoint(rect, edge, reach) }))
    .filter((point) => hitResizeHandle(rect, point, reach) === point.handle);
  return [...resizeCornersOf(rect), ...sides];
}

function edgeAffordancePoint(rect: Rect, edge: ResizeEdge, reach: number): Point {
  const along = { x: rect.x + rect.w * EDGE_AFFORDANCE_FRACTION, y: rect.y + rect.h * EDGE_AFFORDANCE_FRACTION };
  const outward = reach / 2;
  switch (edge) {
    case 'n':
      return { x: along.x, y: rect.y - outward };
    case 's':
      return { x: along.x, y: rect.y + rect.h + outward };
    case 'w':
      return { x: rect.x - outward, y: along.y };
    case 'e':
      return { x: rect.x + rect.w + outward, y: along.y };
  }
}

/** Top-left of each corner handle square, sized for drawing at the current view scale. */
export function selectionHandleOrigins(rect: Rect, handleSize: number): Point[] {
  const half = handleSize / 2;
  return resizeCornersOf(rect).map(({ x, y }) => ({ x: x - half, y: y - half }));
}
