// Pure region move/resize math. Snap arrives as an argument so the canvas view stays the
// place that owns the grid step; membership diffs stay in flow-doc and are computed at commit.

import type { FlowNode, Rect } from '../../shared/flow-format.js';
import type { ModelContext } from '../flow-doc.js';
import { normalizedRect, type Point } from '../geometry.js';
import type { ResizeCorner } from './resize-handles.js';

export interface RegionMoveSnapshot {
  context: ModelContext;
  startRect: Rect;
  startPositions: ReadonlyMap<FlowNode, Point>;
  startWorld: Point;
  moved: boolean;
}

export interface RegionResizeSnapshot {
  context: ModelContext;
  corner: ResizeCorner;
  startRect: Rect;
  startWorld: Point;
}

export type SnapCoord = (value: number) => number;

// The members travel with the frame, so the picture the user grabbed moves as one piece. Only
// a block that already had a drawn area keeps one: moving a region derived purely from its
// members must not invent a `pos` the file would then carry forever (R3).
export function applyRegionMove(gesture: RegionMoveSnapshot, world: Point, snap: SnapCoord): void {
  gesture.moved = true;
  const dx = world.x - gesture.startWorld.x;
  const dy = world.y - gesture.startWorld.y;
  for (const [member, start] of gesture.startPositions) {
    member.pos!.x = snap(start.x + dx);
    member.pos!.y = snap(start.y + dy);
  }
  const drawn = gesture.context.block.pos;
  if (drawn) {
    drawn.x = snap(gesture.startRect.x + dx);
    drawn.y = snap(gesture.startRect.y + dy);
  }
}

// No minimum size: a region is an area the user reserved, and nothing about it needs to stay
// big enough to hold anything (R31). Its members do not move, so shrinking past one shuts it out.
export function applyRegionResize(gesture: RegionResizeSnapshot, world: Point, snap: SnapCoord): void {
  const dx = world.x - gesture.startWorld.x;
  const dy = world.y - gesture.startWorld.y;
  const start = gesture.startRect;
  const corner = gesture.context.block.pos!;
  const opposite = {
    x: gesture.corner[1] === 'w' ? start.x + start.w : start.x,
    y: gesture.corner[0] === 'n' ? start.y + start.h : start.y,
  };
  const dragged = {
    x: snap((gesture.corner[1] === 'w' ? start.x : start.x + start.w) + dx),
    y: snap((gesture.corner[0] === 'n' ? start.y : start.y + start.h) + dy),
  };
  Object.assign(corner, normalizedRect(opposite, dragged));
}

export function rollbackRegionMove(gesture: RegionMoveSnapshot): void {
  for (const [member, start] of gesture.startPositions) Object.assign(member.pos!, start);
  if (gesture.context.block.pos) Object.assign(gesture.context.block.pos, gesture.startRect);
}

export function rollbackRegionResize(gesture: RegionResizeSnapshot): void {
  Object.assign(gesture.context.block.pos!, gesture.startRect);
}

/** Nodes whose display rect is fully enclosed by `rect` — membership for a freshly drawn region. */
export function memberNamesEnclosedByRect(
  nodes: ReadonlyArray<{ name: string; rect: Rect }>,
  rect: Rect,
  contains: (outer: Rect, inner: Rect) => boolean,
): string[] {
  return nodes.filter((node) => contains(rect, node.rect)).map((node) => node.name);
}
