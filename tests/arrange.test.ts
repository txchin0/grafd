// Arranging: laying a graph out afresh, or only some of its nodes around the rest — in a parsed
// document, through the editor's Arrange command, and from `grafd layout`.

import fc from 'fast-check';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allNodes, contextBlockNamed } from '../src/client/flow-doc.js';
import { arrangeScope, type LayoutScope } from '../src/shared/auto-layout.js';
import { arrangeDocument, arrangeGraphScope, placeMissingPositions } from '../src/shared/document-layout.js';
import { parseFlow, serializeFlow, type FlowDocument, type FlowNode, type Rect } from '../src/shared/flow-format.js';
import { runFlowLayout } from '../src/tools/flow-layout.js';
import { createHeadlessEditor, disposeHeadlessEditor } from './editor-harness.js';
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
  it('lays it out as a layered drawing from the corner it started at, the region member in a band of its own', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    expect(arrangeGraphScope(doc.items)).toBe(true);
    const [a, b, c] = ['A', 'B', 'C'].map((name) => nodeNamed(doc, name).pos!);
    expect(b.y).toBe(c.y);
    expect(a.y).not.toBe(b.y);
    expect(a.x).toBe(40);
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
  });

  it('changes nothing the second time', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    arrangeGraphScope(doc.items);
    const arranged = serializeFlow(doc);
    expect(arrangeGraphScope(doc.items)).toBe(false);
    expect(serializeFlow(doc)).toBe(arranged);
  });

  it('lets go of the area a region reserved around the old layout', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    arrangeGraphScope(doc.items);
    expect(contextBlockNamed(doc, 'Cart')!.pos).toBeNull();
  });

  it('arranges every graph scope of a document', () => {
    const doc = parseFlow(UNTIDY_FLOW);
    expect(arrangeDocument(doc)).toBe(true);
    expect(nodeNamed(doc, 'X').pos).not.toBeNull();
    expect(nodeNamed(doc, 'Y').pos!.x).toBeGreaterThan(nodeNamed(doc, 'X').pos!.x);
  });
});

describe('arrangeScope on any graph', () => {
  function scopeOf(graph: LayeredGraph, positions: (Rect | null)[]): LayoutScope {
    const nameOf = (node: number): string => `n${node}`;
    return {
      nodes: graph.nodes.map((node, index) => ({ name: nameOf(index), pos: positions[index], description: node.description, entrypoint: node.entrypoint })),
      edges: graph.edges.map((edge) => ({ from: edge.from, target: nameOf(edge.to), kind: edge.kind })),
      regions: graph.regions.map((members) => ({ members: members.map(nameOf), pos: null })),
    };
  }

  it('leaves an arranged graph exactly as it is', () => {
    fc.assert(fc.property(arbitraryGraph, (graph) => {
      const arranged = arrangeScope(scopeOf(graph, graph.nodes.map(() => null)));
      expect(arrangeScope(scopeOf(graph, arranged))).toEqual(arranged);
    }));
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

  it('refuses an option it does not know', async () => {
    expect(await runFlowLayout(['--sideways'])).toBe(2);
  });
});
