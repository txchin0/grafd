import { describe, expect, it } from 'vitest';
import { addStroke, removeDrawings, type Stroke } from '../src/shared/canvas-drawings.js';
import {
  drawingGroupsOf,
  groupDrawings,
  groupMembersOf,
  pruneGroups,
  ungroupDrawings,
} from '../src/shared/canvas-groups.js';
import {
  documentIdentities,
  drawingListsAreEditable,
  emptyCanvasLayer,
  followIdentityChanges,
  parseCanvasLayer,
  serializeCanvasLayer,
  type CanvasLayer,
} from '../src/shared/canvas-layer.js';
import { lintCanvasLayer } from '../src/shared/canvas-layer-lint.js';
import { parseFlow } from '../src/shared/flow-format.js';

function stroke(id: string, graph: string | null = null): Stroke {
  return { id, graph, color: null, width: 'medium', points: [{ x: 0, y: 0 }, { x: 4, y: 4 }] };
}

function layerWithStrokes(...ids: string[]): CanvasLayer {
  const layer = emptyCanvasLayer();
  for (const id of ids) addStroke(layer, stroke(id));
  return layer;
}

function memberIdsOf(layer: CanvasLayer): string[][] {
  return layer.groups.map((group) => groupMembersOf(group).map((member) => member.id).sort());
}

describe('grouping drawings', () => {
  it('maps each grouped drawing to its whole group, and leaves the rest alone', () => {
    const layer = layerWithStrokes('a', 'b', 'c');
    groupDrawings(layer, new Set(['a', 'b']));
    const groups = drawingGroupsOf(layer);
    expect(groups.get('a')?.sort()).toEqual(['a', 'b']);
    expect(groups.get('b')?.sort()).toEqual(['a', 'b']);
    expect(groups.has('c')).toBe(false);
  });

  it('merges rather than nests: grouped drawings leave the group they were in', () => {
    const layer = layerWithStrokes('a', 'b', 'c', 'd');
    groupDrawings(layer, new Set(['a', 'b', 'c']));
    groupDrawings(layer, new Set(['c', 'd']));
    expect(memberIdsOf(layer)).toEqual([['a', 'b'], ['c', 'd']]);
    groupDrawings(layer, new Set(['b', 'd']));
    // a and c were each left alone in their old groups, which dissolve.
    expect(memberIdsOf(layer)).toEqual([['b', 'd']]);
  });

  it('needs two drawings to make a group', () => {
    const layer = layerWithStrokes('a');
    groupDrawings(layer, new Set(['a']));
    expect(layer.groups).toEqual([]);
  });

  it('ungroups a whole group from any one of its members', () => {
    const layer = layerWithStrokes('a', 'b', 'c', 'd');
    groupDrawings(layer, new Set(['a', 'b']));
    groupDrawings(layer, new Set(['c', 'd']));
    ungroupDrawings(layer, new Set(['a']));
    expect(memberIdsOf(layer)).toEqual([['c', 'd']]);
  });

  it('dissolves a group when deleting leaves it too few members', () => {
    const layer = layerWithStrokes('a', 'b', 'c');
    groupDrawings(layer, new Set(['a', 'b', 'c']));
    removeDrawings(layer, new Set(['a']));
    expect(memberIdsOf(layer)).toEqual([['b', 'c']]);
    removeDrawings(layer, new Set(['b']));
    expect(layer.groups).toEqual([]);
  });

  it('keeps members of kinds it does not know, and counts them', () => {
    const layer = layerWithStrokes('a');
    layer.groups = [{ id: 'g', members: [{ kind: 'drawing', id: 'a' }, { kind: 'node', id: 'n1' }] }];
    const before = layer.groups;
    pruneGroups(layer);
    expect(layer.groups).toBe(before);
  });

  it('drops a block\'s groups with the block\'s drawings', () => {
    const doc = parseFlow('---\nname: demo\n---\n\nHost\n  expand: Steps\n\ngraph: Steps\n  Inner\n');
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('a', 'Steps'));
    addStroke(layer, stroke('b', 'Steps'));
    groupDrawings(layer, new Set(['a', 'b']));
    const before = documentIdentities(doc);
    doc.items = doc.items.filter((item) => item.kind !== 'graph');
    expect(followIdentityChanges(layer, before, documentIdentities(doc))).toBe(true);
    expect(layer.groups).toEqual([]);
  });
});

describe('storing groups', () => {
  it('writes each group on one line before the drawings, and reads it back', () => {
    const layer = layerWithStrokes('a', 'b');
    groupDrawings(layer, new Set(['a', 'b']));
    const text = serializeCanvasLayer(layer)!;
    const lines = text.split('\n');
    const groupsLine = lines.findIndex((line) => line.includes('"groups"'));
    expect(lines[groupsLine + 1]).toContain('"members"');
    expect(groupsLine).toBeLessThan(lines.findIndex((line) => line.includes('"drawings"')));
    expect(parseCanvasLayer(text)).toEqual(layer);
  });

  it('keeps a groups value that is not a list as it is, and takes no drawing edits over it', () => {
    const layer = parseCanvasLayer(JSON.stringify({ groups: 'oops' }));
    expect(layer.groups).toEqual([]);
    expect(JSON.parse(serializeCanvasLayer(layer)!).groups).toBe('oops');
    expect(drawingListsAreEditable(layer)).toBe(false);
    expect(drawingListsAreEditable(parseCanvasLayer(JSON.stringify({ groups: [] })))).toBe(true);
  });
});

describe('linting groups', () => {
  it('reports members whose drawing is gone, and groups that are not lists', () => {
    const layer = layerWithStrokes('a', 'b');
    layer.groups = [{ id: 'g', members: [{ kind: 'drawing', id: 'a' }, { kind: 'drawing', id: 'gone' }] }];
    const text = serializeCanvasLayer(layer)!;
    const [diagnostic] = lintCanvasLayer(text, null).filter((entry) => entry.rule === 'stale-group-member');
    expect(diagnostic.severity).toBe('info');
    expect(text.split('\n')[diagnostic.line - 1]).toContain('"gone"');
    expect(lintCanvasLayer(JSON.stringify({ groups: 3 }), null).map((entry) => entry.rule)).toContain('invalid-groups');
  });
});

describe('groups written by hand', () => {
  it('keeps members it cannot read when a deletion shrinks the group', () => {
    const layer = layerWithStrokes('a', 'b', 'c');
    layer.groups = [{ id: 'g', members: [{ kind: 'drawing', id: 'a' }, { kind: 'drawing', id: 'b' }, 'odd', { kind: 'drawing' }] }];
    removeDrawings(layer, new Set(['a']));
    expect(layer.groups).toEqual([{ id: 'g', members: [{ kind: 'drawing', id: 'b' }, 'odd', { kind: 'drawing' }] }]);
  });

  it('leaves a group with no members list, or one already too short, as written', () => {
    const layer = layerWithStrokes('a');
    const groups = [{ id: 'g', note: 'by hand' }, { id: 'h', members: [{ kind: 'drawing', id: 'a' }] }];
    layer.groups = groups;
    pruneGroups(layer);
    expect(layer.groups).toBe(groups);
  });
});
