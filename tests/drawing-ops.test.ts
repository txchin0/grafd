import { describe, expect, it, vi } from 'vitest';
import type { FlowDocument, GraphItem } from '../src/shared/flow-format.js';
import { drawingsForExtractedDocument, strokesInScope } from '../src/shared/canvas-drawings.js';
import * as FlowDoc from '../src/client/flow-doc.js';
import { EditSession } from '../src/client/edit-session.js';
import { CanvasLayerStore } from '../src/client/canvas-layer-store.js';
import { createCanvasLayerSync } from '../src/client/canvas-layer-sync.js';
import { dressModel } from '../src/client/model-visuals.js';
import { createDrawingOps } from '../src/client/drawing-ops.js';
import { distinctDrawingMoves, drawingWritesOf } from '../src/client/canvas/drawing-selection.js';
import type { FlowModel } from '../src/client/flow-doc.js';

const PATH = 'a.flow';
const LAYER_PATH = 'a.flow.canvas.json';
const HOST_ID = '11111111-1111-4111-8111-111111111111';
const TEXT = `---
name: demo
---

Host
  id: ${HOST_ID}
  pos: 0, 0, 200, 88
  expand: Steps

graph: Steps
  Inner
    id: 22222222-2222-4222-8222-222222222222
    pos: 0, 0, 200, 88
`;
const LINE = [{ x: 0, y: 0 }, { x: 40, y: 10 }];
const PEN = { color: 'red', width: 'thick' } as const;

function createDrawingHarness(text = TEXT) {
  const writes: { path: string; text: string }[] = [];
  const deletes: string[] = [];
  const store = new CanvasLayerStore({ readFile: async () => null, onLoaded: () => {} });
  let session: EditSession;
  const sync = createCanvasLayerSync(() => session, store);
  session = new EditSession({
    writeFile: (path, written) => writes.push({ path, text: written }),
    deleteFile: (path) => deletes.push(path),
    adoptDocument: () => {},
    adoptLayer: (flowPath, layer) => store.adopt(flowPath, layer),
    retargetDocument: () => {},
    observer: sync.observer,
  });
  session.adoptText(PATH, text);
  session.adoptLayerText(PATH, null);
  const doc = () => session.documentAt(PATH)!;
  const notify = vi.fn();
  // The scope a stroke lands in: the open file's body, or the block its host expands.
  let scope: string | null = null;
  const ops = createDrawingOps({
    session: () => session,
    layerSync: sync,
    creationTargetFor: () => ({ owner: { doc: doc(), path: PATH }, scope }),
    ensureScope: (target) => {
      if (target.scope == null || FlowDoc.graphBlockNames(target.owner.doc).includes(target.scope)) return;
      session.trackWithBaseline(target.owner.path, target.owner.doc);
      FlowDoc.ensureScopeItems(target.owner.doc, target.scope);
      session.commit(target.owner.path);
    },
    documentOwnerAt: (path) => (path === PATH ? { doc: doc(), path } : null),
    rerenderAfterEditTo: () => {},
    notify,
  });
  const drawIn = (drawScope: string | null) => {
    scope = drawScope;
    ops.createStroke(LINE, null, PEN);
  };
  const modelOf = (modelScope: string | null): FlowModel => {
    const model = FlowDoc.buildModel(doc(), modelScope);
    model.sourcePath = PATH;
    return dressModel(model, store.layerFor(PATH));
  };
  return { session, store, writes, deletes, notify, ops, doc, drawIn, modelOf };
}

function layerOf(harness: ReturnType<typeof createDrawingHarness>) {
  return harness.store.layerFor(PATH)!;
}

function graphBlock(doc: FlowDocument, name: string): GraphItem {
  return doc.items.find((item): item is GraphItem => item.kind === 'graph' && item.name === name)!;
}

