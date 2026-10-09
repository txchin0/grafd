// Pure region move/resize math. Snap arrives as an argument so the canvas view stays the
// place that owns the grid step; membership diffs stay in flow-doc and are computed at commit.

import type { ContextBlock, FlowNode, Rect } from '../../shared/flow-format.js';
import { contextsContainedIn, regionRectOf, type FlowModel, type ModelContext } from '../flow-doc.js';
import { normalizedRect, type Point } from '../geometry.js';
import { axesOf, type AxisSide, type ResizeHandle } from './resize-handles.js';

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
  handle: ResizeHandle;
  // The frame in the file's layout when the press began (`layoutRegionRectOf`) — what the
  // resize writes from. The painted frame can differ from it while a subgraph is unfolded nearby,
  // since the warp displaces the members it is drawn around, and the warp never reaches disk.
  startRect: Rect;
  // The frame as painted when the press began, and as painted now: its dragged sides move exactly
  // as far as the written ones, so the outline neither jumps when the drag begins nor drifts from
  // the pointer during it.
  displayStartRect: Rect;
  displayRect: Rect;
  startWorld: Point;
  // Whether the block had an authored `pos` when the press began. One without acquires it on the
  // first movement, and an abandoned resize takes it away again.
  hadDrawnArea: boolean;
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

// What a combined move is measured on: the thing the user pressed, when it is one of the things the
// move carries.
export type MoveReference = { node: FlowNode } | { block: ContextBlock } | null;

// Moves everything the gesture carries by one distance, and returns that distance in world units.
// Snapping each piece on its own would let pieces sitting off the grid — or a distance landing on a
// half step — travel different amounts, pulling a region away from its own members and strokes away
// from what they annotate; so the distance is settled once, on the reference, and shared.
export function applyCombinedMove(
  gesture: CombinedMoveSnapshot,
  world: Point,
  snap: SnapCoord,
  reference: MoveReference = null,
): Point {
  gesture.moved = true;
  const delta = combinedMoveDelta(gesture, world, snap, reference);
  for (const [node, start] of gesture.startPositions) {
    const scale = gesture.scales.get(node) ?? 1;
    node.pos!.x = start.x + Math.round(delta.x / scale);
    node.pos!.y = start.y + Math.round(delta.y / scale);
  }
  // Only blocks that already had a drawn area keep one (R3); carried pos-free regions follow
  // their members, which travel above.
  for (const [block, start] of gesture.startRects) {
    block.pos!.x = start.x + Math.round(delta.x);
    block.pos!.y = start.y + Math.round(delta.y);
  }
  return delta;
}

// The pointer's distance, adjusted so the reference — or else the first node, or else the first
// drawn region the move carries — lands on the grid, in world units. A node inside a scaled frame
// snaps in its own graph's units. A move of strokes alone has nothing on the grid, and follows the
// pointer exactly.
export function combinedMoveDelta(
  gesture: CombinedMoveSnapshot,
  world: Point,
  snap: SnapCoord,
  reference: MoveReference = null,
): Point {
  const pointer = { x: world.x - gesture.startWorld.x, y: world.y - gesture.startWorld.y };
  const node = reference && 'node' in reference && gesture.startPositions.has(reference.node)
    ? reference.node
    : null;
  const block = reference && 'block' in reference && gesture.startRects.has(reference.block)
    ? reference.block
    : null;
  const snappedNode = node ?? (block ? null : firstKey(gesture.startPositions));
  if (snappedNode) {
    const start = gesture.startPositions.get(snappedNode)!;
    const scale = gesture.scales.get(snappedNode) ?? 1;
    return {
      x: (snap(start.x + pointer.x / scale) - start.x) * scale,
      y: (snap(start.y + pointer.y / scale) - start.y) * scale,
    };
  }
  const snappedBlock = block ?? firstKey(gesture.startRects);
  if (snappedBlock) {
    const start = gesture.startRects.get(snappedBlock)!;
    return { x: snap(start.x + pointer.x) - start.x, y: snap(start.y + pointer.y) - start.y };
  }
  return pointer;
}

function firstKey<Key>(map: ReadonlyMap<Key, unknown>): Key | null {
  for (const key of map.keys()) return key;
  return null;
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
  const start = gesture.startRect;
  const axes = axesOf(gesture.handle);
  const travel = {
    x: draggedSideTravel(start.x, start.w, axes.x, world.x - gesture.startWorld.x, snap),
    y: draggedSideTravel(start.y, start.h, axes.y, world.y - gesture.startWorld.y, snap),
  };
  // A region with no drawn area acquires one the moment it is resized: the user is reserving
  // space, which is the only thing that ever authors a block's `pos`.
  const frame = gesture.context.block.pos ??= { ...start };
  Object.assign(frame, withDraggedSidesMoved(start, axes, travel));
  gesture.displayRect = withDraggedSidesMoved(gesture.displayStartRect, axes, travel);
}

// How far the side a handle drags along one axis moves: onto the grid wherever the pointer takes
// it. Zero on an axis the handle does not drag.
function draggedSideTravel(start: number, extent: number, side: AxisSide, pointerTravel: number, snap: SnapCoord): number {
  if (side === 0) return 0;
  const follows = side === -1 ? start : start + extent;
  return snap(follows + pointerTravel) - follows;
}

// The rectangle with each dragged side moved by its axis's travel and every other side where it
// was; a side dragged past the one opposite it turns the rectangle over rather than inverting it.
function withDraggedSidesMoved(rect: Rect, axes: { x: AxisSide; y: AxisSide }, travel: Point): Rect {
  const [fromX, toX] = sidesAlong(rect.x, rect.w, axes.x, travel.x);
  const [fromY, toY] = sidesAlong(rect.y, rect.h, axes.y, travel.y);
  return normalizedRect({ x: fromX, y: fromY }, { x: toX, y: toY });
}

function sidesAlong(start: number, extent: number, side: AxisSide, travel: number): [number, number] {
  if (side === 0) return [start, start + extent];
  const stays = side === -1 ? start + extent : start;
  const follows = side === -1 ? start : start + extent;
  return [stays, follows + travel];
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
  const { block } = gesture.context;
  if (!gesture.hadDrawnArea) block.pos = null;
  else Object.assign(block.pos!, gesture.startRect);
}

// While a resize is in progress, paint the rectangle being dragged rather than `regionRectOf`,
// which unions member bounds and would stick the frame until release.
export function regionRectDuringResize(
  context: ModelContext,
  gesture: Pick<RegionResizeSnapshot, 'context' | 'displayRect'> | null,
): Rect | null {
  return gesture?.context === context ? gesture.displayRect : null;
}

// Paint every region from the frozen map, swapping in the dragged rectangle for the one resizing.
export function regionRectsWithDrawnResize(
  gesture: Pick<RegionResizeSnapshot, 'context' | 'displayRect'>,
  frozenRects: ReadonlyMap<ContextBlock, Rect>,
): ReadonlyMap<ContextBlock, Rect> {
  return new Map([...frozenRects, [gesture.context.block, { ...gesture.displayRect }]]);
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
