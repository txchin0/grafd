// Dragging a node in or out of a region. Membership is written by gestures alone (R13/R14), and
// what a drag decides is measured against the frame each region had when the drag began — never
// its live one, which follows the node being dragged.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseFlow, serializeFlow, type FlowNode, type Rect } from '../src/shared/flow-format.js';
import {
  allNodes,
  assignMissingIds,
  buildModel,
  contextBlockNamed,
  addContextMember,
  type MembershipChange,
} from '../src/client/flow-doc.js';
import type { Point } from '../src/client/geometry.js';
import { ExpansionLayer } from '../src/client/canvas/expansion.js';
import type { CanvasActions, RegionTarget } from '../src/client/canvas/canvas-view.js';
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

// A drawn region enclosing a second drawn region whose member belongs only to the inner one, so
// a drag has to carry the group, not just the outer members (R28a).
const NESTED_FLOW = `---
name: Nested
---

context: Zone
  pos: 0, 0, 800, 600
  nodes:
    - Inside

context: Inner
  pos: 400, 320, 200, 120
  nodes:
    - Deep

Inside
  id: in-1
  pos: 200, 200, 200, 88

Deep
  id: deep-1
  pos: 440, 360, 100, 50
`;

// Same layout, but Deep is listed by both regions: the shared member must be carried once.
const SHARED_MEMBER_FLOW = `---
name: Shared
---

context: Zone
  pos: 0, 0, 800, 600
  nodes:
    - Inside
    - Deep

context: Inner
  pos: 400, 320, 200, 120
  nodes:
    - Deep

Inside
  id: in-1
  pos: 200, 200, 200, 88

Deep
  id: deep-1
  pos: 440, 360, 100, 50
`;

// An inner region with no drawn area: carrying it means carrying its members, never writing a pos.
const DERIVED_INNER_FLOW = `---
name: Derived
---

context: Zone
  pos: 0, 0, 800, 600
  nodes:
    - Inside

context: Inner
  nodes:
    - Deep

Inside
  id: in-1
  pos: 200, 200, 200, 88

Deep
  id: deep-1
  pos: 440, 360, 100, 50
`;

// NESTED_FLOW plus a stationary node the group's move leaves inside the carried frame: the
// carried region has to claim it, or it stays unassigned after the move.
const SWEPT_INTO_INNER_FLOW = `---
name: Swept
---

context: Zone
  pos: 0, 0, 800, 600
  nodes:
    - Inside

context: Inner
  pos: 400, 320, 200, 120
  nodes:
    - Deep

Inside
  id: in-1
  pos: 200, 200, 200, 88

Deep
  id: deep-1
  pos: 440, 360, 100, 50

Wanderer
  id: w-1
  pos: 1776, 936, 100, 50
`;

// DERIVED_INNER_FLOW plus a stationary node the move leaves inside the padded member bounds: the
// pos-free carried region sweeps it in without ever gaining a pos of its own.
const DERIVED_SWEEP_FLOW = `---
name: DerivedSweep
---

context: Zone
  pos: 0, 0, 800, 600
  nodes:
    - Inside

context: Inner
  nodes:
    - Deep

Inside
  id: in-1
  pos: 200, 200, 200, 88

Deep
  id: deep-1
  pos: 440, 360, 100, 50

Wanderer
  id: w-1
  pos: 1776, 936, 100, 50
`;

// Same geometry, with a member of the dragged region sitting inside the carried frame: it travels
// with the group and the carried region claims its interior, exactly as the dragged one does.
const LODGER_FLOW = `---
name: Lodger
---

context: Zone
  pos: 0, 0, 800, 600
  nodes:
    - Inside
    - Lodger

context: Inner
  pos: 400, 320, 400, 200
  nodes:
    - Deep

Inside
  id: in-1
  pos: 200, 200, 200, 88

Deep
  id: deep-1
  pos: 440, 360, 100, 50

Lodger
  id: lod-1
  pos: 560, 340, 120, 80
`;

