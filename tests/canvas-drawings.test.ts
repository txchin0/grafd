import { describe, expect, it } from 'vitest';
import {
  addStroke,
  drawingsForExtractedDocument,
  drawingsToCopy,
  pasteDrawings,
  removeDrawings,
  setDrawingColor,
  strokeBounds,
  strokeOf,
  strokePointBounds,
  drawingsInScope,
  transformDrawings,
  type Stroke,
} from '../src/shared/canvas-drawings.js';
import { translationBy } from '../src/shared/drawing-geometry.js';
import { drawingGroupsOf, groupDrawings, groupMembersOf, ungroupDrawings } from '../src/shared/canvas-groups.js';
import {
  documentIdentities,
  emptyCanvasLayer,
  followIdentityChanges,
  parseCanvasLayer,
  serializeCanvasLayer,
} from '../src/shared/canvas-layer.js';
import { parseFlow, type GraphItem } from '../src/shared/flow-format.js';
import * as FlowDoc from '../src/client/flow-doc.js';

const FLOW = `---
name: demo
---

Host
  id: 11111111-1111-4111-8111-111111111111
  expand: Steps

graph: Steps
  Inner
    id: 22222222-2222-4222-8222-222222222222
`;

function stroke(id: string, graph: string | null, points = [{ x: 0, y: 0 }, { x: 10, y: 5 }]): Stroke {
  return { kind: 'stroke', id, graph, color: null, width: 'medium', points };
}

function graphBlock(doc: ReturnType<typeof parseFlow>, name: string): GraphItem {
  return doc.items.find((item): item is GraphItem => item.kind === 'graph' && item.name === name)!;
}

describe('stroke storage', () => {
  it('writes each drawing on one line and reads it back', () => {
    const layer = emptyCanvasLayer();
    addStroke(layer, { ...stroke('s1', 'Steps'), color: 'red', width: 'thick' });
    addStroke(layer, stroke('s2', null));
    const text = serializeCanvasLayer(layer)!;
    const drawingLines = text.split('\n').filter((line) => line.includes('"kind":"stroke"'));
    expect(drawingLines).toHaveLength(2);
    expect(JSON.parse(text).drawings[0]).toEqual({
      id: 's1', kind: 'stroke', graph: 'Steps', color: 'red', width: 'thick', points: [[0, 0], [10, 5]],
    });
    expect(parseCanvasLayer(text)).toEqual(layer);
  });

  it('never writes the default width or ink, nor a graph for the file body', () => {
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('s1', null));
    expect(layer.drawings[0]).toEqual({ id: 's1', kind: 'stroke', points: [[0, 0], [10, 5]] });
  });

  it('rounds points to a tenth of a unit', () => {
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('s1', null, [{ x: 1.234, y: -5.678 }]));
    expect(layer.drawings[0].points).toEqual([[1.2, -5.7]]);
  });

  it('keeps unknown kinds and fields, and a drawings value that is not a list', () => {
    const kept = parseCanvasLayer(JSON.stringify({
      drawings: [{ id: 't', kind: 'sticker', emoji: 'pin' }, { id: 's', kind: 'stroke', points: [[0, 0]], pressure: [1] }],
    }));
    expect(parseCanvasLayer(serializeCanvasLayer(kept))).toEqual(kept);
    expect(drawingsInScope(kept, null).map((entry) => entry.id)).toEqual(['s']);

    const notAList = parseCanvasLayer(JSON.stringify({ drawings: { oops: true } }));
    expect(notAList.drawings).toEqual([]);
    expect(notAList.extras.drawings).toEqual({ oops: true });
    expect(JSON.parse(serializeCanvasLayer(notAList)!).drawings).toEqual({ oops: true });
  });

  it('counts a layer holding only drawings as non-empty, and deletes it with the last one', () => {
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('s1', null));
    expect(serializeCanvasLayer(layer)).not.toBeNull();
    removeDrawings(layer, new Set(['s1']));
    expect(serializeCanvasLayer(layer)).toBeNull();
  });

  it('reads only valid strokes, defaulting a bad colour or width', () => {
    expect(strokeOf({ id: 's', kind: 'stroke', points: [[0, 0]], color: 'mauve', width: 'huge' }))
      .toEqual({ kind: 'stroke', id: 's', graph: null, color: null, width: 'medium', points: [{ x: 0, y: 0 }] });
    expect(strokeOf({ id: 's', kind: 'stroke', points: [] })).toBeNull();
    expect(strokeOf({ id: 's', kind: 'stroke', points: [[0, 'a']] })).toBeNull();
    expect(strokeOf({ kind: 'stroke', points: [[0, 0]] })).toBeNull();
    expect(strokeOf({ id: 's', kind: 'stroke', graph: 3, points: [[0, 0]] })).toBeNull();
  });

  it('files strokes by scope', () => {
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('body', null));
    addStroke(layer, stroke('inner', 'Steps'));
    expect(drawingsInScope(layer, null).map((entry) => entry.id)).toEqual(['body']);
    expect(drawingsInScope(layer, 'Steps').map((entry) => entry.id)).toEqual(['inner']);
  });

  it('measures a stroke including half its line width', () => {
    expect(strokeBounds({ ...stroke('s', null), width: 'thick' })).toEqual({ x: -3, y: -3, w: 16, h: 11 });
  });
});

