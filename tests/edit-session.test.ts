import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFlow, serializeFlow, setProp, type FlowDocument } from '../src/shared/flow-format.js';
import { allNodes } from '../src/client/flow-doc.js';
import { EditSession, COMMIT_DEBOUNCE_MS } from '../src/client/edit-session.js';
import { setNodeShape, type CanvasLayer } from '../src/shared/canvas-layer.js';
import { CanvasLayerStore } from '../src/client/canvas-layer-store.js';
import { createCanvasLayerSync } from '../src/client/canvas-layer-sync.js';

function flowText(nodeName: string): string {
  return `---\nname: demo\n---\n\n${nodeName}:\n  id: 11111111-1111-4111-8111-111111111111\n  pos: 0, 0, 200, 88\n`;
}

interface Harness {
  session: EditSession;
  writes: { path: string; text: string }[];
  deletes: string[];
  layers: Map<string, CanvasLayer>;
  adopted: { path: string; doc: FlowDocument }[];
  retargeted: { from: string; to: string }[];
  lastWriteTo(path: string): string | undefined;
}

function createHarness(): Harness {
  const writes: { path: string; text: string }[] = [];
  const deletes: string[] = [];
  const layers = new Map<string, CanvasLayer>();
  const adopted: { path: string; doc: FlowDocument }[] = [];
  const retargeted: { from: string; to: string }[] = [];
  const session = new EditSession({
    writeFile: (path, text) => writes.push({ path, text }),
    deleteFile: (path) => deletes.push(path),
    adoptDocument: (path, doc) => adopted.push({ path, doc }),
    adoptLayer: (flowPath, layer) => layers.set(flowPath, layer),
    retargetDocument: (from, to) => retargeted.push({ from, to }),
  });
  return {
    session,
    writes,
    deletes,
    layers,
    adopted,
    retargeted,
    lastWriteTo: (path) => [...writes].reverse().find((write) => write.path === path)?.text,
  };
}

// A node's `name` holds its header line verbatim — trailing colon included, since
// flow-format serializes it back unchanged — so a rename has to keep the colon.
function renameFirstNode(doc: FlowDocument, name: string): void {
  allNodes(doc)[0].name = `${name}:`;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parse identity', () => {
  it('publishes the document it parsed, so callers and the expansion cache share one object', () => {
    const { session, adopted } = createHarness();
    const doc = session.adoptText('main.flow', flowText('Start'));
    expect(adopted).toHaveLength(1);
    expect(adopted[0].path).toBe('main.flow');
    expect(adopted[0].doc).toBe(doc);
    expect(session.documentAt('main.flow')).toBe(doc);
  });

  it('publishes the replacement on every subsequent adopt', () => {
    const { session, adopted } = createHarness();
    session.adoptText('main.flow', flowText('Start'));
    const replacement = session.adoptText('main.flow', flowText('Renamed'));
    expect(adopted).toHaveLength(2);
    expect(adopted[1].doc).toBe(replacement);
    expect(session.documentAt('main.flow')).toBe(replacement);
  });
});

describe('committing', () => {
  it('writes the serialized document once the debounce elapses', () => {
    const { session, writes, lastWriteTo } = createHarness();
    const doc = session.adoptText('main.flow', flowText('Start'));
    renameFirstNode(doc, 'Renamed');
    session.commitAfter('main.flow', 'debounce');
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    expect(lastWriteTo('main.flow')).toBe(serializeFlow(doc));
  });

  it('writes nothing when the document serializes to its committed text', () => {
    const { session, writes } = createHarness();
    session.adoptText('main.flow', flowText('Start'));
    session.commit('main.flow');
    expect(writes).toHaveLength(0);
  });

  it('ignores a path it is not tracking', () => {
    const { session, writes } = createHarness();
    session.commit('never-opened.flow');
    session.scheduleCommit('never-opened.flow');
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    expect(writes).toHaveLength(0);
  });
});

