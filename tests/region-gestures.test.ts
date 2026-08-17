import { describe, expect, it } from 'vitest';
import {
  applyCombinedMove,
  applyRegionMove,
  applyRegionResize,
  movingRegionGroupFor,
  regionRectDuringResize,
  regionRectsWithDrawnMove,
  regionRectsWithDrawnResize,
  rollbackCombinedMove,
  rollbackRegionMove,
  rollbackRegionResize,
  type CombinedMoveSnapshot,
  type RegionMoveSnapshot,
  type RegionResizeSnapshot,
} from '../src/client/canvas/region-gestures.js';
import type { ModelContext } from '../src/client/flow-doc.js';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel } from '../src/client/flow-doc.js';

const identity = (value: number) => value;
const snap8 = (value: number) => Math.round(value / 8) * 8;

const DRAWN = `---
name: Demo
---

context: Auth
  pos: 0, 0, 200, 120
  nodes:
    - Login

Login
  id: 11111111-1111-4111-8111-111111111111
  pos: 40, 40, 120, 64
`;

const MEMBER_DERIVED = `---
name: Demo
---

context: Auth
  nodes:
    - Login

Login
  id: 11111111-1111-4111-8111-111111111111
  pos: 40, 40, 120, 64
`;

// A second drawn region, used only to prove the move math translates carried blocks.
const CONTAINED = `---
name: Demo
---

context: Auth
  pos: 0, 0, 200, 120
  nodes:

context: Inner
  pos: 300, 300, 200, 120
  nodes:
`;

function contextNamed(text: string, name: string): ModelContext {
  const model = buildModel(parseFlow(text), null);
  const context = model.contexts.find((entry) => entry.block.name === name);
  if (!context) throw new Error(`missing context ${name}`);
  return context;
}

describe('applyRegionMove', () => {
  it('moves members and an authored pos by the same delta', () => {
    const context = contextNamed(DRAWN, 'Auth');
    const member = context.members[0];
    const gesture: RegionMoveSnapshot = {
      context,
      carriedContexts: [],
      startPositions: new Map([[member, { x: member.pos!.x, y: member.pos!.y }]]),
      startRects: new Map([[context.block, { ...context.block.pos! }]]),
      startWorld: { x: 10, y: 10 },
      moved: false,
    };
    applyRegionMove(gesture, { x: 26, y: 18 }, identity);
    expect(gesture.moved).toBe(true);
    expect(member.pos).toEqual({ x: 56, y: 48, w: 120, h: 64 });
    expect(context.block.pos).toEqual({ x: 16, y: 8, w: 200, h: 120 });
  });

  it('does not invent a pos when the region was member-derived', () => {
    const context = contextNamed(MEMBER_DERIVED, 'Auth');
    const member = context.members[0];
    const gesture: RegionMoveSnapshot = {
      context,
      carriedContexts: [],
      startPositions: new Map([[member, { x: 40, y: 40 }]]),
      startRects: new Map(),
      startWorld: { x: 0, y: 0 },
      moved: false,
    };
    applyRegionMove(gesture, { x: 8, y: 8 }, snap8);
    expect(context.block.pos).toBeNull();
    expect(member.pos!.x).toBe(48);
    expect(member.pos!.y).toBe(48);
  });

  it('translates the pos of every region of the group by the same delta', () => {
    const outer = contextNamed(DRAWN, 'Auth');
    const inner = contextNamed(CONTAINED, 'Inner');
    const gesture: RegionMoveSnapshot = {
      context: outer,
      carriedContexts: [inner],
      startPositions: new Map(),
      startRects: new Map([
        [outer.block, { ...outer.block.pos! }],
        [inner.block, { ...inner.block.pos! }],
      ]),
      startWorld: { x: 0, y: 0 },
      moved: false,
    };
    applyRegionMove(gesture, { x: 40, y: 24 }, identity);
    expect(outer.block.pos).toEqual({ x: 40, y: 24, w: 200, h: 120 });
    expect(inner.block.pos).toEqual({ x: 340, y: 324, w: 200, h: 120 });
  });
});

describe('applyRegionResize', () => {
  it('resizes without a minimum size', () => {
    const context = contextNamed(DRAWN, 'Auth');
    const gesture: RegionResizeSnapshot = {
      context,
      corner: 'se',
      startRect: { ...context.block.pos! },
      startWorld: { x: 200, y: 120 },
    };
    applyRegionResize(gesture, { x: 40, y: 30 }, identity);
    expect(context.block.pos).toEqual({ x: 0, y: 0, w: 40, h: 30 });
  });
});

