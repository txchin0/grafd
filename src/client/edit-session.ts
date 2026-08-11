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
//
//   One action, one undo step — the unit of undo is the action the user took, not the commit.
//   A rename ripples into every file that names the node; a region gesture writes the block, the
//   members and the `inherits` of what they expand into. Undoing those one document at a time
//   would walk through states no user asked for, where one file has been renamed and the rest
//   still name what it used to be called. `runAction` marks the boundary and every commit inside
//   it records into one step.
//
// A step holds the pre-action text of exactly the documents that action changed, recorded as
// each one is first written rather than snapshotted up front. An action that loads a file it
// has never seen — the workspace-wide rename does — would otherwise leave that file out of the
// step that has to restore it.

import { parseFlow, serializeFlow, type FlowDocument } from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';

export type CommitTiming = 'debounce' | 'now';

export const COMMIT_DEBOUNCE_MS = 300;
const UNDO_LIMIT = 100;

type ActionId = number;

// One undo step: the text each document the action changed had before it ran.
interface HistoryStep {
  action: ActionId;
  before: Map<string, string>;
}

// The rest of an action, carried across an await. A ripple resolves in a later turn, by which
// time an undo or a watcher push may have re-parsed the documents it set out to rewrite; the
// work it carries then describes a state that no longer exists.
export interface ActionContinuation {
  /** Runs `body` in the action that opened it, or not at all if that state is gone. */
  resume<T>(body: () => T): T | undefined;
}

interface TrackedDocument {
  doc: FlowDocument;
  // Null while no pre-edit text is known. A drag mutates `pos` in place and only reports the
  // move once it is over, so a document first registered at that point has nothing to diff
  // against and its next commit must write unconditionally.
  committedText: string | null;
  timer?: ReturnType<typeof setTimeout>;
  // The action a debounced commit was scheduled by, so the write it makes 300ms later still
  // lands in that action's step rather than in one of its own.
  pendingAction?: ActionId | null;
}

export interface EditSessionOptions {
  writeFile(path: string, text: string): void;
  // Publishes a freshly parsed document to the expansion cache by identity. See the parse
  // identity note above.
  adoptDocument(path: string, doc: FlowDocument): void;
  // Re-keys a document entry in the expansion cache after its file was renamed, so the cache
  // and the tracked-document map stay the same object under the new path.
  retargetDocument(from: string, to: string): void;
  debounceMs?: number;
}

export class EditSession {
  private readonly tracked = new Map<string, TrackedDocument>();
  private readonly undoStack: HistoryStep[] = [];
  private readonly redoStack: HistoryStep[] = [];
  private readonly writeFile: (path: string, text: string) => void;
  private readonly adoptDocument: (path: string, doc: FlowDocument) => void;
  private readonly retargetDocument: (from: string, to: string) => void;
  private readonly debounceMs: number;
  // Every wholesale replacement of a tracked document bumps this, so a continuation that finds
  // it moved knows the documents it described are gone.
  private replacements = 0;
  private nextActionId = 1;
  private currentAction: ActionId | null = null;

  constructor({
    writeFile,
    adoptDocument,
    retargetDocument,
    debounceMs = COMMIT_DEBOUNCE_MS,
  }: EditSessionOptions) {
    this.writeFile = writeFile;
    this.adoptDocument = adoptDocument;
    this.retargetDocument = retargetDocument;
    this.debounceMs = debounceMs;
  }

  // Marks one user action. Every commit made while it runs — in this document and in every
  // other one the action reaches — records into a single undo step. Nesting joins the action
  // already running, so an action assembled from smaller ones stays one step.
  runAction<T>(body: () => T): T {
    if (this.currentAction != null) return body();
    return this.runInAction(this.nextActionId++, body);
  }

