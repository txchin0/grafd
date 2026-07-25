import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel } from '../src/client/flow-doc.js';
import { ExpansionLayer } from '../src/client/expansion.js';
import type { View } from '../src/client/canvas-view.js';
import type { FlowNode, Rect } from '../src/shared/flow-format.js';
import { VIEWPORT, createCanvasMock, stubCanvasGlobals } from './canvas-mock.js';

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

let CanvasView: typeof import('../src/client/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
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
