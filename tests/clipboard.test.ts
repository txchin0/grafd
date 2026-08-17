// Region-aware clipboard: copy, cut, paste and duplicate for nodes and context blocks, with
// member remapping, name uniquification, and the scoped-paste guard.

import { describe, expect, it, vi } from 'vitest';
import { parseFlow, serializeFlow, type ContextBlock, type FlowDocument, type FlowNode } from '../src/shared/flow-format.js';
import { assignMissingIds, contextBlockNamed, nodesIn, allNodes } from '../src/client/flow-doc.js';
import type { DocumentOwner } from '../src/client/canvas/expansion.js';
import type { RegionTarget } from '../src/client/canvas/canvas-view.js';
import type { OpenFlow } from '../src/client/open-flow.js';
import { createClipboard, type Clipboard, type ClipboardOptions } from '../src/client/clipboard.js';

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

interface Harness {
  doc: FlowDocument;
  clipboard: Clipboard;
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

function harnessFor(text: string, flowOverride?: Partial<OpenFlow>, documentResolvable = true): Harness {
  const doc = parseFlow(text);
  assignMissingIds(doc);
  const owner: DocumentOwner = { doc, path: 'main.flow' };
  const flow: OpenFlow = {
    doc,
    path: 'main.flow',
    scope: null,
    model: { nodes: [], edges: [], ghosts: [], contexts: [], nodesByName: new Map(), traits: new Map(), sourceDoc: doc, sourcePath: 'main.flow', sourceScope: null },
    ...flowOverride,
  };
  let selection: FlowNode[] = [];
  let selectedRegions: RegionTarget[] = [];
  const options = {
    select: vi.fn(),
    deleteSelection: vi.fn(),
    applyToDoc: vi.fn((_owner: DocumentOwner, mutation: () => void) => mutation()),
  };
  const clipboard = createClipboard({
    openFlow: () => flow,
    selection: () => selection,
    selectedRegions: () => selectedRegions,
    select: (nodes, regions) => options.select(nodes, regions),
    ownerOf: () => owner,
    ownerOfRegion: () => owner,
    documentAt: (path) => (documentResolvable && path === 'main.flow' ? owner : null),
    applyToDoc: (target, mutation) => options.applyToDoc(target, mutation),
    deleteSelection: () => options.deleteSelection(),
  } satisfies ClipboardOptions);
  const setSelection = (nodes: FlowNode[], regions: ContextBlock[]) => {
    selection = nodes;
    selectedRegions = regions.map((block) => ({ block, doc, path: 'main.flow' }));
  };
  return {
    doc,
    clipboard,
    options,
    nodeNamed: (name) => allNodes(doc).find((node) => node.name === name)!,
    regionNamed: (name) => contextBlockNamed(doc, name)!,
    blocksIn: () => doc.items.filter((item): item is { kind: 'context'; block: ContextBlock } => item.kind === 'context').map((item) => item.block),
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
    harness.clipboard.paste();

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

  it('pastes a region whose members were not copied as empty', () => {
    const harness = harnessFor(MAIN);
    harness.setSelection([], [harness.regionNamed('Cart')]);
    harness.clipboard.copy();
    harness.clipboard.paste();

    const pasted = harness.blocksIn().find((block) => block.name === 'Cart 2')!;
    expect(pasted.members).toEqual([]);
  });

  it('does not paste regions into an open graph scope', () => {
    // The region's document is no longer loaded, so paste falls back to the open flow — which
    // is scoped to a graph block. The nodes land in the scope; the region is dropped rather
    // than written into graph items (R5/R45).
    const harness = harnessFor(SCOPED, { scope: 'Steps' }, false);
    harness.setSelection([], [harness.regionNamed('Auth')]);
    harness.clipboard.copy();
    harness.clipboard.paste();

    expect(harness.blocksIn()).toHaveLength(1);
    expect(harness.blocksIn().map((block) => block.name)).toEqual(['Auth']);
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
    harness.clipboard.paste({ x: 500, y: 500 });
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
    harness.clipboard.paste();
    const reparsed = parseFlow(textOf(harness.doc));
    expect(contextBlockNamed(reparsed, 'Auth 2')).toBeTruthy();
    expect(nodesIn(reparsed.items).map((node) => node.name)).toContain('Login 2');
  });
});