describe('drawing a stroke', () => {
  it('writes it into the scope it was drawn in, as one undoable step', () => {
    const harness = createDrawingHarness();
    harness.drawIn('Steps');
    const [stroke] = strokesInScope(layerOf(harness), 'Steps');
    expect(stroke).toMatchObject({ graph: 'Steps', color: 'red', width: 'thick', points: LINE });
    expect(harness.writes.map((write) => write.path)).toEqual([LAYER_PATH]);

    expect(harness.session.undo()).toEqual([LAYER_PATH]);
    expect(harness.deletes).toEqual([LAYER_PATH]);
    expect(strokesInScope(layerOf(harness), 'Steps')).toEqual([]);
    harness.session.redo();
    expect(strokesInScope(layerOf(harness), 'Steps')).toHaveLength(1);
  });

  it('creates the block an expand names but nothing declares, in the same undo step', () => {
    const harness = createDrawingHarness(TEXT.replace('expand: Steps', 'expand: Later'));
    harness.drawIn('Later');
    expect(FlowDoc.graphBlockNames(harness.doc())).toContain('Later');
    expect(strokesInScope(layerOf(harness), 'Later')).toHaveLength(1);

    expect(harness.session.undo().sort()).toEqual([PATH, LAYER_PATH]);
    expect(FlowDoc.graphBlockNames(harness.doc())).not.toContain('Later');
    expect(layerOf(harness).drawings).toEqual([]);
  });

  it('writes nothing, not even the block, when the layer cannot be read — and says so', () => {
    const harness = createDrawingHarness(TEXT.replace('expand: Steps', 'expand: Later'));
    harness.session.forget(LAYER_PATH);
    harness.store.adoptUnreadable(PATH);
    harness.drawIn('Later');
    expect(harness.writes).toEqual([]);
    expect(FlowDoc.graphBlockNames(harness.doc())).not.toContain('Later');
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('a.flow.canvas.json'));
  });

  it('writes nothing over a drawings value that is not a list — and says so', () => {
    const harness = createDrawingHarness();
    harness.session.adoptLayerText(PATH, JSON.stringify({ drawings: 3 }));
    harness.drawIn(null);
    expect(harness.writes).toEqual([]);
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('a.flow.canvas.json'));
  });
});

describe('copying strokes', () => {
  it('pastes a copy into another graph as one undoable step', () => {
    const harness = createDrawingHarness();
    harness.drawIn(null);
    const [source] = strokesInScope(layerOf(harness), null);
    const [copied] = harness.ops.copyDrawings([{ model: harness.modelOf(null), id: source.id }]);
    expect(copied.scope).toBeNull();

    const pasted = harness.ops.pasteDrawings({ owner: copied.owner, scope: 'Steps' }, copied.carried, { x: 5, y: 5 });
    const [copy] = strokesInScope(layerOf(harness), 'Steps');
    expect(pasted).toEqual([{ path: PATH, scope: 'Steps', id: copy.id }]);
    expect(copy.points).toEqual(LINE.map((point) => ({ x: point.x + 5, y: point.y + 5 })));

    harness.session.undo();
    expect(strokesInScope(layerOf(harness), 'Steps')).toEqual([]);
    expect(strokesInScope(layerOf(harness), null)).toHaveLength(1);
  });

  it('copies strokes of each graph apart, since each is in its own coordinates', () => {
    const harness = createDrawingHarness();
    harness.drawIn(null);
    harness.drawIn('Steps');
    const [body] = strokesInScope(layerOf(harness), null);
    const [inner] = strokesInScope(layerOf(harness), 'Steps');
    const copies = harness.ops.copyDrawings([
      { model: harness.modelOf(null), id: body.id },
      { model: harness.modelOf('Steps'), id: inner.id },
    ]);
    expect(copies.map((copy) => [copy.scope, copy.carried.drawings.map((drawing) => drawing.id)])).toEqual([
      [null, [body.id]],
      ['Steps', [inner.id]],
    ]);
  });
});

describe('drawings following the .flow', () => {
  it('renames a block\'s strokes with the block, in the same undo step', () => {
    const harness = createDrawingHarness();
    harness.drawIn('Steps');
    const doc = harness.doc();
    FlowDoc.renameGraphBlock(doc, graphBlock(doc, 'Steps'), 'Phases');
    harness.session.commit(PATH);
    expect(strokesInScope(layerOf(harness), 'Phases')).toHaveLength(1);

    expect(harness.session.undo().sort()).toEqual([PATH, LAYER_PATH]);
    expect(strokesInScope(layerOf(harness), 'Steps')).toHaveLength(1);
  });
});

