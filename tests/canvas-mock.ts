// Minimal stand-ins for the browser APIs CanvasView touches, so its geometry and rendering
// can be exercised under Vitest without a DOM.

import { vi } from 'vitest';
import { ExpansionLayer } from '../src/client/canvas/expansion.js';

export const VIEWPORT = { width: 1280, height: 800 };

export function createContextMock() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    ellipse: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    setLineDash: vi.fn(),
    clip: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
  };
}

export function createCanvasMock(width = VIEWPORT.width, height = VIEWPORT.height): HTMLCanvasElement {
  const context = createContextMock();
  return {
    width,
    height,
    style: {},
    parentElement: { tagName: 'DIV' },
    addEventListener: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
}

// An inert expansion layer for views whose test does not exercise inline expansion. It still
// has to be a real layer — the view requires one — so tests that never collect loci get the
// same "no geometry pass has run yet" behaviour the app has before its first frame.
export function createExpansionLayer(): ExpansionLayer {
  return new ExpansionLayer({ onNeedsRender: () => {}, readExternalFile: async () => null });
}

export function stubCanvasGlobals(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}
