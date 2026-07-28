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

describe('documentGeneration', () => {
  it('moves whenever a tracked document is replaced or dropped', () => {
    const { session } = createHarness();
    session.adoptText('main.flow', flowText('Start'));
    const afterFirstAdopt = session.documentGeneration;

    session.adoptText('main.flow', flowText('Second'));
    expect(session.documentGeneration).not.toBe(afterFirstAdopt);

    const afterReplace = session.documentGeneration;
    session.forget('main.flow');
    expect(session.documentGeneration).not.toBe(afterReplace);
  });

  it('holds still while a document is only edited', () => {
    const { session } = createHarness();
    const doc = session.adoptText('main.flow', flowText('Start'));
    const before = session.documentGeneration;
    renameFirstNode(doc, 'Renamed');
    session.commit('main.flow');
    expect(session.documentGeneration).toBe(before);
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
  it('restores the open file and a frame document from one history entry', () => {
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
