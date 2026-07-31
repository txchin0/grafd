// The view's end of touchpad and touchscreen input: which handler a wheel event reaches, and
// what happens to a single-pointer gesture when a second pointer joins it.
//
// Two fingers landing a few milliseconds apart is the ordinary way a pinch starts, so the
// first finger has almost always begun a drag by the time the second arrives. Whatever it
// began has to be undone rather than committed — otherwise every pinch over a node nudges
// that node and writes the nudge to disk.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel } from '../src/client/flow-doc.js';
import type { CanvasActions } from '../src/client/canvas/canvas-view.js';
import { createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

const FLOW = `Alpha
  id: alpha-1
  pos: 100, 100, 200, 100
`;

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
  vi.spyOn(CanvasView.prototype, 'requestRender').mockImplementation(() => {});
});

type PointerHandler = (event: unknown) => void;

function pointerEvent(pointerId: number, x: number, y: number) {
  return { pointerId, clientX: x, clientY: y, button: 0, buttons: 1, shiftKey: false, detail: 1 };
}

function wheelEvent(overrides: Record<string, unknown> = {}) {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    clientX: 0,
    clientY: 0,
    timeStamp: 0,
    preventDefault: () => {},
    ...overrides,
  };
}

function createSurface() {
  const canvas = createCanvasMock();
  const actions = {
    createNode: vi.fn(),
    quickCreateNode: vi.fn(),
    nodeClicked: vi.fn(),
    canvasClicked: vi.fn(),
    moveCommitted: vi.fn(),
    completeEdge: vi.fn(),
    editEdge: vi.fn(),
    editNodeTitle: vi.fn(),
    openExpand: vi.fn(),
    toggleExpand: vi.fn(),
    materializeGhost: vi.fn(),
    contextMenu: vi.fn(),
    regionMoved: vi.fn(),
    regionResized: vi.fn(),
    deleteRegion: vi.fn(),
    createRegion: vi.fn(),
    regionClicked: vi.fn(),
    viewChanged: vi.fn(),
  } satisfies CanvasActions;
  const view = new CanvasView(canvas, actions, createExpansionLayer());

  const doc = parseFlow(FLOW);
  const model = buildModel(doc, null);
  model.sourceDoc = doc;
  model.sourcePath = 'touch.flow';
  view.setModel(model);
  view.setViewNow({ x: 0, y: 0, scale: 1 });

  const listeners = new Map<string, PointerHandler>(
    (canvas.addEventListener as unknown as { mock: { calls: [string, PointerHandler][] } }).mock.calls,
  );
  const dispatch = (type: string, event: unknown) => listeners.get(type)!(event);
  return { view, actions, model, dispatch };
}

describe('CanvasView touch and touchpad input', () => {
  it('rolls back the drag the first finger started when a second finger lands', () => {
    const { actions, model, dispatch } = createSurface();
    const node = model.nodes[0];

    dispatch('pointerdown', pointerEvent(1, 200, 150));
    dispatch('pointermove', pointerEvent(1, 260, 190));
    expect(node.pos).not.toMatchObject({ x: 100, y: 100 });

    dispatch('pointerdown', pointerEvent(2, 400, 150));

    expect(node.pos).toMatchObject({ x: 100, y: 100 });
    expect(actions.moveCommitted).not.toHaveBeenCalled();
  });

  it('pans and zooms the camera while both fingers move', () => {
    const { view, dispatch } = createSurface();

    dispatch('pointerdown', pointerEvent(1, 100, 200));
    dispatch('pointerdown', pointerEvent(2, 300, 200));
    dispatch('pointermove', pointerEvent(1, 100, 300));
    dispatch('pointermove', pointerEvent(2, 500, 300));

    expect(view.view.scale).toBeCloseTo(2, 10);
    // The world point under the midpoint at 200,200 is now under the midpoint at 300,300.
    expect({ x: (300 - view.view.x) / view.view.scale, y: (300 - view.view.y) / view.view.scale })
      .toEqual({ x: expect.closeTo(200, 10), y: expect.closeTo(200, 10) });
  });

  it('ignores the finger left behind when a pinch ends, then accepts a fresh press', () => {
    const { view, actions, dispatch } = createSurface();

    dispatch('pointerdown', pointerEvent(1, 100, 200));
    dispatch('pointerdown', pointerEvent(2, 300, 200));
    dispatch('pointerup', pointerEvent(2, 300, 200));

    const viewAfterPinch = { ...view.view };
    dispatch('pointermove', pointerEvent(1, 400, 500));
    dispatch('pointerup', pointerEvent(1, 400, 500));
    expect(view.view).toEqual(viewAfterPinch);
    expect(actions.nodeClicked).not.toHaveBeenCalled();
    expect(actions.canvasClicked).not.toHaveBeenCalled();

    dispatch('pointerdown', pointerEvent(1, 200, 150));
    dispatch('pointerup', pointerEvent(1, 200, 150));
    expect(actions.nodeClicked).toHaveBeenCalledTimes(1);
  });

  it('pans the camera on a touchpad wheel and leaves the nodes alone', () => {
    const { view, model, dispatch } = createSurface();

    dispatch('wheel', wheelEvent({ deltaX: 30, deltaY: -12.5 }));

    expect(view.view).toEqual({ x: -30, y: 12.5, scale: 1 });
    expect(model.nodes[0].pos).toMatchObject({ x: 100, y: 100 });
  });

  it('zooms about the pointer on a pinch, which reaches the page as ctrl+wheel', () => {
    const { view, dispatch } = createSurface();

    dispatch('wheel', wheelEvent({ deltaY: -20, ctrlKey: true, clientX: 400, clientY: 300 }));

    expect(view.view.scale).toBeGreaterThan(1);
    expect(view.screenToWorld({ x: 400, y: 300 })).toEqual({
      x: expect.closeTo(400, 10),
      y: expect.closeTo(300, 10),
    });
  });

  it('still zooms by a step on a mouse wheel', () => {
    const { view, dispatch } = createSurface();

    dispatch('wheel', wheelEvent({ deltaY: -100 }));
    expect(view.view.scale).toBeCloseTo(1.1, 10);
    dispatch('wheel', wheelEvent({ deltaY: 100, timeStamp: 5000 }));
    expect(view.view.scale).toBeCloseTo(1, 10);
  });

  it('discards the in-flight drag when the pointer stream is cancelled', () => {
    const { actions, model, dispatch } = createSurface();
    const node = model.nodes[0];

    dispatch('pointerdown', pointerEvent(1, 200, 150));
    dispatch('pointermove', pointerEvent(1, 260, 190));
    dispatch('pointercancel', pointerEvent(1, 260, 190));

    expect(node.pos).toMatchObject({ x: 100, y: 100 });
    expect(actions.moveCommitted).not.toHaveBeenCalled();
  });
});
