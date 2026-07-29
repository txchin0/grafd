// The band returned by titlePlacementOf is what the inline title editor overlays and what
// a double-click is tested against, so it has to keep matching the text the canvas draws.
// The mocked measureText reports width 0, so every title wraps to a single line here.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel } from '../src/client/flow-doc.js';
import { ExpansionLayer } from '../src/client/canvas/expansion.js';
import { createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

const DASHBOARD_FLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../flows/dashboard.flow'),
  'utf8',
);

const TITLE_LINE_HEIGHT = 20;
const NODE_TEXT_SIDE_PADDING = 13;

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
  vi.spyOn(CanvasView.prototype, 'requestRender').mockImplementation(() => {});
});

function createView(layer: ExpansionLayer = createExpansionLayer()) {
  return new CanvasView(createCanvasMock(), {} as unknown as ConstructorParameters<typeof CanvasView>[1], layer);
}

function dashboardModel() {
  const doc = parseFlow(DASHBOARD_FLOW);
  const model = buildModel(doc, null);
  model.sourceDoc = doc;
  model.sourcePath = 'dashboard.flow';
  return model;
}

describe('CanvasView title placement', () => {
  it('centers a plain node title on the node and insets it by the text padding', () => {
    const model = dashboardModel();
    const view = createView();
    view.setModel(model);

    const node = model.nodes.find((candidate) => candidate.name === 'Fetch User Profile')!;
    const placement = view.titlePlacementOf(node)!;
    const pos = node.pos!;

    expect(placement.align).toBe('center');
    expect(placement.screenScale).toBeCloseTo(view.view.scale, 8);
    expect(placement.rect.x).toBe(pos.x + NODE_TEXT_SIDE_PADDING);
    expect(placement.rect.w).toBe(pos.w - 2 * NODE_TEXT_SIDE_PADDING);
    expect(placement.rect.h).toBe(TITLE_LINE_HEIGHT);
    expect(placement.rect.y + placement.rect.h / 2).toBeCloseTo(pos.y + pos.h / 2, 8);
  });

  it('lifts the title band above center when the node also renders a description', () => {
    const model = dashboardModel();
    const view = createView();
    view.setModel(model);

    const node = model.nodes.find((candidate) => candidate.name === 'Render Dashboard')!;
    const placement = view.titlePlacementOf(node)!;
    const pos = node.pos!;

    expect(placement.rect.y + placement.rect.h).toBeLessThan(pos.y + pos.h / 2);
    expect(placement.rect.y).toBeGreaterThan(pos.y);
  });

  it('titles an unfolded frame host left-aligned in its header strip', () => {
    const model = dashboardModel();
    const expansions = createExpansionLayer();
    const view = createView(expansions);
    view.setModel(model);

    const host = model.nodes.find((candidate) => candidate.name === 'Handle Logout Button')!;
    expansions.restoreOpen([host.id!]);
    expansions.layout(model, performance.now());
    expansions.collectLoci(model);

    const frame = model.display!.expansions.get(host)!.frame;
    const placement = view.titlePlacementOf(host)!;

    expect(placement.align).toBe('left');
    expect(placement.fontPx).toBe(13);
    expect(placement.rect.x).toBeGreaterThanOrEqual(frame.x);
    expect(placement.rect.x).toBeLessThan(frame.x + 12);
    expect(placement.rect.y + placement.rect.h / 2).toBeCloseTo(frame.y + 16, 8);
    expect(placement.rect.w).toBeLessThanOrEqual(frame.w - 64);
  });

  it('pushes a nested node title through its frame transform', () => {
    const model = dashboardModel();
    const expansions = createExpansionLayer();
    const view = createView(expansions);
    view.setModel(model);

    const host = model.nodes.find((candidate) => candidate.name === 'Handle Logout Button')!;
    expansions.restoreOpen([host.id!]);
    expansions.layout(model, performance.now());
    expansions.collectLoci(model);

    const expansion = model.display!.expansions.get(host)!;
    const inner = expansion.subModel.nodes.find((candidate) => candidate.name === 'Confirm Logout')!;
    const placement = view.titlePlacementOf(inner)!;
    const innerPos = inner.pos!;
    const { scale, tx, ty } = expansion.transform;

    expect(placement.screenScale).toBeCloseTo(view.view.scale * scale, 8);
    expect(placement.rect.x).toBeCloseTo((innerPos.x + NODE_TEXT_SIDE_PADDING) * scale + tx, 8);
    expect(placement.rect.w).toBeCloseTo((innerPos.w - 2 * NODE_TEXT_SIDE_PADDING) * scale, 8);
    expect(placement.rect.h).toBeCloseTo(TITLE_LINE_HEIGHT * scale, 8);
    expect(placement.rect.y + placement.rect.h / 2)
      .toBeCloseTo((innerPos.y + innerPos.h / 2) * scale + ty, 8);
  });

  it('reports no placement for a node that is not on the canvas', () => {
    const model = dashboardModel();
    const expansions = createExpansionLayer();
    const view = createView(expansions);
    view.setModel(model);
    expansions.collectLoci(model);

    const hidden = buildModel(parseFlow(DASHBOARD_FLOW), 'Logout Confirmation').nodes[0];
    expect(view.titlePlacementOf(hidden)).toBeNull();
  });
});
