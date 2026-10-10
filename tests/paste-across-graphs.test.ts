// Pasting into a graph other than the one copied from, end to end through the editor core: the
// copy lands in the graph under the pointer — an unfolded frame or the canvas, in any file — and
// takes along what it needs to mean the same thing there.

import { afterEach, describe, expect, it } from 'vitest';
import { getProp, parseFlow, type FlowDocument, type FlowNode } from '../src/shared/flow-format.js';
import { allNodes, containingGraphBlockName, graphBlockNames, nodesIn, scopeItems } from '../src/client/flow-doc.js';
import type { Point } from '../src/client/geometry.js';
import type { Rect } from '../src/shared/flow-format.js';
import { canvasLayerPathOf, nodeShapeOf, parseCanvasLayer } from '../src/shared/canvas-layer.js';
import { createHeadlessEditor, disposeHeadlessEditor, type HeadlessEditor } from './editor-harness.js';

const MAIN = 'main.flow';
const EXTERNAL = 'sub/ext.flow';

const FLOW = `---
name: Main
---

Alpha
  id: alpha-1
  pos: 0, 0, 180, 80
  -> Delta

Delta
  id: delta-1
  pos: 400, 0, 180, 80
  expand: Delta

graph: Delta
  Inner
    id: inner-1
    pos: 0, 0, 160, 72
    -> Second

  Second
    id: second-1
    pos: 260, 0, 160, 72
`;

const LINKED_MAIN = `---
name: Main
---

Ext
  id: ext-1
  pos: 0, 0, 180, 80
  expand: [Ext](sub/ext.flow)

Other
  id: other-1
  pos: 400, 0, 180, 80
  expand: Local

graph: Local
  Taken
    id: taken-1
    pos: 0, 0, 160, 72
`;

const EXTERNAL_FLOW = `---
name: Ext
---

Host
  id: host-1
  pos: 0, 0, 160, 72
  expand: Local

Linked
  id: linked-1
  pos: 260, 0, 160, 72
  expand: [Far](far.flow)

Twin
  id: twin-1
  pos: 520, 0, 160, 72
  expand: Local

graph: Local
  Deep
    id: deep-1
    pos: 0, 0, 160, 72
`;

// The carried subgraph's look: Deep's shape, and a stroke drawn inside the block.
const EXTERNAL_LAYER = JSON.stringify({
  format: 'grafd-canvas/1',
  nodes: { 'deep-1': { shape: 'diamond' } },
  drawings: [{ id: 'deep-stroke', kind: 'stroke', graph: 'Local', width: 'thin', points: [[0, 100], [80, 120]] }],
});

const EMPTY_SPOT: Point = { x: 200, y: 400 };

afterEach(() => disposeHeadlessEditor());

function docOnDisk(editor: HeadlessEditor, path = MAIN): FlowDocument {
  return parseFlow(editor.workspace.file(path)!);
}

function nodeNamed(doc: FlowDocument, name: string): FlowNode | undefined {
  return allNodes(doc).find((node) => node.name === name);
}

function liveNode(editor: HeadlessEditor, id: string): FlowNode {
  return editor.core.findNode(id)!;
}

function centerOf({ x, y, w, h }: Rect): Point {
  return { x: x + w / 2, y: y + h / 2 };
}

async function unfold(editor: HeadlessEditor, hostId: string): Promise<void> {
  editor.core.toggleInlineExpansion(liveNode(editor, hostId));
  await editor.settle();
  editor.core.view.refreshDisplayGeometry();
}

async function copyNodes(editor: HeadlessEditor, ids: string[]): Promise<void> {
  editor.core.view.setSelection(ids.map((id) => liveNode(editor, id)));
  editor.core.runCommand('copy');
  await editor.settle();
}

async function pasteFromMenuAt(editor: HeadlessEditor, world: Point): Promise<void> {
  await editor.rightClick(world);
  await editor.chooseMenuItem('Paste');
}

// Between two nodes of an unfolded frame: inside the frame, on nothing.
function betweenInFrame(editor: HeadlessEditor, leftId: string, rightId: string): Point {
  const left = editor.core.view.rect(liveNode(editor, leftId));
  const right = editor.core.view.rect(liveNode(editor, rightId));
  return { x: (left.x + left.w + right.x) / 2, y: left.y + left.h / 2 };
}

describe('pasting out of an unfolded frame', () => {
  it('lands at the top level under the pointer, keeping only the edges among what was copied', async () => {
    const editor = await createHeadlessEditor({ [MAIN]: FLOW }, { open: MAIN });
    await unfold(editor, 'delta-1');
    await copyNodes(editor, ['inner-1']);

    await pasteFromMenuAt(editor, EMPTY_SPOT);

    const doc = docOnDisk(editor);
    const pasted = nodesIn(doc.items).find((node) => node.name === 'Inner')!;
    expect(pasted.pos).toMatchObject(EMPTY_SPOT);
    expect(pasted.edges).toEqual([]);
    expect(nodesIn(scopeItems(doc, 'Delta')).map((node) => node.name)).toEqual(['Inner', 'Second']);
  });

  it('keeps an edge whose both ends were copied', async () => {
    const editor = await createHeadlessEditor({ [MAIN]: FLOW }, { open: MAIN });
    await unfold(editor, 'delta-1');
    await copyNodes(editor, ['inner-1', 'second-1']);

    await pasteFromMenuAt(editor, EMPTY_SPOT);

    const pasted = nodesIn(docOnDisk(editor).items).find((node) => node.name === 'Inner')!;
    expect(pasted.edges.map((edge) => edge.target)).toEqual(['Second']);
  });

  it('is put back by one undo', async () => {
    const editor = await createHeadlessEditor({ [MAIN]: FLOW }, { open: MAIN });
    await unfold(editor, 'delta-1');
    const before = editor.workspace.file(MAIN);
    await copyNodes(editor, ['inner-1']);
    await pasteFromMenuAt(editor, EMPTY_SPOT);

    editor.core.undo();
    await editor.settle();

    expect(editor.workspace.file(MAIN)).toBe(before);
  });
});

