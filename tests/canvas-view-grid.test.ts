import { beforeAll, describe, expect, it, type Mock } from 'vitest';
import { createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
});

// drawGrid is the only thing that paints dots this size, so counting them isolates the grid
// from the rest of the scene.
const GRID_DOT_SIZE = 1.5;

function countGridDots(canvas: HTMLCanvasElement): number {
  const fillRect = (canvas.getContext('2d') as unknown as { fillRect: Mock }).fillRect;
  return fillRect.mock.calls.filter((call) => call[2] === GRID_DOT_SIZE && call[3] === GRID_DOT_SIZE).length;
}

// The constructor sizes the canvas and renders once, so each measurement starts from a
// cleared spy rather than from whatever that first frame drew.
function createViewOnMockCanvas() {
  const canvas = createCanvasMock();
  const view = new CanvasView(canvas, {} as unknown as ConstructorParameters<typeof CanvasView>[1], createExpansionLayer());
  const renderAndCountGridDots = () => {
    (canvas.getContext('2d') as unknown as { fillRect: Mock }).fillRect.mockClear();
    view.requestRender();
    return countGridDots(canvas);
  };
  return { view, renderAndCountGridDots };
}

describe('CanvasView.gridIsVisible', () => {
  it('draws the grid by default', () => {
    const { renderAndCountGridDots } = createViewOnMockCanvas();
    expect(renderAndCountGridDots()).toBeGreaterThan(0);
  });

  it('draws no grid once the preference turns it off', () => {
    const { view, renderAndCountGridDots } = createViewOnMockCanvas();
    view.gridIsVisible = false;
    expect(renderAndCountGridDots()).toBe(0);
  });

  it('still draws the grid into an export that asked for one', () => {
    const { view } = createViewOnMockCanvas();
    view.gridIsVisible = false;

    const exportCanvas = createCanvasMock(400, 300);
    view.renderSnapshot({
      canvas: exportCanvas,
      viewport: { width: 400, height: 300 },
      pixelRatio: 1,
      background: null,
      grid: true,
    });

    expect(countGridDots(exportCanvas)).toBeGreaterThan(0);
  });
});