// A stationary region the dragged frame comes to rest over: it stuck out of the frame at gesture
// start, so it is not carried, and the move must leave its membership alone even though the frame
// now encloses it. Passerby sits inside it unlisted, which is exactly the trap a sweep of the
// live containment would fall into.
const SWALLOW_FLOW = `---
name: Swallow
---

context: Big
  pos: 0, 0, 900, 900
  nodes:

context: Small
  pos: 820, 100, 200, 200
  nodes:
    - InSmall

InSmall
  id: s-1
  pos: 860, 140, 100, 50

Passerby
  id: p-1
  pos: 880, 200, 100, 50
`;

// A stationary region that does not travel with the drag: the dragged region's member N comes to
// rest fully inside B's frame, so the move adds N to B's list without sweeping anything else.
const ABSORBED_MEMBER_FLOW = `---
name: Absorb
---

context: A
  pos: 0, 0, 800, 600
  nodes:
    - N

context: B
  pos: 900, 0, 400, 300
  nodes:

N
  id: n-1
  pos: 200, 200, 200, 88
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
    editRegionTitle: vi.fn(),
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

describe('moving a region so a carried member lands inside a stationary region', () => {
  it('adds the member to the stationary region and reports it as a join', () => {
    const { doc, actions, canvas } = openedCanvas(ABSORBED_MEMBER_FLOW);
    // The stub records the report like the real action, then applies the membership change the
    // way the action's commit would, so the file effect is asserted alongside the gesture.
    actions.regionMoved = vi.fn((_region, _movedNodes, membershipChanges: MembershipChange[]) => {
      for (const change of membershipChanges) addContextMember(change.block, change.node.name);
    }) as unknown as typeof actions.regionMoved;
    dragOnCanvas(canvas, { x: 0, y: 300 }, { x: 800, y: 300 });

    expect(asNames(regionChangesFrom(actions, 'regionMoved'))).toEqual([['B', 'N', 'joins']]);
    expect(contextBlockNamed(doc, 'B')!.members).toEqual(['N']);
  });
});

describe('moving a region over a contained region', () => {
  // Dragging Zone by (1360, 600) lands every coordinate below on a grid multiple of 8.
  it('carries the inner frame, its members, and the sweep-in, and writes the frame to the file (R28a)', () => {
    const { doc, actions, canvas } = openedCanvas(NESTED_FLOW);
    dragOnCanvas(canvas, { x: 0, y: 300 }, { x: 1360, y: 900 });

    expect(contextBlockNamed(doc, 'Zone')!.pos).toEqual({ x: 1360, y: 600, w: 800, h: 600 });
    expect(contextBlockNamed(doc, 'Inner')!.pos).toEqual({ x: 1760, y: 920, w: 200, h: 120 });
    const deep = allNodes(doc).find((node) => node.name === 'Deep')!;
    expect(deep.pos).toEqual({ x: 1800, y: 960, w: 100, h: 50 });

    const movedCalls = (actions.regionMoved as unknown as { mock: { calls: [unknown, FlowNode[]][] } }).mock.calls;
    expect(movedCalls[0][1].map((node) => node.name)).toEqual(['Inside', 'Deep']);
    expect(asNames(regionChangesFrom(actions, 'regionMoved'))).toEqual([['Zone', 'Deep', 'joins']]);

    // The carried frame is a block property like the dragged one's, so it must survive a
    // serialize → parse round-trip, not just the in-memory mutation.
    const reparsed = parseFlow(serializeFlow(doc));
    expect(contextBlockNamed(reparsed, 'Inner')!.pos).toEqual({ x: 1760, y: 920, w: 200, h: 120 });
  });

  it('carries a member listed by both regions exactly once', () => {
    const { actions, canvas } = openedCanvas(SHARED_MEMBER_FLOW);
    dragOnCanvas(canvas, { x: 0, y: 300 }, { x: 1360, y: 900 });

    const movedCalls = (actions.regionMoved as unknown as { mock: { calls: [unknown, FlowNode[]][] } }).mock.calls;
    expect(movedCalls[0][1].map((node) => node.name)).toEqual(['Inside', 'Deep']);
  });

  it('leaves an inner region with no drawn area pos-free while carrying its members', () => {
    const { doc, actions, canvas } = openedCanvas(DERIVED_INNER_FLOW);
    dragOnCanvas(canvas, { x: 0, y: 300 }, { x: 1360, y: 900 });

    expect(contextBlockNamed(doc, 'Inner')!.pos).toBeNull();
    const deep = allNodes(doc).find((node) => node.name === 'Deep')!;
    expect(deep.pos).toEqual({ x: 1800, y: 960, w: 100, h: 50 });
    expect(asNames(regionChangesFrom(actions, 'regionMoved'))).toEqual([['Zone', 'Deep', 'joins']]);
  });

  it('rolls the carried region and its members back when the gesture is cancelled', () => {
    const { doc, actions, canvas } = openedCanvas(NESTED_FLOW);
    cancelledDrag(canvas, { x: 0, y: 300 }, { x: 1360, y: 900 });

    expect(contextBlockNamed(doc, 'Zone')!.pos).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(contextBlockNamed(doc, 'Inner')!.pos).toEqual({ x: 400, y: 320, w: 200, h: 120 });
    const deep = allNodes(doc).find((node) => node.name === 'Deep')!;
    expect(deep.pos).toEqual({ x: 440, y: 360, w: 100, h: 50 });
    expect(actions.regionMoved).not.toHaveBeenCalled();
  });

  it('leaves a region it merely overlaps alone (R48)', () => {
    const { doc, canvas } = openedCanvas(OVERLAPPING_FLOW);
    dragOnCanvas(canvas, { x: 0, y: 300 }, { x: 48, y: 300 });

    expect(contextBlockNamed(doc, 'Left')!.pos).toEqual({ x: 48, y: 0, w: 700, h: 700 });
    expect(contextBlockNamed(doc, 'Right')!.pos).toEqual({ x: 400, y: 0, w: 700, h: 700 });
    expect(allNodes(doc).find((node) => node.name === 'Outside')!.pos).toEqual({ x: 1600, y: 900, w: 200, h: 88 });
  });

  it('sweeps a stationary node the carried frame comes to rest over into the carried region', () => {
    const { actions, canvas } = openedCanvas(SWEPT_INTO_INNER_FLOW);
    dragOnCanvas(canvas, { x: 0, y: 300 }, { x: 1360, y: 900 });

    expect(asNames(regionChangesFrom(actions, 'regionMoved')).sort()).toEqual([
      ['Inner', 'Wanderer', 'joins'],
      ['Zone', 'Deep', 'joins'],
      ['Zone', 'Wanderer', 'joins'],
    ]);
  });

  it('sweeps into a carried region with no drawn area, which stays pos-free', () => {
    const { doc, actions, canvas } = openedCanvas(DERIVED_SWEEP_FLOW);
    dragOnCanvas(canvas, { x: 0, y: 300 }, { x: 1360, y: 900 });

    expect(contextBlockNamed(doc, 'Inner')!.pos).toBeNull();
    expect(asNames(regionChangesFrom(actions, 'regionMoved')).sort()).toEqual([
      ['Inner', 'Wanderer', 'joins'],
      ['Zone', 'Deep', 'joins'],
      ['Zone', 'Wanderer', 'joins'],
    ]);
  });

  // The dragged region claims its whole interior (R29), and so does each carried one: a member of
  // the dragged region already sitting inside the carried frame joins it as the group travels.
  it('claims the carried frame for a travelling member that already sat inside it', () => {
    const { actions, canvas } = openedCanvas(LODGER_FLOW);
    dragOnCanvas(canvas, { x: 0, y: 300 }, { x: 1360, y: 900 });

    expect(asNames(regionChangesFrom(actions, 'regionMoved')).sort()).toEqual([
      ['Inner', 'Lodger', 'joins'],
      ['Zone', 'Deep', 'joins'],
    ]);
  });

  // The carried set was frozen at gesture start: a stationary region the dragged frame merely
  // comes to rest over is not part of it, and its membership is untouched — Passerby sits inside
  // Small unlisted, and stays unlisted.
  it('leaves a stationary region the dragged frame comes to rest over unswept', () => {
    const { doc, actions, canvas } = openedCanvas(SWALLOW_FLOW);
    dragOnCanvas(canvas, { x: 0, y: 300 }, { x: 400, y: 300 });

    expect(contextBlockNamed(doc, 'Big')!.pos).toEqual({ x: 400, y: 0, w: 900, h: 900 });
    expect(contextBlockNamed(doc, 'Small')!.pos).toEqual({ x: 820, y: 100, w: 200, h: 200 });
    expect(asNames(regionChangesFrom(actions, 'regionMoved')).sort()).toEqual([
      ['Big', 'InSmall', 'joins'],
      ['Big', 'Passerby', 'joins'],
    ]);
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

function doubleClickOnCanvas(canvas: HTMLCanvasElement, point: Point): void {
  listenerFor(canvas, 'pointerdown')({
    button: 0,
    pointerId: 1,
    clientX: point.x,
    clientY: point.y,
    shiftKey: false,
    detail: 1,
  });
  listenerFor(canvas, 'pointerup')({ pointerId: 1, clientX: point.x, clientY: point.y, detail: 1 });
  listenerFor(canvas, 'pointerdown')({
    button: 0,
    pointerId: 1,
    clientX: point.x,
    clientY: point.y,
    shiftKey: false,
    detail: 2,
  });
  listenerFor(canvas, 'pointerup')({ pointerId: 1, clientX: point.x, clientY: point.y, detail: 2 });
  listenerFor(canvas, 'dblclick')({
    button: 0,
    clientX: point.x,
    clientY: point.y,
    shiftKey: false,
    detail: 2,
  });
}

describe('double-clicking a region label', () => {
  // With the mocked measureText width of 0, the label band is only as wide as its hit padding.
  const labelPoint = { x: 12, y: 16 };

  it('opens inline title edit on the label', () => {
    const { actions, canvas } = openedCanvas(ZONE_FLOW);
    doubleClickOnCanvas(canvas, labelPoint);
    expect(actions.editRegionTitle).toHaveBeenCalledTimes(1);
    const calls = (actions.editRegionTitle as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].block.name).toBe('Zone');
  });

  it('does not open inline title edit on the border alone', () => {
    const { actions, canvas } = openedCanvas(ZONE_FLOW);
    doubleClickOnCanvas(canvas, { x: 0, y: 300 });
    expect(actions.editRegionTitle).not.toHaveBeenCalled();
  });

  it('opens the region editor only on the first click of a double-click', () => {
    const { actions, canvas } = openedCanvas(ZONE_FLOW);
    doubleClickOnCanvas(canvas, labelPoint);
    expect(actions.regionClicked).toHaveBeenCalledTimes(1);
  });
});

// A region with a member, a second region holding a free node, so a mixed selection drag can
// move a region and a node at once and the free node can leave a stationary frame (R50).
const MIXED_FLOW = `---
name: Mixed
---

