// The heads an edge can end in, as outlines in the edge's own coordinates. The painter strokes
// and fills them on the canvas and the edge editor's picker draws them as SVG, both from the one
// outline here, so the button always shows the head the canvas draws.
//
// Every head is either drawn in lines or filled solid, so the line it ends never has to be
// trimmed back from the tip: a filled head covers the line's end, and a line head starts there.

import type { Arrowhead } from '../../shared/canvas-edge-style.js';
import { offsetAlong, perpendicular, unitVectorBetween, type Point } from '../geometry.js';

export type ArrowheadOutline =
  | { kind: 'lines'; strokes: Point[][] }
  | { kind: 'polygon'; points: Point[] }
  | { kind: 'circle'; center: Point; radius: number };

const ARROW_LENGTH = 11;
const ARROW_SPREAD_RADIANS = 0.46;
const TRIANGLE_LENGTH = 12;
const TRIANGLE_HALF_WIDTH = 5;
const DIAMOND_HALF_LENGTH = 7;
const DIAMOND_HALF_WIDTH = 4.5;
const DOT_RADIUS = 4;
const BAR_HALF_WIDTH = 6;

// Null for `none`, and wherever the approach coincides with the tip so there is no direction.
export function arrowheadOutline(kind: Arrowhead, approach: Point, tip: Point): ArrowheadOutline | null {
  const forward = unitVectorBetween(approach, tip);
  if (kind === 'none' || (forward.x === 0 && forward.y === 0)) return null;
  const backward = { x: -forward.x, y: -forward.y };
  const across = perpendicular(forward);
  switch (kind) {
    case 'arrow':
      return { kind: 'lines', strokes: [[rotatedBarb(tip, backward, -ARROW_SPREAD_RADIANS), tip, rotatedBarb(tip, backward, ARROW_SPREAD_RADIANS)]] };
    case 'triangle': {
      const base = offsetAlong(tip, backward, TRIANGLE_LENGTH);
      return { kind: 'polygon', points: [tip, offsetAlong(base, across, TRIANGLE_HALF_WIDTH), offsetAlong(base, across, -TRIANGLE_HALF_WIDTH)] };
    }
    case 'diamond': {
      const middle = offsetAlong(tip, backward, DIAMOND_HALF_LENGTH);
      return {
        kind: 'polygon',
        points: [
          tip,
          offsetAlong(middle, across, DIAMOND_HALF_WIDTH),
          offsetAlong(tip, backward, DIAMOND_HALF_LENGTH * 2),
          offsetAlong(middle, across, -DIAMOND_HALF_WIDTH),
        ],
      };
    }
    case 'dot':
      return { kind: 'circle', center: offsetAlong(tip, backward, DOT_RADIUS), radius: DOT_RADIUS };
    case 'bar':
      return { kind: 'lines', strokes: [[offsetAlong(tip, across, BAR_HALF_WIDTH), offsetAlong(tip, across, -BAR_HALF_WIDTH)]] };
  }
}

function rotatedBarb(tip: Point, backward: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const direction = { x: backward.x * cos - backward.y * sin, y: backward.x * sin + backward.y * cos };
  return offsetAlong(tip, direction, ARROW_LENGTH);
}

export function arrowheadIsFilled(outline: ArrowheadOutline): boolean {
  return outline.kind !== 'lines';
}

export function arrowheadPathData(outline: ArrowheadOutline): string {
  switch (outline.kind) {
    case 'lines':
      return outline.strokes.map((stroke) => polylinePath(stroke)).join(' ');
    case 'polygon':
      return `${polylinePath(outline.points)} Z`;
    case 'circle': {
      const { center, radius } = outline;
      return `M ${center.x - radius} ${center.y} A ${radius} ${radius} 0 1 0 ${center.x + radius} ${center.y} `
        + `A ${radius} ${radius} 0 1 0 ${center.x - radius} ${center.y} Z`;
    }
  }
}

function polylinePath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}
