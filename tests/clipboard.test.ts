// Region-aware clipboard: copy, cut, paste and duplicate for nodes and context blocks, with
// member remapping, name uniquification, and paste into a `graph:` scope.

import { describe, expect, it, vi } from 'vitest';
import { getProp, parseFlow, serializeFlow, type ContextBlock, type FlowDocument, type FlowNode } from '../src/shared/flow-format.js';
import { assignMissingIds, allContextBlocks, buildModel, contextBlockNamed, nodesIn, allNodes } from '../src/client/flow-doc.js';
import type { DocumentOwner } from '../src/client/canvas/expansion.js';
import type { RegionTarget } from '../src/client/canvas/canvas-view.js';
import type { DrawingSelection } from '../src/client/canvas/drawing-selection.js';
import { createClipboard, type Clipboard, type ClipboardOptions, type PastePlacement } from '../src/client/clipboard.js';
import {
  applyCapturedVisuals,
  applyRegionVisuals,
  captureRegionVisuals,
  captureVisuals,
  documentIdentities,
  emptyCanvasLayer,
  nodeShapeOf,
  setNodeShape,
  type CanvasLayer,
} from '../src/shared/canvas-layer.js';
import { edgeStyleOf, setEdgeStyle } from '../src/shared/canvas-edge-style.js';
import { regionStyleOf, setRegionStyle } from '../src/shared/canvas-region-style.js';

// An edge's colour reads and writes alike whatever its kind, so these tests treat every edge as a
// flow edge.
function setEdgeColor(layer: CanvasLayer, edgeKey: string, color: string | null): void {
  setEdgeStyle(layer, edgeKey, { color }, 'flow');
}

function edgeColorOf(layer: CanvasLayer | null, edgeKey: string | null): string | null {
  return edgeStyleOf(layer, edgeKey, 'flow').color;
}

const MAIN = `---
name: Main
---

context: Auth
  pos: 0, 0, 800, 600
  nodes:
    - Login

context: Cart
  pos: 900, 0, 400, 300
  nodes:

Login
  id: l-1
  pos: 200, 200, 200, 88

Checkout
  id: c-1
  pos: 1000, 100, 200, 88
`;

const SCOPED = `---
name: Main
---

context: Auth
  pos: 0, 0, 800, 600
  nodes:

graph: Steps
  Login
    id: l-1
    pos: 200, 200, 200, 88
`;

// For the tests about nodes and regions: no strokes are ever selected.
const withoutDrawings = {
  selectedDrawings: () => [],
  copyDrawings: () => [],
  copyDrawingsInScope: () => ({ drawings: [], groups: [] }),
  pasteDrawings: () => [],
  runAction: (body: () => void) => body(),
  notify: () => {},
} satisfies Partial<ClipboardOptions>;

const KEYBOARD_POINTER = { x: 0, y: 0 };

// Pastes into `owner`'s graph `scope`: from the keyboard, or from the canvas menu at `point`.
function pasteInto(clipboard: Clipboard, owner: DocumentOwner, scope: string | null = null, point?: { x: number; y: number }): void {
  const placement: PastePlacement = point ? 'at-point' : 'beside-originals';
  clipboard.paste({ target: { owner, scope }, point: point ?? KEYBOARD_POINTER, placement });
}

interface Harness {
  doc: FlowDocument;
  clipboard: Clipboard;
  paste: (scope?: string | null, point?: { x: number; y: number }) => void;
  options: {
    select: ReturnType<typeof vi.fn>;
    deleteSelection: ReturnType<typeof vi.fn>;
    applyToDoc: ReturnType<typeof vi.fn>;
  };
  nodeNamed: (name: string) => FlowNode;
  regionNamed: (name: string) => ContextBlock;
  blocksIn: () => ContextBlock[];
  setSelection: (nodes: FlowNode[], regions: ContextBlock[]) => void;
}