  // Hands the rest of the current action to work that finishes in a later turn. Called outside
  // an action it opens one, so a continuation's own writes still coalesce.
  suspendAction(): ActionContinuation {
    const action = this.currentAction ?? this.nextActionId++;
    const generation = this.replacements;
    return {
      resume: <T>(body: () => T): T | undefined => {
        if (generation !== this.replacements) return undefined;
        return this.runInAction(action, body);
      },
    };
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
  // recovered. Its next commit always writes, and records nothing into the step: there is no
  // prior state to put back, so that first commit is not undoable — the usual entry is a drag
  // on a frame document the session has not tracked yet (commitMovesFor).
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

  // Moves a tracked document to a new path after its file was renamed. Pending commits follow
  // the move (re-armed against the new path). The expansion cache is re-keyed through
  // `retargetDocument`, so both maps keep pointing at the same document object. Deliberately
  // does not bump `replacements`: nothing was re-parsed, so in-flight action continuations
  // stay valid.
  //
  // History is clamped here: every earlier step restores pre-rename text that still spells
  // the old path, and the move itself is not undoable, so those steps can no longer describe
  // a real state. This holds even when the renamed file was never tracked — steps for other
  // documents name the old path too.
  retarget(from: string, to: string): void {
    const entry = this.tracked.get(from);
    if (entry) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.commitPending(to), this.debounceMs);
      }
      this.tracked.delete(from);
      this.tracked.set(to, entry);
    }
    this.retargetDocument(from, to);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  // Writes a document's current serialized text without recording an undo step — the
  // file-rename ripple's writes are not part of undo history because the path move itself is
  // not undoable, and an undo that reverted only the links would leave them naming a file
  // that no longer exists.
  commitWithoutUndo(path: string): void {
    const entry = this.tracked.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.pendingAction = null;
    FlowDoc.ensureLayoutEverywhere(entry.doc);
    const text = serializeFlow(entry.doc);
    if (text === entry.committedText) return;
    entry.committedText = text;
    this.writeFile(path, text);
  }

  commitAfter(path: string, timing: CommitTiming): void {
    if (timing === 'now') this.commit(path);
    else this.scheduleCommit(path);
  }

  scheduleCommit(path: string): void {
    const entry = this.tracked.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.pendingAction = this.currentAction;
    entry.timer = setTimeout(() => this.commitPending(path), this.debounceMs);
  }

  commit(path: string): void {
    const entry = this.tracked.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.pendingAction = null;
    FlowDoc.ensureLayoutEverywhere(entry.doc);
    const text = serializeFlow(entry.doc);
    if (text === entry.committedText) return;
    if (entry.committedText != null) this.recordPreActionText(path, entry.committedText);
    entry.committedText = text;
    this.writeFile(path, text);
  }

  // A commit that was scheduled belongs to the action that scheduled it whatever makes it land —
  // its own timer, or a flush from an undo pressed before that timer fired.
  private commitPending(path: string): void {
    const action = this.tracked.get(path)?.pendingAction;
    if (action == null) {
      this.commit(path);
      return;
    }
    this.runInAction(action, () => this.commit(path));
  }

  flush(): void {
    for (const path of [...this.tracked.keys()]) this.commitPending(path);
  }

  // Reinstate each document in a step that differs from its current text, writing every one
  // back so other tools see the reverted state. Returns the paths that changed.
  private restore(step: HistoryStep): string[] {
    const changed: string[] = [];
    for (const [path, text] of step.before) {
      if (this.committedTextAt(path) === text) continue;
      this.adoptText(path, text);
      this.writeFile(path, text);
      changed.push(path);
    }
    return changed;
  }

  undo(): string[] {
    this.flush();
    const step = this.undoStack.pop();
    if (!step) return [];
    this.redoStack.push(this.counterStep(step));
    return this.restore(step);
  }

  redo(): string[] {
    this.flush();
    const step = this.redoStack.pop();
    if (!step) return [];
    this.undoStack.push(this.counterStep(step));
    return this.restore(step);
  }

  // The step that undoes the one about to be restored: the same documents, at the text they
  // currently hold. Built before restoring, and only from documents still tracked — a path
  // whose file is gone has no state to come back to.
  private counterStep(step: HistoryStep): HistoryStep {
    const before = new Map<string, string>();
    for (const path of step.before.keys()) {
      const text = this.committedTextAt(path);
      if (text != null) before.set(path, text);
    }
    return { action: step.action, before };
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

  private runInAction<T>(action: ActionId, body: () => T): T {
    const outer = this.currentAction;
    this.currentAction = action;
    try {
      return body();
    } finally {
      this.currentAction = outer;
    }
  }

  // Only the first write to a document within an action is its pre-action text; later ones in
  // the same action would record what the action itself put there.
  private recordPreActionText(path: string, text: string): void {
    const step = this.stepForCurrentAction();
    if (!step.before.has(path)) step.before.set(path, text);
  }

  // An action extends the step it is already building. A step left on top by some other action
  // is never extended: an unrelated edit that landed between an action and the continuation it
  // is still waiting on would otherwise be undone along with it.
  private stepForCurrentAction(): HistoryStep {
    const top = this.undoStack[this.undoStack.length - 1];
    if (this.currentAction != null && top?.action === this.currentAction) return top;
    return this.pushStep(this.currentAction ?? this.nextActionId++);
  }

  private pushStep(action: ActionId): HistoryStep {
    const step: HistoryStep = { action, before: new Map() };
    this.undoStack.push(step);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    return step;
  }
}