describe('a document replaced while a commit is pending', () => {
  it('never writes the pre-push object back over a watcher update', () => {
    const { session, writes, lastWriteTo } = createHarness();
    const doc = session.adoptText('frame.flow', flowText('Start'));
    renameFirstNode(doc, 'LocalEdit');
    session.commitAfter('frame.flow', 'debounce');

    session.adoptText('frame.flow', flowText('FromWatcher'));
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);

    expect(writes.some((write) => write.text.includes('LocalEdit'))).toBe(false);
    expect(lastWriteTo('frame.flow')).toBeUndefined();
  });

  it('writes nothing for a path dropped by reset', () => {
    const { session, writes } = createHarness();
    const doc = session.adoptText('main.flow', flowText('Start'));
    renameFirstNode(doc, 'Renamed');
    session.commitAfter('main.flow', 'debounce');

    session.reset();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);

    expect(writes).toHaveLength(0);
  });

  it('writes nothing for a path that was forgotten', () => {
    const { session, writes } = createHarness();
    const doc = session.adoptText('doomed.flow', flowText('Start'));
    renameFirstNode(doc, 'Renamed');
    session.commitAfter('doomed.flow', 'debounce');

    session.forget('doomed.flow');
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);

    expect(writes).toHaveLength(0);
  });
});

describe('continuations', () => {
  it('drops work whose documents were replaced while it was in flight', () => {
    const { session } = createHarness();
    session.adoptText('main.flow', flowText('Start'));
    const continuation = session.suspendAction();

    session.adoptText('main.flow', flowText('FromWatcher'));

    const resumed = vi.fn();
    continuation.resume(resumed);
    expect(resumed).not.toHaveBeenCalled();
  });

  it('drops work whose documents were dropped while it was in flight', () => {
    const { session } = createHarness();
    session.adoptText('doomed.flow', flowText('Start'));
    const continuation = session.suspendAction();

    session.forget('doomed.flow');

    const resumed = vi.fn();
    continuation.resume(resumed);
    expect(resumed).not.toHaveBeenCalled();
  });

  it('runs work that only outlived edits to those documents', () => {
    const { session } = createHarness();
    const doc = session.adoptText('main.flow', flowText('Start'));
    const continuation = session.suspendAction();

    renameFirstNode(doc, 'Renamed');
    session.commit('main.flow');

    expect(continuation.resume(() => 'ran')).toBe('ran');
  });
});