function harnessFor(text: string): Harness {
  const doc = parseFlow(text);
  assignMissingIds(doc);
  const owner: DocumentOwner = { doc, path: 'main.flow' };
  let selection: FlowNode[] = [];
  let selectedRegions: RegionTarget[] = [];
  const options = {
    select: vi.fn(),
    deleteSelection: vi.fn(),
    applyToDoc: vi.fn((_owner: DocumentOwner, mutation: () => void) => mutation()),
  };
  const clipboard = createClipboard({
    selection: () => selection,
    selectedRegions: () => selectedRegions,
    select: (nodes, regions) => options.select(nodes, regions),
    ownerOf: () => owner,
    ownerOfRegion: () => owner,
    documentAt: (path) => (path === 'main.flow' ? doc : null),
    applyToDoc: (target, mutation) => options.applyToDoc(target, mutation),
    deleteSelection: () => options.deleteSelection(),
    captureVisuals: () => null,
    applyCapturedVisuals: () => {},
    captureRegionVisuals: () => null,
    applyRegionVisuals: () => {},
    ...withoutDrawings,
  } satisfies ClipboardOptions);
  const setSelection = (nodes: FlowNode[], regions: ContextBlock[]) => {
    selection = nodes;
    selectedRegions = regions.map((block) => ({ block, doc, path: 'main.flow' }));
  };
  return {
    doc,
    clipboard,
    paste: (scope = null, point) => pasteInto(clipboard, owner, scope, point),
    options,
    nodeNamed: (name) => allNodes(doc).find((node) => node.name === name)!,
    regionNamed: (name) => contextBlockNamed(doc, name)!,
    blocksIn: () => allContextBlocks(doc),
    setSelection,
  };
}

function textOf(doc: FlowDocument): string {
  return serializeFlow(doc);
}

