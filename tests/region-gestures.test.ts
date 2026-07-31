import { describe, expect, it } from 'vitest';
import {
  applyRegionMove,
  applyRegionResize,
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