// One action is one undo step, whatever it reaches: the documents it writes are not known when
// it starts — a ripple loads files nobody had opened — and it can finish in a later turn.
describe('an action spanning several documents', () => {
  it('undoes every document it wrote in one step', () => {
    const { session, lastWriteTo } = createHarness();
    const open = session.adoptText('main.flow', flowText('Start'));
    const frame = session.adoptText('frame.flow', flowText('Inner'));

    session.runAction(() => {
      renameFirstNode(open, 'StartEdited');
      session.commit('main.flow');
      renameFirstNode(frame, 'InnerEdited');
      session.commit('frame.flow');
    });

    expect(session.undo().sort()).toEqual(['frame.flow', 'main.flow']);
    expect(lastWriteTo('main.flow')).toContain('Start:');
    expect(lastWriteTo('frame.flow')).toContain('Inner:');
    expect(session.undo()).toEqual([]);
  });

  it('redoes every document it wrote in one step', () => {
    const { session, lastWriteTo } = createHarness();
    const open = session.adoptText('main.flow', flowText('Start'));
    const frame = session.adoptText('frame.flow', flowText('Inner'));

    session.runAction(() => {
      renameFirstNode(open, 'StartEdited');
      session.commit('main.flow');
      renameFirstNode(frame, 'InnerEdited');
      session.commit('frame.flow');
    });
    session.undo();

    expect(session.redo().sort()).toEqual(['frame.flow', 'main.flow']);
    expect(lastWriteTo('main.flow')).toContain('StartEdited');
    expect(lastWriteTo('frame.flow')).toContain('InnerEdited');
  });

  it('restores a document it only reached after it had started', () => {
    const { session, lastWriteTo } = createHarness();
    const open = session.adoptText('main.flow', flowText('Start'));
    const loadedByTheRipple = parseFlow(flowText('Elsewhere'));

    session.runAction(() => {
      renameFirstNode(open, 'StartEdited');
      session.commit('main.flow');
      session.trackWithBaseline('other.flow', loadedByTheRipple);
      renameFirstNode(loadedByTheRipple, 'ElsewhereEdited');
      session.commit('other.flow');
    });

    expect(session.undo().sort()).toEqual(['main.flow', 'other.flow']);
    expect(lastWriteTo('other.flow')).toContain('Elsewhere:');
  });

  it('keeps a continuation that resumes in a later turn in the same step', () => {
    const { session, lastWriteTo } = createHarness();
    const open = session.adoptText('main.flow', flowText('Start'));
    const other = session.adoptText('other.flow', flowText('Elsewhere'));

    const continuation = session.runAction(() => {
      renameFirstNode(open, 'StartEdited');
      session.commit('main.flow');
      return session.suspendAction();
    });
    continuation.resume(() => {
      renameFirstNode(other, 'ElsewhereEdited');
      session.commit('other.flow');
    });

    expect(session.undo().sort()).toEqual(['main.flow', 'other.flow']);
    expect(lastWriteTo('other.flow')).toContain('Elsewhere:');
    expect(session.undo()).toEqual([]);
  });

  // The window between an action and the continuation it is waiting on belongs to the user like
  // any other: an edit made in it is theirs to undo on its own.
  it('leaves an edit made while it waited out of its step', () => {
    const { session, lastWriteTo } = createHarness();
    const open = session.adoptText('main.flow', flowText('Start'));
    const other = session.adoptText('other.flow', flowText('Elsewhere'));
    const unrelated = session.adoptText('unrelated.flow', flowText('Aside'));

    const continuation = session.runAction(() => {
      renameFirstNode(open, 'StartEdited');
      session.commit('main.flow');
      return session.suspendAction();
    });
    renameFirstNode(unrelated, 'AsideEdited');
    session.commit('unrelated.flow');
    continuation.resume(() => {
      renameFirstNode(other, 'ElsewhereEdited');
      session.commit('other.flow');
    });

    expect(session.undo()).toEqual(['other.flow']);
    expect(lastWriteTo('unrelated.flow')).toContain('AsideEdited');
    expect(session.undo()).toEqual(['unrelated.flow']);
  });

  it('lands a debounced commit in the action that scheduled it', () => {
    const { session } = createHarness();
    const open = session.adoptText('main.flow', flowText('Start'));
    const frame = session.adoptText('frame.flow', flowText('Inner'));

    session.runAction(() => {
      renameFirstNode(open, 'StartEdited');
      session.commitAfter('main.flow', 'debounce');
      renameFirstNode(frame, 'InnerEdited');
      session.commit('frame.flow');
    });
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);

    expect(session.undo().sort()).toEqual(['frame.flow', 'main.flow']);
    expect(session.undo()).toEqual([]);
  });

  // Undo flushes first. A rename debounces its own document while its ripple writes the rest
  // immediately, so an undo pressed inside that window has to land on the whole rename.
  it('lands a debounced commit flushed by an undo in the action that scheduled it', () => {
    const { session, lastWriteTo } = createHarness();
    const open = session.adoptText('main.flow', flowText('Start'));
    const frame = session.adoptText('frame.flow', flowText('Inner'));

    session.runAction(() => {
      renameFirstNode(open, 'StartEdited');
      session.commitAfter('main.flow', 'debounce');
      renameFirstNode(frame, 'InnerEdited');
      session.commit('frame.flow');
    });
    session.undo();

    expect(lastWriteTo('main.flow')).toContain('Start:');
    expect(lastWriteTo('frame.flow')).toContain('Inner:');
  });

  it('keeps an action assembled from smaller ones to one step', () => {
    const { session } = createHarness();
    const open = session.adoptText('main.flow', flowText('Start'));
    const frame = session.adoptText('frame.flow', flowText('Inner'));

    session.runAction(() => {
      session.runAction(() => {
        renameFirstNode(open, 'StartEdited');
        session.commit('main.flow');
      });
      renameFirstNode(frame, 'InnerEdited');
      session.commit('frame.flow');
    });

    expect(session.undo().sort()).toEqual(['frame.flow', 'main.flow']);
    expect(session.undo()).toEqual([]);
  });
});