describe('clipboard with regions', () => {
  it('copies and pastes a region with remapped members next to its nodes', () => {
    const harness = harnessFor(MAIN);
    harness.setSelection(
      [harness.nodeNamed('Login')],
      [harness.regionNamed('Auth')],
    );
    harness.clipboard.copy();
    harness.paste();

    const names = harness.blocksIn().map((block) => block.name);
    expect(names).toContain('Auth 2');
    const pasted = harness.blocksIn().find((block) => block.name === 'Auth 2')!;
    expect(pasted.pos).toEqual({ x: 24, y: 24, w: 800, h: 600 });
    expect(pasted.members).toEqual(['Login 2']);
    expect(harness.options.select).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'Login 2' })]),
      [pasted],
    );
  });

  it('steps each repeated paste further from the originals, starting over on a new copy', () => {
    const harness = harnessFor(MAIN);
    harness.setSelection([harness.nodeNamed('Login')], []);
    harness.clipboard.copy();
    harness.paste();
    harness.paste();
    expect(harness.nodeNamed('Login 2').pos).toEqual({ x: 224, y: 224, w: 200, h: 88 });
    expect(harness.nodeNamed('Login 3').pos).toEqual({ x: 248, y: 248, w: 200, h: 88 });

    harness.clipboard.copy();
    harness.paste();
    expect(harness.nodeNamed('Login 4').pos).toEqual({ x: 224, y: 224, w: 200, h: 88 });
  });

  it('pastes a region whose members were not copied as empty', () => {
    const harness = harnessFor(MAIN);
    harness.setSelection([], [harness.regionNamed('Cart')]);
    harness.clipboard.copy();
    harness.paste();

    const pasted = harness.blocksIn().find((block) => block.name === 'Cart 2')!;
    expect(pasted.members).toEqual([]);
  });

  it('pastes regions into an open graph scope', () => {
    const harness = harnessFor(SCOPED);
    harness.setSelection([], [harness.regionNamed('Auth')]);
    harness.clipboard.copy();
    harness.paste('Steps');

    expect(harness.blocksIn().map((block) => block.name)).toEqual(['Auth', 'Auth 2']);
    const graph = harness.doc.items.find((item) => item.kind === 'graph');
    expect(graph && graph.kind === 'graph' ? graph.items[0] : null).toMatchObject({
      kind: 'context',
      block: expect.objectContaining({ name: 'Auth 2' }),
    });
  });

  it('pastes from the keyboard into another graph at the pointer, stepping on with each repeat', () => {
    const harness = harnessFor(SCOPED);
    harness.setSelection([harness.nodeNamed('Login')], []);
    harness.clipboard.copy();
    const target = { owner: { doc: harness.doc, path: 'main.flow' }, scope: null };
    harness.clipboard.paste({ target, point: { x: 500, y: 100 }, placement: 'beside-originals' });
    harness.clipboard.paste({ target, point: { x: 500, y: 100 }, placement: 'beside-originals' });

    const topLevel = nodesIn(harness.doc.items);
    expect(topLevel.map((node) => node.pos)).toEqual([
      { x: 500, y: 100, w: 200, h: 88 },
      { x: 524, y: 124, w: 200, h: 88 },
    ]);
  });

  it('writes a graph block an expand names but nobody has written yet, to paste into', () => {
    const harness = harnessFor(MAIN);
    harness.setSelection([harness.nodeNamed('Checkout')], []);
    harness.clipboard.copy();
    harness.paste('Fresh', { x: 0, y: 0 });

    const fresh = harness.doc.items.find((item) => item.kind === 'graph' && item.name === 'Fresh');
    expect(fresh && fresh.kind === 'graph' ? nodesIn(fresh.items).map((node) => node.name) : null).toEqual(['Checkout']);
  });

  it("points a pasted node's updates at the region copied with it", () => {
    const harness = harnessFor(MAIN.replace('  pos: 200, 200, 200, 88', '  pos: 200, 200, 200, 88\n  updates: [Auth]'));
    harness.setSelection([harness.nodeNamed('Login')], [harness.regionNamed('Auth')]);
    harness.clipboard.copy();
    harness.paste();

    expect(getProp(harness.nodeNamed('Login 2'), 'updates')).toBe('[Auth 2]');
    expect(getProp(harness.nodeNamed('Login'), 'updates')).toBe('[Auth]');
  });

  it('duplicates a mixed selection as one cluster with remapped membership', () => {
    const harness = harnessFor(MAIN);
    harness.setSelection(
      [harness.nodeNamed('Login')],
      [harness.regionNamed('Auth')],
    );
    harness.clipboard.duplicateSelection();

    const pasted = harness.blocksIn().find((block) => block.name === 'Auth 2')!;
    expect(pasted.members).toEqual(['Login 2']);
    expect(harness.nodeNamed('Login 2').pos).toEqual({ x: 224, y: 224, w: 200, h: 88 });
    expect(harness.options.select).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'Login 2' })]),
      [pasted],
    );
  });

  it('cut copies and deletes the whole selection, regions included', () => {
    const harness = harnessFor(MAIN);
    harness.setSelection(
      [harness.nodeNamed('Checkout')],
      [harness.regionNamed('Cart')],
    );
    harness.clipboard.cut();

    expect(harness.options.deleteSelection).toHaveBeenCalled();
    expect(harness.clipboard.hasContent()).toBe(true);
  });

  it('hasContent is true for a region-only clipboard and paste works into the same doc', () => {
    const harness = harnessFor(MAIN);
    harness.setSelection([], [harness.regionNamed('Auth')]);
    harness.clipboard.copy();
    expect(harness.clipboard.hasContent()).toBe(true);
    harness.paste(null, { x: 500, y: 500 });
    const pasted = harness.blocksIn().find((block) => block.name === 'Auth 2')!;
    expect(pasted.pos).toEqual({ x: 500, y: 500, w: 800, h: 600 });
  });

  it('keeps the serialized file valid after pasting a region', () => {
    const harness = harnessFor(MAIN);
    harness.setSelection(
      [harness.nodeNamed('Login')],
      [harness.regionNamed('Auth')],
    );
    harness.clipboard.copy();
    harness.paste();
    const reparsed = parseFlow(textOf(harness.doc));
    expect(contextBlockNamed(reparsed, 'Auth 2')).toBeTruthy();
    expect(nodesIn(reparsed.items).map((node) => node.name)).toContain('Login 2');
  });
});