describe('stroke edits', () => {
  it('moves and recolours only the strokes named, replacing the list', () => {
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('a', null));
    addStroke(layer, stroke('b', null));
    const before = layer.drawings;
    transformDrawings(layer, new Map([['a', translationBy({ x: 5, y: -1 })]]));
    setDrawingColor(layer, new Set(['b']), 'blue');
    expect(layer.drawings).not.toBe(before);
    expect(layer.drawings[0].points).toEqual([[5, -1], [15, 4]]);
    expect(layer.drawings[1]).toMatchObject({ color: 'blue', points: [[0, 0], [10, 5]] });
    setDrawingColor(layer, new Set(['b']), null);
    expect(layer.drawings[1].color).toBeUndefined();
  });
});

describe('drawings following their graph block', () => {
  it('re-files a block\'s drawings when the block is renamed', () => {
    const doc = parseFlow(FLOW);
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('inner', 'Steps'));
    addStroke(layer, stroke('body', null));
    const before = documentIdentities(doc);
    FlowDoc.renameGraphBlock(doc, graphBlock(doc, 'Steps'), 'Phases');
    expect(followIdentityChanges(layer, before, documentIdentities(doc))).toBe(true);
    expect(drawingsInScope(layer, 'Phases').map((entry) => entry.id)).toEqual(['inner']);
    expect(drawingsInScope(layer, null).map((entry) => entry.id)).toEqual(['body']);
  });

  it('drops a block\'s drawings with the block', () => {
    const doc = parseFlow(FLOW);
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('inner', 'Steps'));
    const before = documentIdentities(doc);
    doc.items.splice(doc.items.indexOf(graphBlock(doc, 'Steps')), 1);
    followIdentityChanges(layer, before, documentIdentities(doc));
    expect(layer.drawings).toEqual([]);
  });

  it('leaves drawings alone whose block the earlier capture does not account for', () => {
    const doc = parseFlow(FLOW);
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('orphan', 'Gone'));
    const before = documentIdentities(doc);
    FlowDoc.renameGraphBlock(doc, graphBlock(doc, 'Steps'), 'Phases');
    followIdentityChanges(layer, before, documentIdentities(doc));
    expect(layer.drawings.map((drawing) => drawing.graph)).toEqual(['Gone']);
  });
});

describe('drawings for an extracted document', () => {
  it('makes the block\'s drawings the body\'s, keeps carried blocks, and gives every copy a fresh id', () => {
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('own', 'Steps'));
    addStroke(layer, stroke('nested', 'Detail'));
    addStroke(layer, stroke('parent', null));
    addStroke(layer, stroke('elsewhere', 'Other'));
    const carried = drawingsForExtractedDocument(layer, 'Steps', new Set(['Detail'])).drawings;
    expect(carried.map((drawing) => drawing.graph)).toEqual([undefined, 'Detail']);
    expect(carried.map((drawing) => drawing.id)).not.toContain('own');
    expect(carried.map((drawing) => drawing.id)).not.toContain('nested');
  });

  it("takes along the groups formed by drawings it carries, under the copies' ids", () => {
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('a', 'Steps'));
    addStroke(layer, stroke('b', 'Steps'));
    addStroke(layer, stroke('stays', null));
    groupDrawings(layer, new Set(['a', 'b']));
    groupDrawings(layer, new Set(['stays', 'a']));
    const carried = drawingsForExtractedDocument(layer, 'Steps', new Set());
    expect(carried.groups).toEqual([]);
    ungroupDrawings(layer, new Set(['stays']));
    groupDrawings(layer, new Set(['a', 'b']));
    const regrouped = drawingsForExtractedDocument(layer, 'Steps', new Set());
    expect(regrouped.groups).toHaveLength(1);
    expect(groupMembersOf(regrouped.groups[0]).map((member) => member.id).sort())
      .toEqual(regrouped.drawings.map((drawing) => drawing.id as string).sort());
  });
});

describe('copying and pasting drawings', () => {
  it('pastes detached copies under fresh ids, filed and shifted, with their group', () => {
    const layer = emptyCanvasLayer();
    addStroke(layer, stroke('a', 'Steps'));
    addStroke(layer, stroke('b', 'Steps'));
    addStroke(layer, stroke('c', 'Steps'));
    groupDrawings(layer, new Set(['a', 'b']));
    const carried = drawingsToCopy(layer, new Set(['a', 'b']));
    setDrawingColor(layer, new Set(['a']), 'red');

    const pasted = pasteDrawings(layer, carried, null, { x: 100, y: -5 });
    const copies = drawingsInScope(layer, null);
    expect(copies.map((copy) => copy.id)).toEqual(pasted);
    expect(pasted).not.toContain('a');
    expect(copies[0]).toMatchObject({ color: null, points: [{ x: 100, y: -5 }, { x: 110, y: 0 }] });
    expect(drawingGroupsOf(layer).get(pasted[0])?.sort()).toEqual([...pasted].sort());
    expect(layer.groups).toHaveLength(2);
  });
});

describe('the bounds of a stroke', () => {
  it('spans any number of points', () => {
    const points = Array.from({ length: 200_000 }, (_, index) => ({ x: index, y: -index }));
    expect(strokePointBounds(stroke('long', null, points))).toEqual({ x: 0, y: -199_999, w: 199_999, h: 199_999 });
  });
});
