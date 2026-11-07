// Arrows end to end through the editor core: the arrow tool, a free arrow's end dots, and an edge's
// end dots — pinning the side an edge meets its node at, and pulling an edge off its node into a
// free arrow. Judged on the files the workspace holds afterwards, and on the one undo step that
// puts each back.

import { afterEach, describe, expect, it } from 'vitest';
import { allNodes } from '../src/client/flow-doc.js';
import type { Point } from '../src/client/geometry.js';
import { arrowDrawingOf, type ArrowDrawing } from '../src/shared/canvas-arrow.js';
import { canvasLayerPathOf, parseCanvasLayer } from '../src/shared/canvas-layer.js';
import { textDrawingOf } from '../src/shared/canvas-text.js';
import { parseFlow } from '../src/shared/flow-format.js';
import { createHeadlessEditor, disposeHeadlessEditor, type HeadlessEditor } from './editor-harness.js';

const FLOW_PATH = 'main.flow';
const LAYER_PATH = canvasLayerPathOf(FLOW_PATH);
const EDGE_KEY = 'a-1 -> #b-1 : "go"';

// A and B side by side, joined by a labelled edge; C below them, joined to nothing.
const FLOW = `---
name: Arrows
---

A
  id: a-1
  pos: 0, 0, 200, 88
  -> B : "go"

B
  id: b-1
  pos: 800, 0, 200, 88

C
  id: c-1
  pos: 400, 400, 200, 88
`;

const A_CENTER = { x: 100, y: 44 };
const C_CENTER = { x: 500, y: 444 };
const ON_THE_EDGE = { x: 300, y: 44 };
const EMPTY = { x: 300, y: 700 };

afterEach(() => disposeHeadlessEditor());

async function openEditor(): Promise<HeadlessEditor> {
  return createHeadlessEditor({ [FLOW_PATH]: FLOW }, { open: FLOW_PATH });
}

function edgesOfA(editor: HeadlessEditor): string[] {
  const nodeA = allNodes(parseFlow(editor.workspace.file(FLOW_PATH)!)).find((node) => node.name === 'A')!;
  return nodeA.edges.map((spec) => spec.target);
}

function arrowsIn(editor: HeadlessEditor): ArrowDrawing[] {
  return parseCanvasLayer(editor.workspace.file(LAYER_PATH)).drawings.flatMap((drawing) => arrowDrawingOf(drawing) ?? []);
}

function endDots(editor: HeadlessEditor, kind: 'edge-end-handle' | 'arrow-end-handle'): Point[] {
  return editor.core.view.affordances().filter((affordance) => affordance.kind === kind).map((affordance) => affordance.point);
}

function pathBetween(from: Point, to: Point): Point[] {
  const steps = 6;
  return Array.from({ length: steps + 1 }, (_, step) => ({
    x: from.x + ((to.x - from.x) * step) / steps,
    y: from.y + ((to.y - from.y) * step) / steps,
  }));
}

async function undo(editor: HeadlessEditor): Promise<void> {
  editor.core.runCommand('undo');
  await editor.settle();
}

async function selectTheEdge(editor: HeadlessEditor): Promise<[Point, Point]> {
  await editor.click(ON_THE_EDGE);
  const [start, end] = endDots(editor, 'edge-end-handle');
  return [start, end];
}

