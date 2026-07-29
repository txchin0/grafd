import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlow } from '../src/shared/flow-format.js';
import { allNodes, buildModel } from '../src/client/flow-doc.js';
import type { Rect } from '../src/shared/flow-format.js';
import {
  composeTransforms,
  ExpansionLayer,
  inverseTransformPoint,
  inverseTransformRect,
  pairMobility,
  ripplePush,
  separationVector,
  subModelBounds,
  TOGGLE_DURATION_MS,
  transformRect,
} from '../src/client/canvas/expansion.js';

const DASHBOARD_FLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../flows/dashboard.flow'),
  'utf8',
);

// Two levels of expansion in one document: Host unfolds `Sub`, whose Middle node unfolds
// `Deep` — the shape a dive from inside a frame has to navigate.
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

function rectCenter(rect: Rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function topLeftInside(rect: Rect) {
  return { x: rect.x + 1, y: rect.y + 1 };
}

function contains(rect: Rect, point: { x: number; y: number }) {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

describe('transformRect', () => {
  it('maps a local rect through a frame transform', () => {
    expect(transformRect({ x: 10, y: 20, w: 100, h: 50 }, { scale: 0.5, tx: 40, ty: 60 })).toEqual({
      x: 45,
      y: 70,
      w: 50,
      h: 25,
    });
  });
});

describe('separationVector', () => {
  it('returns null when rects are clear of each other', () => {
    expect(separationVector({ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 0, w: 100, h: 100 }, 0)).toBeNull();
  });

  it('pushes along the axis of least penetration', () => {
    const push = separationVector({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 0, w: 100, h: 100 }, 0)!;
    expect(push).toEqual({ dx: 50, dy: 0 });
  });

  it('honors the margin', () => {
    const push = separationVector({ x: 0, y: 0, w: 100, h: 100 }, { x: 120, y: 0, w: 100, h: 100 }, 40);
    expect(push).toEqual({ dx: 20, dy: 0 });
  });
});

describe('pairMobility', () => {
  it('frames are immovable against plain nodes and split evenly otherwise', () => {
    expect(pairMobility(false, false)).toEqual([0.5, 0.5]);
    expect(pairMobility(true, true)).toEqual([0.5, 0.5]);
    expect(pairMobility(true, false)).toEqual([0, 1]);
    expect(pairMobility(false, true)).toEqual([1, 0]);
  });
});

describe('ripplePush', () => {
  it('does not push while the frame is at its resting size', () => {
    const rect = { x: 0, y: 0, w: 100, h: 100 };
    expect(ripplePush(rect, rect, { x: 300, y: 0, w: 100, h: 100 })).toEqual({ dx: 0, dy: 0 });
  });

  it('pushes a neighbor away from a grown frame, decaying with distance', () => {
    const hostBase = { x: 0, y: 0, w: 100, h: 100 };
    const frame = { x: -50, y: -50, w: 200, h: 200 };
    const near = ripplePush(hostBase, frame, { x: 200, y: 0, w: 100, h: 100 });
    const far = ripplePush(hostBase, frame, { x: 600, y: 0, w: 100, h: 100 });
    expect(near.dx).toBeGreaterThan(0);
    expect(near.dy).toBeCloseTo(0);
    expect(far.dx).toBeGreaterThan(0);
    expect(far.dx).toBeLessThan(near.dx);
  });
});

describe('subModelBounds', () => {
  it('falls back to a default size for an empty subgraph', () => {
    const doc = parseFlow('');
    const bounds = subModelBounds(buildModel(doc, null));
    expect(bounds).toEqual({ x: 0, y: 0, w: 320, h: 180 });
  });

  it('wraps node rects with a content margin', () => {
    const doc = parseFlow('A\n  pos: 100, 100, 200, 88\n');
    const bounds = subModelBounds(buildModel(doc, null));
    expect(bounds).toEqual({ x: 64, y: 64, w: 272, h: 160 });
  });
});

describe('ExpansionLayer', () => {
  function layerWithSpy() {
    const onNeedsRender = vi.fn();
    const readExternalFile = vi.fn(async () => null);
    return { layer: new ExpansionLayer({ onNeedsRender, readExternalFile }), onNeedsRender };
  }

  it('toggles a node open and closed', () => {
    const { layer, onNeedsRender } = layerWithSpy();
    const doc = parseFlow('A\n  id: node-1\n  expand: Sub\n');
    const [node] = allNodes(doc);
    expect(layer.isOpen(node.id)).toBe(false);
    layer.toggle(node);
    expect(layer.isOpen(node.id)).toBe(true);
    layer.toggle(node);
    expect(layer.isOpen(node.id)).toBe(false);
    expect(onNeedsRender).toHaveBeenCalledTimes(2);
  });

  it('restoreOpen seeds ids as fully open', () => {
    const { layer, onNeedsRender } = layerWithSpy();
    expect(layer.isOpen('a')).toBe(false);
    layer.restoreOpen(['a', 'b']);
    expect(layer.isOpen('a')).toBe(true);
    expect(layer.isOpen('b')).toBe(true);
    expect(onNeedsRender).toHaveBeenCalledTimes(1);
  });

  it('openVisibleNodeIds reports open loci only', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow('A\n  id: node-1\n  expand: Sub\nB\n  id: node-2\n');
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    layer.restoreOpen(['node-1']);
    layer.layout(model, performance.now());
    layer.collectLoci(model);
    expect(layer.openVisibleNodeIds()).toEqual(['node-1']);
  });

  it('ignores toggles for nodes without an id and null ids', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow('A\n');
    layer.toggle(allNodes(doc)[0]);
    expect(layer.isOpen(null)).toBe(false);
  });

  it('adopts external documents and finds their nodes', () => {
    const { layer, onNeedsRender } = layerWithSpy();
    expect(layer.watchesPath('sub.flow')).toBe(false);
    layer.adoptExternalText('sub.flow', 'Inner\n  id: inner-1\n');
    expect(layer.watchesPath('sub.flow')).toBe(true);
    const found = layer.findNodeById('inner-1');
    expect(found?.name).toBe('Inner');
    expect(layer.ownerOf(found!)?.path).toBe('sub.flow');
    expect(layer.documentAt('sub.flow')).toBe(layer.ownerOf(found!)!.doc);
    expect(onNeedsRender).toHaveBeenCalled();
  });

  it('ensureDocument resolves once the fetch completes', async () => {
    const onNeedsRender = vi.fn();
    const readExternalFile = vi.fn(async () => '---\nname: Dash\ndescription: "hi"\n---\n');
    const layer = new ExpansionLayer({ onNeedsRender, readExternalFile });
    const doc = await layer.ensureDocument('dashboard.flow');
    expect(doc).not.toBeNull();
    expect(layer.documentAt('dashboard.flow')).toBe(doc);
  });

  it('adoptDocument stores the same object and invalidates sub-models', () => {
    const { layer } = layerWithSpy();
    const hostDoc = parseFlow('Host\n  id: host\n  pos: 0, 0, 120, 80\n  expand: [X](sub.flow)\n');
    const firstSub = parseFlow('First\n  id: first\n  pos: 0, 0, 100, 80\n');
    const secondSub = parseFlow('Second\n  id: second\n  pos: 0, 0, 100, 80\n');
    layer.adoptDocument('sub.flow', firstSub);
    expect(layer.documentAt('sub.flow')).toBe(firstSub);

    const host = allNodes(hostDoc)[0];
    const model = buildModel(hostDoc, null);
    model.sourceDoc = hostDoc;
    model.sourcePath = 'main.flow';
    layer.toggle(host);
    layer.layout(model, performance.now());
    expect(layer.findNodeById('first')?.name).toBe('First');

    layer.adoptDocument('sub.flow', secondSub);
    expect(layer.documentAt('sub.flow')).toBe(secondSub);
    layer.layout(model, performance.now() + 1000);
    expect(layer.findNodeById('first')).toBeNull();
    expect(layer.findNodeById('second')?.name).toBe('Second');
  });

  it('does not claim ownership of foreign nodes', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow('A\n  id: a\n');
    expect(layer.ownerOf(allNodes(doc)[0])).toBeNull();
    expect(layer.findNodeById('a')).toBeNull();
  });

  it('rebuilds loci for a scoped graph after parent inline expansion', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(DASHBOARD_FLOW);
    const parentModel = buildModel(doc, null);
    parentModel.sourceDoc = doc;
    parentModel.sourcePath = 'dashboard.flow';

    const childModel = buildModel(doc, 'Logout Confirmation');
    childModel.sourceDoc = doc;
    childModel.sourcePath = 'dashboard.flow';

    const host = parentModel.nodes.find((node) => node.name === 'Handle Logout Button')!;
    const inner = childModel.nodes.find((node) => node.name === 'Show Confirmation Dialog')!;

    layer.restoreOpen([host.id!]);
    layer.layout(parentModel, performance.now());
    layer.collectLoci(parentModel);

    const embedded = layer.locusOf(inner)!;
    expect(layer.isEmbedded(inner)).toBe(true);
    expect(embedded.host).toBe(host);
    expect(embedded.model).not.toBe(childModel);

    layer.layout(childModel, performance.now());
    layer.collectLoci(childModel);

    const topLevel = layer.locusOf(inner)!;
    expect(layer.isEmbedded(inner)).toBe(false);
    expect(topLevel.model).toBe(childModel);
    expect(topLevel.host).toBeNull();
    expect(topLevel.transform).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it('reports the frame hosts a twice-nested node sits inside, outermost first', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(NESTED_FLOW);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    const [host, middle, leaf] = ['Host', 'Middle', 'Leaf'].map(
      (name) => allNodes(doc).find((node) => node.name === name)!,
    );

    layer.restoreOpen([host.id!, middle.id!]);
    layer.layout(model, performance.now());
    layer.collectLoci(model);

    expect(layer.ancestorHosts(host)).toEqual([]);
    expect(layer.ancestorHosts(middle)).toEqual([host]);
    expect(layer.ancestorHosts(leaf)).toEqual([host, middle]);
  });

  it('composes the dive anchor of a nested frame through its locus', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(NESTED_FLOW);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    const host = allNodes(doc).find((node) => node.name === 'Host')!;
    const middle = allNodes(doc).find((node) => node.name === 'Middle')!;

    layer.restoreOpen([host.id!, middle.id!]);
    layer.layout(model, performance.now());
    layer.collectLoci(model);

    const hostExpansion = model.display!.expansions.get(host)!;
    const middleExpansion = hostExpansion.subModel.display!.expansions.get(middle)!;
    const anchor = layer.diveAnchor(middle)!;

    expect(anchor.transform).toEqual(
      composeTransforms(hostExpansion.transform, middleExpansion.transform),
    );
    expect(anchor.frame).toEqual(
      transformRect(hostExpansion.subModel.display!.rects.get(middle)!, hostExpansion.transform),
    );
  });

  it('leaves a top-level dive anchor untransformed', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(NESTED_FLOW);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    const host = allNodes(doc).find((node) => node.name === 'Host')!;

    layer.restoreOpen([host.id!]);
    layer.layout(model, performance.now());
    layer.collectLoci(model);

    const expansion = model.display!.expansions.get(host)!;
    const anchor = layer.diveAnchor(host)!;
    expect(anchor.transform).toEqual(expansion.transform);
    expect(anchor.frame).toEqual(model.display!.rects.get(host));
  });

  it('has no dive anchor for a node that is not unfolded', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(NESTED_FLOW);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    const host = allNodes(doc).find((node) => node.name === 'Host')!;

    layer.layout(model, performance.now());
    layer.collectLoci(model);

    expect(layer.diveAnchor(host)).toBeNull();
  });

  it('resolves the innermost frame a world point falls in', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(NESTED_FLOW);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    model.sourcePath = 'nested.flow';
    const [host, middle] = ['Host', 'Middle'].map(
      (name) => allNodes(doc).find((node) => node.name === name)!,
    );

    layer.restoreOpen([host.id!, middle.id!]);
    layer.layout(model, performance.now());
    layer.collectLoci(model);

    const hostFrame = layer.frameFor(host)!;
    const middleFrame = layer.frameFor(middle)!;

    const cornerOfHostFrame = topLeftInside(hostFrame.interior);
    expect(contains(middleFrame.interior, cornerOfHostFrame)).toBe(false);

    expect(layer.frameAt(rectCenter(middleFrame.interior))!.host).toBe(middle);
    expect(layer.frameAt(cornerOfHostFrame)!.host).toBe(host);
    expect(layer.frameAt({ x: hostFrame.interior.x - 500, y: hostFrame.interior.y - 500 })).toBeNull();
  });

  it('names the graph block each frame writes into', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(NESTED_FLOW);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    model.sourcePath = 'nested.flow';
    const [host, middle] = ['Host', 'Middle'].map(
      (name) => allNodes(doc).find((node) => node.name === name)!,
    );

    layer.restoreOpen([host.id!, middle.id!]);
    layer.layout(model, performance.now());
    layer.collectLoci(model);

    expect(layer.frameFor(host)!.model.sourceScope).toBe('Sub');
    expect(layer.frameFor(host)!.model.sourcePath).toBe('nested.flow');
    expect(layer.frameFor(middle)!.model.sourceScope).toBe('Deep');
  });

  it('reports the scope of a graph block that has no body yet', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow('Host\n  id: host-1\n  pos: 0, 0, 200, 88\n  expand: Unwritten\n');
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    model.sourcePath = 'nested.flow';
    const host = allNodes(doc)[0];

    layer.restoreOpen([host.id!]);
    layer.layout(model, performance.now());
    layer.collectLoci(model);

    expect(layer.frameFor(host)!.model.sourceScope).toBe('Unwritten');
  });

  it('maps a point inside a frame back to subgraph coordinates', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(NESTED_FLOW);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    model.sourcePath = 'nested.flow';
    const host = allNodes(doc).find((node) => node.name === 'Host')!;

    layer.restoreOpen([host.id!]);
    layer.layout(model, performance.now());
    layer.collectLoci(model);

    const frame = layer.frameFor(host)!;
    const middle = frame.model.nodes.find((node) => node.name === 'Middle')!;
    const middleInWorld = transformRect(frame.model.display!.rects.get(middle) ?? middle.pos!, frame.transform);

    expect(inverseTransformRect(middleInWorld, frame.transform)).toEqual(middle.pos);
    expect(inverseTransformPoint(rectCenter(middleInWorld), frame.transform)).toEqual(rectCenter(middle.pos!));
  });

  it('leaves embedded loci stale when layout runs without collectLoci on the scoped graph', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(DASHBOARD_FLOW);
    const parentModel = buildModel(doc, null);
    parentModel.sourceDoc = doc;
    parentModel.sourcePath = 'dashboard.flow';

    const childModel = buildModel(doc, 'Logout Confirmation');
    childModel.sourceDoc = doc;

    const host = parentModel.nodes.find((node) => node.name === 'Handle Logout Button')!;
    const inner = childModel.nodes.find((node) => node.name === 'Show Confirmation Dialog')!;

    layer.restoreOpen([host.id!]);
    layer.layout(parentModel, performance.now());
    layer.collectLoci(parentModel);

    layer.layout(childModel, performance.now());

    const stale = layer.locusOf(inner)!;
    expect(stale.host).toBe(host);
    expect(stale.model).not.toBe(childModel);
  });
});

