// Arranging: laying a graph out afresh, or only some of its nodes around the rest — in a parsed
// document, through the editor's Arrange command, and from `grafd layout`.

import fc from 'fast-check';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allNodes, contextBlockNamed } from '../src/client/flow-doc.js';
import { arrangeScope, type LayoutScope } from '../src/shared/auto-layout.js';
import { arrangeDocument, arrangeGraphScope, assignMissingNodeIds, placeMissingPositions, setPlannedBends } from '../src/shared/document-layout.js';
import { scoreDocumentText } from '../src/shared/document-score.js';
import { parseFlow, serializeFlow, type FlowDocument, type FlowNode, type Rect } from '../src/shared/flow-format.js';
import { runFlowLayout } from '../src/tools/flow-layout.js';
import { canvasLayerPathOf, emptyCanvasLayer, parseCanvasLayer, setNodeShape, type NodeShape } from '../src/shared/canvas-layer.js';
import { createHeadlessEditor, disposeHeadlessEditor, type HeadlessEditor } from './editor-harness.js';
import type { LayeredGraph } from '../src/shared/layered-layout.js';
import { arbitraryGraph, overlaps } from './layout-fixtures.js';

const FLOW_PATH = 'main.flow';

// Laid out by hand, badly: B far below A and C on top of where B ought to be.
const UNTIDY_FLOW = `---
name: Untidy
---

context: Cart
  pos: 0, 0, 1400, 900
  nodes:
    - A

A
  id: a-1
  pos: 40, 40, 200, 88
  -> B

B
  id: b-1
  pos: 600, 700, 200, 88
  -> C

C
  id: c-1
  pos: 300, 40, 200, 88

graph: Inner
  X
    -> Y

  Y
`;

// The same graph without its unplaced `graph:` block: the editor gives unplaced nodes ids and
// positions on opening, which the first edit writes out, so an undo goes back to that rather than to
// the text the file was opened with.
const UNTIDY_PLACED_FLOW = `${UNTIDY_FLOW.slice(0, UNTIDY_FLOW.indexOf('graph: Inner')).trimEnd()}\n`;

function nodeNamed(doc: FlowDocument, name: string): FlowNode {
  return allNodes(doc).find((node) => node.name === name)!;
}

function posOf(text: string, name: string): Rect {
  return nodeNamed(parseFlow(text), name).pos!;
}

describe('arranging a whole graph', () => {
  it('lays it out as a layered drawing from the corner it started at, the region member level with what it leads to', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    expect(arrangeGraphScope(doc.items).moved).toBe(true);
    const [a, b, c] = ['A', 'B', 'C'].map((name) => nodeNamed(doc, name).pos!);
    expect(b.y).toBe(c.y);
    expect(a.y).toBe(b.y);
    expect(a.x).toBe(40);
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
  });

  it('changes nothing the second time', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    arrangeGraphScope(doc.items);
    const arranged = serializeFlow(doc);
    expect(arrangeGraphScope(doc.items).moved).toBe(false);
    expect(serializeFlow(doc)).toBe(arranged);
  });

  it('lets go of the area a region reserved around the old layout', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    arrangeGraphScope(doc.items);
    expect(contextBlockNamed(doc, 'Cart')!.pos).toBeNull();
  });

  it('arranges every graph scope of a document', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    expect(arrangeDocument(doc).moved).toBe(true);
    expect(nodeNamed(doc, 'X').pos).not.toBeNull();
    expect(nodeNamed(doc, 'Y').pos!.x).toBeGreaterThan(nodeNamed(doc, 'X').pos!.x);
  });
});

describe('arrangeScope on any graph', () => {
  function scopeOf(graph: LayeredGraph, positions: (Rect | null)[]): LayoutScope {
    const nameOf = (node: number): string => `n${node}`;
    return {
      nodes: graph.nodes.map((node, index) => ({ name: nameOf(index), pos: positions[index], description: node.description, entrypoint: node.entrypoint })),
      edges: graph.edges.map((edge) => ({ from: edge.from, target: nameOf(edge.to), kind: edge.kind, label: edge.label })),
      regions: graph.regions.map((members) => ({ members: members.map(nameOf), pos: null })),
    };
  }

  it('leaves an arranged graph exactly as it is', () => {
    fc.assert(fc.property(arbitraryGraph, (graph) => {
      const arranged = arrangeScope(scopeOf(graph, graph.nodes.map(() => null)));
      expect(arrangeScope(scopeOf(graph, arranged.rects))).toEqual(arranged);
    }));
  });
});

