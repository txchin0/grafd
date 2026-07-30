// Pure view-space geometry: points, rectangles, and the interpolation the canvas modules
// share. No DOM, no canvas context, no document AST — everything here is arithmetic on plain
// shapes, which is what lets the canvas view, the expansion layer and the camera transitions
// each build on it without reaching for one another.

import type { Rect } from '../shared/flow-format.js';

export interface Point {
  x: number;
  y: number;
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function rectContains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return {
    x: left,
    y: top,
    w: Math.max(a.x + a.w, b.x + b.w) - left,
    h: Math.max(a.y + a.h, b.y + b.h) - top,
  };
}

export function padRect(rect: Rect, padding: number): Rect {
  return { x: rect.x - padding, y: rect.y - padding, w: rect.w + padding * 2, h: rect.h + padding * 2 };
}

/** The axis-aligned rect spanned by two corners, in either order. */
export function normalizedRect(pointA: Point, pointB: Point): Rect {
  return {
    x: Math.min(pointA.x, pointB.x),
    y: Math.min(pointA.y, pointB.y),
    w: Math.abs(pointA.x - pointB.x),
    h: Math.abs(pointA.y - pointB.y),
  };
}

/** The rect enclosing every rect given, or null when there are none to enclose. */
export function boundsOfRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The unit vector pointing from one point to another, or a zero vector if they coincide. */
export function unitVectorBetween(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };
  return { x: dx / length, y: dy / length };
}

/** The direction turned a quarter turn, for measuring offsets across a direction of travel. */
export function perpendicular(direction: Point): Point {
  return { x: -direction.y, y: direction.x };
}

export function offsetAlong(point: Point, direction: Point, distance: number): Point {
  return { x: point.x + direction.x * distance, y: point.y + direction.y * distance };
}

export function midpointOf(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Where an edge touching `rect` meets its border: the crossing point of the ray from the
// rect's center toward `towardPoint`.
export function rectBorderPointToward(rect: Rect, towardPoint: Point): Point {
  const center = rectCenter(rect);
  return rectBorderPointFrom(rect, center, unitVectorBetween(center, towardPoint));
}

// Where a ray leaves `rect`, cast from an origin inside it rather than from its center.
// Offsetting the origin is what slides an edge's anchor along the border, which is how parallel
// edges between one pair of nodes meet it at distinct points instead of stacking on the one.
export function rectBorderPointFrom(rect: Rect, origin: Point, direction: Point): Point {
  if (direction.x === 0 && direction.y === 0) return origin;
  const toVerticalEdge = direction.x === 0
    ? Infinity
    : ((direction.x > 0 ? rect.x + rect.w : rect.x) - origin.x) / direction.x;
  const toHorizontalEdge = direction.y === 0
    ? Infinity
    : ((direction.y > 0 ? rect.y + rect.h : rect.y) - origin.y) / direction.y;
  const distance = Math.max(0, Math.min(toVerticalEdge, toHorizontalEdge));
  return offsetAlong(origin, direction, distance);
}

// Half-extent of an axis-aligned rect along a unit direction (its support function), used to
// measure clearance between rects without treating them as circles.
export function halfExtentAlong(rect: Rect, direction: Point): number {
  return (Math.abs(direction.x) * rect.w + Math.abs(direction.y) * rect.h) / 2;
}
