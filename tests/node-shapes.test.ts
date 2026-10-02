import { describe, expect, it } from 'vitest';
import { NODE_SHAPES } from '../src/shared/canvas-layer.js';
import { outlinePathData, shapeBorderPointFrom, shapeOutline, shapeTextBox } from '../src/client/canvas/node-shapes.js';
import { rectCenter, unitVectorBetween } from '../src/client/geometry.js';

const RECT = { x: 100, y: 50, w: 200, h: 100 };
const CENTER = rectCenter(RECT);

function exitToward(shape: (typeof NODE_SHAPES)[number], toward: { x: number; y: number }) {
  return shapeBorderPointFrom(shape, RECT, CENTER, unitVectorBetween(CENTER, toward));
}

describe('shapeBorderPointFrom', () => {
  it('meets a rectangle on its border', () => {
    expect(exitToward('rectangle', { x: 1000, y: CENTER.y })).toEqual({ x: 300, y: 100 });
  });

  it('meets an ellipse on its curve, inside the corners of the rectangle', () => {
    const point = exitToward('ellipse', { x: 300, y: 150 });
    const normalized = ((point.x - CENTER.x) / 100) ** 2 + ((point.y - CENTER.y) / 50) ** 2;
    expect(normalized).toBeCloseTo(1, 6);
    expect(point.x).toBeLessThan(300);
  });

  it('meets a diamond on the facet between two of its points', () => {
    const point = exitToward('diamond', { x: 300, y: 150 });
    // The lower-right facet runs from (300, 100) to (200, 150): x/100 + y/50 = 1 about the centre.
    expect((point.x - CENTER.x) / 100 + (point.y - CENTER.y) / 50).toBeCloseTo(1, 6);
  });

  it('reaches the side points of a diamond and a hexagon straight across', () => {
    expect(exitToward('diamond', { x: 1000, y: CENTER.y })).toEqual({ x: 300, y: 100 });
    expect(exitToward('hexagon', { x: 0, y: CENTER.y })).toEqual({ x: 100, y: 100 });
  });

  it('meets a parallelogram on its slanted side', () => {
    const point = exitToward('parallelogram', { x: 1000, y: CENTER.y });
    expect(point.x).toBeLessThan(300);
    expect(point.y).toBeCloseTo(CENTER.y, 6);
  });

  it('lands on the outline for every shape and direction', () => {
    for (const shape of NODE_SHAPES) {
      for (let degrees = 0; degrees < 360; degrees += 15) {
        const radians = (degrees * Math.PI) / 180;
        const point = shapeBorderPointFrom(shape, RECT, CENTER, { x: Math.cos(radians), y: Math.sin(radians) });
        expect(point.x, `${shape} ${degrees}°`).toBeGreaterThanOrEqual(RECT.x - 1e-6);
        expect(point.x, `${shape} ${degrees}°`).toBeLessThanOrEqual(RECT.x + RECT.w + 1e-6);
        expect(point.y, `${shape} ${degrees}°`).toBeGreaterThanOrEqual(RECT.y - 1e-6);
        expect(point.y, `${shape} ${degrees}°`).toBeLessThanOrEqual(RECT.y + RECT.h + 1e-6);
        expect(Math.hypot(point.x - CENTER.x, point.y - CENTER.y), `${shape} ${degrees}°`).toBeGreaterThan(20);
      }
    }
  });
});

describe('shapeTextBox', () => {
  it('is the rectangle itself for rectangular shapes and a centred inset box otherwise', () => {
    expect(shapeTextBox('rectangle', RECT)).toEqual(RECT);
    expect(shapeTextBox('rounded', RECT)).toEqual(RECT);
    for (const shape of NODE_SHAPES) {
      const box = shapeTextBox(shape, RECT);
      expect(box.x, shape).toBeGreaterThanOrEqual(RECT.x);
      expect(box.y, shape).toBeGreaterThanOrEqual(RECT.y);
      expect(box.x + box.w, shape).toBeLessThanOrEqual(RECT.x + RECT.w);
      expect(box.y + box.h, shape).toBeLessThanOrEqual(RECT.y + RECT.h);
    }
  });

  it('keeps a diamond text box inside the diamond', () => {
    const box = shapeTextBox('diamond', RECT);
    const corners = [
      { x: box.x, y: box.y },
      { x: box.x + box.w, y: box.y + box.h },
    ];
    for (const corner of corners) {
      expect(Math.abs(corner.x - CENTER.x) / 100 + Math.abs(corner.y - CENTER.y) / 50).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('outlinePathData', () => {
  it('gives a closed path for every shape, and two for the cylinder (body, then lid)', () => {
    for (const shape of NODE_SHAPES) {
      const paths = outlinePathData(shapeOutline(shape, RECT));
      expect(paths.length, shape).toBe(shape === 'cylinder' ? 2 : 1);
      for (const path of paths) expect(path.trim().endsWith('Z'), shape).toBe(true);
    }
  });
});
