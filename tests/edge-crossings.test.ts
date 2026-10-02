import { describe, expect, it } from 'vitest';
import { countCrossingPairs, type CrossingSegment } from '../src/shared/edge-crossings.js';

function segment(x1: number, y1: number, x2: number, y2: number): CrossingSegment {
  return { from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
}

function crossingBundles(downRight: number, downLeft: number): CrossingSegment[] {
  const segments: CrossingSegment[] = [];
  for (let i = 0; i < downRight; i++) {
    const y = i * 20;
    segments.push(segment(0, y, 100, 100 + y));
  }
  for (let i = 0; i < downLeft; i++) {
    const y = i * 20;
    segments.push(segment(100, y, 0, 100 + y));
  }
  return segments;
}

describe('countCrossingPairs', () => {
  it('counts an X as one crossing', () => {
    expect(countCrossingPairs([segment(0, 0, 10, 10), segment(0, 10, 10, 0)])).toBe(1);
  });

  it('does not count segments that share an endpoint', () => {
    expect(countCrossingPairs([segment(0, 0, 10, 0), segment(10, 0, 20, 0)])).toBe(0);
  });

  it('does not count collinear overlap', () => {
    expect(countCrossingPairs([segment(0, 0, 10, 0), segment(5, 0, 15, 0)])).toBe(0);
  });

  it('does not count a zero-length segment', () => {
    expect(countCrossingPairs([segment(5, 5, 5, 5), segment(0, 0, 10, 10)])).toBe(0);
  });

  it('counts a 2-by-2 bundle as four crossings', () => {
    expect(countCrossingPairs(crossingBundles(2, 2))).toBe(4);
  });

  it('counts a 3-by-2 bundle as six crossings', () => {
    expect(countCrossingPairs(crossingBundles(3, 2))).toBe(6);
  });
});