describe('moving strokes with nodes', () => {
  it('lands a mixed node and stroke move as one undo step', () => {
    const harness = createDrawingHarness();
    harness.drawIn(null);
    const [stroke] = strokesInScope(layerOf(harness), null);
    const model = harness.modelOf(null);

    harness.session.runAction(() => {
      const host = FlowDoc.allNodes(harness.doc()).find((node) => node.id === HOST_ID)!;
      harness.session.trackWithoutBaseline(PATH, harness.doc());
      host.pos!.x += 16;
      harness.session.commit(PATH);
      harness.ops.moveDrawings([{ model, id: stroke.id, offset: { x: 16, y: 0 } }]);
    });
    expect(strokesInScope(layerOf(harness), null)[0].points[0]).toEqual({ x: 16, y: 0 });

    expect(harness.session.undo().sort()).toEqual([PATH, LAYER_PATH]);
    expect(strokesInScope(layerOf(harness), null)[0].points[0]).toEqual({ x: 0, y: 0 });
    const host = FlowDoc.allNodes(harness.doc()).find((node) => node.id === HOST_ID)!;
    expect(host.pos!.x).toBe(0);
  });

  it('moves a stroke shown in two frames once', () => {
    const harness = createDrawingHarness();
    harness.drawIn('Steps');
    const [stroke] = strokesInScope(layerOf(harness), 'Steps');
    const firstFrame = harness.modelOf('Steps');
    const secondFrame = harness.modelOf('Steps');
    harness.ops.moveDrawings([
      { model: firstFrame, id: stroke.id, offset: { x: 10, y: 0 } },
      { model: secondFrame, id: stroke.id, offset: { x: 10, y: 0 } },
    ]);
    expect(strokesInScope(layerOf(harness), 'Steps')[0].points[0]).toEqual({ x: 10, y: 0 });
  });
});

describe('resizing a stroke', () => {
  it('rewrites its points as one undoable step, keeping its line width', () => {
    const harness = createDrawingHarness();
    harness.drawIn(null);
    const [stroke] = strokesInScope(layerOf(harness), null);
    harness.ops.resizeDrawings([{ model: harness.modelOf(null), id: stroke.id }], { scaleX: 2, scaleY: 3, x: 5, y: 0 });
    const [resized] = strokesInScope(layerOf(harness), null);
    expect(resized.points).toEqual([{ x: 5, y: 0 }, { x: 85, y: 30 }]);
    expect(resized.width).toBe('thick');

    expect(harness.session.undo()).toEqual([LAYER_PATH]);
    expect(strokesInScope(layerOf(harness), null)[0].points).toEqual(LINE);
  });
});

describe('resizing a group', () => {
  it('stretches every member alike, as one undoable step', () => {
    const harness = createDrawingHarness();
    harness.drawIn(null);
    harness.drawIn(null);
    const model = harness.modelOf(null);
    const selections = strokesInScope(layerOf(harness), null).map((stroke) => ({ model, id: stroke.id }));
    harness.ops.groupDrawings(selections);
    harness.ops.resizeDrawings(selections, { scaleX: 2, scaleY: 1, x: 0, y: 0 });
    expect(strokesInScope(layerOf(harness), null).map((stroke) => stroke.points[1])).toEqual([{ x: 80, y: 10 }, { x: 80, y: 10 }]);

    expect(harness.session.undo()).toEqual([LAYER_PATH]);
    expect(strokesInScope(layerOf(harness), null).map((stroke) => stroke.points[1])).toEqual([LINE[1], LINE[1]]);
  });
});

describe('grouping strokes', () => {
  it('groups strokes of one graph as one undoable step', () => {
    const harness = createDrawingHarness();
    harness.drawIn(null);
    harness.drawIn(null);
    const model = harness.modelOf(null);
    const selections = strokesInScope(layerOf(harness), null).map((stroke) => ({ model, id: stroke.id }));
    expect(harness.ops.canGroup(selections)).toBe(true);
    harness.ops.groupDrawings(selections);
    expect(harness.ops.isAnyGrouped(selections)).toBe(true);
    expect(model.visuals!.strokeGroupOf(selections[0].id).sort()).toEqual(selections.map((entry) => entry.id).sort());

    expect(harness.session.undo()).toEqual([LAYER_PATH]);
    expect(layerOf(harness).groups).toEqual([]);
  });

  it('will not group strokes drawn in different graphs', () => {
    const harness = createDrawingHarness();
    harness.drawIn(null);
    harness.drawIn('Steps');
    const [body] = strokesInScope(layerOf(harness), null);
    const [inner] = strokesInScope(layerOf(harness), 'Steps');
    const selections = [{ model: harness.modelOf(null), id: body.id }, { model: harness.modelOf('Steps'), id: inner.id }];
    expect(harness.ops.canGroup(selections)).toBe(false);
    harness.ops.groupDrawings(selections);
    expect(layerOf(harness).groups).toEqual([]);
  });
});

