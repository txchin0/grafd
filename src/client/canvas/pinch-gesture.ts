// Where the camera sits during a two-finger gesture. Pan and zoom are one calculation rather
// than two: the world point under the midpoint of the two fingers when they landed is held
// under their current midpoint, so fingers that only translate pan, fingers that only spread
// zoom about their midpoint, and any mixture of the two does both at once.
//
// Pure point math — the scale limits arrive as an argument rather than being imported, so the
// view stays the one place that decides how far it may zoom.

import type { Point } from '../geometry.js';
import type { View } from './camera-transition.js';

export interface PinchSample {
  center: Point;
  distance: number;
}

export interface PinchAnchor extends PinchSample {
  view: View;
}

export interface ScaleLimits {
  min: number;
  max: number;
}

export function pinchCenter(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

export function pinchDistance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function viewForPinch(start: PinchAnchor, current: PinchSample, limits: ScaleLimits): View {
  const scale = clamp(start.view.scale * spreadRatio(start.distance, current.distance), limits);
  const anchorWorld = {
    x: (start.center.x - start.view.x) / start.view.scale,
    y: (start.center.y - start.view.y) / start.view.scale,
  };
  return {
    scale,
    x: current.center.x - anchorWorld.x * scale,
    y: current.center.y - anchorWorld.y * scale,
  };
}

// Two fingers landing on the same spot would otherwise divide by zero, and a pinch that
// cannot measure a spread is a pure pan.
function spreadRatio(startDistance: number, currentDistance: number): number {
  return startDistance > 0 ? currentDistance / startDistance : 1;
}

function clamp(scale: number, limits: ScaleLimits): number {
  return Math.min(limits.max, Math.max(limits.min, scale));
}
