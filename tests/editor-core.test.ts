// End to end through the editor core: a gesture goes in on the canvas, and what comes out is
// judged on the files the workspace holds afterwards — the move, the membership it implied, the
// canvas layer, and the one undo step that puts all of it back.

import { afterEach, describe, expect, it } from 'vitest';
import { parseFlow, type FlowNode } from '../src/shared/flow-format.js';
import { allNodes, contextBlockNamed } from '../src/client/flow-doc.js';
import type { Point } from '../src/client/geometry.js';
import { canvasLayerPathOf } from '../src/shared/canvas-layer.js';
import type { RegionStylePatch } from '../src/shared/canvas-region-style.js';
import type { RegionTarget } from '../src/client/canvas/canvas-view.js';
import { createHeadlessEditor, disposeHeadlessEditor, type HeadlessEditor } from './editor-harness.js';

const FLOW_PATH = 'main.flow';

// One region drawn around A alone, with B far enough away to be dragged in.
const REGIONED_FLOW = `---
name: Regions
---

context: Auth
  nodes:
    - A

A
  id: a-1
  pos: 200, 200, 200, 88

B
  id: b-1
  pos: 800, 200, 200, 88
`;

// A host node expanding into a local graph block that declares a region of its own.
const NESTED_REGION_FLOW = `---
name: Shop
---

Checkout
  id: checkout-1
  pos: 200, 200, 200, 88
  expand: Checkout

graph: Checkout
  context: Session
    nodes:
      - Pay

  Pay
    id: pay-1
    pos: 0, 0, 200, 88
`;

afterEach(() => disposeHeadlessEditor());

function openRegionedFlow(): Promise<HeadlessEditor> {
  return createHeadlessEditor({ [FLOW_PATH]: REGIONED_FLOW }, { open: FLOW_PATH });
}

function nodeOnDisk(editor: HeadlessEditor, name: string): FlowNode | undefined {
  return allNodes(parseFlow(editor.workspace.file(FLOW_PATH)!)).find((node) => node.name === name);
}

function membersOnDisk(editor: HeadlessEditor, regionName: string): string[] {
  const region = contextBlockNamed(parseFlow(editor.workspace.file(FLOW_PATH)!), regionName);
  if (!region) throw new Error(`No region named ${regionName} on disk`);
  return region.members;
}

function centerOf(node: FlowNode): Point {
  return { x: node.pos!.x + node.pos!.w / 2, y: node.pos!.y + node.pos!.h / 2 };
}

describe('the headless editor', () => {
  it('opens the flow it was asked for', async () => {
    const editor = await openRegionedFlow();
    expect(editor.core.openFlow()?.path).toBe(FLOW_PATH);
    expect(editor.core.view.model.nodes.map((node) => node.name)).toEqual(['A', 'B']);
  });
});

describe('dragging a node into a region', () => {
  it('writes the move and the membership to the file', async () => {
    const editor = await openRegionedFlow();
    const a = nodeOnDisk(editor, 'A')!;
    const b = nodeOnDisk(editor, 'B')!;

    await editor.drag([centerOf(b), { x: centerOf(a).x, y: centerOf(a).y + 4 }]);

    expect(membersOnDisk(editor, 'Auth')).toEqual(['A', 'B']);
    expect(nodeOnDisk(editor, 'B')!.pos!.x).not.toBe(b.pos!.x);
  });

  it('puts both back in one undo step', async () => {
    const editor = await openRegionedFlow();
    const before = editor.workspace.file(FLOW_PATH);
    const a = nodeOnDisk(editor, 'A')!;
    const b = nodeOnDisk(editor, 'B')!;

    await editor.drag([centerOf(b), { x: centerOf(a).x, y: centerOf(a).y + 4 }]);
    editor.core.undo();
    await editor.settle();

    expect(editor.workspace.file(FLOW_PATH)).toBe(before);
  });
});

describe('deleting a node from its context menu', () => {
  it('removes it from the file and from the region that listed it', async () => {
    const editor = await openRegionedFlow();
    const a = nodeOnDisk(editor, 'A')!;

    await editor.rightClick(centerOf(a));
    await editor.chooseMenuItem('Delete');

    expect(nodeOnDisk(editor, 'A')).toBeUndefined();
    expect(membersOnDisk(editor, 'Auth')).toEqual([]);
  });
});

