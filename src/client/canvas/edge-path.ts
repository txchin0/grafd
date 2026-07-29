// The shape of a drawn edge, and the single flattened polyline every consumer measures against.
//
// Edges are drawn by rough.js as a spline through a list of points. Hit-testing, label placement,
// the edit popup anchor and the arrowhead tangent all need to know where that spline actually goes.
// Deriving each of them from the control points independently is how the clickable region drifts
// away from the ink, so they all read `EdgeGeometry.path` instead.

import type { Rect } from '../../shared/flow-format.js';
import type { Point } from '../geometry.js';

// rough.js renders `curve` as a cardinal spline: it pads the point list by repeating the first and
// last entry, then chains one cubic Bézier per interior pair. Flattening mirrors that construction
// exactly — these constants are rough.js's, not ours, and must not be tuned independently of it.
const CURVE_TIGHTNESS = 0;
const CARDINAL_TANGENT_DIVISOR = 6;
const SAMPLES_PER_SEGMENT = 12;

export interface EdgeGeometry {
  /** The points the drawn spline passes through, start to end. At least two. */
  through: Point[];
  /** `through` flattened to the polyline that defines where this edge visually is. */
  path: Point[];
  labelRect: Rect | null;
}

export function createEdgeGeometry(through: Point[]): EdgeGeometry {
  return { through, path: flattenEdgePath(through), labelRect: null };
}

export function edgeStart(geometry: EdgeGeometry): Point {
  return geometry.through[0];
}

export function edgeEnd(geometry: EdgeGeometry): Point {
  return geometry.through[geometry.through.length - 1];
}

function cubicPointAt(start: Point, controlA: Point, controlB: Point, end: Point, t: number): Point {
  const inverse = 1 - t;
  const startWeight = inverse * inverse * inverse;
  const controlAWeight = 3 * inverse * inverse * t;
  const controlBWeight = 3 * inverse * t * t;
  const endWeight = t * t * t;
  return {
    x: start.x * startWeight + controlA.x * controlAWeight + controlB.x * controlBWeight + end.x * endWeight,
    y: start.y * startWeight + controlA.y * controlAWeight + controlB.y * controlBWeight + end.y * endWeight,
  };
}

// Repeating the endpoints is what makes the spline start and end exactly on them instead of
// treating them as mere tangent hints.
function withRepeatedEndpoints(through: Point[]): Point[] {
  return [through[0], ...through, through[through.length - 1]];
}

export function flattenEdgePath(through: Point[]): Point[] {
  if (through.length < 2) return [...through];
  const points = withRepeatedEndpoints(through);
  const tension = 1 - CURVE_TIGHTNESS;
  const path: Point[] = [points[1]];
  for (let index = 1; index + 2 < points.length; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const controlA = {
      x: start.x + tension * (end.x - points[index - 1].x) / CARDINAL_TANGENT_DIVISOR,
      y: start.y + tension * (end.y - points[index - 1].y) / CARDINAL_TANGENT_DIVISOR,
    };
    const controlB = {
      x: end.x + tension * (start.x - points[index + 2].x) / CARDINAL_TANGENT_DIVISOR,
      y: end.y + tension * (start.y - points[index + 2].y) / CARDINAL_TANGENT_DIVISOR,
    };
    for (let step = 1; step <= SAMPLES_PER_SEGMENT; step += 1) {
      path.push(cubicPointAt(start, controlA, controlB, end, step / SAMPLES_PER_SEGMENT));
    }
  }
  return path;
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const lengthSquared = abX * abX + abY * abY;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - a.x) * abX + (point.y - a.y) * abY) / lengthSquared));
  const closest = { x: a.x + abX * t, y: a.y + abY * t };
  return Math.hypot(point.x - closest.x, point.y - closest.y);
}

export function distanceToEdgePath(point: Point, path: Point[]): number {
  let nearest = Infinity;
  for (let index = 1; index < path.length; index += 1) {
    nearest = Math.min(nearest, distanceToSegment(point, path[index - 1], path[index]));
  }
  return nearest;
}

function segmentLengths(path: Point[]): number[] {
  const lengths: number[] = [];
  for (let index = 1; index < path.length; index += 1) {
    lengths.push(Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y));
  }
  return lengths;
}

function pointAtArcLength(path: Point[], target: number): Point {
  const lengths = segmentLengths(path);
  let travelled = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    if (travelled + lengths[index] >= target) {
      const withinSegment = lengths[index] === 0 ? 0 : (target - travelled) / lengths[index];
      const from = path[index];
      const to = path[index + 1];
      return {
        x: from.x + (to.x - from.x) * withinSegment,
        y: from.y + (to.y - from.y) * withinSegment,
      };
    }
    travelled += lengths[index];
  }
  return path[path.length - 1];
}

function totalPathLength(path: Point[]): number {
  return segmentLengths(path).reduce((sum, length) => sum + length, 0);
}

/** Where a label or an editor popup sits: half way along the edge as drawn, not along its chord. */
export function edgePathMidpoint(path: Point[]): Point {
  if (path.length < 2) return path[0];
  return pointAtArcLength(path, totalPathLength(path) / 2);
}

/**
 * A point `backoff` along the path behind its end, giving the arrowhead a tangent that follows the
 * curve into the tip rather than pointing at it from a distant control point.
 */
export function edgePathApproach(path: Point[], backoff: number): Point {
  if (path.length < 2) return path[0];
  return pointAtArcLength(path, Math.max(0, totalPathLength(path) - backoff));
}
