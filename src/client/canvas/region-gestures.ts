// Pure region move/resize math. Snap arrives as an argument so the canvas view stays the
// place that owns the grid step; membership diffs stay in flow-doc and are computed at commit.

import type { ContextBlock, FlowNode, Rect } from '../../shared/flow-format.js';
import { contextsContainedIn, regionRectOf, type FlowModel, type ModelContext } from '../flow-doc.js';
import { normalizedRect, type Point } from '../geometry.js';
import type { ResizeCorner } from './resize-handles.js';

export interface RegionMoveSnapshot {
  context: ModelContext;
  // The R28a group's other members: every region whose whole frame lay inside the dragged one's
  // at gesture start. Frozen then — a region the dragged frame merely comes to rest over later is
  // neither carried nor swept. The dragged context itself is not included.
  carriedContexts: ModelContext[];
  // The blocks with an authored `pos` that travel with the drag: the dragged region itself plus
  // every carried region, with the `pos` each had then. A member-derived region has no entry —
  // carrying it means carrying its members, never inventing a `pos` for it (R3).
  startRects: ReadonlyMap<ContextBlock, Rect>;
  // Every member of the dragged region and of each carried region, with the position it started
  // at. A member shared by two regions of the group is recorded once, so the whole group moves
  // and rolls back as one piece (R28a).
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

// The regions a move translates: the selected ones plus, per R28a, every region whose whole
// frame lay inside a selected region's frame at gesture start. Deduped — a region both selected
// and contained, or contained by two selected regions, is carried once. The set is frozen here;
// a region a moving frame merely comes to rest over later is neither carried nor swept.
export function movingRegionGroupFor(model: FlowModel, selected: readonly ModelContext[]): ModelContext[] {
  const group = new Set(selected);
  for (const context of selected) {
    for (const contained of contextsContainedIn(model, context)) group.add(contained);
  }
  return [...group];
}

// Everything a mixed selection move translates, in one snapshot: the selected nodes and the
// members the moving regions carry, deduped, with each node's starting position and locus scale
// (frame members are top-level, so their scale is 1 and a plain region drag divides by nothing),
// plus the authored `pos` each moving region had — a member-derived region has no entry and
// must not gain one (R3).
export interface CombinedMoveSnapshot {
  startPositions: ReadonlyMap<FlowNode, Point>;
  scales: ReadonlyMap<FlowNode, number>;
  movingRegions: readonly ModelContext[];
  startRects: ReadonlyMap<ContextBlock, Rect>;
  startWorld: Point;
  moved: boolean;
}

export function applyCombinedMove(gesture: CombinedMoveSnapshot, world: Point, snap: SnapCoord): void {
  gesture.moved = true;
  const dx = world.x - gesture.startWorld.x;
  const dy = world.y - gesture.startWorld.y;
  for (const [node, start] of gesture.startPositions) {
    const scale = gesture.scales.get(node) ?? 1;
    node.pos!.x = snap(start.x + dx / scale);
    node.pos!.y = snap(start.y + dy / scale);
  }
  // Only blocks that already had a drawn area keep one (R3); carried pos-free regions follow
  // their members, which travel above.
  for (const [block, start] of gesture.startRects) {
    block.pos!.x = snap(start.x + dx);
    block.pos!.y = snap(start.y + dy);
  }
}

export function rollbackCombinedMove(gesture: CombinedMoveSnapshot): void {
  for (const [node, start] of gesture.startPositions) Object.assign(node.pos!, start);
  for (const [block, start] of gesture.startRects) Object.assign(block.pos!, start);
}

// The members travel with the frame, so the picture the user grabbed moves as one piece. Only
// a block that already had a drawn area keeps one: moving a region derived purely from its
// members must not invent a `pos` the file would then carry forever (R3).
export function applyRegionMove(gesture: RegionMoveSnapshot, world: Point, snap: SnapCoord): void {
  applyCombinedMove({
    startPositions: gesture.startPositions,
    scales: new Map([...gesture.startPositions.keys()].map((node) => [node, 1])),
    movingRegions: [gesture.context, ...gesture.carriedContexts],
    startRects: gesture.startRects,
    startWorld: gesture.startWorld,
    moved: gesture.moved,
  }, world, snap);
  gesture.moved = true;
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
  rollbackCombinedMove({
    startPositions: gesture.startPositions,
    scales: new Map(),
    movingRegions: [gesture.context, ...gesture.carriedContexts],
    startRects: gesture.startRects,
    startWorld: gesture.startWorld,
    moved: gesture.moved,
  });
}

export function rollbackRegionResize(gesture: RegionResizeSnapshot): void {
  Object.assign(gesture.context.block.pos!, gesture.startRect);
}

// While a resize is in progress, trust the live `block.pos` rather than `regionRectOf`, which
// unions member bounds and would stick the frame until release.
export function regionRectDuringResize(
  context: ModelContext,
  gesture: Pick<RegionResizeSnapshot, 'context'> | null,
): Rect | null {
  return gesture?.context === context ? gesture.context.block.pos ?? null : null;
}

// Paint every region from the frozen map, swapping in the drawn rectangle for the one resizing.
export function regionRectsWithDrawnResize(
  resizing: ModelContext,
  frozenRects: ReadonlyMap<ContextBlock, Rect>,
): ReadonlyMap<ContextBlock, Rect> {
  const drawn = resizing.block.pos;
  if (!drawn) return frozenRects;
  return new Map([...frozenRects, [resizing.block, { ...drawn }]]);
}

// Paint a mixed move: stationary regions keep the frozen frame the user aimed at (R13, R18),
// while every moving region draws its live frame so the outline tracks the drag.
export function regionRectsWithDrawnMove(
  moving: readonly ModelContext[],
  model: FlowModel,
  frozenRects: ReadonlyMap<ContextBlock, Rect>,
): ReadonlyMap<ContextBlock, Rect> {
  const painted = new Map(frozenRects);
  for (const context of moving) {
    const rect = regionRectOf(model, context);
    if (rect) painted.set(context.block, rect);
  }
  return painted;
}

/** Nodes whose display rect is fully enclosed by `rect` — membership for a freshly drawn region. */
export function memberNamesEnclosedByRect(
  nodes: ReadonlyArray<{ name: string; rect: Rect }>,
  rect: Rect,
  contains: (outer: Rect, inner: Rect) => boolean,
): string[] {
  return nodes.filter((node) => contains(rect, node.rect)).map((node) => node.name);
}