describe('pasting into an unfolded frame', () => {
  it('lands in the subgraph the frame shows', async () => {
    const editor = await createHeadlessEditor({ [MAIN]: FLOW }, { open: MAIN });
    await unfold(editor, 'delta-1');
    await copyNodes(editor, ['alpha-1']);

    await pasteFromMenuAt(editor, betweenInFrame(editor, 'inner-1', 'second-1'));

    const doc = docOnDisk(editor);
    const copy = allNodes(doc).find((node) => node.name.startsWith('Alpha') && node.id !== 'alpha-1')!;
    expect(containingGraphBlockName(doc, copy)).toBe('Delta');
    expect(copy.edges).toEqual([]);
  });

  it('refuses a host pasted inside its own expansion, writing nothing', async () => {
    const editor = await createHeadlessEditor({ [MAIN]: FLOW }, { open: MAIN });
    await unfold(editor, 'delta-1');
    const before = editor.workspace.file(MAIN);
    await copyNodes(editor, ['delta-1']);

    await pasteFromMenuAt(editor, betweenInFrame(editor, 'inner-1', 'second-1'));

    expect(editor.workspace.file(MAIN)).toBe(before);
  });
});

describe('pasting after leaving a dive', () => {
  it('lands in the graph on screen, under the pointer', async () => {
    const editor = await createHeadlessEditor({ [MAIN]: FLOW }, { open: MAIN });
    const diving = editor.core.openExpand(liveNode(editor, 'delta-1'));
    await editor.settle();
    await diving;
    expect(editor.core.openFlow()?.scope).toBe('Delta');
    await copyNodes(editor, ['inner-1']);
    const leaving = editor.core.navigateBackTo(0);
    await editor.settle();
    await leaving;
    expect(editor.core.openFlow()?.scope).toBe(null);

    editor.hover(EMPTY_SPOT);
    editor.core.runCommand('paste');
    await editor.settle();

    const pasted = nodesIn(docOnDisk(editor).items).find((node) => node.name === 'Inner')!;
    expect(pasted.pos).toMatchObject(EMPTY_SPOT);
  });
});

describe('pasting into another file', () => {
  async function copyOutOfExternalFrame(ids: string[]): Promise<HeadlessEditor> {
    const editor = await createHeadlessEditor(
      { [MAIN]: LINKED_MAIN, [EXTERNAL]: EXTERNAL_FLOW, [canvasLayerPathOf(EXTERNAL)]: EXTERNAL_LAYER },
      { open: MAIN },
    );
    await unfold(editor, 'ext-1');
    await copyNodes(editor, ids);
    return editor;
  }

  it('carries the local subgraph a host expands into, renamed past a block already there', async () => {
    const editor = await copyOutOfExternalFrame(['host-1']);

    await pasteFromMenuAt(editor, EMPTY_SPOT);

    const doc = docOnDisk(editor);
    const host = nodesIn(doc.items).find((node) => node.name === 'Host')!;
    expect(getProp(host, 'expand')).toBe('Local 2');
    expect(graphBlockNames(doc)).toEqual(['Local', 'Local 2']);
    expect(nodesIn(scopeItems(doc, 'Local 2')).map((node) => node.name)).toEqual(['Deep']);
    expect(nodesIn(scopeItems(doc, 'Local')).map((node) => node.name)).toEqual(['Taken']);
    expect(nodeNamed(doc, 'Deep')!.id).not.toBe('deep-1');
  });

  it('carries a subgraph two hosts share once, and they still share it', async () => {
    const editor = await copyOutOfExternalFrame(['host-1', 'twin-1']);

    await pasteFromMenuAt(editor, EMPTY_SPOT);

    const doc = docOnDisk(editor);
    expect(graphBlockNames(doc)).toEqual(['Local', 'Local 2']);
    expect(['Host', 'Twin'].map((name) => getProp(nodeNamed(doc, name)!, 'expand'))).toEqual(['Local 2', 'Local 2']);
  });

  it("takes the subgraph's look along: its nodes' shapes and the drawings inside it", async () => {
    const editor = await copyOutOfExternalFrame(['host-1']);

    await pasteFromMenuAt(editor, EMPTY_SPOT);

    const deep = nodeNamed(docOnDisk(editor), 'Deep')!;
    const layer = parseCanvasLayer(editor.workspace.file(canvasLayerPathOf(MAIN)));
    expect(nodeShapeOf(layer, deep.id)).toBe('diamond');
    expect(layer.drawings.map((drawing) => drawing.graph)).toEqual(['Local 2']);
  });

  it('respells an expand link from the file it lands in', async () => {
    const editor = await copyOutOfExternalFrame(['linked-1']);

    await pasteFromMenuAt(editor, EMPTY_SPOT);

    expect(getProp(nodeNamed(docOnDisk(editor), 'Linked')!, 'expand')).toBe('[Far](sub/far.flow)');
  });

  it('leaves the file it was copied from alone', async () => {
    const editor = await copyOutOfExternalFrame(['host-1']);
    const external = editor.workspace.file(EXTERNAL);

    await pasteFromMenuAt(editor, EMPTY_SPOT);

    expect(editor.workspace.file(EXTERNAL)).toBe(external);
  });
});
