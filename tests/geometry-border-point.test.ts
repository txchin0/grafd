// Edge anchors are border crossings, and an anchor that leaves its border detaches the arrowhead
// from the node it points at. These tests pin the ray-to-border arithmetic that places them.

import { describe, expect, it } from 'vitest';
import {
  rectBorderPointFrom,
  rectBorderPointToward,
  rectCenter,
  unitVectorBetween,
} from '../src/client/geometry.js';

const RECT = { x: 100, y: 200, w: 200, h: 80 };

function isOnBorderOf(point: { x: number; y: number }, rect: { x: number; y: number; w: number; h: number }): boolean {
  const onVerticalEdge = Math.abs(point.x - rect.x) < 1e-9 || Math.abs(point.x - (rect.x + rect.w)) < 1e-9;
  const onHorizontalEdge = Math.abs(point.y - rect.y) < 1e-9 || Math.abs(point.y - (rect.y + rect.h)) < 1e-9;
  const withinX = point.x >= rect.x - 1e-9 && point.x <= rect.x + rect.w + 1e-9;
  const withinY = point.y >= rect.y - 1e-9 && point.y <= rect.y + rect.h + 1e-9;
  return (onVerticalEdge && withinY) || (onHorizontalEdge && withinX);
}

describe('rectBorderPointFrom', () => {
  it('agrees with the center-ray form when the origin is the center', () => {
    const center = rectCenter(RECT);
    for (const target of [{ x: 900, y: 240 }, { x: -400, y: 900 }, { x: 200, y: -50 }]) {
      const fromCenter = rectBorderPointFrom(RECT, center, unitVectorBetween(center, target));
      const toward = rectBorderPointToward(RECT, target);
      expect(fromCenter.x).toBeCloseTo(toward.x, 9);
      expect(fromCenter.y).toBeCloseTo(toward.y, 9);
    }
  });

  it('slides the crossing along the border as the origin is offset across the ray', () => {
    const center = rectCenter(RECT);
    const rightward = { x: 1, y: 0 };
    const centred = rectBorderPointFrom(RECT, center, rightward);
    const raised = rectBorderPointFrom(RECT, { x: center.x, y: center.y - 20 }, rightward);
    expect(centred.x).toBeCloseTo(RECT.x + RECT.w, 9);
    expect(raised.x).toBeCloseTo(RECT.x + RECT.w, 9);
    expect(raised.y).toBeCloseTo(centred.y - 20, 9);
  });

  it('lands on the border for offset origins leaving in every direction', () => {
    const center = rectCenter(RECT);
    const origins = [center, { x: center.x + 60, y: center.y }, { x: center.x, y: center.y + 30 }];
    const directions = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    for (const origin of origins) {
      for (const direction of [...directions, unitVectorBetween(origin, { x: 900, y: 900 })]) {
        expect(isOnBorderOf(rectBorderPointFrom(RECT, origin, direction), RECT)).toBe(true);
      }
    }
  });

  it('returns the origin unchanged when there is no direction to travel', () => {
    expect(rectBorderPointFrom(RECT, { x: 150, y: 220 }, { x: 0, y: 0 })).toEqual({ x: 150, y: 220 });
  });

  it('stays put rather than travelling backwards when the origin is already outside', () => {
    const outside = { x: RECT.x + RECT.w + 40, y: rectCenter(RECT).y };
    expect(rectBorderPointFrom(RECT, outside, { x: 1, y: 0 })).toEqual(outside);
  });
});
