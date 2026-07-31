// Dragging a node in or out of a region. Membership is written by gestures alone (R13/R14), and
// what a drag decides is measured against the frame each region had when the drag began — never
// its live one, which follows the node being dragged.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseFlow, type FlowNode, type Rect } from '../src/shared/flow-format.js';
import {
  allNodes,
  assignMissingIds,
  buildModel,
  contextBlockNamed,
  type MembershipChange,
} from '../src/client/flow-doc.js';
import type { Point } from '../src/client/geometry.js';
import { ExpansionLayer } from '../src/client/canvas/expansion.js';
import type { CanvasActions } from '../src/client/canvas/canvas-view.js';
import { createCanvasMock, stubCanvasGlobals } from './canvas-mock.js';

// One region drawn around A alone, wide enough that B can be dragged into it and A out of it.
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

C
  id: c-1
  pos: 800, 400, 200, 88
`;

// A drawn region roomy enough to receive a whole selection at once.
const GROUP_FLOW = `---
name: Group
---

context: Group
  pos: 0, 0, 900, 900
  nodes:

P
  id: p-1
  pos: 1400, 200, 200, 88

Q
  id: q-1
  pos: 1400, 400, 200, 88
`;

// Two regions sharing a stretch of canvas, so one node can sit inside both at once.
const OVERLAPPING_FLOW = `---
name: Overlaps
---

context: Left
  pos: 0, 0, 700, 700
  nodes:

context: Right
  pos: 400, 0, 700, 700
  nodes:

Outside
  id: out-1
  pos: 1600, 900, 200, 88
`;

// A drawn region with one member and one node well outside it, so a move can sweep the outsider
// in and a resize can shut the member out.
const ZONE_FLOW = `---
name: Zone
---

context: Zone
  pos: 0, 0, 800, 600
  nodes:
    - Inside

Inside
  id: in-1
  pos: 200, 200, 200, 88

Far
  id: far-1
  pos: 1400, 900, 200, 88