describe("an edge's end dots", () => {
  it('show at both ends of a lone selected edge, where it leaves and meets its nodes', async () => {
    const editor = await openEditor();
    const [start, end] = await selectTheEdge(editor);
    expect(start.x).toBeCloseTo(200, 6);
    expect(start.y).toBeCloseTo(44, 6);
    expect(end.x).toBeCloseTo(800, 6);
    expect(editor.core.view.pressTargetKindAt(start)).toBe('edge-end-handle');
  });

  it('pin the angle an end meets its node at, writing only the layer, in one undo step', async () => {
    const editor = await openEditor();
    const flowBefore = editor.workspace.file(FLOW_PATH);
    const [start] = await selectTheEdge(editor);
    await editor.drag(pathBetween(start, { x: 102, y: 80 }));
    expect(parseCanvasLayer(editor.workspace.file(LAYER_PATH)).edges[EDGE_KEY]).toEqual({ startAngle: 180 });
    expect(editor.workspace.file(FLOW_PATH)).toBe(flowBefore);
    const [pinnedStart] = endDots(editor, 'edge-end-handle');
    expect(pinnedStart.x).toBeCloseTo(100, 6);
    expect(pinnedStart.y).toBeCloseTo(88, 6);

    await undo(editor);
    expect(editor.workspace.file(LAYER_PATH)).toBeNull();
  });

  it('pull the edge off into a lone free arrow, its label gone with it, when dropped on empty canvas', async () => {
    const editor = await openEditor();
    const [start, end] = await selectTheEdge(editor);
    await editor.drag(pathBetween(end, EMPTY));
    expect(edgesOfA(editor)).toEqual([]);
    const [arrow] = arrowsIn(editor);
    expect(arrow.points[0].x).toBeCloseTo(start.x, 0);
    expect(arrow.points[0].y).toBeCloseTo(start.y, 0);
    expect(arrow.points[1]).toEqual(EMPTY);
    expect(arrow.endHead).toBe('arrow');
    const layer = parseCanvasLayer(editor.workspace.file(LAYER_PATH));
    expect(layer.drawings.flatMap((drawing) => textDrawingOf(drawing) ?? [])).toEqual([]);
    expect(layer.groups).toEqual([]);
    expect(editor.core.view.selectedDrawings.map((drawing) => drawing.id)).toEqual([arrow.id]);
    expect(endDots(editor, 'arrow-end-handle')).toHaveLength(2);

    await undo(editor);
    expect(edgesOfA(editor)).toEqual(['B']);
    expect(arrowsIn(editor)).toEqual([]);
  });

  it('keep an error edge red once pulled off', async () => {
    const editor = await createHeadlessEditor({ [FLOW_PATH]: FLOW.replace('  -> B : "go"', '  on_error: -> B') }, { open: FLOW_PATH });
    const [, end] = await selectTheEdge(editor);
    await editor.drag(pathBetween(end, EMPTY));
    expect(arrowsIn(editor).map((arrow) => [arrow.color, arrow.line])).toEqual([['red', 'dashed']]);
  });

  it('write nothing when the edge was removed on disk mid-drag', async () => {
    const editor = await openEditor();
    const [, end] = await selectTheEdge(editor);
    const [first, ...rest] = pathBetween(end, EMPTY);
    editor.press(first);
    editor.moveTo(rest[0]);
    const withoutTheEdge = FLOW.replace('  -> B : "go"\n', '');
    editor.workspace.writeExternally(FLOW_PATH, withoutTheEdge);
    for (const point of rest.slice(1)) editor.moveTo(point);
    editor.release(EMPTY);
    await editor.settle();
    expect(editor.workspace.file(FLOW_PATH)).toBe(withoutTheEdge);
    expect(arrowsIn(editor)).toEqual([]);
  });

  it('change nothing when dropped on another node', async () => {
    const editor = await openEditor();
    const before = editor.workspace.snapshot();
    const [, end] = await selectTheEdge(editor);
    await editor.drag(pathBetween(end, C_CENTER));
    expect(editor.workspace.snapshot()).toEqual(before);
  });
});

describe('the arrow tool', () => {
  it('draws a free arrow between two points of empty canvas, leaving the .flow alone', async () => {
    const editor = await openEditor();
    const flowBefore = editor.workspace.file(FLOW_PATH);
    editor.setTool('arrow');
    await editor.drag(pathBetween({ x: 300, y: 600 }, { x: 600, y: 700 }));
    const [arrow] = arrowsIn(editor);
    expect(arrow.points).toEqual([{ x: 300, y: 600 }, { x: 600, y: 700 }]);
    expect(editor.workspace.file(FLOW_PATH)).toBe(flowBefore);
  });

  it('adds an edge to the .flow when dragged from one node onto another', async () => {
    const editor = await openEditor();
    editor.setTool('arrow');
    await editor.drag(pathBetween(A_CENTER, C_CENTER));
    expect(edgesOfA(editor)).toEqual(['B', 'C']);
    expect(arrowsIn(editor)).toEqual([]);
  });

  it('draws a free arrow from a node let go on empty canvas', async () => {
    const editor = await openEditor();
    editor.setTool('arrow');
    await editor.drag(pathBetween(A_CENTER, EMPTY));
    expect(edgesOfA(editor)).toEqual(['B']);
    expect(arrowsIn(editor).map((arrow) => arrow.points)).toEqual([[A_CENTER, EMPTY]]);
  });

  it('makes no node and opens no editor on a double-click', async () => {
    const editor = await openEditor();
    const before = editor.workspace.snapshot();
    editor.setTool('arrow');
    await editor.doubleClick(EMPTY);
    await editor.doubleClick(ON_THE_EDGE);
    expect(editor.workspace.snapshot()).toEqual(before);
    expect(editor.core.view.selectedEdges).toEqual([]);
  });

  it('draws nothing for a drag that comes back to where it began', async () => {
    const editor = await openEditor();
    const before = editor.workspace.snapshot();
    editor.setTool('arrow');
    await editor.drag([...pathBetween(EMPTY, { x: 400, y: 700 }), ...pathBetween({ x: 400, y: 700 }, EMPTY)]);
    expect(editor.workspace.snapshot()).toEqual(before);
  });
});

describe("a free arrow's end dots", () => {
  it('move the dragged end anywhere and leave the other where it was', async () => {
    const editor = await openEditor();
    editor.setTool('arrow');
    await editor.drag(pathBetween({ x: 300, y: 600 }, { x: 600, y: 700 }));
    editor.setTool('select');
    await editor.click({ x: 450, y: 650 });
    const [, end] = endDots(editor, 'arrow-end-handle');
    expect(end).toEqual({ x: 600, y: 700 });
    await editor.drag(pathBetween(end, { x: 640, y: 520 }));
    expect(arrowsIn(editor)[0].points).toEqual([{ x: 300, y: 600 }, { x: 640, y: 520 }]);
  });
});