describe('collapseFrom', () => {
  function layerWithSpy() {
    const onNeedsRender = vi.fn();
    const readExternalFile = vi.fn(async () => null);
    return { layer: new ExpansionLayer({ onNeedsRender, readExternalFile }), onNeedsRender };
  }

  it('starts fully open and animating closed on the first layout pass', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(`graph: Sub
  Inner
    pos: 100, 100, 200, 88

Host
  id: host-1
  pos: 200, 150, 200, 88
  expand: Sub
`);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    const host = allNodes(doc).find((node) => node.name === 'Host')!;
    layer.collapseFrom(host);
    const now = performance.now();
    layer.layout(model, now);
    layer.collectLoci(model);
    const expansion = model.display!.expansions.get(host)!;
    expect(expansion.alpha).toBeCloseTo(1, 5);
    expect(layer.isOpen(host.id)).toBe(false);
    expect(layer.openVisibleNodeIds()).toEqual([]);
    const { animating } = layer.layout(model, now);
    expect(animating).toBe(true);
  });

  it('garbage-collects the entry after the toggle duration', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(`graph: Sub
  Inner
    pos: 100, 100, 200, 88

Host
  id: host-1
  pos: 200, 150, 200, 88
  expand: Sub
`);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    const host = allNodes(doc).find((node) => node.name === 'Host')!;
    layer.collapseFrom(host);
    const start = performance.now();
    layer.layout(model, start + TOGGLE_DURATION_MS);
    expect(model.display!.expansions.size).toBe(0);
  });

  it('maps frame-1 content at scale 1 with a 7px vertical offset for clusters within MAX_INNER_SIZE', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(`graph: Sub
  A
    pos: 100, 100, 200, 88
  B
    pos: 300, 100, 200, 88

Host
  id: host-1
  pos: 200, 100, 200, 88
  expand: Sub
`);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    const host = allNodes(doc).find((node) => node.name === 'Host')!;
    layer.collapseFrom(host);
    layer.layout(model, performance.now());
    const expansion = model.display!.expansions.get(host)!;
    expect(expansion.transform.scale).toBeCloseTo(1, 5);
    expect(expansion.transform.tx).toBeCloseTo(0, 5);
    expect(expansion.transform.ty).toBeCloseTo(7, 5);
  });
});

describe('discardToggle', () => {
  function layerWithSpy() {
    const onNeedsRender = vi.fn();
    const readExternalFile = vi.fn(async () => null);
    return { layer: new ExpansionLayer({ onNeedsRender, readExternalFile }), onNeedsRender };
  }

  it('removes an open expansion entry and cached sub-model immediately', () => {
    const { layer } = layerWithSpy();
    const doc = parseFlow(`graph: Sub
  Inner
    pos: 100, 100, 200, 88

Host
  id: host-1
  pos: 200, 150, 200, 88
  expand: Sub
`);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    const host = allNodes(doc).find((node) => node.name === 'Host')!;
    layer.toggle(host);
    layer.layout(model, performance.now());
    expect(layer.isOpen(host.id!)).toBe(true);
    layer.discardToggle(host.id!);
    expect(layer.isOpen(host.id!)).toBe(false);
    layer.layout(model, performance.now());
    expect(model.display!.expansions.size).toBe(0);
  });
});