`;

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
  vi.spyOn(CanvasView.prototype, 'requestRender').mockImplementation(() => {});
});

function stubActions(): CanvasActions {
  return {
    createNode: vi.fn(),
    quickCreateNode: vi.fn(),
    nodeClicked: vi.fn(),
    canvasClicked: vi.fn(),
    moveCommitted: vi.fn(),
    completeEdge: vi.fn(),
    editEdge: vi.fn(),
    editNodeTitle: vi.fn(),
    openExpand: vi.fn(),
    toggleExpand: vi.fn(),
    materializeGhost: vi.fn(),
    contextMenu: vi.fn(),
    regionMoved: vi.fn(),
    regionResized: vi.fn(),
    deleteRegion: vi.fn(),
    createRegion: vi.fn(),
    regionClicked: vi.fn(),
  };
}

function openedCanvas(flowText: string, tool: 'select' | 'node' | 'context' = 'select') {
  const doc = parseFlow(flowText);
  assignMissingIds(doc);
  const model = buildModel(doc, null);
  model.sourcePath = 'regions.flow';

  const layer = new ExpansionLayer({ onNeedsRender: () => {}, readExternalFile: async () => null });
  const actions = stubActions();
  const canvas = createCanvasMock();
  const view = new CanvasView(canvas, actions, layer);
  view.setModel(model);
  view.setTool(tool);
  view.refreshDisplayGeometry();

  return { doc, view, actions, canvas, nodeNamed: (name: string) => allNodes(doc).find((n) => n.name === name)! };
}

function listenerFor(canvas: HTMLCanvasElement, type: string) {
  const calls = (canvas.addEventListener as unknown as { mock: { calls: [string, (event: unknown) => void][] } }).mock.calls;
  return calls.find(([name]) => name === type)![1];
}

// The identity camera makes screen and world coordinates the same, so gesture points are world points.
function dragOnCanvas(canvas: HTMLCanvasElement, from: Point, to: Point, options: { shiftKey?: boolean } = {}): void {
  const shiftKey = options.shiftKey ?? false;
  listenerFor(canvas, 'pointerdown')({ button: 0, pointerId: 1, clientX: from.x, clientY: from.y, shiftKey, detail: 1 });
  listenerFor(canvas, 'pointermove')({ pointerId: 1, clientX: to.x, clientY: to.y });
  listenerFor(canvas, 'pointerup')({ pointerId: 1, clientX: to.x, clientY: to.y, detail: 1 });
}

function cancelledDrag(canvas: HTMLCanvasElement, from: Point, to: Point): void {
  listenerFor(canvas, 'pointerdown')({ button: 0, pointerId: 1, clientX: from.x, clientY: from.y, shiftKey: false, detail: 1 });
  listenerFor(canvas, 'pointermove')({ pointerId: 1, clientX: to.x, clientY: to.y });
  listenerFor(canvas, 'pointercancel')({ pointerId: 1, clientX: to.x, clientY: to.y });
}

function centerOf(node: FlowNode): Point {
  return { x: node.pos!.x + node.pos!.w / 2, y: node.pos!.y + node.pos!.h / 2 };
}

function changesFrom(actions: CanvasActions): MembershipChange[] {
  const calls = (actions.moveCommitted as unknown as { mock: { calls: [FlowNode[], MembershipChange[]][] } }).mock.calls;
  expect(calls.length).toBe(1);
  return calls[0][1] ?? [];
}

function asNames(changes: MembershipChange[]) {
  return changes.map((change) => [change.block.name, change.node.name, change.joins ? 'joins' : 'leaves']);
}

describe('dragging a node into a region', () => {
  it('adds it once it is fully inside', () => {
    const { actions, canvas, nodeNamed } = openedCanvas(REGIONED_FLOW);
    const a = nodeNamed('A');
    const b = nodeNamed('B');
    // Land B beside A, well within the frozen frame around A.
    dragOnCanvas(canvas, centerOf(b), { x: centerOf(a).x, y: centerOf(a).y + 4 });
    expect(asNames(changesFrom(actions))).toEqual([['Auth', 'B', 'joins']]);
  });

  it('leaves membership alone while the node only overlaps the frame', () => {
    const { actions, canvas, nodeNamed } = openedCanvas(REGIONED_FLOW);
    const a = nodeNamed('A');
    const b = nodeNamed('B');
    // Straddles the border: touching a region is not joining it.
    dragOnCanvas(canvas, centerOf(b), { x: a.pos!.x - 100, y: centerOf(a).y });
    expect(changesFrom(actions)).toEqual([]);
  });
});

// The case the frozen frame exists for: a region with no `pos` is the bounds of its members, so
// measuring against its live rect would let the frame follow the node and no member could leave.
describe('dragging the only member out of a region with no drawn area', () => {
  it('removes it', () => {
    const { actions, canvas, nodeNamed } = openedCanvas(REGIONED_FLOW);
    const a = nodeNamed('A');
    dragOnCanvas(canvas, centerOf(a), { x: 2000, y: 2000 });
    expect(asNames(changesFrom(actions))).toEqual([['Auth', 'A', 'leaves']]);
  });

  it('keeps it while it stays inside', () => {
    const { actions, canvas, nodeNamed } = openedCanvas(REGIONED_FLOW);
    const a = nodeNamed('A');
    dragOnCanvas(canvas, centerOf(a), { x: centerOf(a).x + 6, y: centerOf(a).y + 6 });
    expect(changesFrom(actions)).toEqual([]);
  });
});

describe('dragging a multi-node selection', () => {
  it('carries every node in it, not only the one under the cursor (R16)', () => {
    const { actions, canvas, nodeNamed } = openedCanvas(GROUP_FLOW);
    const p = nodeNamed('P');
    const q = nodeNamed('Q');
    listenerFor(canvas, 'pointerdown')({ button: 0, pointerId: 1, clientX: centerOf(q).x, clientY: centerOf(q).y, shiftKey: true, detail: 1 });
    listenerFor(canvas, 'pointerup')({ pointerId: 1, clientX: centerOf(q).x, clientY: centerOf(q).y, detail: 1 });
    dragOnCanvas(canvas, centerOf(p), { x: centerOf(p).x - 1100, y: centerOf(p).y }, { shiftKey: true });

    expect(asNames(changesFrom(actions)).sort()).toEqual([
      ['Group', 'P', 'joins'],
      ['Group', 'Q', 'joins'],
    ]);
  });
});

describe('a node dropped where two regions overlap', () => {
  it('joins each of them independently (R15)', () => {
    const { actions, canvas, nodeNamed } = openedCanvas(OVERLAPPING_FLOW);
    const outside = nodeNamed('Outside');
    dragOnCanvas(canvas, centerOf(outside), { x: 550, y: 350 });
    expect(asNames(changesFrom(actions)).sort()).toEqual([
      ['Left', 'Outside', 'joins'],
      ['Right', 'Outside', 'joins'],
    ]);
  });

  it('joins only the one it landed inside', () => {
    const { actions, canvas, nodeNamed } = openedCanvas(OVERLAPPING_FLOW);
    const outside = nodeNamed('Outside');
    dragOnCanvas(canvas, centerOf(outside), { x: 200, y: 350 });
    expect(asNames(changesFrom(actions))).toEqual([['Left', 'Outside', 'joins']]);
  });
});

describe('an abandoned drag', () => {
  it('reports nothing and leaves the file untouched', () => {
    const { doc, actions, canvas, nodeNamed } = openedCanvas(REGIONED_FLOW);
    const b = nodeNamed('B');
    const startPosition = { ...b.pos! };
    cancelledDrag(canvas, centerOf(b), { x: 300, y: 244 });
    expect(actions.moveCommitted).not.toHaveBeenCalled();
    expect(b.pos).toEqual(startPosition);
    expect(contextBlockNamed(doc, 'Auth')!.members).toEqual(['A']);
  });
});

function pressAt(canvas: HTMLCanvasElement, point: Point): void {
  listenerFor(canvas, 'pointerdown')({ button: 0, pointerId: 1, clientX: point.x, clientY: point.y, shiftKey: false, detail: 1 });
  listenerFor(canvas, 'pointerup')({ pointerId: 1, clientX: point.x, clientY: point.y, detail: 1 });
}

function regionChangesFrom(actions: CanvasActions, key: 'regionMoved' | 'regionResized'): MembershipChange[] {
  const calls = (actions[key] as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  expect(calls.length).toBe(1);
  return (key === 'regionMoved' ? calls[0][2] : calls[0][1]) as MembershipChange[];
}

describe('pressing a region', () => {
  it('selects it by its frame', () => {
    const { view, canvas } = openedCanvas(ZONE_FLOW);
    pressAt(canvas, { x: 0, y: 300 });
    expect(view.selectedRegion?.block.name).toBe('Zone');
  });

  it('leaves its interior to the marquee, since a region encloses nodes it does not own (R27)', () => {
    const { view, canvas, nodeNamed } = openedCanvas(ZONE_FLOW);
    dragOnCanvas(canvas, { x: 100, y: 100 }, { x: 500, y: 400 });
    expect(view.selectedRegion).toBeNull();
    expect([...view.selection]).toEqual([nodeNamed('Inside')]);
  });

  it('deselects it when the press lands on empty canvas', () => {
    const { view, canvas } = openedCanvas(ZONE_FLOW);
    pressAt(canvas, { x: 0, y: 300 });
    pressAt(canvas, { x: 1200, y: 300 });
    expect(view.selectedRegion).toBeNull();
  });
});

describe('moving a region', () => {
  it('carries its members and sweeps in a node it lands around (R29)', () => {
    const { actions, canvas, nodeNamed } = openedCanvas(ZONE_FLOW);
    const inside = nodeNamed('Inside');
    dragOnCanvas(canvas, { x: 0, y: 300 }, { x: 1300, y: 900 });

    // Positions land on the same grid a node drag snaps to.
    expect(inside.pos).toEqual({ x: 1504, y: 800, w: 200, h: 88 });
    expect(asNames(regionChangesFrom(actions, 'regionMoved'))).toEqual([['Zone', 'Far', 'joins']]);
  });

  it('rolls the frame and its members back when the gesture is cancelled', () => {
    const { doc, actions, canvas, nodeNamed } = openedCanvas(ZONE_FLOW);
    const inside = nodeNamed('Inside');
    cancelledDrag(canvas, { x: 0, y: 300 }, { x: 1300, y: 900 });

    expect(inside.pos).toEqual({ x: 200, y: 200, w: 200, h: 88 });
    expect(contextBlockNamed(doc, 'Zone')!.pos).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(actions.regionMoved).not.toHaveBeenCalled();
  });
});

describe('resizing a region', () => {
  it('shuts out a member the drawn rectangle no longer covers (R31)', () => {
    const { doc, actions, canvas } = openedCanvas(ZONE_FLOW);
    pressAt(canvas, { x: 0, y: 300 });
    dragOnCanvas(canvas, { x: 800, y: 600 }, { x: 300, y: 250 });

    expect(contextBlockNamed(doc, 'Zone')!.pos).toEqual({ x: 0, y: 0, w: 304, h: 248 });
    expect(asNames(regionChangesFrom(actions, 'regionResized'))).toEqual([['Zone', 'Inside', 'leaves']]);
  });

  // Nothing about a reserved area needs to stay big enough to hold anything.
  it('is not clamped to a minimum size', () => {
    const { doc, canvas } = openedCanvas(ZONE_FLOW);
    pressAt(canvas, { x: 0, y: 300 });
    dragOnCanvas(canvas, { x: 800, y: 600 }, { x: 20, y: 10 });
    expect(contextBlockNamed(doc, 'Zone')!.pos).toEqual({ x: 0, y: 0, w: 24, h: 8 });
  });

  it('rolls back when the gesture is cancelled', () => {
    const { doc, actions, canvas } = openedCanvas(ZONE_FLOW);
    pressAt(canvas, { x: 0, y: 300 });
    cancelledDrag(canvas, { x: 800, y: 600 }, { x: 300, y: 250 });
    expect(contextBlockNamed(doc, 'Zone')!.pos).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(actions.regionResized).not.toHaveBeenCalled();
  });
});

describe('drawing a region with the context tool', () => {
  it('takes in every node the rectangle encloses, and no node it merely overlaps (R9)', () => {
    const { actions, canvas } = openedCanvas(ZONE_FLOW, 'context');
    // Encloses Inside (200,200,200,88) whole; clips Far (1400,900) entirely out.
    dragOnCanvas(canvas, { x: 150, y: 150 }, { x: 600, y: 400 });

    const calls = (actions.createRegion as unknown as { mock: { calls: [Rect, FlowNode | null, string[]][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][2]).toEqual(['Inside']);
    expect(calls[0][1]).toBeNull();
  });

  it('excludes a node the rectangle only cuts across', () => {
    const { actions, canvas } = openedCanvas(ZONE_FLOW, 'context');
    dragOnCanvas(canvas, { x: 150, y: 150 }, { x: 300, y: 400 });
    const calls = (actions.createRegion as unknown as { mock: { calls: [Rect, FlowNode | null, string[]][] } }).mock.calls;
    expect(calls[0][2]).toEqual([]);
  });

  it('creates nothing from a rectangle too small to be deliberate', () => {
    const { actions, canvas } = openedCanvas(ZONE_FLOW, 'context');
    dragOnCanvas(canvas, { x: 150, y: 150 }, { x: 156, y: 154 });
    expect(actions.createRegion).not.toHaveBeenCalled();
    expect(actions.createNode).not.toHaveBeenCalled();
  });

  it('still creates a node when the node tool drew the rectangle', () => {
    const { actions, canvas } = openedCanvas(ZONE_FLOW, 'node');
    dragOnCanvas(canvas, { x: 900, y: 100 }, { x: 1100, y: 300 });
    expect(actions.createNode).toHaveBeenCalled();
    expect(actions.createRegion).not.toHaveBeenCalled();
  });
});
