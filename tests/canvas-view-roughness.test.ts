// `baseRoughness` scales the roughness every element hands to rough.js, which shows up as how
// far the drawn ink strays from the ideal shape. The flow here holds a single node with no
// edges, so every path coordinate the canvas receives belongs to that node's rectangle.

import { beforeAll, describe, expect, it, type Mock } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel } from '../src/client/flow-doc.js';
import { createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

const NODE_RECT = { x: 60, y: 100, w: 200, h: 72 };
const SOLO_FLOW = `---
name: Solo
---

Only Node
  id: 1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d
  pos: ${NODE_RECT.x}, ${NODE_RECT.y}, ${NODE_RECT.w}, ${NODE_RECT.h}
`;

const PATH_METHODS = ['moveTo', 'lineTo'] as const;

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
});

// Distance from a point to the rectangle's outline, which is 0 for ink laid exactly on the
// ideal shape and grows with the jitter rough.js adds.
function distanceToRectOutline({ x, y }: { x: number; y: number }): number {
  const left = NODE_RECT.x;
  const right = NODE_RECT.x + NODE_RECT.w;
  const top = NODE_RECT.y;
  const bottom = NODE_RECT.y + NODE_RECT.h;
  const insideHorizontally = x >= left && x <= right;
  const insideVertically = y >= top && y <= bottom;
  const toVerticalSides = Math.min(Math.abs(x - left), Math.abs(x - right));
  const toHorizontalSides = Math.min(Math.abs(y - top), Math.abs(y - bottom));
  if (insideHorizontally && insideVertically) return Math.min(toVerticalSides, toHorizontalSides);
  if (insideHorizontally) return toHorizontalSides;
  if (insideVertically) return toVerticalSides;
  return Math.hypot(toVerticalSides, toHorizontalSides);
}

function widestStrayFromRect(baseRoughness: number): number {
  const canvas = createCanvasMock();
  const context = canvas.getContext('2d') as unknown as Record<string, Mock>;
  const view = new CanvasView(canvas, {} as unknown as ConstructorParameters<typeof CanvasView>[1], createExpansionLayer());
  view.baseRoughness = baseRoughness;
  view.setModel(buildModel(parseFlow(SOLO_FLOW), null));
  for (const method of PATH_METHODS) context[method].mockClear();
  view.requestRender();

  const drawnPoints = PATH_METHODS.flatMap((method) =>
    context[method].mock.calls.map(([x, y]) => ({ x: x as number, y: y as number })),
  );
  expect(drawnPoints.length).toBeGreaterThan(0);
  return Math.max(...drawnPoints.map(distanceToRectOutline));
}

describe('CanvasView.baseRoughness', () => {
  it('draws the node exactly on its rectangle when roughness is zero', () => {
    expect(widestStrayFromRect(0)).toBeCloseTo(0, 8);
  });

  it('strays further from the rectangle the higher the base roughness', () => {
    const atDefault = widestStrayFromRect(1);
    expect(atDefault).toBeGreaterThan(0.5);
    expect(widestStrayFromRect(10)).toBeGreaterThan(atDefault);
  });
});
