// A provider's name is how every other file refers to it: downstream files carry it in the
// `inherits` the editor generates and in the `updates` their nodes declare (spec §8.4, §8.6),
// so a rename that stopped at this file would leave them naming a provider nobody declares.
//
// Loading the workspace resumes in a later turn, by which time an undo or a watcher push may
// have re-parsed the documents. The rename would then describe a state that no longer exists.

import type { FlowDocument } from '../../shared/flow-format.js';
import * as FlowDoc from '../flow-doc.js';
import type { DocumentOwner } from '../canvas/expansion.js';
import type { CommitTiming } from '../edit-session.js';

export interface WorkspaceRenameDeps {
  documentGeneration(): number;
  loadEveryWorkspaceDocument(): Promise<void>;
  knownDocuments(): DocumentOwner[];
  applyToDoc(owner: DocumentOwner, mutation: () => void, options?: { commit?: CommitTiming }): void;
}

export async function renameContextAcrossWorkspace(
  deps: WorkspaceRenameDeps,
  declaring: DocumentOwner,
  oldName: string,
  newName: string,
): Promise<void> {
  const generation = deps.documentGeneration();
  await deps.loadEveryWorkspaceDocument();
  if (generation !== deps.documentGeneration()) return;

  for (const entry of deps.knownDocuments()) {
    if (entry.doc === declaring.doc) continue;
    // A file that declares a provider of this name declares its own; the names collide but the
    // providers do not, and rewriting its references would point them at ours.
    if (FlowDoc.contextBlockNamed(entry.doc, oldName)) continue;
    if (!FlowDoc.referencesContext(entry.doc, oldName)) continue;
    deps.applyToDoc(entry, () => FlowDoc.renameContextReferences(entry.doc, oldName, newName), { commit: 'now' });
  }
}

/** Test helper: whether a document still names `oldName` in inherits or updates. */
export function documentReferencesContext(doc: FlowDocument, name: string): boolean {
  return FlowDoc.referencesContext(doc, name);
}