describe('regionRectDuringResize', () => {
  it('returns the live pos for the region being resized', () => {
    const context = contextNamed(DRAWN, 'Auth');
    context.block.pos = { x: 0, y: 0, w: 40, h: 30 };
    const gesture = { context, corner: 'se' as const, startRect: { x: 0, y: 0, w: 200, h: 120 }, startWorld: { x: 0, y: 0 } };
    expect(regionRectDuringResize(context, gesture)).toEqual({ x: 0, y: 0, w: 40, h: 30 });
  });

  it('returns null for a different region', () => {
    const context = contextNamed(DRAWN, 'Auth');
    const other = contextNamed(DRAWN, 'Auth');
    const gesture = { context, corner: 'se' as const, startRect: { x: 0, y: 0, w: 200, h: 120 }, startWorld: { x: 0, y: 0 } };
    expect(regionRectDuringResize(other, gesture)).toBeNull();
  });
});

describe('regionRectsWithDrawnResize', () => {
  it('paints the drawn rectangle while shrinking past members', () => {
    const context = contextNamed(DRAWN, 'Auth');
    const frozen = new Map([[context.block, { x: 0, y: 0, w: 200, h: 120 }]]);
    context.block.pos = { x: 0, y: 0, w: 40, h: 30 };
    const painted = regionRectsWithDrawnResize(context, frozen);
    expect(painted.get(context.block)).toEqual({ x: 0, y: 0, w: 40, h: 30 });
  });

  it('leaves the frozen map unchanged when there is no drawn pos', () => {
    const context = contextNamed(MEMBER_DERIVED, 'Auth');
    const frozen = new Map([[context.block, { x: 32, y: 32, w: 136, h: 80 }]]);
    const painted = regionRectsWithDrawnResize(context, frozen);
    expect(painted).toBe(frozen);
  });
});

describe('rollback', () => {
  it('restores members and pos after an abandoned move', () => {
    const context = contextNamed(DRAWN, 'Auth');
    const member = context.members[0];
    const inner = contextNamed(CONTAINED, 'Inner');
    const gesture: RegionMoveSnapshot = {
      context,
      carriedContexts: [inner],
      startPositions: new Map([[member, { x: 40, y: 40 }]]),
      startRects: new Map([
        [context.block, { x: 0, y: 0, w: 200, h: 120 }],
        [inner.block, { x: 300, y: 300, w: 200, h: 120 }],
      ]),
      startWorld: { x: 0, y: 0 },
      moved: true,
    };
    applyRegionMove(gesture, { x: 50, y: 50 }, identity);
    rollbackRegionMove(gesture);
    expect(member.pos).toMatchObject({ x: 40, y: 40 });
    expect(context.block.pos).toEqual({ x: 0, y: 0, w: 200, h: 120 });
    expect(inner.block.pos).toEqual({ x: 300, y: 300, w: 200, h: 120 });
  });

  it('restores pos after an abandoned resize', () => {
    const context = contextNamed(DRAWN, 'Auth');
    const gesture: RegionResizeSnapshot = {
      context,
      corner: 'se',
      startRect: { x: 0, y: 0, w: 200, h: 120 },
      startWorld: { x: 200, y: 120 },
    };
    applyRegionResize(gesture, { x: 10, y: 10 }, identity);
    rollbackRegionResize(gesture);
    expect(context.block.pos).toEqual({ x: 0, y: 0, w: 200, h: 120 });
  });
});

const NESTED = `---
name: Nested
---

context: Outer
  pos: 0, 0, 800, 600
  nodes:
    - Host

context: Inner
  pos: 400, 320, 200, 120
  nodes:
    - Deep

context: Sibling
  pos: 900, 0, 400, 300
  nodes:

Host
  id: h-1
  pos: 200, 200, 200, 88

Deep
  id: d-1
  pos: 440, 360, 100, 50
`;

function modelOf(text: string) {
  return buildModel(parseFlow(text), null);
}

