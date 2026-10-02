// Groups on a canvas layer: things picked up as one. Selecting any member selects them all, so a
// group moves, recolours and deletes together. A group is decoration like everything else in the
// layer and means nothing to the graph.
//
// Members are typed (`{ "kind": "drawing", "id": … }`) so later kinds — nodes, other groups —
// can join without a format change. This editor creates groups of drawings only, and keeps a
// member of a kind it does not know exactly as written.

import type { CanvasLayer } from './canvas-layer.js';
import { newUuid } from './flow-format.js';

export const DRAWING_MEMBER_KIND = 'drawing';
// Fewer than this and there is nothing to hold together.
const MIN_GROUP_MEMBERS = 2;

// One entry of the `groups` list, kept whole; the readers below validate what they read.
export type Group = { id?: unknown; members?: unknown } & Record<string, unknown>;

export interface GroupMember {
  kind: string;
  id: string;
}

export function groupMembersOf(group: Group): GroupMember[] {
  if (!Array.isArray(group.members)) return [];
  return group.members.filter(isGroupMember);
}

function isGroupMember(value: unknown): value is GroupMember {
  if (typeof value !== 'object' || value == null) return false;
  const member = value as Record<string, unknown>;
  return typeof member.kind === 'string' && typeof member.id === 'string';
}

function drawingIdsOf(group: Group): string[] {
  return groupMembersOf(group).filter((member) => member.kind === DRAWING_MEMBER_KIND).map((member) => member.id);
}

// Each grouped drawing's id, mapped to the ids of every drawing in its group (itself included).
// A drawing listed by two groups — only a hand edit does that — belongs to the first.
export function drawingGroupsOf(layer: CanvasLayer): Map<string, string[]> {
  const groupOf = new Map<string, string[]>();
  for (const group of layer.groups) {
    const ids = drawingIdsOf(group);
    for (const id of ids) {
      if (!groupOf.has(id)) groupOf.set(id, ids);
    }
  }
  return groupOf;
}

// The drawings become one new group. Any group they belonged to loses them first, so grouping
// members of two groups merges them rather than nesting one inside the other.
export function groupDrawings(layer: CanvasLayer, ids: ReadonlySet<string>): void {
  if (ids.size < MIN_GROUP_MEMBERS) return;
  const remaining = layer.groups.flatMap((group) => withoutMembersWhere(group, (member) => isDrawingIn(member, ids)));
  const members: GroupMember[] = [...ids].map((id) => ({ kind: DRAWING_MEMBER_KIND, id }));
  layer.groups = [...remaining, { id: newUuid(), members }];
}

// Dissolves every group holding any of the drawings, whole: ungrouping one member of a group
// ungroups all of it.
export function ungroupDrawings(layer: CanvasLayer, ids: ReadonlySet<string>): void {
  layer.groups = layer.groups.filter((group) => !drawingIdsOf(group).some((id) => ids.has(id)));
}

function isDrawingIn(member: GroupMember, ids: ReadonlySet<string>): boolean {
  return member.kind === DRAWING_MEMBER_KIND && ids.has(member.id);
}

// The group after removing the well-formed members `isRemoved` picks: as it was when none is,
// gone when the removal leaves too few to hold anything together, otherwise the rest. Everything
// else in the list — members of unknown kinds, entries this editor cannot read at all — is kept
// exactly as written. Only a removal dissolves a group: one that was already short, or that has
// no `members` list, was written that way by hand and is left for the linter to report.
function withoutMembersWhere(group: Group, isRemoved: (member: GroupMember) => boolean): Group[] {
  if (!Array.isArray(group.members)) return [group];
  const kept = group.members.filter((member) => !(isGroupMember(member) && isRemoved(member)));
  if (kept.length === group.members.length) return [group];
  return kept.length < MIN_GROUP_MEMBERS ? [] : [{ ...group, members: kept }];
}

// Drops members whose drawing is gone, and groups that leaves too short. Members of kinds this
// editor does not know are never judged gone. The list is only replaced when something changed,
// so an unchanged layer compares as unchanged.
export function pruneGroups(layer: CanvasLayer): void {
  const drawingIds = new Set(layer.drawings.flatMap((drawing) => (typeof drawing.id === 'string' ? [drawing.id] : [])));
  const isGone = (member: GroupMember) => member.kind === DRAWING_MEMBER_KIND && !drawingIds.has(member.id);
  const pruned = layer.groups.flatMap((group) => withoutMembersWhere(group, isGone));
  const changed = pruned.length !== layer.groups.length || pruned.some((group, index) => group !== layer.groups[index]);
  if (changed) layer.groups = pruned;
}

// The groups a set of copied drawings takes along, under the copies' ids: a group comes along
// when at least two of its members were copied, with a fresh id of its own.
export function groupsForCopies(groups: readonly Group[], copiedIds: ReadonlyMap<string, string>): Group[] {
  return groups.flatMap((group) => {
    const members = drawingIdsOf(group).flatMap((id) => {
      const copyId = copiedIds.get(id);
      return copyId ? [{ kind: DRAWING_MEMBER_KIND, id: copyId }] : [];
    });
    return members.length >= MIN_GROUP_MEMBERS ? [{ id: newUuid(), members }] : [];
  });
}
