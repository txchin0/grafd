import { beforeAll, describe, expect, it, type Mock } from 'vitest';
import { createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
});

// The grid fills the canvas with a repeating tile, and nothing else on the canvas is filled with a
// pattern, so counting pattern fills isolates the grid from the rest of the scene.
function recordGridFills(canvas: HTMLCanvasElement): { count: () => number; clear: () => void } {
  const context = canvas.getContext('2d') as unknown as { fillRect: Mock; fillStyle: unknown };
  let fills = 0;
  context.fillRect.mockImplementation(() => {
    if (typeof context.fillStyle === 'object') fills++;
  });
  return { count: () => fills, clear: () => { fills = 0; } };
}

// The constructor sizes the canvas and renders once, so each measurement starts from a
// cleared count rather than from whatever that first frame drew.
function createViewOnMockCanvas() {
  const canvas = createCanvasMock();
  const gridFills = recordGridFills(canvas);
  const view = new CanvasView(canvas, {} as unknown as ConstructorParameters<typeof CanvasView>[1], createExpansionLayer());
  const renderAndCountGridFills = () => {
    gridFills.clear();
    view.requestRender();
    return gridFills.count();
  };
  return { view, renderAndCountGridFills };
}

describe('CanvasView.gridIsVisible', () => {
  it('draws the grid by default', () => {
    const { renderAndCountGridFills } = createViewOnMockCanvas();
    expect(renderAndCountGridFills()).toBeGreaterThan(0);
  });

  it('draws no grid once the preference turns it off', () => {
    const { view, renderAndCountGridFills } = createViewOnMockCanvas();
    view.gridIsVisible = false;
    expect(renderAndCountGridFills()).toBe(0);
  });

  it('still draws the grid into an export that asked for one', () => {
    const { view } = createViewOnMockCanvas();
    view.gridIsVisible = false;

    const exportCanvas = createCanvasMock(400, 300);
    const exportFills = recordGridFills(exportCanvas);
    view.renderSnapshot({
      canvas: exportCanvas,
      viewport: { width: 400, height: 300 },
      pixelRatio: 1,
      background: null,
      grid: true,
    });

    expect(exportFills.count()).toBeGreaterThan(0);
  });
});
