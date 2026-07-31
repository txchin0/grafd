// Corner hit-testing and handle positions shared by node and region selection chrome.
// Hit radius is measured in screen pixels and converted by the caller via `viewScale`.

import type { Rect } from '../../shared/flow-format.js';
import type { Point } from '../geometry.js';

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

export const HANDLE_HIT_RADIUS_PX = 9;

export interface CornerPoint {
  corner: ResizeCorner;
  x: number;
  y: number;
}

export function resizeCornersOf(rect: Rect): CornerPoint[] {
  const { x, y, w, h } = rect;
  return [
    { corner: 'nw', x, y },
    { corner: 'ne', x: x + w, y },
    { corner: 'sw', x, y: y + h },
    { corner: 'se', x: x + w, y: y + h },
  ];
}

export function hitResizeCorner(rect: Rect, world: Point, hitRadius: number): ResizeCorner | null {
  for (const candidate of resizeCornersOf(rect)) {
    if (Math.hypot(world.x - candidate.x, world.y - candidate.y) <= hitRadius) {
      return candidate.corner;
    }
  }
  return null;
}

/** Top-left of each selection handle square, sized for drawing at the current view scale. */
export function selectionHandleOrigins(rect: Rect, handleSize: number): Point[] {
  const half = handleSize / 2;
  return resizeCornersOf(rect).map(({ x, y }) => ({ x: x - half, y: y - half }));
}
