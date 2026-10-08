// Every head ends exactly on the edge's tip and points the way the edge arrives, whichever
// direction that is — the painter and the picker icons both rely on it.

import { describe, expect, it } from 'vitest';
import { arrowheadOutline, arrowheadPathData, type ArrowheadOutline } from '../src/client/canvas/arrowheads.js';
import { ARROWHEADS, type Arrowhead } from '../src/shared/canvas-edge-style.js';
import { distanceToPolyline, type Point } from '../src/client/geometry.js';

const TIP = { x: 200, y: 50 };
const APPROACHES: Point[] = [
  { x: 100, y: 50 },
  { x: 200, y: -60 },
  { x: 260, y: 110 },
];
const DRAWN_HEADS = ARROWHEADS.filter((head): head is Exclude<Arrowhead, 'none'> => head !== 'none');

function pointsOf(outline: ArrowheadOutline): Point[] {
  if (outline.kind === 'lines') return outline.strokes.flat();
  if (outline.kind === 'polygon') return outline.points;
  return [outline.center];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// How far the drawn ink comes from the tip: a bar crosses the tip mid-stroke, so this measures to
// what is drawn, not to its corners.
function reachOf(outline: ArrowheadOutline): number {
  if (outline.kind === 'circle') return distance(outline.center, TIP) - outline.radius;
  const polylines = outline.kind === 'lines' ? outline.strokes : [[...outline.points, outline.points[0]]];
  return Math.min(...polylines.map((polyline) => distanceToPolyline(TIP, polyline)));
}

describe('arrowhead outlines', () => {
  it('draws nothing for no head, or when there is no direction to point in', () => {
    expect(arrowheadOutline('none', APPROACHES[0], TIP)).toBeNull();
    expect(arrowheadOutline('arrow', TIP, TIP)).toBeNull();
  });

  for (const head of DRAWN_HEADS) {
    for (const approach of APPROACHES) {
      it(`ends a ${head} on the tip and points it along the approach from (${approach.x}, ${approach.y})`, () => {
        const outline = arrowheadOutline(head, approach, TIP)!;
        const points = pointsOf(outline);
        expect(reachOf(outline)).toBeCloseTo(0, 6);

        // Everything the head draws lies on the approach side of the tip, never beyond it.
        const forward = { x: TIP.x - approach.x, y: TIP.y - approach.y };
        for (const point of points) {
          expect(forward.x * (point.x - TIP.x) + forward.y * (point.y - TIP.y)).toBeLessThanOrEqual(1e-9);
        }
      });
    }
  }

  it('gives every drawn head SVG path data for its picker icon', () => {
    for (const head of DRAWN_HEADS) {
      expect(arrowheadPathData(arrowheadOutline(head, APPROACHES[0], TIP)!)).toMatch(/^M /);
    }
  });
});
