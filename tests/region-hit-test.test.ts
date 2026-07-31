import { describe, expect, it } from 'vitest';
import {
  HANDLE_HIT_RADIUS_PX,
  hitResizeCorner,
  resizeCornersOf,
  selectionHandleOrigins,
} from '../src/client/canvas/resize-handles.js';
import { hitRegionAt, REGION_BORDER_BAND_PX } from '../src/client/canvas/region-hit-test.js';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel } from '../src/client/flow-doc.js';

describe('hitResizeCorner', () => {
  const rect = { x: 0, y: 0, w: 100, h: 80 };

  it('hits each corner within the radius', () => {
    expect(hitResizeCorner(rect, { x: 0, y: 0 }, 5)).toBe('nw');
    expect(hitResizeCorner(rect, { x: 100, y: 0 }, 5)).toBe('ne');
    expect(hitResizeCorner(rect, { x: 0, y: 80 }, 5)).toBe('sw');
    expect(hitResizeCorner(rect, { x: 100, y: 80 }, 5)).toBe('se');
  });

  it('misses the interior and mid-edges', () => {
    expect(hitResizeCorner(rect, { x: 50, y: 40 }, HANDLE_HIT_RADIUS_PX)).toBeNull();
    expect(hitResizeCorner(rect, { x: 50, y: 0 }, 4)).toBeNull();
  });
});

describe('selectionHandleOrigins', () => {
  it('centers handle squares on the rectangle corners', () => {
    const rect = { x: 10, y: 20, w: 40, h: 30 };
    expect(selectionHandleOrigins(rect, 8)).toEqual([
      { x: 6, y: 16 },
      { x: 46, y: 16 },
      { x: 6, y: 46 },
      { x: 46, y: 46 },
    ]);
    expect(resizeCornersOf(rect)).toHaveLength(4);
  });
});

describe('hitRegionAt', () => {
  const text = `---
name: Demo
---

context: Outer
  pos: 0, 0, 300, 200
  nodes:
    - A

context: Inner
  pos: 40, 40, 100, 80
  nodes:
    - A

A:
  id: 11111111-1111-4111-8111-111111111111
  pos: 50, 50, 80, 60
`;

  it('hits the border band but not the interior', () => {
    const model = buildModel(parseFlow(text), null);
    const labelBand = () => ({ x: -1000, y: -1000, w: 1, h: 1 });
    expect(hitRegionAt(model, { x: 0, y: 100 }, 1, labelBand)?.block.name).toBe('Outer');
    expect(hitRegionAt(model, { x: 150, y: 100 }, 1, labelBand)).toBeNull();
  });

  it('prefers the topmost overlapping frame', () => {
    const model = buildModel(parseFlow(text), null);
    const labelBand = () => ({ x: -1000, y: -1000, w: 1, h: 1 });
    // Shared border of Inner (drawn later) wins over Outer.
    expect(hitRegionAt(model, { x: 40, y: 80 }, 1, labelBand)?.block.name).toBe('Inner');
  });

  it('hits via the label band callback', () => {
    const model = buildModel(parseFlow(text), null);
    const labelBand = (name: string) =>
      name === 'Outer' ? { x: 500, y: 500, w: 40, h: 16 } : { x: -1000, y: -1000, w: 1, h: 1 };
    expect(hitRegionAt(model, { x: 510, y: 508 }, 1, labelBand)?.block.name).toBe('Outer');
    expect(REGION_BORDER_BAND_PX).toBeGreaterThan(0);
  });
});
