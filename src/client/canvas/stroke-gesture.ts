// The two gestures a drawing has: a stroke being drawn, and any drawing resized by a corner or side.
//
// A stroke in progress belongs to the graph the pen landed in — the innermost unfolded frame
// under that point, or the top-level graph — and every point is kept in that graph's own
// coordinates from then on, so the stroke is already where it will be stored. Unlike a drawn
// rectangle, a stroke may wander out of the frame it started in: the frame grows to hold it once
// it lands.

import type { DrawingTransform } from '../../shared/drawing-geometry.js';
import type { FlowNode, Rect } from '../../shared/flow-format.js';
import { simplifyPolyline, type Point } from '../geometry.js';
import { inverseTransformPoint, type FrameTarget, type FrameTransform } from './expansion.js';
import { axesOf, type ResizeHandle } from './resize-handles.js';

// A resize may squash a stroke this far and no further, in the stroke's own units, so it never
// folds over onto itself. A stroke already thinner than this keeps its own extent as the floor.
const MIN_RESIZED_EXTENT = 4;
// Pointer samples closer together than this add nothing the smoothing would show.
const MIN_SAMPLE_SPACING_PX = 1.5;
// How far, on screen, the simplified stroke may stray from the sampled one.
const SIMPLIFY_TOLERANCE_PX = 0.5;

export interface StrokeGesture {
  type: 'draw';
  frameHost: FlowNode | null;
  transform: FrameTransform;
  points: Point[];
  lastScreen: Point;
}

const TOP_LEVEL_TRANSFORM: FrameTransform = { scale: 1, tx: 0, ty: 0 };

export function beginStrokeGesture(frame: FrameTarget | null, world: Point, screen: Point): StrokeGesture {
  const transform = frame?.transform ?? TOP_LEVEL_TRANSFORM;
  return {
    type: 'draw',
    frameHost: frame?.host ?? null,
    transform,
    points: [inverseTransformPoint(world, transform)],
    lastScreen: screen,
  };
}

// Whether the sample was far enough from the last one to be kept.
export function extendStrokeGesture(gesture: StrokeGesture, world: Point, screen: Point): boolean {
  const travelled = Math.hypot(screen.x - gesture.lastScreen.x, screen.y - gesture.lastScreen.y);
  if (travelled < MIN_SAMPLE_SPACING_PX) return false;
  gesture.points.push(inverseTransformPoint(world, gesture.transform));
  gesture.lastScreen = screen;
  return true;
}

// The points to store, thinned to what the screen could show at the scale they were drawn at.
export function finishedStrokePoints(gesture: StrokeGesture, viewScale: number): Point[] {
  const screenUnitsPerLocalUnit = viewScale * gesture.transform.scale;
  return simplifyPolyline(gesture.points, SIMPLIFY_TOLERANCE_PX / screenUnitsPerLocalUnit);
}

// The transform that stretches `startBox` — the drawings' combined geometry — so the dragged
// corner or side follows the pointer while the opposite one stays put; a side leaves the axis
// along it alone. No snapping: ink follows the hand. A straight line has no extent across itself,
// so dragging along that axis leaves it alone too.
//
// With `keepAspect` both axes take the scale of the axis dragged further for its size, growing or
// shrinking, so the handle tracks the pointer along the axis the hand is clearly moving — for a
// side, the only axis it drags; the other then grows from its near side. Text scales this way:
// its size grows with its box, and a stretched box would hold the text at neither scale.
//
// `smallestScaleX` holds a stretch back from narrowing past what the drawings allow — text no
// narrower than one letter — so the floor is reached with the opposite side still in place.
export function resizedDrawingTransform(
  startBox: Rect,
  handle: ResizeHandle,
  delta: Point,
  { keepAspect, smallestScaleX = 0 }: { keepAspect: boolean; smallestScaleX?: number },
): DrawingTransform {
  const axes = axesOf(handle);
  const anchorX = axes.x === -1 ? startBox.x + startBox.w : startBox.x;
  const anchorY = axes.y === -1 ? startBox.y + startBox.h : startBox.y;
  const stretchX = axes.x === 0 ? 1 : Math.max(smallestScaleX, stretchedScale(startBox.w, axes.x * delta.x));
  const stretchY = axes.y === 0 ? 1 : stretchedScale(startBox.h, axes.y * delta.y);
  const furtherDragged = Math.abs(Math.log(stretchX)) >= Math.abs(Math.log(stretchY)) ? stretchX : stretchY;
  // Each axis floors on its own; held to one scale, the shorter side reaches its floor first.
  const uniform = Math.max(furtherDragged, smallestScale(startBox.w), smallestScale(startBox.h));
  const scaleX = keepAspect ? uniform : stretchX;
  const scaleY = keepAspect ? uniform : stretchY;
  return { scaleX, scaleY, x: anchorX * (1 - scaleX), y: anchorY * (1 - scaleY) };
}

function stretchedScale(startExtent: number, growth: number): number {
  if (startExtent <= 0) return 1;
  return Math.max(smallestScale(startExtent) * startExtent, startExtent + growth) / startExtent;
}

// How far an extent may shrink: to MIN_RESIZED_EXTENT, or not at all when it is already smaller.
function smallestScale(startExtent: number): number {
  return startExtent <= 0 ? 0 : Math.min(MIN_RESIZED_EXTENT, startExtent) / startExtent;
}
