// An edge drawn the way the canvas draws it, closely enough to judge a layout by: a curve from one
// node to the other passing through its bend, cut off where it enters each node, and the point its
// label sits on. The canvas itself runs a cardinal spline between the nodes' borders
// (client/canvas/edge-path.ts); this runs a quadratic through the same three points, which differs
// from it by a few pixels at most — far less than anything the score is looking for.

import { bendPointOn, type EdgeBend } from './canvas-edge-style.js';
import { DEFAULT_NODE_SHAPE, type NodeShape } from './canvas-layer.js';
import type { Rect } from './flow-format.js';
import { rectCenter, type Point } from './rect-math.js';
import { shapeContainsPoint } from './shape-text-box.js';

const SKETCH_STEPS = 64;

export interface EdgeSketch {
  // The part of the edge outside both of its nodes, as a polyline; empty when the nodes overlap
  // so much that nothing of it shows.
  points: Point[];
  // Where its label is drawn.
  grip: Point;
}

// `fromShape` and `toShape` cut the curve where the canvas does: at the outline each node is
// drawn with, so an edge leaving a diamond's tip is not cut short at its bounding box.
export function sketchEdge(
  fromRect: Rect,
  toRect: Rect,
  bend: EdgeBend | null,
  fromShape: NodeShape = DEFAULT_NODE_SHAPE,
  toShape: NodeShape = DEFAULT_NODE_SHAPE,
): EdgeSketch {
  const from = rectCenter(fromRect);
  const to = rectCenter(toRect);
  const through = bend ? bendPointOn(bend, from, to) : null;
  const curve = through ? quadraticThrough(from, through, to) : straightLine(from, to);
  const points = curve.filter((point) => !shapeContainsPoint(fromShape, fromRect, point) && !shapeContainsPoint(toShape, toRect, point));
  const grip = through ?? midpointOf(points, from, to);
  return { points, grip };
}

function straightLine(from: Point, to: Point): Point[] {
  return Array.from({ length: SKETCH_STEPS + 1 }, (_, step) => {
    const t = step / SKETCH_STEPS;
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  });
}

// The quadratic from `from` to `to` that passes through `through` halfway along.
function quadraticThrough(from: Point, through: Point, to: Point): Point[] {
  const control = { x: 2 * through.x - (from.x + to.x) / 2, y: 2 * through.y - (from.y + to.y) / 2 };
  return Array.from({ length: SKETCH_STEPS + 1 }, (_, step) => {
    const t = step / SKETCH_STEPS;
    return {
      x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t * t * to.x,
      y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t * t * to.y,
    };
  });
}

// A straight edge's label sits halfway between where it leaves one node and enters the other.
function midpointOf(points: Point[], from: Point, to: Point): Point {
  const start = points[0] ?? from;
  const end = points[points.length - 1] ?? to;
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

