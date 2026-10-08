// A bend is stored relative to the chord between an edge's endpoints, so it has to come back to
// the point it was dragged to, and keep its shape however that chord is moved.

import { describe, expect, it } from 'vitest';
import { bendPointOf, bendThrough, distanceFromChord } from '../src/client/canvas/edge-bend.js';
import type { EdgeChord } from '../src/client/canvas/edge-path.js';
import type { Point } from '../src/client/geometry.js';

const CHORD: EdgeChord = { from: { x: 100, y: 100 }, to: { x: 500, y: 100 } };

function expectPointsClose(actual: Point | null, expected: Point): void {
  expect(actual).not.toBeNull();
  expect(actual!.x).toBeCloseTo(expected.x, 6);
  expect(actual!.y).toBeCloseTo(expected.y, 6);
}

function transformedChord(chord: EdgeChord, transform: (point: Point) => Point): EdgeChord {
  return { from: transform(chord.from), to: transform(chord.to) };
}

describe('bend arithmetic', () => {
  it('puts the bend point back under the point it was taken from', () => {
    const dragged = { x: 220, y: 30 };
    expectPointsClose(bendPointOf(bendThrough(dragged, CHORD)!, CHORD), dragged);
  });

  it('measures a bend as fractions of the chord', () => {
    const bend = bendThrough({ x: 300, y: 180 }, CHORD)!;
    expect(bend.along).toBeCloseTo(0.5, 6);
    expect(Math.abs(bend.across)).toBeCloseTo(0.2, 6);
  });

  it('keeps its shape when the chord is moved, stretched and turned', () => {
    const dragged = { x: 220, y: 30 };
    const bend = bendThrough(dragged, CHORD)!;
    const quarterTurnDoubledAndShifted = (point: Point): Point => ({ x: -2 * point.y + 40, y: 2 * point.x - 10 });
    const movedChord = transformedChord(CHORD, quarterTurnDoubledAndShifted);
    expectPointsClose(bendPointOf(bend, movedChord), quarterTurnDoubledAndShifted(dragged));
  });

  it('has nothing to measure against when the chord has no length', () => {
    const collapsed = { from: { x: 10, y: 10 }, to: { x: 10, y: 10 } };
    expect(bendThrough({ x: 50, y: 50 }, collapsed)).toBeNull();
    expect(bendPointOf({ along: 0.5, across: 0.2 }, collapsed)).toBeNull();
  });

  it('clamps a point past either end of the chord, so the edge never folds back', () => {
    expect(bendThrough({ x: 700, y: 60 }, CHORD)!.along).toBe(1);
    expect(bendThrough({ x: -50, y: 60 }, CHORD)!.along).toBe(0);
  });

  it('measures distance to the chord segment, not the line through it', () => {
    expect(distanceFromChord({ x: 300, y: 112 }, CHORD)).toBeCloseTo(12, 6);
    // On the line, but 200 past its end: far from the chord, so it never reads as straightened.
    expect(distanceFromChord({ x: 700, y: 100 }, CHORD)).toBeCloseTo(200, 6);
  });
});