// The layered drawing puts "Payment Provider" in the row below the spine, right where the edge
// looping back from "Ask Another Card" crosses it; arranging steps it out of that edge's way.
const LOOP_PAST_A_LEAF_FLOW = `---
name: Take Payment
---

Choose Method
  -> Authorize Card

Authorize Card
  -> Payment Provider
  -> Approved?

Approved?
  -> Capture Funds : "yes"
  -> Ask Another Card : "no"

Ask Another Card
  -> Choose Method

Capture Funds

Payment Provider
`;

// Every step can fail into "Alert Data Team", drawn below the spine; the edge from "Load Warehouse"
// runs through the "Warehouse" cylinder beside it, and the moves that would step the cylinder up
// or down walk into other nodes.
const FAILURES_PAST_A_STORE_FLOW = `---
name: Nightly Ingestion
---

Nightly Trigger
  -> Extract Sources

Extract Sources
  on_error: -> Alert Data Team
  -> Validate Schemas

Validate Schemas
  -> Transform Data : "valid"
  -> Quarantine Bad Rows : "bad rows"

Transform Data
  on_error: -> Alert Data Team
  -> Load Warehouse

Load Warehouse
  on_error: -> Alert Data Team
  -> Refresh Dashboards
  -> Warehouse

Refresh Dashboards
  -> Run Complete

Run Complete

Quarantine Bad Rows

Warehouse

Alert Data Team
`;

describe('arranging polishes the layered drawing', () => {
  it('steps a node off the spine aside when the move for the node in the way walks into another', () => {
    const doc = parseFlow(FAILURES_PAST_A_STORE_FLOW);
    assignMissingNodeIds(doc.items);
    const shapes: Record<string, NodeShape> = {
      'Nightly Trigger': 'ellipse', 'Run Complete': 'rounded', 'Alert Data Team': 'parallelogram',
      'Quarantine Bad Rows': 'cylinder', Warehouse: 'cylinder',
    };
    const shapeOf = (node: FlowNode): NodeShape => shapes[node.name] ?? 'rectangle';
    const layer = emptyCanvasLayer();
    for (const node of allNodes(doc)) setNodeShape(layer, node.id!, shapeOf(node));
    setPlannedBends(layer, doc, arrangeGraphScope(doc.items, undefined, shapeOf).bends);
    const [body] = scoreDocumentText(serializeFlow(doc), layer);
    expect(body.current.counts['edge-through-node']).toBe(0);
    const spine = ['Transform Data', 'Load Warehouse', 'Refresh Dashboards'].map((name) => nodeNamed(doc, name).pos!);
    expect(new Set(spine.map((rect) => rect.y + rect.h / 2)).size).toBe(1);
  });

  it('steps a node out of the way of an edge drawn through it', () => {
    const doc = parseFlow(LOOP_PAST_A_LEAF_FLOW);
    assignMissingNodeIds(doc.items);
    const layer = emptyCanvasLayer();
    setPlannedBends(layer, doc, arrangeGraphScope(doc.items).bends);
    const [body] = scoreDocumentText(serializeFlow(doc), layer);
    expect(body.current.counts['edge-through-node']).toBe(0);
    expect(body.current.score).toBe(body.arranged);
  });
});

describe('arranging some of a graph', () => {
  it('moves only the chosen nodes, beside what they connect to', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    const before = ['A', 'C'].map((name) => ({ ...nodeNamed(doc, name).pos! }));
    arrangeGraphScope(doc.items, new Set([nodeNamed(doc, 'B')]));

    expect(['A', 'C'].map((name) => nodeNamed(doc, name).pos)).toEqual(before);
    const b = nodeNamed(doc, 'B').pos!;
    expect(b.y).not.toBe(700);
    for (const name of ['A', 'C']) expect(overlaps(b, nodeNamed(doc, name).pos!)).toBe(false);
  });

  it('keeps the area a region reserved', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    arrangeGraphScope(doc.items, new Set([nodeNamed(doc, 'B')]));
    expect(contextBlockNamed(doc, 'Cart')!.pos).not.toBeNull();
  });
});

describe('placing missing positions', () => {
  it('places only the nodes that have none', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    expect(placeMissingPositions(doc)).toBe(true);
    expect(nodeNamed(doc, 'B').pos).toEqual({ x: 600, y: 700, w: 200, h: 88 });
    expect(nodeNamed(doc, 'X').pos).not.toBeNull();
    expect(placeMissingPositions(doc)).toBe(false);
  });
});

// A→D skips over B and C, so arranged on one row the straight line from A to D would run through
// both; the bend Arrange gives it runs it along the lane kept clear beside them.
const SKIPPING_FLOW = `---
name: Skipping
---

A
  id: a-1
  pos: 40, 40, 200, 88
  -> B
  -> D : "skip"

B
  id: b-1
  pos: 40, 400, 200, 88
  -> C

C
  id: c-1
  pos: 600, 600, 200, 88
  -> D

D
  id: d-1
  pos: 900, 40, 200, 88
`;

