import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { allNodes, buildModel } from '../src/client/flow-doc.js';
import { ExpansionLayer } from '../src/client/expansion.js';
import {
  backOutAnchorFor,
  divePathTo,
  type DiveNavigationContext,
} from '../src/client/dive-navigation.js';
import type { FlowModel } from '../src/client/flow-doc.js';
import type { View } from '../src/client/canvas-view.js';
import { createCanvasMock, stubCanvasGlobals } from './canvas-mock.js';

const NESTED_FLOW = `graph: Deep
  Leaf
    id: leaf-1
    pos: 0, 0, 200, 88

graph: Sub
  Middle
    id: middle-1
    pos: 100, 100, 200, 88
    expand: Deep

Host
  id: host-1
  pos: 200, 100, 200, 88
  expand: Sub
`;

let CanvasView: typeof import('../src/client/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas-view.js'));
  vi.spyOn(CanvasView.prototype, 'requestRender').mockImplementation(() => {});
});

function nestedScene() {
  const layer = new ExpansionLayer({
    onNeedsRender: vi.fn(),
    readExternalFile: vi.fn(async () => null),
  });
  const doc = parseFlow(NESTED_FLOW);
  const model = buildModel(doc, null);
  model.sourcePath = 'nested.flow';
  const host = allNodes(doc).find((node) => node.name === 'Host')!;
  const middle = allNodes(doc).find((node) => node.name === 'Middle')!;
  layer.restoreOpen([host.id!, middle.id!]);
  layer.layout(model, performance.now());
  layer.collectLoci(model);

  const canvas = createCanvasMock();
  const canvasView = new CanvasView(canvas, {} as unknown as ConstructorParameters<typeof CanvasView>[1]);
  canvasView.expansionLayer = layer;

  const liveView: View = { x: 40, y: -20, scale: 1.25 };
  const ctx: DiveNavigationContext = {
    path: 'nested.flow',
    scope: null,
    doc,
    model,
    liveView,
    fitViewForModel: (flowModel) => canvasView.fitViewForModel(flowModel),
    ancestorHosts: (node) => layer.ancestorHosts(node),
    modelOf: (node) => layer.modelOf(node),
    documentAt: (path) => layer.documentAt(path),
  };

  return { layer, doc, model, host, middle, ctx, canvasView };
}

describe('divePathTo', () => {
  it('synthesizes one trail entry per skipped frame level and lands on the target graph', () => {
    const { ctx, host, middle } = nestedScene();

    const dive = divePathTo(ctx, middle)!;

    expect(dive.entries).toHaveLength(2);
    expect(dive.entries[0]).toMatchObject({ path: 'nested.flow', scope: null, nodeId: host.id });
    expect(dive.entries[0].view).toEqual(ctx.liveView);
    expect(dive.entries[1]).toMatchObject({ path: 'nested.flow', scope: 'Sub', nodeId: middle.id });
    expect(dive.destination).toEqual({ path: 'nested.flow', scope: 'Deep', link: null });
  });
});

describe('backOutAnchorFor', () => {
  it('uses the unfolded frame transform for a single-step back into a scoped graph', () => {
    const { layer, doc, ctx, middle } = nestedScene();
    const dive = divePathTo(ctx, middle)!;
    const deepModel = buildModel(doc, 'Deep');
    deepModel.sourcePath = 'nested.flow';
    const subModel = buildModel(doc, 'Sub');
    subModel.sourcePath = 'nested.flow';
    layer.layout(subModel, performance.now());
    layer.collectLoci(subModel);

    const subCtx: DiveNavigationContext = { ...ctx, scope: 'Sub', model: subModel };
    const anchor = backOutAnchorFor(subCtx, [dive.entries[1]], deepModel)!;

    expect(anchor.transform).toEqual(subModel.display!.expansions.get(middle)!.transform);
  });

  it('composes every dropped crumb into the same placement a nested dive started from', () => {
    const { layer, doc, ctx, middle } = nestedScene();
    const dive = divePathTo(ctx, middle)!;
    const deepModel = buildModel(doc, 'Deep') as FlowModel;
    deepModel.sourcePath = 'nested.flow';

    const anchor = backOutAnchorFor(ctx, dive.entries, deepModel)!;
    const onScreen = layer.diveAnchor(middle)!;

    expect(anchor.transform).toEqual(onScreen.transform);
    expect(anchor.rect).toEqual(onScreen.frame);
  });
});