describe('clipboard and the canvas layer', () => {
  const SOURCE = `---\nname: Main\n---\n\ncontext: Auth\n  pos: -20, -20, 540, 128\n  nodes: Ask, Answer\n\nAsk\n  id: ask-1\n  pos: 0, 0, 200, 88\n  -> Answer : "yes"\n\nAnswer\n  id: answer-1\n  pos: 300, 0, 200, 88\n`;

  function visualHarness() {
    const doc = parseFlow(SOURCE);
    const owner: DocumentOwner = { doc, path: 'main.flow' };
    const layer = emptyCanvasLayer();
    setNodeShape(layer, 'ask-1', 'diamond');
    setEdgeColor(layer, documentIdentities(doc).edgeKeys.get(allNodes(doc)[0].edges[0])!, 'green');
    setRegionStyle(layer, 'Auth', { color: 'purple', fill: 'dots' });
    let selection: FlowNode[] = [];
    let selectedRegions: RegionTarget[] = [];
    const clipboard = createClipboard({
      selection: () => selection,
      selectedRegions: () => selectedRegions,
      select: () => {},
      ownerOf: () => owner,
      ownerOfRegion: () => owner,
      documentAt: () => doc,
      applyToDoc: (_owner, mutation) => mutation(),
      deleteSelection: () => {},
      captureVisuals: (from, nodes) => captureVisuals(layer, documentIdentities(from.doc), nodes),
      applyCapturedVisuals: (to, copies, visuals) => {
        if (visuals) applyCapturedVisuals(layer, documentIdentities(to.doc), copies, visuals);
      },
      captureRegionVisuals: (_from, regions) => captureRegionVisuals(layer, regions),
      applyRegionVisuals: (_to, copies, visuals) => {
        if (visuals) applyRegionVisuals(layer, copies, visuals);
      },
      ...withoutDrawings,
    } satisfies ClipboardOptions);
    const select = (names: string[], regionNames: string[] = []) => {
      selection = names.map((name) => allNodes(doc).find((node) => node.name === name)!);
      selectedRegions = regionNames.map((name) => ({ block: contextBlockNamed(doc, name)!, doc, path: 'main.flow' }));
    };
    return { doc, layer, clipboard: { ...clipboard, paste: () => pasteInto(clipboard, owner) }, select };
  }

  function regionCopiesOf(doc: FlowDocument, sourceName: string): ContextBlock[] {
    return allContextBlocks(doc).filter((block) => block.name !== sourceName && block.name.startsWith(sourceName));
  }

  function copiesOf(doc: FlowDocument, sourceName: string): FlowNode[] {
    return allNodes(doc).filter((node) => node.name !== sourceName && node.name.startsWith(sourceName));
  }

  it('pastes copies wearing their sources\' shapes and edge colours', () => {
    const { doc, layer, clipboard, select } = visualHarness();
    select(['Ask', 'Answer']);
    clipboard.copy();
    clipboard.paste();
    const [askCopy] = copiesOf(doc, 'Ask');
    expect(nodeShapeOf(layer, askCopy.id)).toBe('diamond');
    expect(edgeColorOf(layer, documentIdentities(doc).edgeKeys.get(askCopy.edges[0])!)).toBe('green');
  });

  it("pastes a region copy wearing its source's colour and background", () => {
    const { doc, layer, clipboard, select } = visualHarness();
    select(['Ask', 'Answer'], ['Auth']);
    clipboard.copy();
    clipboard.paste();
    const [authCopy] = regionCopiesOf(doc, 'Auth');
    expect(regionStyleOf(layer, authCopy.name)).toEqual({ color: 'purple', fillColor: null, fill: 'dots' });
  });

  it("carries a region's look through a duplicate of the region alone", () => {
    const { doc, layer, clipboard, select } = visualHarness();
    select([], ['Auth']);
    clipboard.duplicateSelection();
    const [authCopy] = regionCopiesOf(doc, 'Auth');
    expect(regionStyleOf(layer, authCopy.name).color).toBe('purple');
  });

  it('carries visuals through a duplicate', () => {
    const { doc, layer, clipboard, select } = visualHarness();
    select(['Ask']);
    clipboard.duplicateSelection();
    const [askCopy] = copiesOf(doc, 'Ask');
    expect(nodeShapeOf(layer, askCopy.id)).toBe('diamond');
    // The copy's edge still points at the original Answer, under its own key.
    expect(edgeColorOf(layer, documentIdentities(doc).edgeKeys.get(askCopy.edges[0])!)).toBe('green');
  });
});

