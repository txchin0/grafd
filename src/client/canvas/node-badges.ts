// The expand/collapse affordances on a node carrying `expand`: where they sit, what they
// show, and how close a pointer has to be to count as hitting one.
//
// This is the contract between painting and hit-testing — the painter draws exactly these
// positions and the pointer code tests exactly them, so neither owns it and both read it.

import type { FlowNode } from '../../shared/flow-format.js';
import { displayRectOf, type FlowModel } from '../flow-doc.js';

export type BadgeKind = 'open' | 'inline' | 'collapse';

export interface Badge {
  kind: BadgeKind;
  x: number;
  y: number;
}

export interface BadgeHit {
  kind: BadgeKind;
  node: FlowNode;
}

export const BADGE_SYMBOLS: Record<BadgeKind, string> = { open: '⤢', inline: '⊞', collapse: '⊟' };
export const BADGE_HIT_RADIUS = 12;
export const BADGE_DIAMETER = 20;

const BADGE_SLOT_SPACING = 24;
const BADGE_INSET = { right: 16, top: 15 };

// Slots run right-to-left from the node's top-right corner. An unfolded node offers collapse
// where a folded one offers inline expansion; both always offer full-page open.
export function nodeBadges(model: FlowModel, node: FlowNode, isUnfolded: boolean): Badge[] {
  if (!model.traits.get(node)?.expand) return [];
  const rect = displayRectOf(model, node);
  const slotCenter = (slot: number) => ({
    x: rect.x + rect.w - BADGE_INSET.right - slot * BADGE_SLOT_SPACING,
    y: rect.y + BADGE_INSET.top,
  });
  return [
    { kind: 'open', ...slotCenter(0) },
    { kind: isUnfolded ? 'collapse' : 'inline', ...slotCenter(1) },
  ];
}