function edgeBendsIn(editor: HeadlessEditor): Record<string, unknown> {
  const layer = parseCanvasLayer(editor.workspace.file(canvasLayerPathOf(FLOW_PATH)));
  return Object.fromEntries(Object.entries(layer.edges).flatMap(([key, entry]) => ('bend' in entry ? [[key, entry.bend]] : [])));
}

describe('the bends Arrange lays', () => {
  afterEach(() => disposeHeadlessEditor());

  it('plans a bend for the long edge and none for the short ones', () => {
    const doc = parseFlow(SKIPPING_FLOW);
    const { bends } = arrangeGraphScope(doc.items);
    const bent = bends.filter((plan) => plan.bend !== null);
    expect(bent.map((plan) => `${plan.node.name} -> ${plan.spec?.target}`)).toEqual(['A -> D']);
    expect(bends).toHaveLength(4);
  });

  it('writes the bends with the moves, in one undo step', async () => {
    const editor = await createHeadlessEditor({ [FLOW_PATH]: SKIPPING_FLOW }, { open: FLOW_PATH });
    editor.core.runCommand('arrange');
    await editor.settle();
    expect(Object.keys(edgeBendsIn(editor))).toHaveLength(1);

    editor.core.undo();
    await editor.settle();
    expect(edgeBendsIn(editor)).toEqual({});
    expect(posOf(editor.workspace.file(FLOW_PATH)!, 'C')).toEqual({ x: 600, y: 600, w: 200, h: 88 });
  });

  it('writes nothing when arranged again', async () => {
    const editor = await createHeadlessEditor({ [FLOW_PATH]: SKIPPING_FLOW }, { open: FLOW_PATH });
    editor.core.runCommand('arrange');
    await editor.settle();
    const files = editor.workspace.snapshot();
    const depth = editor.core.session.undoDepth;

    editor.core.runCommand('arrange');
    await editor.settle();
    expect(editor.workspace.snapshot()).toEqual(files);
    expect(editor.core.session.undoDepth).toBe(depth);
  });

  it('straightens the edges of the nodes it arranges on their own', async () => {
    const editor = await createHeadlessEditor({ [FLOW_PATH]: SKIPPING_FLOW }, { open: FLOW_PATH });
    editor.core.runCommand('arrange');
    await editor.settle();
    const d = editor.core.view.model.nodes.find((node) => node.name === 'D')!;
    editor.core.view.setSelection([d], [], []);

    editor.core.runCommand('arrange');
    await editor.settle();
    expect(edgeBendsIn(editor)).toEqual({});
  });
});

describe('the Arrange command', () => {
  afterEach(() => disposeHeadlessEditor());

  it('arranges the whole graph in one undo step when nothing is selected', async () => {
    const editor = await createHeadlessEditor({ [FLOW_PATH]: UNTIDY_PLACED_FLOW }, { open: FLOW_PATH });
    const before = editor.workspace.file(FLOW_PATH);

    expect(editor.core.runCommand('arrange')).toBe(true);
    await editor.settle();
    const after = editor.workspace.file(FLOW_PATH)!;
    expect(posOf(after, 'B').y).toBe(posOf(after, 'C').y);

    editor.core.undo();
    await editor.settle();
    expect(editor.workspace.file(FLOW_PATH)).toBe(before);
  });

  it('writes nothing when the graph is already arranged', async () => {
    const editor = await createHeadlessEditor({ [FLOW_PATH]: UNTIDY_PLACED_FLOW }, { open: FLOW_PATH });
    editor.core.runCommand('arrange');
    await editor.settle();
    const arranged = editor.workspace.file(FLOW_PATH);

    editor.core.runCommand('arrange');
    await editor.settle();
    expect(editor.workspace.file(FLOW_PATH)).toBe(arranged);
    editor.core.undo();
    await editor.settle();
    expect(editor.workspace.file(FLOW_PATH)).not.toBe(arranged);
  });

  it('arranges only the selection when there is one', async () => {
    const editor = await createHeadlessEditor({ [FLOW_PATH]: UNTIDY_PLACED_FLOW }, { open: FLOW_PATH });
    const b = editor.core.view.model.nodes.find((node) => node.name === 'B')!;
    editor.core.view.setSelection([b], [], []);

    editor.core.runCommand('arrange');
    await editor.settle();
    const after = editor.workspace.file(FLOW_PATH)!;
    expect(posOf(after, 'A')).toEqual({ x: 40, y: 40, w: 200, h: 88 });
    expect(posOf(after, 'C')).toEqual({ x: 300, y: 40, w: 200, h: 88 });
    expect(posOf(after, 'B').y).not.toBe(700);
  });

  it('is offered on the canvas menu', async () => {
    const editor = await createHeadlessEditor({ [FLOW_PATH]: UNTIDY_PLACED_FLOW }, { open: FLOW_PATH });
    await editor.rightClick({ x: 1200, y: 1200 });
    await editor.chooseMenuItem('Arrange graph');
    await editor.settle();
    const after = editor.workspace.file(FLOW_PATH)!;
    expect(posOf(after, 'B').y).toBe(posOf(after, 'C').y);
  });
});