context: Zone
  pos: 0, 0, 800, 600
  nodes:
    - Inside

context: Other
  pos: 900, 0, 400, 300
  nodes:
    - Wanderer

Inside
  id: in-1
  pos: 200, 200, 200, 88

Wanderer
  id: w-1
  pos: 1000, 100, 200, 88
`;

function shiftPressAt(canvas: HTMLCanvasElement, point: Point): void {
  listenerFor(canvas, 'pointerdown')({ button: 0, pointerId: 1, clientX: point.x, clientY: point.y, shiftKey: true, detail: 1 });
  listenerFor(canvas, 'pointerup')({ pointerId: 1, clientX: point.x, clientY: point.y, detail: 1 });
}

describe('multi-selecting regions with the select tool', () => {
  it('shift-click adds a region to a node selection (R50)', () => {
    const { view, canvas, nodeNamed } = openedCanvas(MIXED_FLOW);
    pressAt(canvas, centerOf(nodeNamed('Wanderer')));
    shiftPressAt(canvas, { x: 0, y: 300 });

    expect(view.selectedRegion?.block.name).toBe('Zone');
    expect([...view.selection]).toEqual([nodeNamed('Wanderer')]);
  });

  it('shift-click on a selected region deselects it, keeping the nodes', () => {
    const { view, canvas, nodeNamed } = openedCanvas(MIXED_FLOW);
    pressAt(canvas, centerOf(nodeNamed('Wanderer')));
    shiftPressAt(canvas, { x: 0, y: 300 });
    shiftPressAt(canvas, { x: 0, y: 300 });

    expect(view.selectedRegion).toBeNull();
    expect([...view.selection]).toEqual([nodeNamed('Wanderer')]);
  });

  it('marquee selects a region only when the marquee encloses its whole frame (R50)', () => {
    const { view, canvas } = openedCanvas(ZONE_FLOW);
    dragOnCanvas(canvas, { x: -20, y: -20 }, { x: 820, y: 620 });

    expect(view.selectedRegion?.block.name).toBe('Zone');
  });

  it('marquee that only intersects a region leaves it unselected', () => {
    const { view, canvas } = openedCanvas(ZONE_FLOW);
    dragOnCanvas(canvas, { x: 400, y: 300 }, { x: 1200, y: 900 });

    expect(view.selectedRegion).toBeNull();
  });

  it('marquee still starts inside a region interior, and selects a fully enclosed inner region', () => {
    const { view, canvas } = openedCanvas(NESTED_FLOW);
    dragOnCanvas(canvas, { x: 300, y: 300 }, { x: 700, y: 500 });

    expect(view.selectedRegion?.block.name).toBe('Inner');
    expect(view.selectedRegions.size).toBe(1);
  });

  it('pressing an already-selected region keeps the whole selection', () => {
    const { view, canvas, nodeNamed } = openedCanvas(MIXED_FLOW);
    pressAt(canvas, centerOf(nodeNamed('Wanderer')));
    shiftPressAt(canvas, { x: 0, y: 300 });
    pressAt(canvas, { x: 0, y: 300 });

    expect(view.selectedRegion?.block.name).toBe('Zone');
    expect([...view.selection]).toEqual([nodeNamed('Wanderer')]);
  });

  it('closes open editors at press time, even on a shift-toggle', () => {
    const { actions, canvas } = openedCanvas(MIXED_FLOW);
    shiftPressAt(canvas, { x: 0, y: 300 });
    expect(actions.canvasClicked).toHaveBeenCalled();
  });
});

describe('moving a mixed selection', () => {
  it('translates the region, its members, and the selected node together, one report (R50)', () => {
    const { doc, actions, canvas, nodeNamed } = openedCanvas(MIXED_FLOW);
    pressAt(canvas, { x: 0, y: 300 });
    dragOnCanvas(canvas, centerOf(nodeNamed('Wanderer')), { x: 1900, y: 744 }, { shiftKey: true });

    expect(contextBlockNamed(doc, 'Zone')!.pos).toEqual({ x: 800, y: 600, w: 800, h: 600 });
    expect(nodeNamed('Inside').pos).toEqual({ x: 1000, y: 800, w: 200, h: 88 });
    expect(nodeNamed('Wanderer').pos).toEqual({ x: 1800, y: 704, w: 200, h: 88 });

    const movedCalls = (actions.regionMoved as unknown as { mock: { calls: [RegionTarget[], FlowNode[]][] } }).mock.calls;
    expect(movedCalls[0][1].map((node) => node.name)).toEqual(['Wanderer', 'Inside']);
    expect(movedCalls[0][0].map((region) => region.block.name)).toEqual(['Zone']);
  });

  it('lets a free selected node leave a stationary region it travelled out of (R13)', () => {
    const { actions, canvas, nodeNamed } = openedCanvas(MIXED_FLOW);
    pressAt(canvas, { x: 0, y: 300 });
    dragOnCanvas(canvas, centerOf(nodeNamed('Wanderer')), { x: 1800, y: 700 }, { shiftKey: true });

    expect(asNames(regionChangesFrom(actions, 'regionMoved'))).toEqual([['Other', 'Wanderer', 'leaves']]);
  });

  it('never offers resize handles to a mixed selection — the corner is just more border', () => {
    const { actions, canvas, nodeNamed } = openedCanvas(MIXED_FLOW);
    pressAt(canvas, { x: 0, y: 300 });
    shiftPressAt(canvas, centerOf(nodeNamed('Wanderer')));
    dragOnCanvas(canvas, { x: 800, y: 600 }, { x: 880, y: 600 });

    expect(actions.regionResized).not.toHaveBeenCalled();
    expect(actions.regionMoved).toHaveBeenCalledTimes(1);
  });
});