describe('movingRegionGroupFor', () => {
  it('adds every region fully contained in a selected region, once', () => {
    const model = modelOf(NESTED);
    const outer = model.contexts.find((context) => context.block.name === 'Outer')!;
    expect(movingRegionGroupFor(model, [outer]).map((context) => context.block.name)).toEqual(['Outer', 'Inner']);
  });

  it('dedupes a region that is both selected and contained', () => {
    const model = modelOf(NESTED);
    const outer = model.contexts.find((context) => context.block.name === 'Outer')!;
    const inner = model.contexts.find((context) => context.block.name === 'Inner')!;
    expect(movingRegionGroupFor(model, [outer, inner]).map((context) => context.block.name)).toEqual(['Outer', 'Inner']);
  });

  it('leaves a merely overlapping region out (R48)', () => {
    const model = modelOf(NESTED);
    const outer = model.contexts.find((context) => context.block.name === 'Outer')!;
    const inner = model.contexts.find((context) => context.block.name === 'Inner')!;
    expect(movingRegionGroupFor(model, [inner]).map((context) => context.block.name)).toEqual(['Inner']);
    expect(movingRegionGroupFor(model, [inner])).not.toContain(outer);
  });
});

describe('applyCombinedMove', () => {
  it('translates free nodes, carried members, and authored pos by one delta', () => {
    const model = modelOf(NESTED);
    const outer = model.contexts.find((context) => context.block.name === 'Outer')!;
    const inner = model.contexts.find((context) => context.block.name === 'Inner')!;
    const host = model.nodes.find((node) => node.name === 'Host')!;
    const deep = model.nodes.find((node) => node.name === 'Deep')!;
    const gesture: CombinedMoveSnapshot = {
      startPositions: new Map([
        [host, { x: 200, y: 200 }],
        [deep, { x: 440, y: 360 }],
      ]),
      scales: new Map(),
      movingRegions: [outer, inner],
      startRects: new Map([
        [outer.block, { ...outer.block.pos! }],
        [inner.block, { ...inner.block.pos! }],
      ]),
      startWorld: { x: 10, y: 10 },
      moved: false,
    };
    applyCombinedMove(gesture, { x: 42, y: 26 }, identity);
    expect(gesture.moved).toBe(true);
    expect(host.pos).toMatchObject({ x: 232, y: 216 });
    expect(deep.pos).toMatchObject({ x: 472, y: 376 });
    expect(outer.block.pos).toEqual({ x: 32, y: 16, w: 800, h: 600 });
    expect(inner.block.pos).toEqual({ x: 432, y: 336, w: 200, h: 120 });
  });

  it('divides node deltas by the locus scale while regions stay in world space', () => {
    const model = modelOf(NESTED);
    const host = model.nodes.find((node) => node.name === 'Host')!;
    const gesture: CombinedMoveSnapshot = {
      startPositions: new Map([[host, { x: 200, y: 200 }]]),
      scales: new Map([[host, 2]]),
      movingRegions: [],
      startRects: new Map(),
      startWorld: { x: 0, y: 0 },
      moved: false,
    };
    applyCombinedMove(gesture, { x: 80, y: 40 }, identity);
    expect(host.pos).toMatchObject({ x: 240, y: 220 });
  });

  it('rolls everything back', () => {
    const model = modelOf(NESTED);
    const outer = model.contexts.find((context) => context.block.name === 'Outer')!;
    const host = model.nodes.find((node) => node.name === 'Host')!;
    const gesture: CombinedMoveSnapshot = {
      startPositions: new Map([[host, { x: 200, y: 200 }]]),
      scales: new Map(),
      movingRegions: [outer],
      startRects: new Map([[outer.block, { x: 0, y: 0, w: 800, h: 600 }]]),
      startWorld: { x: 0, y: 0 },
      moved: true,
    };
    applyCombinedMove(gesture, { x: 50, y: 50 }, identity);
    rollbackCombinedMove(gesture);
    expect(host.pos).toMatchObject({ x: 200, y: 200 });
    expect(outer.block.pos).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
});

describe('regionRectsWithDrawnMove', () => {
  it('swaps live frames in for the moving regions and keeps the rest frozen', () => {
    const model = modelOf(NESTED);
    const outer = model.contexts.find((context) => context.block.name === 'Outer')!;
    const inner = model.contexts.find((context) => context.block.name === 'Inner')!;
    const sibling = model.contexts.find((context) => context.block.name === 'Sibling')!;
    const frozen = new Map([
      [outer.block, { x: 0, y: 0, w: 800, h: 600 }],
      [inner.block, { x: 400, y: 320, w: 200, h: 120 }],
      [sibling.block, { x: 900, y: 0, w: 400, h: 300 }],
    ]);
    outer.block.pos = { x: 100, y: 100, w: 800, h: 600 };
    const painted = regionRectsWithDrawnMove([outer], model, frozen);
    expect(painted.get(outer.block)).toEqual({ x: 100, y: 100, w: 800, h: 600 });
    expect(painted.get(sibling.block)).toEqual({ x: 900, y: 0, w: 400, h: 300 });
  });
});
