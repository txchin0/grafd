import { describe, expect, it } from 'vitest';
import {
  applyRegionMove,
  applyRegionResize,
  regionRectDuringResize,
  regionRectsWithDrawnResize,
  rollbackRegionMove,
  rollbackRegionResize,
  type RegionMoveSnapshot,
  type RegionResizeSnapshot,
} from '../src/client/canvas/region-gestures.js';
import type { ModelContext } from '../src/client/flow-doc.js';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel, regionRectOf } from '../src/client/flow-doc.js';

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
      startRect: { ...context.block.pos! },
      startPositions: new Map([[member, { x: member.pos!.x, y: member.pos!.y }]]),
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
      startRect: regionRectOf(buildModel(parseFlow(MEMBER_DERIVED), null), context)!,
      startPositions: new Map([[member, { x: 40, y: 40 }]]),
      startWorld: { x: 0, y: 0 },
      moved: false,
    };
    applyRegionMove(gesture, { x: 8, y: 8 }, snap8);
    expect(context.block.pos).toBeNull();
    expect(member.pos!.x).toBe(48);
    expect(member.pos!.y).toBe(48);
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
    const gesture: RegionMoveSnapshot = {
      context,
      startRect: { x: 0, y: 0, w: 200, h: 120 },
      startPositions: new Map([[member, { x: 40, y: 40 }]]),
      startWorld: { x: 0, y: 0 },
      moved: true,
    };
    applyRegionMove(gesture, { x: 50, y: 50 }, identity);
    rollbackRegionMove(gesture);
    expect(member.pos).toMatchObject({ x: 40, y: 40 });
    expect(context.block.pos).toEqual({ x: 0, y: 0, w: 200, h: 120 });
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
