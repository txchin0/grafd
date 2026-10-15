// A bent edge on the canvas: the bend arithmetic itself lives with the stored bend
// (canvas-edge-style.ts), and this adapts it to the chord an edge's geometry carries.

import { bendPointOn, bendThroughPoint, type EdgeBend } from '../../shared/canvas-edge-style.js';
import { distanceToSegment, type Point } from '../geometry.js';
import type { EdgeChord } from './edge-path.js';

// Whether a chord can carry a bend at all: one of no length — two nodes stacked on the same
// centre — has nothing to measure a bend against.
export function canBendAlong(chord: EdgeChord): boolean {
  return chord.from.x !== chord.to.x || chord.from.y !== chord.to.y;
}

export function bendPointOf(bend: EdgeBend, chord: EdgeChord): Point | null {
  return bendPointOn(bend, chord.from, chord.to);
}

// The bend whose point is nearest `point`.
export function bendThrough(point: Point, chord: EdgeChord): EdgeBend | null {
  return bendThroughPoint(point, chord.from, chord.to);
}

// Measured to the segment, not the line through it: a point dragged out past an end, along the
// line, is far from the chord and must not read as a straightened edge.
export function distanceFromChord(point: Point, chord: EdgeChord): number {
  return distanceToSegment(point, chord.from, chord.to);
}
