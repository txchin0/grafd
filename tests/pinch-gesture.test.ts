// Pan and zoom come out of one calculation, so the property worth pinning down is the one it
// is built around: the world point under the fingers' midpoint when they landed stays under
// their midpoint for the rest of the gesture.

import { describe, expect, it } from 'vitest';
import { pinchCenter, pinchDistance, viewForPinch, type PinchAnchor } from '../src/client/canvas/pinch-gesture.js';
import type { View } from '../src/client/canvas/camera-transition.js';

const LIMITS = { min: 0.12, max: 5 };

function anchorFor(view: View, first: { x: number; y: number }, second: { x: number; y: number }): PinchAnchor {
  return { view, center: pinchCenter(first, second), distance: pinchDistance(first, second) };
}

function worldUnder(view: View, screen: { x: number; y: number }) {
  return { x: (screen.x - view.x) / view.scale, y: (screen.y - view.y) / view.scale };
}

describe('viewForPinch', () => {
  const startView: View = { x: 40, y: -20, scale: 0.8 };
  const start = anchorFor(startView, { x: 100, y: 100 }, { x: 300, y: 100 });

  it('pans without changing scale when both fingers translate together', () => {
    const moved = viewForPinch(start, anchorFor(startView, { x: 150, y: 160 }, { x: 350, y: 160 }), LIMITS);
    expect(moved.scale).toBeCloseTo(startView.scale, 10);
    expect(moved.x).toBeCloseTo(startView.x + 50, 10);
    expect(moved.y).toBeCloseTo(startView.y + 60, 10);
  });

  it('scales by the ratio of the spread and holds the midpoint still', () => {
    const spread = anchorFor(startView, { x: 0, y: 100 }, { x: 400, y: 100 });
    const zoomed = viewForPinch(start, spread, LIMITS);
    expect(zoomed.scale).toBeCloseTo(startView.scale * 2, 10);
    expect(worldUnder(zoomed, spread.center)).toEqual({
      x: expect.closeTo(worldUnder(startView, start.center).x, 10),
      y: expect.closeTo(worldUnder(startView, start.center).y, 10),
    });
  });

  it('pans and zooms at once when the fingers both move and spread', () => {
    const current = anchorFor(startView, { x: 200, y: 300 }, { x: 600, y: 300 });
    const next = viewForPinch(start, current, LIMITS);
    expect(next.scale).toBeCloseTo(startView.scale * 2, 10);
    expect(worldUnder(next, current.center)).toEqual({
      x: expect.closeTo(worldUnder(startView, start.center).x, 10),
      y: expect.closeTo(worldUnder(startView, start.center).y, 10),
    });
  });

  it('clamps at the zoom limits instead of running past them', () => {
    const hugeSpread = anchorFor(startView, { x: -900, y: 100 }, { x: 1100, y: 100 });
    expect(viewForPinch(start, hugeSpread, LIMITS).scale).toBe(LIMITS.max);
    const pinchedShut = anchorFor(startView, { x: 199, y: 100 }, { x: 201, y: 100 });
    expect(viewForPinch(start, pinchedShut, LIMITS).scale).toBe(LIMITS.min);
  });

  it('treats two fingers landing on one spot as a pure pan', () => {
    const degenerate = anchorFor(startView, { x: 100, y: 100 }, { x: 100, y: 100 });
    const next = viewForPinch(degenerate, { center: { x: 150, y: 100 }, distance: 30 }, LIMITS);
    expect(next.scale).toBe(startView.scale);
    expect(next.x).toBeCloseTo(startView.x + 50, 10);
  });
});
