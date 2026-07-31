import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFlow, serializeFlow, setProp, type FlowDocument } from '../src/shared/flow-format.js';
import { allNodes } from '../src/client/flow-doc.js';
import { EditSession, COMMIT_DEBOUNCE_MS } from '../src/client/edit-session.js';

function flowText(nodeName: string): string {
  return `---\nname: demo\n---\n\n${nodeName}:\n  id: 11111111-1111-4111-8111-111111111111\n  pos: 0, 0, 200, 88\n`;
}

interface Harness {
  session: EditSession;
  writes: { path: string; text: string }[];
  adopted: { path: string; doc: FlowDocument }[];
  lastWriteTo(path: string): string | undefined;
}

function createHarness(): Harness {
  const writes: { path: string; text: string }[] = [];
  const adopted: { path: string; doc: FlowDocument }[] = [];
  const session = new EditSession({
    writeFile: (path, text) => writes.push({ path, text }),
    adoptDocument: (path, doc) => adopted.push({ path, doc }),
  });
  return {
    session,
    writes,
    adopted,
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

  // Restoring text written before Graf ever assigned ids mints fresh ones, so selection and
  // open editors bound to the old ids are dropped. Recorded because it reads like a defect and
  // is not one: committed text is the source of truth and that text never carried an id.
  it('mints new ids when restoring text that never carried any', () => {
    const { session } = createHarness();
    const doc = session.adoptText('main.flow', '---\nname: demo\n---\n\nStart:\n');
    const assignedId = allNodes(doc)[0].id;
    expect(assignedId).toBeTruthy();

    renameFirstNode(doc, 'Renamed');
    session.commit('main.flow');
    session.undo();

    const restoredId = allNodes(session.documentAt('main.flow')!)[0].id;
    expect(restoredId).toBeTruthy();
    expect(restoredId).not.toBe(assignedId);
  });
});
