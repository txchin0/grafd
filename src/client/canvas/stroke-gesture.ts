// The two gestures a stroke has: being drawn, and being resized by a corner once it exists.
//
// A stroke in progress belongs to the graph the pen landed in — the innermost unfolded frame
// under that point, or the top-level graph — and every point is kept in that graph's own
// coordinates from then on, so the stroke is already where it will be stored. Unlike a drawn
// rectangle, a stroke may wander out of the frame it started in: the frame grows to hold it once
// it lands.

import type { StrokeTransform } from '../../shared/canvas-drawings.js';
import type { FlowNode, Rect } from '../../shared/flow-format.js';
import { simplifyPolyline, type Point } from '../geometry.js';
import { inverseTransformPoint, type FrameTarget, type FrameTransform } from './expansion.js';
import type { ResizeCorner } from './resize-handles.js';

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

// The transform that stretches `startBox` — a stroke's point bounds — so the dragged corner
// follows the pointer while the opposite corner stays put. No snapping: ink follows the hand.
// A straight line has no extent across itself, so dragging along that axis leaves it alone.
export function resizedStrokeTransform(startBox: Rect, corner: ResizeCorner, delta: Point): StrokeTransform {
  const dragsWest = corner[1] === 'w';
  const dragsNorth = corner[0] === 'n';
  const anchorX = dragsWest ? startBox.x + startBox.w : startBox.x;
  const anchorY = dragsNorth ? startBox.y + startBox.h : startBox.y;
  const scaleX = stretchedScale(startBox.w, dragsWest ? -delta.x : delta.x);
  const scaleY = stretchedScale(startBox.h, dragsNorth ? -delta.y : delta.y);
  return { scaleX, scaleY, x: anchorX * (1 - scaleX), y: anchorY * (1 - scaleY) };
}

function stretchedScale(startExtent: number, growth: number): number {
  if (startExtent <= 0) return 1;
  const floor = Math.min(MIN_RESIZED_EXTENT, startExtent);
  return Math.max(floor, startExtent + growth) / startExtent;
}
