// End to end through the editor core: a gesture goes in on the canvas, and what comes out is
// judged on the files the workspace holds afterwards — the move, the membership it implied, the
// canvas layer, and the one undo step that puts all of it back.

import { afterEach, describe, expect, it } from 'vitest';
import { parseFlow, type FlowNode } from '../src/shared/flow-format.js';
import { allNodes, contextBlockNamed } from '../src/client/flow-doc.js';
import type { Point } from '../src/client/geometry.js';
import { canvasLayerPathOf } from '../src/shared/canvas-layer.js';
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
