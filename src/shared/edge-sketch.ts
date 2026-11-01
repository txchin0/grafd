// An edge drawn the way the canvas draws it, closely enough to judge a layout by: a curve from one
// node to the other passing through its bend, cut off where it enters each node, and the point its
// label sits on. An end pinned to an angle starts from where that angle leaves its node instead of
// from the node's centre. The canvas itself runs a cardinal spline between the nodes' borders
// (client/canvas/edge-path.ts); this runs a quadratic through the same three points, which differs
// from it by a few pixels at most — far less than anything the score is looking for.

import { anchorDirectionOf, bendPointOn, type EdgeBend } from './canvas-edge-style.js';
import { DEFAULT_NODE_SHAPE, type NodeShape } from './canvas-layer.js';
import type { Rect } from './flow-format.js';
import { rectCenter, type Point } from './rect-math.js';
import { shapeContainsPoint } from './shape-text-box.js';

const SKETCH_STEPS = 64;
// Halvings of the ray from a node's centre to its rectangle's corner distance: far finer than a
// pixel on any node.
const BORDER_SEARCH_STEPS = 24;

// The angles an edge's ends are pinned to, null for an end left to its route.
export interface PinnedEnds {
  startAngle: number | null;
  endAngle: number | null;
}

const NO_PINNED_ENDS: PinnedEnds = { startAngle: null, endAngle: null };

export interface EdgeSketch {
  // The part of the edge outside both of its nodes, as a polyline; empty when the nodes overlap
  // so much that nothing of it shows.
  points: Point[];
  // The same line with no more points than its shape needs — a straight edge's two ends — for
  // testing it segment by segment against other edges, which is most of what scoring costs.
  polyline: Point[];
  // The box around `points`, null when there are none: what the score tests first, since most pairs
  // of edges and most nodes are nowhere near each other.
  bounds: Rect | null;
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
  pinned: PinnedEnds = NO_PINNED_ENDS,
): EdgeSketch {
  const fromCenter = rectCenter(fromRect);
  const toCenter = rectCenter(toRect);
  const through = bend ? bendPointOn(bend, fromCenter, toCenter) : null;
  const from = pinned.startAngle != null ? pinnedBorderPoint(fromShape, fromRect, pinned.startAngle) : fromCenter;
  const to = pinned.endAngle != null ? pinnedBorderPoint(toShape, toRect, pinned.endAngle) : toCenter;
  const curve = through ? quadraticThrough(from, through, to) : straightLine(from, to);
  const points = curve.filter((point) => !shapeContainsPoint(fromShape, fromRect, point) && !shapeContainsPoint(toShape, toRect, point));
  const grip = through ?? midpointOf(points, from, to);
  return { points, polyline: through ? points : endsOf(points), bounds: boundsOfPoints(points), grip };
}

// Where the ray from the node's centre at `angle` leaves its outline, found by halving the ray: the
// outline is convex, so the ray crosses it once.
function pinnedBorderPoint(shape: NodeShape, rect: Rect, angle: number): Point {
  const center = rectCenter(rect);
  const direction = anchorDirectionOf(angle);
  const pointAt = (distance: number): Point => ({ x: center.x + direction.x * distance, y: center.y + direction.y * distance });
  let inside = 0;
  let outside = Math.hypot(rect.w, rect.h);
  for (let step = 0; step < BORDER_SEARCH_STEPS; step += 1) {
    const middle = (inside + outside) / 2;
    if (shapeContainsPoint(shape, rect, pointAt(middle))) inside = middle;
    else outside = middle;
  }
  return pointAt(outside);
}

// A straight edge's part outside both nodes is one unbroken run (every outline is convex), so its
// two ends draw it whole.
function endsOf(points: Point[]): Point[] {
  return points.length < 2 ? points : [points[0], points[points.length - 1]];
}

function boundsOfPoints(points: Point[]): Rect | null {
  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, w: Math.max(...xs) - left, h: Math.max(...ys) - top };
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