describe('clipboard and strokes', () => {
  const carried = { drawings: [{ id: 's', kind: 'stroke', points: [[10, 20], [30, 40]] }], groups: [] };

  function strokeHarness() {
    const doc = parseFlow(MAIN);
    assignMissingIds(doc);
    const owner: DocumentOwner = { doc, path: 'main.flow' };
    const model = buildModel(doc, null);
    const selectedDrawings: DrawingSelection[] = [{ model, id: 's' }];
    const deletions: string[] = [];
    let openActions = 0;
    const pasteDrawings = vi.fn((target: { owner: DocumentOwner; scope: string | null }) => [
      { path: target.owner.path, scope: target.scope, id: 'copy' },
    ]);
    const select = vi.fn();
    const clipboard = createClipboard({
      selection: () => [],
      selectedRegions: () => [],
      selectedDrawings: () => selectedDrawings,
      select,
      ownerOf: () => owner,
      ownerOfRegion: () => owner,
      documentAt: () => doc,
      applyToDoc: (_owner, mutation) => mutation(),
      deleteSelection: () => deletions.push(openActions > 0 ? 'inside an action' : 'alone'),
      captureVisuals: () => null,
      applyCapturedVisuals: () => {},
      captureRegionVisuals: () => null,
      applyRegionVisuals: () => {},
      copyDrawings: () => [{ owner, scope: null, carried }],
      copyDrawingsInScope: () => ({ drawings: [], groups: [] }),
      pasteDrawings,
      runAction: (body) => {
        openActions += 1;
        body();
        openActions -= 1;
      },
      notify: () => {},
    } satisfies ClipboardOptions);
    return { owner, clipboard, deletions, pasteDrawings, select };
  }

  it('cuts strokes as one action, and pastes them back under the pointer, selected', () => {
    const { owner, clipboard, deletions, pasteDrawings, select } = strokeHarness();
    clipboard.cut();
    expect(deletions).toEqual(['inside an action']);
    expect(clipboard.hasContent()).toBe(true);

    pasteInto(clipboard, owner, null, { x: 110, y: 120 });
    expect(pasteDrawings).toHaveBeenCalledWith({ owner, scope: null }, carried, { x: 100, y: 100 });
    expect(select).toHaveBeenCalledWith([], [], [{ path: 'main.flow', scope: null, id: 'copy' }]);
  });

  it('duplicates strokes a step away from themselves', () => {
    const { owner, clipboard, pasteDrawings, select } = strokeHarness();
    clipboard.duplicateSelection();
    expect(pasteDrawings).toHaveBeenCalledWith({ owner, scope: null }, carried, { x: 24, y: 24 });
    expect(select).toHaveBeenCalledWith([], [], [{ path: 'main.flow', scope: null, id: 'copy' }]);
  });
});
