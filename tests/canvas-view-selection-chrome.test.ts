// A selection's handles sit on the outline it is drawn with, at every zoom.

import { beforeAll, describe, expect, it, type Mock } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { addStroke } from '../src/shared/canvas-drawings.js';
import { groupDrawings } from '../src/shared/canvas-groups.js';
import { emptyCanvasLayer } from '../src/shared/canvas-layer.js';
import { allNodes, assignMissingIds, buildModel } from '../src/client/flow-doc.js';
import { dressModel } from '../src/client/model-visuals.js';
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

function selectedGroupOfStrokesOnCanvas() {
  const layer = emptyCanvasLayer();
  addStroke(layer, { kind: 'stroke', id: 's1', graph: null, color: null, width: 'medium', points: [{ x: 0, y: 0 }, { x: 80, y: 40 }] });
  addStroke(layer, { kind: 'stroke', id: 's2', graph: null, color: null, width: 'medium', points: [{ x: 200, y: 100 }, { x: 260, y: 160 }] });
  groupDrawings(layer, new Set(['s1', 's2']));
  const model = buildModel(parseFlow(ONE_NODE_FLOW), null);
  model.sourcePath = 'chrome.flow';
  const canvas = createCanvasMock();
  const view = new CanvasView(canvas, {} as CanvasActions, createExpansionLayer());
  view.setModel(dressModel(model, layer));
  view.setSelection([], [], [{ path: 'chrome.flow', scope: null, id: 's1' }]);
  return { view, context: canvas.getContext('2d') as unknown as { strokeRect: Mock } };
}

describe('a selected group', () => {
  it('is outlined once, around all its members, and its members are not outlined on their own', () => {
    const { view, context } = selectedGroupOfStrokesOnCanvas();
    view.requestRender();
    context.strokeRect.mockClear();
    view.requestRender();

    const outlines = context.strokeRect.mock.calls as RectCall[];
    expect(outlines).toHaveLength(1);
    const [[x, y, w, h]] = outlines;
    expect(x).toBeLessThan(0);
    expect(y).toBeLessThan(0);
    expect(x + w).toBeGreaterThan(260);
    expect(y + h).toBeGreaterThan(160);
  });
});
