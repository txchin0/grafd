// The rectangle math the canvas paints and the linter judges against, shared so the region the
// one draws and the area the other flags are the same shape. "Same" is the canvas's closed
// state: while a subgraph frame is open the live canvas displaces surrounding nodes, and only
// the file-derived rects the linter judges remain fixed.
//
// Shared code may not import client/geometry.ts, so this module is where both sides get their
// rect math; canvas modules import it directly.

import type { Rect } from './flow-format.js';

// How far a region's frame stands off its members, so the enclosure reads as one and a member's
// own outline never touches it.
export const REGION_MEMBER_PADDING = 26;

// Where a region draws (spec §8.3): the union of the area the user drew, if any, with its
// members' bounds — which is what makes every member contained by construction. Null when there
// is neither, since the editor never invents geometry for a region and never writes one back.
export function regionRectFrom(blockPos: Rect | null, memberPositions: Rect[]): Rect | null {
  const memberBounds = boundsOfRects(memberPositions);
  if (!memberBounds) return blockPos;
  const padded = padRect(memberBounds, REGION_MEMBER_PADDING);
  return blockPos ? unionRect(blockPos, padded) : padded;
}

/** Whether `outer` fully encloses `inner`, touching borders included. */
export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function boundsOfRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function padRect(rect: Rect, padding: number): Rect {
  return { x: rect.x - padding, y: rect.y - padding, w: rect.w + padding * 2, h: rect.h + padding * 2 };
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
