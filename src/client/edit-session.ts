// The workspace's edit pipeline: every .flow document an edit can reach — the open file and
// any external file unfolded inside a frame — is tracked here with its last committed text,
// its own debounce timer, and one shared undo history.
//
// There is deliberately no separate path for the open file. An edit inside a frame lands in
// that frame's (possibly external) document, so undo has to span every document an action
// could touch; treating them uniformly is also what makes two invariants enforceable in a
// single place:
//
//   Parse identity — `adoptText` is the only thing that parses a tracked document, and it
//   hands the resulting object straight to the expansion cache. The open file's document and
//   `documentAt(openPath)` are therefore always the same object, never two copies of one file
//   that drift apart as edits land on whichever one the caller happened to hold.
//
//   No resurrection — a pending commit stores only its path. The document is re-read from the
//   registry when the timer fires, and registering a replacement cancels the timer outright,
//   so a document replaced by a watcher push, an undo, or a file switch can never be
//   serialized back over the content that replaced it.

import { parseFlow, serializeFlow, type FlowDocument } from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';

export type CommitTiming = 'debounce' | 'now';

// The committed text of every tracked document at one point in time — one undo step.
export type WorkspaceSnapshot = { path: string; text: string }[];

export const COMMIT_DEBOUNCE_MS = 300;
const UNDO_LIMIT = 100;

interface TrackedDocument {
  doc: FlowDocument;
  // Null while no pre-edit text is known. A drag mutates `pos` in place and only reports the
  // move once it is over, so a document first registered at that point has nothing to diff
  // against and its next commit must write unconditionally.
  committedText: string | null;
  timer?: ReturnType<typeof setTimeout>;
}

export interface EditSessionOptions {
  writeFile(path: string, text: string): void;
  // Publishes a freshly parsed document to the expansion cache by identity. See the parse
  // identity note above.
  adoptDocument(path: string, doc: FlowDocument): void;
  debounceMs?: number;
}

export class EditSession {
  private readonly tracked = new Map<string, TrackedDocument>();
  private readonly undoStack: WorkspaceSnapshot[] = [];
  private readonly redoStack: WorkspaceSnapshot[] = [];
  private readonly writeFile: (path: string, text: string) => void;
  private readonly adoptDocument: (path: string, doc: FlowDocument) => void;
  private readonly debounceMs: number;
  private replacements = 0;

  constructor({ writeFile, adoptDocument, debounceMs = COMMIT_DEBOUNCE_MS }: EditSessionOptions) {
    this.writeFile = writeFile;
    this.adoptDocument = adoptDocument;
    this.debounceMs = debounceMs;
  }

  // Work carried across an await — a workspace-wide rename ripple — describes the documents
  // that were live when it started. Every wholesale replacement bumps this, so a ripple that
  // finds it moved knows its subject no longer exists and abandons the rest of its work.
  get documentGeneration(): number {
    return this.replacements;
  }

  documentAt(path: string): FlowDocument | null {
    return this.tracked.get(path)?.doc ?? null;
  }

  committedTextAt(path: string): string | null {
    return this.tracked.get(path)?.committedText ?? null;
  }

  isTracking(path: string): boolean {
    return this.tracked.has(path);
  }

  // Parse `text` and install it as the document at `path`, replacing whatever was there.
  adoptText(path: string, text: string): FlowDocument {
    const doc = parseFlow(text);
    FlowDoc.assignMissingIds(doc);
    this.replace(path, { doc, committedText: text });
    this.adoptDocument(path, doc);
    return doc;
  }

  // Register a document loaded by someone else (the expansion layer's lazy fetch) ahead of
  // mutating it, so its pre-edit text becomes the baseline the first undo restores.
  trackWithBaseline(path: string, doc: FlowDocument): void {
    if (this.tracked.has(path)) return;
    this.tracked.set(path, { doc, committedText: serializeFlow(doc) });
  }

  // Register a document that has already been mutated in place, where no pre-edit text can be
  // recovered. Its next commit always writes. Paths with no baseline are omitted from
  // snapshot(), so that first commit is not undoable — the usual entry is a drag on a frame
  // document the session has not tracked yet (commitMovesFor).
  trackWithoutBaseline(path: string, doc: FlowDocument): void {
    if (this.tracked.has(path)) return;
    this.tracked.set(path, { doc, committedText: null });
  }

  // Stop tracking a path whose file is gone, cancelling anything pending against it.
  forget(path: string): void {
    const entry = this.tracked.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.tracked.delete(path);
    this.replacements += 1;
  }

  commitAfter(path: string, timing: CommitTiming): void {
    if (timing === 'now') this.commit(path);
    else this.scheduleCommit(path);
  }

  scheduleCommit(path: string): void {
    const entry = this.tracked.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.commit(path), this.debounceMs);
  }

  commit(path: string): void {
    const entry = this.tracked.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    FlowDoc.ensureLayoutEverywhere(entry.doc);
    const text = serializeFlow(entry.doc);
    if (text === entry.committedText) return;
    this.pushHistory(this.snapshot());
    entry.committedText = text;
    this.writeFile(path, text);
  }

  flush(): void {
    for (const path of [...this.tracked.keys()]) this.commit(path);
  }

  // Paths tracked with committedText === null are omitted — there is no restorable prior
  // state, so a commit that follows trackWithoutBaseline cannot be undone for that path.
  snapshot(): WorkspaceSnapshot {
    const snapshot: WorkspaceSnapshot = [];
    for (const [path, entry] of this.tracked) {
      if (entry.committedText != null) snapshot.push({ path, text: entry.committedText });
    }
    return snapshot;
  }

  // Reinstate each document in a snapshot that differs from its current text, writing every
  // one back so other tools see the reverted state. Returns the paths that changed.
  restore(snapshot: WorkspaceSnapshot): string[] {
    const changed: string[] = [];
    for (const { path, text } of snapshot) {
      if (this.committedTextAt(path) === text) continue;
      this.adoptText(path, text);
      this.writeFile(path, text);
      changed.push(path);
    }
    return changed;
  }

  undo(): string[] {
    this.flush();
    if (this.undoStack.length === 0) return [];
    this.redoStack.push(this.snapshot());
    return this.restore(this.undoStack.pop()!);
  }

  redo(): string[] {
    this.flush();
    if (this.redoStack.length === 0) return [];
    this.undoStack.push(this.snapshot());
    return this.restore(this.redoStack.pop()!);
  }

  // Forgets every document and the whole history — the paths mean different files after a
  // workspace switch, and nothing pending may outlive them.
  reset(): void {
    for (const entry of this.tracked.values()) clearTimeout(entry.timer);
    this.tracked.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.replacements += 1;
  }

  private replace(path: string, entry: TrackedDocument): void {
    const existing = this.tracked.get(path);
    if (existing) {
      clearTimeout(existing.timer);
      this.replacements += 1;
    }
    this.tracked.set(path, entry);
  }

  private pushHistory(snapshot: WorkspaceSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }
}
