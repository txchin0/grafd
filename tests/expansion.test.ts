import { describe, expect, it, vi } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { allNodes, buildModel } from '../src/client/flow-doc.js';
import {
  ExpansionLayer,
  pairMobility,
  ripplePush,
  separationVector,
  subModelBounds,
} from '../src/client/expansion.js';

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
});
