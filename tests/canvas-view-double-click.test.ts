// Double-clicking a subgraph node dives into it, so the hit test that decides which node
// counts as one has to agree with the badges: any node carrying `expand`, including nodes
// that only exist inside an unfolded frame.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel } from '../src/client/flow-doc.js';
import { ExpansionLayer } from '../src/client/canvas/expansion.js';
import { createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

const DASHBOARD_FLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.grafd/dashboard.flow'),
  'utf8',
);

const NESTED_FLOW = `Host
  id: host-1
  pos: 0, 0, 400, 300
  expand: Middle

graph: Middle
  Inner Subgraph
    id: inner-1
    pos: 100, 100, 200, 88
    expand: Deep

graph: Deep
  Leaf
    pos: 0, 0, 120, 60
`;

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
  vi.spyOn(CanvasView.prototype, 'requestRender').mockImplementation(() => {});
});

function createView(layer: ExpansionLayer = createExpansionLayer()) {
  return new CanvasView(createCanvasMock(), {} as unknown as ConstructorParameters<typeof CanvasView>[1], layer);
}

function modelOf(text: string) {
  const doc = parseFlow(text);
  const model = buildModel(doc, null);
  model.sourceDoc = doc;
  model.sourcePath = 'dashboard.flow';
  return model;
}

function centerOf({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return { x: x + w / 2, y: y + h / 2 };
}

describe('CanvasView subgraphToOpenAt', () => {
  it('reports the node under the point when it expands a subgraph', () => {
    const model = modelOf(DASHBOARD_FLOW);
    const view = createView();
    view.setModel(model);

    const host = model.nodes.find((candidate) => candidate.name === 'Handle Logout Button')!;
    expect(view.subgraphToOpenAt(centerOf(host.pos!))).toBe(host);
  });

  it('reports nothing for a plain node or for empty canvas', () => {
    const model = modelOf(DASHBOARD_FLOW);
    const view = createView();
    view.setModel(model);

    const plain = model.nodes.find((candidate) => candidate.name === 'Fetch User Profile')!;
    expect(view.subgraphToOpenAt(centerOf(plain.pos!))).toBeNull();
    expect(view.subgraphToOpenAt({ x: -500, y: -500 })).toBeNull();
  });

  it('reports nothing while the preference is off', () => {
    const model = modelOf(DASHBOARD_FLOW);
    const view = createView();
    view.doubleClickOpensSubgraph = false;
    view.setModel(model);

    const host = model.nodes.find((candidate) => candidate.name === 'Handle Logout Button')!;
    expect(view.subgraphToOpenAt(centerOf(host.pos!))).toBeNull();
  });

  it('reaches a subgraph node nested inside an unfolded frame', () => {
    const model = modelOf(NESTED_FLOW);
    const expansions = createExpansionLayer();
    const view = createView(expansions);
    view.setModel(model);

    const host = model.nodes.find((candidate) => candidate.name === 'Host')!;
    expansions.restoreOpen([host.id!]);
    expansions.layout(model, performance.now());
    expansions.collectLoci(model);

    const expansion = model.display!.expansions.get(host)!;
    const inner = expansion.subModel.nodes.find((candidate) => candidate.name === 'Inner Subgraph')!;
    const innerCenter = centerOf(inner.pos!);
    const { scale, tx, ty } = expansion.transform;

    expect(view.subgraphToOpenAt({ x: innerCenter.x * scale + tx, y: innerCenter.y * scale + ty })).toBe(inner);
  });
});
