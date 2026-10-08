// The arithmetic of a bent edge: where a stored bend puts the edge's middle, and which bend puts
// it under a dragged point. A bend is measured against the chord between the endpoints' centres
// (canvas-edge-style.ts), so these are the only two places that know how.

import { clampBendAlong, type EdgeBend } from '../../shared/canvas-edge-style.js';
import { distanceToSegment, perpendicular, type Point } from '../geometry.js';
import type { EdgeChord } from './edge-path.js';

function chordVector(chord: EdgeChord): Point {
  return { x: chord.to.x - chord.from.x, y: chord.to.y - chord.from.y };
}

function squaredLengthOf(vector: Point): number {
  return vector.x * vector.x + vector.y * vector.y;
}

// Null for a chord of no length: its two ends coincide, so there is nothing to measure against.
// `along` is trusted as given: a bend is clamped where it enters, read from a file or taken from
// the pointer.
export function bendPointOf(bend: EdgeBend, chord: EdgeChord): Point | null {
  const vector = chordVector(chord);
  if (squaredLengthOf(vector) === 0) return null;
  const across = perpendicular(vector);
  return {
    x: chord.from.x + bend.along * vector.x + bend.across * across.x,
    y: chord.from.y + bend.along * vector.y + bend.across * across.y,
  };
}

// The bend whose point is nearest `point`. `along` is clamped, so past either end of the chord the
// bend tracks the end rather than folding the edge back on itself.
export function bendThrough(point: Point, chord: EdgeChord): EdgeBend | null {
  const vector = chordVector(chord);
  const squaredLength = squaredLengthOf(vector);
  if (squaredLength === 0) return null;
  const offset = { x: point.x - chord.from.x, y: point.y - chord.from.y };
  const across = perpendicular(vector);
  return {
    along: clampBendAlong((offset.x * vector.x + offset.y * vector.y) / squaredLength),
    across: (offset.x * across.x + offset.y * across.y) / squaredLength,
  };
}

// Measured to the segment, not the line through it: a point dragged out past an end, along the
// line, is far from the chord and must not read as a straightened edge.
export function distanceFromChord(point: Point, chord: EdgeChord): number {
  return distanceToSegment(point, chord.from, chord.to);
}