describe('grafd layout', () => {
  async function workspaceWith(text: string): Promise<{ root: string; file: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'grafd-layout-'));
    const file = path.join(root, FLOW_PATH);
    await writeFile(file, text);
    return { root, file };
  }

  it('places nodes without a position and leaves placed ones alone', async () => {
    const { root, file } = await workspaceWith(UNTIDY_FLOW);
    expect(await runFlowLayout([root])).toBe(0);
    const text = await readFile(file, 'utf8');
    expect(posOf(text, 'B')).toEqual({ x: 600, y: 700, w: 200, h: 88 });
    expect(posOf(text, 'X')).not.toBeNull();
  });

  it('leaves a file whose nodes are all placed byte for byte as it was', async () => {
    const { root, file } = await workspaceWith(UNTIDY_FLOW);
    await runFlowLayout([root]);
    const placed = await readFile(file, 'utf8');
    await runFlowLayout([root]);
    expect(await readFile(file, 'utf8')).toBe(placed);
  });

  it('lays every graph out afresh with --all', async () => {
    const { root, file } = await workspaceWith(UNTIDY_FLOW);
    expect(await runFlowLayout([root, '--all'])).toBe(0);
    const text = await readFile(file, 'utf8');
    expect(posOf(text, 'B').y).toBe(posOf(text, 'C').y);
  });

  it('writes the bends Arrange lays to the canvas layer with --all, and nothing the second time', async () => {
    const { root, file } = await workspaceWith(SKIPPING_FLOW);
    await runFlowLayout([root, '--all']);
    const layerText = await readFile(canvasLayerPathOf(file), 'utf8');
    expect(Object.keys(parseCanvasLayer(layerText).edges)).toEqual(['a-1 -> #d-1 : "skip"']);

    const flowText = await readFile(file, 'utf8');
    await runFlowLayout([root, '--all']);
    expect(await readFile(file, 'utf8')).toBe(flowText);
    expect(await readFile(canvasLayerPathOf(file), 'utf8')).toBe(layerText);
  });

  it('gives every node an id with --all, so the bends can be filed under them', async () => {
    const { root, file } = await workspaceWith(SKIPPING_FLOW.replace(/^ {2}id: .*\n/gm, ''));
    await runFlowLayout([root, '--all']);
    const doc = parseFlow(await readFile(file, 'utf8'));
    expect(allNodes(doc).every((node) => node.id)).toBe(true);
    const layer = parseCanvasLayer(await readFile(canvasLayerPathOf(file), 'utf8'));
    expect(Object.keys(layer.edges)).toEqual([`${nodeNamed(doc, 'A').id} -> #${nodeNamed(doc, 'D').id} : "skip"`]);
  });

  it('leaves a layer it cannot read as it is, and still arranges', async () => {
    const { root, file } = await workspaceWith(SKIPPING_FLOW);
    await writeFile(canvasLayerPathOf(file), '{ not json');
    await runFlowLayout([root, '--all']);
    expect(await readFile(canvasLayerPathOf(file), 'utf8')).toBe('{ not json');
    expect(posOf(await readFile(file, 'utf8'), 'C')).not.toEqual({ x: 600, y: 600, w: 200, h: 88 });
  });

  it('turns every graph the way --direction says', async () => {
    const { root, file } = await workspaceWith(SKIPPING_FLOW);
    await runFlowLayout([root, '--all', '--direction=TB']);
    const text = await readFile(file, 'utf8');
    expect(posOf(text, 'B').y).toBeGreaterThan(posOf(text, 'A').y);
    expect(posOf(text, 'C').y).toBeGreaterThan(posOf(text, 'B').y);
  });

  it('refuses a direction without --all, or one it does not know', async () => {
    expect(await runFlowLayout(['--direction=TB'])).toBe(2);
    expect(await runFlowLayout(['--all', '--direction=diagonal'])).toBe(2);
  });

  it('refuses an option it does not know', async () => {
    expect(await runFlowLayout(['--sideways'])).toBe(2);
  });
});
