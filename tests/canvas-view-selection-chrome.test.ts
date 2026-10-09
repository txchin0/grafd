// A selection's handles sit on the outline it is drawn with, at every zoom.

import { beforeAll, describe, expect, it, type Mock } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { allNodes, assignMissingIds, buildModel } from '../src/client/flow-doc.js';
import type { CanvasActions } from '../src/client/canvas/canvas-view.js';
import type { Point } from '../src/client/geometry.js';
import { createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
});

const ONE_NODE_FLOW = `---
name: Chrome
---

A
  id: a-1
  pos: 100, 100, 200, 88
`;

const EXTREME_ZOOM = 40;

type RectCall = [number, number, number, number];

function selectedNodeOnCanvas() {
  const doc = parseFlow(ONE_NODE_FLOW);
  assignMissingIds(doc);
  const model = buildModel(doc, null);
  model.sourcePath = 'chrome.flow';
  const canvas = createCanvasMock();
  const view = new CanvasView(canvas, {} as CanvasActions, createExpansionLayer());
  view.setModel(model);
  view.select(allNodes(doc)[0]);
  return { view, context: canvas.getContext('2d') as unknown as { strokeRect: Mock; fillRect: Mock } };
}

// Screen distance from each corner of the selection outline to the centre of its handle, at the
// given zoom. Handles are the square fills of the drawn handle size; the outline is the
// rectangle stroked around the node.
function handleOffsetsFromOutlineCornersAt(scale: number): number[] {
  const { view, context } = selectedNodeOnCanvas();
  view.view = { x: 0, y: 0, scale };
  context.strokeRect.mockClear();
  context.fillRect.mockClear();
  view.requestRender();

  const handleSize = 8 / scale;
  const handleCenters = (context.fillRect.mock.calls as RectCall[])
    .filter(([, , w, h]) => w === handleSize && h === handleSize)
    .map(([x, y]) => ({ x: x + handleSize / 2, y: y + handleSize / 2 }));
  const [outline] = (context.strokeRect.mock.calls as RectCall[]).filter(([x, y]) => x < 100 && y < 100);
  const [x, y, w, h] = outline;
  const outlineCorners: Point[] = [{ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h }];

  expect(handleCenters).toHaveLength(4);
  return outlineCorners.map((corner) =>
    Math.min(...handleCenters.map((center) => Math.hypot(center.x - corner.x, center.y - corner.y))) * scale);
}

describe('a selected node\'s corner handles', () => {
  it.each([1, EXTREME_ZOOM])('sit on its outline\'s corners at zoom %d', (scale) => {
    for (const offset of handleOffsetsFromOutlineCornersAt(scale)) expect(offset).toBeCloseTo(0, 6);
  });
});