describe('documents mutated in place before they are tracked', () => {
  it('still writes the first commit, having no pre-edit text to diff against', () => {
    const { session, lastWriteTo } = createHarness();
    const doc = parseFlow(flowText('Dragged'));
    setProp(allNodes(doc)[0], 'pos', '40, 40, 200, 88');

    session.trackWithoutBaseline('frame.flow', doc);
    session.commit('frame.flow');

    expect(lastWriteTo('frame.flow')).toBe(serializeFlow(doc));
  });

  it('keeps the baseline of a document already tracked', () => {
    const { session, writes } = createHarness();
    session.adoptText('frame.flow', flowText('Start'));
    session.trackWithoutBaseline('frame.flow', session.documentAt('frame.flow')!);
    session.commit('frame.flow');
    expect(writes).toHaveLength(0);
  });
});

describe('undo across every document an edit can reach', () => {
  // Two edits, so two steps. Grouping them takes an action; see the suite above.
  it('restores the open file and a frame document, each on its own step', () => {
    const { session, lastWriteTo } = createHarness();
    const open = session.adoptText('main.flow', flowText('Start'));
    const frame = session.adoptText('frame.flow', flowText('Inner'));

    renameFirstNode(open, 'StartEdited');
    session.commit('main.flow');
    renameFirstNode(frame, 'InnerEdited');
    session.commit('frame.flow');

    expect(lastWriteTo('main.flow')).toContain('StartEdited');
    expect(lastWriteTo('frame.flow')).toContain('InnerEdited');

    const changed = session.undo();
    expect(changed).toEqual(['frame.flow']);
    expect(lastWriteTo('frame.flow')).toContain('Inner:');
    expect(lastWriteTo('frame.flow')).not.toContain('InnerEdited');

    expect(session.undo()).toEqual(['main.flow']);
    expect(lastWriteTo('main.flow')).toContain('Start:');
    expect(lastWriteTo('main.flow')).not.toContain('StartEdited');
  });

  it('replaces the document object of every restored path', () => {
    const { session } = createHarness();
    const original = session.adoptText('main.flow', flowText('Start'));
    renameFirstNode(original, 'Renamed');
    session.commit('main.flow');

    session.undo();
    const restored = session.documentAt('main.flow');
    expect(restored).not.toBe(original);
    expect(allNodes(restored!)[0].name).toBe('Start:');
  });

  it('redoes what it undid', () => {
    const { session, lastWriteTo } = createHarness();
    const doc = session.adoptText('main.flow', flowText('Start'));
    renameFirstNode(doc, 'Renamed');
    session.commit('main.flow');

    session.undo();
    expect(lastWriteTo('main.flow')).not.toContain('Renamed');

    expect(session.redo()).toEqual(['main.flow']);
    expect(lastWriteTo('main.flow')).toContain('Renamed');
  });

  it('flushes a pending commit before reading history, so the edit is undoable', () => {
    const { session, lastWriteTo } = createHarness();
    const doc = session.adoptText('main.flow', flowText('Start'));
    renameFirstNode(doc, 'Renamed');
    session.commitAfter('main.flow', 'debounce');

    session.undo();

    expect(lastWriteTo('main.flow')).toContain('Start:');
    expect(lastWriteTo('main.flow')).not.toContain('Renamed');
  });

  it('does nothing with an empty history', () => {
    const { session, writes } = createHarness();
    session.adoptText('main.flow', flowText('Start'));
    expect(session.undo()).toEqual([]);
    expect(session.redo()).toEqual([]);
    expect(writes).toHaveLength(0);
  });

  it('keeps node identity across a restore of text that carries ids', () => {
    const { session } = createHarness();
    const doc = session.adoptText('main.flow', flowText('Start'));
    const id = allNodes(doc)[0].id;
    expect(id).toBeTruthy();

    renameFirstNode(doc, 'Renamed');
    session.commit('main.flow');
    session.undo();

    expect(allNodes(session.documentAt('main.flow')!)[0].id).toBe(id);
  });

  // The ids minted on load are part of the committed state, so a restore keeps them: the canvas
  // layer keys its visuals by those ids before any edit has written them to the file.
  it('keeps the ids assigned on load across a restore of text that never carried any', () => {
    const { session } = createHarness();
    const doc = session.adoptText('main.flow', '---\nname: demo\n---\n\nStart:\n');
    const assignedId = allNodes(doc)[0].id;
    expect(assignedId).toBeTruthy();

    renameFirstNode(doc, 'Renamed');
    session.commit('main.flow');
    session.undo();

    expect(allNodes(session.documentAt('main.flow')!)[0].id).toBe(assignedId);
  });
});