describe('drawing selections', () => {
  it('collapses copies of one stored stroke into a single write', () => {
    const harness = createDrawingHarness();
    const first = harness.modelOf('Steps');
    const second = harness.modelOf('Steps');
    const writes = drawingWritesOf([{ model: first, id: 's' }, { model: second, id: 's' }, { model: second, id: 't' }]);
    expect(writes).toHaveLength(1);
    expect([...writes[0].ids]).toEqual(['s', 't']);
    expect(distinctDrawingMoves([
      { model: first, id: 's', offset: { x: 1, y: 0 } },
      { model: second, id: 's', offset: { x: 2, y: 0 } },
    ])).toEqual([{ model: first, id: 's', offset: { x: 1, y: 0 } }]);
  });

  it('deletes and recolours selected strokes', () => {
    const harness = createDrawingHarness();
    harness.drawIn(null);
    harness.drawIn(null);
    const [kept, removed] = strokesInScope(layerOf(harness), null);
    const model = harness.modelOf(null);
    harness.ops.recolorDrawings([{ model, id: kept.id }], 'blue');
    harness.ops.deleteDrawings([{ model, id: removed.id }]);
    expect(strokesInScope(layerOf(harness), null)).toEqual([{ ...kept, color: 'blue' }]);
  });
});

describe('a parsed layer with drawings in a model', () => {
  it('shows each model only its own scope\'s strokes', () => {
    const harness = createDrawingHarness();
    harness.drawIn('Steps');
    harness.drawIn(null);
    expect(harness.modelOf('Steps').visuals!.strokes().map((stroke) => stroke.graph)).toEqual(['Steps']);
    expect(harness.modelOf(null).visuals!.strokes().map((stroke) => stroke.graph)).toEqual([null]);
  });
});

describe('extracting a block into its own file', () => {
  function extractSteps(text: string, drawnScope: string) {
    const harness = createDrawingHarness(text);
    harness.drawIn(drawnScope);
    const parentDrawings = { ...layerOf(harness) };
    let extracted: FlowDocument | null = null;
    harness.session.runAction(() => {
      harness.session.trackWithBaseline(PATH, harness.doc());
      extracted = FlowDoc.extractGraphBlockToDocument(harness.doc(), 'Steps', 'steps.flow');
      harness.session.commit(PATH);
    });
    const carried = drawingsForExtractedDocument(parentDrawings, 'Steps', new Set(FlowDoc.graphBlockNames(extracted!))).drawings;
    return { parentStrokes: strokesInScope(layerOf(harness), drawnScope), carried };
  }

  it("moves the block's strokes into the new file's body, since the block leaves the parent", () => {
    const { parentStrokes, carried } = extractSteps(TEXT, 'Steps');
    expect(parentStrokes).toEqual([]);
    expect(carried).toHaveLength(1);
    expect(carried[0].graph).toBeUndefined();
  });

  // A block nested in the extracted one travels with it, but stays in the parent too while the
  // parent's own nodes still expand it — so its strokes are copied, under fresh ids.
  it('copies the strokes of a nested block the parent still uses', () => {
    const { parentStrokes, carried } = extractSteps(`${TEXT}    expand: Detail

Outer
  id: 33333333-3333-4333-8333-333333333333
  pos: 300, 0, 200, 88
  expand: Detail

graph: Detail
  Leaf
    id: 44444444-4444-4444-8444-444444444444
    pos: 0, 0, 200, 88
`, 'Detail');
    expect(parentStrokes).toHaveLength(1);
    expect(carried).toHaveLength(1);
    expect(carried[0].graph).toBe('Detail');
    expect(carried[0].id).not.toBe(parentStrokes[0].id);
  });
});