function regionTarget(editor: HeadlessEditor, name: string): RegionTarget {
  const flow = editor.core.openFlow()!;
  return { block: contextBlockNamed(flow.doc, name)!, doc: flow.doc, path: flow.path };
}

function styleRegion(editor: HeadlessEditor, name: string, patch: RegionStylePatch): void {
  const region = regionTarget(editor, name);
  const owner = editor.core.contextOps.ownerOfRegion(region);
  editor.core.applyLayerEdit(owner, () => editor.core.layerSync.setRegionStyle(owner, region.block, patch));
}

function regionsOnDisk(editor: HeadlessEditor, flowPath = FLOW_PATH): Record<string, unknown> | undefined {
  const text = editor.workspace.file(canvasLayerPathOf(flowPath));
  return text == null ? undefined : JSON.parse(text).regions;
}

describe('styling a region', () => {
  it('writes only the canvas layer, as one undo step', async () => {
    const editor = await openRegionedFlow();
    const flowBefore = editor.workspace.file(FLOW_PATH);

    styleRegion(editor, 'Auth', { color: 'blue', fill: 'cross-hatch' });
    await editor.settle();
    expect(regionsOnDisk(editor)).toEqual({ Auth: { color: 'blue', fill: 'cross-hatch' } });
    expect(editor.workspace.file(FLOW_PATH)).toBe(flowBefore);

    editor.core.undo();
    await editor.settle();
    expect(editor.workspace.file(canvasLayerPathOf(FLOW_PATH))).toBeNull();
  });

  it('keeps its look through a rename, and undo puts the look back under the old name', async () => {
    const editor = await openRegionedFlow();
    styleRegion(editor, 'Auth', { fillColor: 'yellow' });
    await editor.settle();

    expect(editor.core.contextOps.renameRegion(regionTarget(editor, 'Auth'), 'Login')).toBeNull();
    await editor.settle();
    expect(regionsOnDisk(editor)).toEqual({ Login: { fillColor: 'yellow' } });

    editor.core.undo();
    await editor.settle();
    expect(regionsOnDisk(editor)).toEqual({ Auth: { fillColor: 'yellow' } });
  });

  it('takes the looks of a graph block\'s regions along when the block is extracted into a file', async () => {
    const editor = await createHeadlessEditor({ [FLOW_PATH]: NESTED_REGION_FLOW }, { open: FLOW_PATH });
    const host = nodeOnDisk(editor, 'Checkout')!;
    const owner = { doc: editor.core.openFlow()!.doc, path: FLOW_PATH };
    const session = contextBlockNamed(owner.doc, 'Session')!;
    editor.core.applyLayerEdit(owner, () => editor.core.layerSync.setRegionStyle(owner, session, { color: 'green' }));
    await editor.settle();

    await editor.rightClick(centerOf(host));
    await editor.chooseMenuItem('Extract into file');
    await editor.settle();

    const extractedLayers = [...editor.workspace.snapshot().keys()]
      .filter((path) => path.endsWith('.canvas.json') && path !== canvasLayerPathOf(FLOW_PATH));
    expect(extractedLayers).toHaveLength(1);
    expect(JSON.parse(editor.workspace.file(extractedLayers[0])!).regions).toEqual({ Session: { color: 'green' } });
  });
});

describe('drawing with the pen', () => {
  it('writes the stroke to the flow\'s canvas layer, and undo removes the layer again', async () => {
    const editor = await openRegionedFlow();
    const layerPath = canvasLayerPathOf(FLOW_PATH);
    expect(editor.workspace.file(layerPath)).toBeNull();

    editor.setTool('draw');
    await editor.drag([{ x: 500, y: 600 }, { x: 540, y: 620 }, { x: 580, y: 650 }, { x: 620, y: 660 }]);

    const layer = JSON.parse(editor.workspace.file(layerPath)!);
    expect(layer.drawings).toHaveLength(1);

    editor.core.undo();
    await editor.settle();
    expect(editor.workspace.file(layerPath)).toBeNull();
  });
});