describe('a file read in a form the editor does not write', () => {
  const CRLF_TEXT = flowText('Start').replace(/\n/g, '\r\n');

  it('writes the canonical form on the next flush without recording an undo step', () => {
    const { session, lastWriteTo } = createHarness();
    const doc = session.adoptText('main.flow', CRLF_TEXT);
    session.flush();
    expect(lastWriteTo('main.flow')).toBe(serializeFlow(doc));
    expect(session.undo()).toEqual([]);
  });

  it('undoes a layer edit made before the .flow was ever written', () => {
    const { session, layers } = createHarness();
    session.adoptText('a.flow', CRLF_TEXT);
    const layer = session.adoptLayerText('a.flow', null);
    session.runAction(() => {
      session.trackLayerWithBaseline('a.flow', layer);
      setNodeShape(layer, '11111111-1111-4111-8111-111111111111', 'ellipse');
      session.commit('a.flow.canvas.json');
    });

    expect(session.undo()).toEqual(['a.flow.canvas.json']);
    expect(layers.get('a.flow')?.nodes).toEqual({});
  });

  it('records its canonical form as the state an edit undoes to', () => {
    const { session } = createHarness();
    const doc = session.adoptText('main.flow', CRLF_TEXT);
    const canonical = serializeFlow(doc);
    renameFirstNode(doc, 'Renamed');
    session.commit('main.flow');
    session.undo();
    expect(session.committedTextAt('main.flow')).toBe(canonical);
  });
});

describe('canvas layers', () => {
  const LAYER_PATH = 'a.flow.canvas.json';

  function trackEmptyLayer(session: EditSession): CanvasLayer {
    const layer = session.adoptLayerText('a.flow', null);
    session.trackLayerWithBaseline('a.flow', layer);
    return layer;
  }

  it('undoes the first visual on a graph by deleting the layer file it created, and redo writes it back', () => {
    const { session, deletes, lastWriteTo, layers } = createHarness();
    const layer = trackEmptyLayer(session);
    session.runAction(() => {
      setNodeShape(layer, 'n1', 'diamond');
      session.commit(LAYER_PATH);
    });
    const written = lastWriteTo(LAYER_PATH);
    expect(written).toContain('diamond');

    expect(session.undo()).toEqual([LAYER_PATH]);
    expect(deletes).toEqual([LAYER_PATH]);
    expect(layers.get('a.flow')?.nodes).toEqual({});

    expect(session.redo()).toEqual([LAYER_PATH]);
    expect(lastWriteTo(LAYER_PATH)).toBe(written);
    expect(layers.get('a.flow')?.nodes).toEqual({ n1: { shape: 'diamond' } });
  });

  it('deletes the file when the last visual is cleared, restores it on undo and deletes it again on redo', () => {
    const { session, deletes, lastWriteTo } = createHarness();
    const layer = session.adoptLayerText('a.flow', JSON.stringify({ nodes: { n1: { shape: 'ellipse' } } }));
    session.runAction(() => {
      setNodeShape(layer, 'n1', null);
      session.commit(LAYER_PATH);
    });
    expect(deletes).toEqual([LAYER_PATH]);

    session.undo();
    expect(lastWriteTo(LAYER_PATH)).toContain('ellipse');
    expect(session.layerAt('a.flow')?.nodes).toEqual({ n1: { shape: 'ellipse' } });

    session.redo();
    expect(deletes).toEqual([LAYER_PATH, LAYER_PATH]);
    expect(session.layerAt('a.flow')?.nodes).toEqual({});
  });

  it('carries a pending layer commit to the new path when its .flow is renamed', () => {
    const { session, writes } = createHarness();
    session.adoptText('a.flow', flowText('Start'));
    const layer = trackEmptyLayer(session);
    setNodeShape(layer, 'n1', 'hexagon');
    session.scheduleCommit(LAYER_PATH);
    session.retarget('a.flow', 'b.flow');
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    expect(writes.map((write) => write.path)).toEqual(['b.flow.canvas.json']);
    expect(session.layerAt('b.flow')).toBe(layer);
    expect(session.layerAt('a.flow')).toBeNull();
  });

  it('forgets a deleted .flow together with its layer, so nothing pending re-creates either', () => {
    const { session, writes } = createHarness();
    session.adoptText('a.flow', flowText('Start'));
    const layer = trackEmptyLayer(session);
    setNodeShape(layer, 'n1', 'hexagon');
    session.scheduleCommit(LAYER_PATH);
    session.forget('a.flow');
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    expect(writes).toEqual([]);
  });
});

