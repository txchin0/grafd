import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel } from '../src/client/flow-doc.js';
import { ExpansionLayer } from '../src/client/expansion.js';
import type { View } from '../src/client/canvas-view.js';
import type { FlowNode, Rect } from '../src/shared/flow-format.js';

const VIEWPORT = { width: 1280, height: 800 };
const DASHBOARD_FLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../flows/dashboard.flow'),
  'utf8',
);

function viewCenterWorld(view: View, bounds: { width: number; height: number }) {
  return {
    x: (bounds.width / 2 - view.x) / view.scale,
    y: (bounds.height / 2 - view.y) / view.scale,
  };
}

function contentCenterOf(nodes: FlowNode[]): { x: number; y: number } {
  const rects = nodes.map((node) => node.pos!);
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function worldRectVisibleInView(rect: Rect, view: View, bounds: { width: number; height: number }): boolean {
  const left = -view.x / view.scale;
  const top = -view.y / view.scale;
  const right = (bounds.width - view.x) / view.scale;
  const bottom = (bounds.height - view.y) / view.scale;
  return rect.x + rect.w >= left && rect.x <= right && rect.y + rect.h >= top && rect.y <= bottom;
}

function createCanvasMock(width = VIEWPORT.width, height = VIEWPORT.height): HTMLCanvasElement {
  return {
    width,
    height,
    style: {},
    parentElement: { tagName: 'DIV' },
    addEventListener: vi.fn(),
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
    getContext: vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
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
      arc: vi.fn(),
      closePath: vi.fn(),
    })),
  } as unknown as HTMLCanvasElement;
}

let CanvasView: typeof import('../src/client/canvas-view.js').CanvasView;

beforeAll(async () => {
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
  ({ CanvasView } = await import('../src/client/canvas-view.js'));
  vi.spyOn(CanvasView.prototype, 'requestRender').mockImplementation(() => {});
});

describe('CanvasView fit after subgraph navigation', () => {
  it('centers the camera on a scoped graph after inline expansion on the parent', () => {
    const doc = parseFlow(DASHBOARD_FLOW);
    const parentModel = buildModel(doc, null);
    parentModel.sourceDoc = doc;
    parentModel.sourcePath = 'dashboard.flow';

    const childModel = buildModel(doc, 'Logout Confirmation');
    childModel.sourceDoc = doc;
    childModel.sourcePath = 'dashboard.flow';

    const host = parentModel.nodes.find((node) => node.name === 'Handle Logout Button')!;
    const expansions = new ExpansionLayer({
      onNeedsRender: () => {},
      readExternalFile: async () => null,
    });

    const canvas = createCanvasMock();
    // Fit-to-content never dispatches actions, so a bare stub is enough here.
    const view = new CanvasView(canvas, {} as unknown as ConstructorParameters<typeof CanvasView>[1]);
    view.expansionLayer = expansions;

    view.setModel(parentModel);
    expansions.restoreOpen([host.id!]);
    view.setModel(childModel);
    view.fitToContent();

    const expectedCenter = contentCenterOf(childModel.nodes);
    const actualCenter = viewCenterWorld(view.view, VIEWPORT);

    expect(actualCenter.x).toBeCloseTo(expectedCenter.x, 0);
    expect(actualCenter.y).toBeCloseTo(expectedCenter.y, 0);
    expect(actualCenter.x).toBeLessThan(500);

    for (const node of childModel.nodes) {
      expect(worldRectVisibleInView(node.pos!, view.view, VIEWPORT)).toBe(true);
    }
  });
});