describe('writing with the text tool', () => {
  const PLACED_AT = { x: 520, y: 600 };

  function textsOnDisk(editor: HeadlessEditor): Record<string, unknown>[] {
    const layerText = editor.workspace.file(canvasLayerPathOf(FLOW_PATH));
    return layerText ? JSON.parse(layerText).drawings : [];
  }

  async function writeText(editor: HeadlessEditor, typed: string): Promise<void> {
    editor.setTool('text');
    await editor.click(PLACED_AT);
    await editor.finishText(typed);
  }

  it('writes nothing until the text is typed, then one undoable text where the click was', async () => {
    const editor = await openRegionedFlow();
    editor.setTool('text');
    await editor.click(PLACED_AT);
    expect(editor.openText()).toMatchObject({ kind: 'new', topLeft: PLACED_AT });
    expect(editor.workspace.file(canvasLayerPathOf(FLOW_PATH))).toBeNull();

    await editor.finishText('Hello\nworld\n\n');
    const [text] = textsOnDisk(editor);
    expect(text).toMatchObject({ kind: 'text', text: 'Hello\nworld' });
    expect((text.box as number[]).slice(0, 2)).toEqual([PLACED_AT.x, PLACED_AT.y]);
    expect(editor.core.view.selectedDrawings.map((drawing) => drawing.id)).toEqual([text.id]);

    editor.core.undo();
    await editor.settle();
    expect(editor.workspace.file(canvasLayerPathOf(FLOW_PATH))).toBeNull();
  });

  it('makes nothing of a text left blank', async () => {
    const editor = await openRegionedFlow();
    await writeText(editor, '  \n ');
    expect(editor.workspace.file(canvasLayerPathOf(FLOW_PATH))).toBeNull();
    expect(editor.core.session.undoDepth).toBe(0);
  });

  it('edits a text in place on a double-click, and deletes one emptied out', async () => {
    const editor = await openRegionedFlow();
    await writeText(editor, 'First');
    const [{ id, box }] = textsOnDisk(editor) as { id: string; box: number[] }[];
    const middle = { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 };

    editor.setTool('select');
    await editor.doubleClick(middle);
    expect(editor.openText()).toMatchObject({ kind: 'existing', drawing: { id } });
    await editor.finishText('Second line\nand third');
    const [edited] = textsOnDisk(editor) as { text: string; box: number[] }[];
    expect(edited.text).toBe('Second line\nand third');
    expect(edited.box.slice(0, 2)).toEqual(box.slice(0, 2));
    expect(edited.box[3]).toBeCloseTo(box[3] * 2, 1);

    await editor.doubleClick(middle);
    await editor.finishText('');
    expect(editor.workspace.file(canvasLayerPathOf(FLOW_PATH))).toBeNull();
  });

  it('keeps a text whose editor a click elsewhere closed untouched', async () => {
    const editor = await openRegionedFlow();
    await writeText(editor, 'Stays');
    const before = editor.workspace.file(canvasLayerPathOf(FLOW_PATH));
    const [{ box }] = textsOnDisk(editor) as { box: number[] }[];
    await editor.doubleClick({ x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 });
    await editor.click({ x: -400, y: -400 });
    expect(editor.workspace.file(canvasLayerPathOf(FLOW_PATH))).toBe(before);
  });
});

describe('a ghost', () => {
  const FLOW_WITH_GHOST = `---
name: Ghosts
---

A
  id: a-1
  pos: 200, 200, 200, 88
  -> Missing
`;

  async function openWithGhost(): Promise<{ editor: HeadlessEditor; ghostCenter: Point }> {
    const editor = await createHeadlessEditor({ [FLOW_PATH]: FLOW_WITH_GHOST }, { open: FLOW_PATH });
    const { pos } = editor.core.view.model.ghosts[0];
    return { editor, ghostCenter: { x: pos.x + pos.w / 2, y: pos.y + pos.h / 2 } };
  }

  it('becomes a node when clicked', async () => {
    const { editor, ghostCenter } = await openWithGhost();
    await editor.click(ghostCenter);
    expect(nodeOnDisk(editor, 'Missing')).toBeDefined();
  });

  it('stays a ghost when the press is dragged away', async () => {
    const { editor, ghostCenter } = await openWithGhost();
    await editor.drag([ghostCenter, { x: ghostCenter.x + 40, y: ghostCenter.y + 30 }]);
    expect(nodeOnDisk(editor, 'Missing')).toBeUndefined();
  });
});