describe('canvas layers following .flow edits', () => {
  const NODE_ID = '11111111-1111-4111-8111-111111111111';
  const TARGET_ID = '22222222-2222-4222-8222-222222222222';
  const TEXT = `---\nname: demo\n---\n\nStart\n  id: ${NODE_ID}\n  pos: 0, 0, 200, 88\n  -> End : "go"\n\nEnd\n  id: ${TARGET_ID}\n  pos: 300, 0, 200, 88\n`;
  const OLD_KEY = `${NODE_ID} -> #${TARGET_ID} : "go"`;
  const NEW_KEY = `${NODE_ID} -> #${TARGET_ID} : "done"`;

  function createSyncedSession() {
    const writes: { path: string; text: string }[] = [];
    const store = new CanvasLayerStore({ readFile: async () => null, onLoaded: () => {} });
    let session: EditSession;
    const sync = createCanvasLayerSync(() => session, store);
    session = new EditSession({
      writeFile: (path, text) => writes.push({ path, text }),
      deleteFile: () => {},
      adoptDocument: () => {},
      adoptLayer: (flowPath, layer) => store.adopt(flowPath, layer),
      retargetDocument: () => {},
      observer: sync.observer,
    });
    return { session, store, writes };
  }

  it('re-keys an edge colour when the edge is relabelled, in the same undo step as the .flow write', () => {
    const { session, store, writes } = createSyncedSession();
    const doc = session.adoptText('a.flow', TEXT);
    const layer = session.adoptLayerText('a.flow', JSON.stringify({ edges: { [OLD_KEY]: { color: 'red' } } }));
    expect(store.layerFor('a.flow')).toBe(layer);

    allNodes(doc)[0].edges[0].label = 'done';
    session.commit('a.flow');
    expect(layer.edges).toEqual({ [NEW_KEY]: { color: 'red' } });
    expect(writes.map((write) => write.path)).toEqual(['a.flow.canvas.json', 'a.flow']);

    expect(session.undo().sort()).toEqual(['a.flow', 'a.flow.canvas.json']);
    expect(session.layerAt('a.flow')?.edges).toEqual({ [OLD_KEY]: { color: 'red' } });
    expect(allNodes(session.documentAt('a.flow')!)[0].edges[0].label).toBe('go');
  });

  it('drops a deleted node\'s shape with the commit that deleted it', () => {
    const { session } = createSyncedSession();
    const doc = session.adoptText('a.flow', TEXT);
    const layer = session.adoptLayerText('a.flow', JSON.stringify({ nodes: { [TARGET_ID]: { shape: 'diamond' } } }));
    doc.items = doc.items.filter((item) => item.kind !== 'node' || item.node.name !== 'End');
    session.commit('a.flow');
    expect(layer.nodes).toEqual({});
  });
});
