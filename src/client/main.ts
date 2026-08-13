// App shell: file list, workspace sync, undo/redo, keyboard shortcuts, and the glue between
// canvas gestures (canvas-view.ts), document mutations (flow-doc.ts), the floating editors
// (editors.ts), and inline subgraph expansion (expansion.ts).
//
// Files live in the active workspace (workspace.ts): the Grafd server when one is answering
// (self-hosted mode), browser storage when the app is statically hosted (serverless mode),
// or a local folder opened through the File System Access API in either mode. UI state —
// entrypoint, active flow, per-flow cameras — persists to the workspace's
// grafd.manifest.json.
//
// Sync model: the serialized file text is the source of truth. Every mutation edits the
// parsed AST, re-renders immediately, and writes the re-serialized text to the workspace
// (debounced for typing, immediate for drags). External file changes arrive through the
// workspace delegate and replace the AST wholesale; selection and open editors survive via
// node UUIDs.
//
// Navigation model: opening a node's subgraph (its ⤢ badge) pushes the current location
// onto a trail and plays a zoom-into-the-node transition, so the breadcrumb reads like a
// path (login / dashboard.flow). Trail crumbs animate back out; picking a file from the
// sidebar snaps and clears the trail.

import {
  parseFlow,
  serializeFlow,
  setPreambleField,
  getProp,
  setProp,
  quoteValue,
  collapseToSingleLine,
  parseExpandLink,
  resolveLinkPath,
  resolvedExpandPath,
  descriptionForNode,
  referencesForNode,
  setPreambleReferences,
  sanitizeName,
  unquote,
  type EdgeSpec,
  type ExpandLink,
  type FlowDocument,
  type FlowItem,
  type FlowNode,
  type Rect,
  type Reference,
} from '../shared/flow-format.js';
import { DEFAULT_NODE_SIZE } from '../shared/auto-layout.js';
import * as FlowDoc from './flow-doc.js';
import type { FlowModel, MembershipChange, ModelEdge } from './flow-doc.js';
import type { Point } from './geometry.js';
import { CanvasView, type ContextTarget, type EdgeDrop, type Tool, type View } from './canvas/canvas-view.js';
import { createContextMenu, type MenuItem } from './context-menu.js';
import type { Modal } from './modal.js';
import { createPreferencesDialog } from './preferences-dialog.js';
import { applyCanvasFont } from './canvas-font.js';
import { loadPreferences, savePreferences, type Preferences } from './preferences.js';
import type { LinkContext } from './reference-link.js';
import { applyTheme } from './theme.js';
import {
  ExpansionLayer,
  TOGGLE_DURATION_MS,
  type DocumentOwner,
} from './canvas/expansion.js';
import {
  backOutAnchorFor,
  divePathTo,
  type DiveTarget,
  type TrailEntry,
} from './canvas/dive-navigation.js';
import { createEditors, type Editors } from './editors.js';
import { EditSession, type CommitTiming } from './edit-session.js';
import { MANIFEST_FILE_NAME } from '../shared/manifest.js';
import type { Workspace, WorkspaceDelegate } from './workspace.js';
import { ServerWorkspace, serverIsAvailable } from './workspace-server.js';
import { BrowserWorkspace } from './workspace-browser.js';
import { FolderWorkspace, folderPickingIsSupported, pickWorkspaceFolder } from './workspace-folder.js';
import { exportWorkspaceAsZip } from './export.js';
import { safeFileStem } from './download.js';
import { createScreenshotDialog } from './screenshot.js';
import { createSidebarFiles } from './sidebar-files.js';
import { createGraphPanel } from './graph-panel.js';
import { createClipboard } from './clipboard.js';
import { createWorkspaceUiState } from './workspace-ui-state.js';
import type { OpenFlow } from './open-flow.js';
import {
  createContextOrchestration,
  getBlockProp,
  setBlockProp,
  type ContextOrchestration,
} from './context/index.js';
import {
  copyFlowPath,
  extractedFlowPath,
  findExistingFile,
  folderOf,
  nextUntitledFlowName,
  normalizeFlowPath,
} from './flow-paths.js';
import { renameTargetPath, rewriteFileReferences, validateFlowRename } from './file-rename.js';

// TrailEntry and DiveTarget live in dive-navigation.ts.

let openFlow: OpenFlow | null = null;
let workspaceFiles: string[] = [];

const navigation = { trail: [] as TrailEntry[], inProgress: false };

// Every document an edit can reach — the open file and any external file unfolded inside a
// frame — is tracked by one session, which owns their committed texts, their debounced
// writes, and the undo history spanning all of them (edit-session.ts).
const session = new EditSession({
  writeFile: sendWrite,
  adoptDocument: (path, doc) => expansions.adoptDocument(path, doc),
  retargetDocument: (from, to) => expansions.retargetPath(from, to),
});

let currentPreferences: Preferences = loadPreferences();
applyTheme(currentPreferences.theme);
let workspace: Workspace | null = null;
let defaultWorkspaceKind: 'server' | 'browser' = 'browser';

function elementById<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const elements = {
  fileList: elementById<HTMLUListElement>('file-list'),
  newFileButton: elementById<HTMLButtonElement>('new-file-button'),
  newFileInput: elementById<HTMLInputElement>('new-file-input'),
  newFileError: elementById<HTMLParagraphElement>('new-file-error'),
  breadcrumb: elementById<HTMLElement>('breadcrumb'),
  emptyState: elementById<HTMLDivElement>('empty-state'),
  emptyStateHint: elementById<HTMLParagraphElement>('empty-state-hint'),
  connectionDot: elementById<HTMLSpanElement>('connection-dot'),
  workspaceName: elementById<HTMLSpanElement>('workspace-name'),
  workspaceMenuButton: elementById<HTMLButtonElement>('workspace-menu-button'),
  sidebarToggle: elementById<HTMLButtonElement>('sidebar-toggle'),
  sidebarReveal: elementById<HTMLButtonElement>('sidebar-reveal'),
  helpToggle: elementById<HTMLButtonElement>('help-toggle'),
  helpOverlay: elementById<HTMLDivElement>('help-overlay'),
  toolSelectButton: elementById<HTMLButtonElement>('tool-select-button'),
  toolNodeButton: elementById<HTMLButtonElement>('tool-node-button'),
  toolContextButton: elementById<HTMLButtonElement>('tool-context-button'),
  zoomIn: elementById<HTMLButtonElement>('zoom-in-button'),
  zoomOut: elementById<HTMLButtonElement>('zoom-out-button'),
  zoomLevel: elementById<HTMLButtonElement>('zoom-level-button'),
  zoomFit: elementById<HTMLButtonElement>('zoom-fit-button'),
  graphPanel: elementById<HTMLDivElement>('graph-panel'),
  graphToggle: elementById<HTMLButtonElement>('gp-toggle'),
  graphName: elementById<HTMLInputElement>('gp-name'),
  graphDescription: elementById<HTMLTextAreaElement>('gp-description'),
  graphOnError: elementById<HTMLInputElement>('gp-on-error'),
  graphEntrypoint: elementById<HTMLInputElement>('gp-entrypoint'),
  graphReferenceRows: elementById<HTMLDivElement>('gp-reference-rows'),
  graphAddReference: elementById<HTMLButtonElement>('gp-add-reference'),
};

// grafd.manifest.json — the workspace entrypoint plus the camera, open frames and active flow
// this browser last left behind. Sampled from the live view at save time.
const uiState = createWorkspaceUiState({
  writeFile: sendWrite,
  activePath: () => openFlow?.path ?? null,
  camera: () => view.view,
  openExpansionIds: () => expansions.openVisibleNodeIds(),
});

const contextMenu = createContextMenu();

// Region/context-block orchestration. Declared early so CanvasView callbacks can close over it;
// assigned after view/editors exist — those callbacks only run on user gestures.
let contextOps: ContextOrchestration;

// Copy/cut/paste/duplicate. Built here rather than beside the canvas because everything it
// needs — the selection, the owning document of a node, the routed mutation — is reached
// through callbacks, so nothing it depends on has to exist yet.
const clipboard = createClipboard({
  openFlow: () => openFlow,
  selection: () => [...view.selection],
  select: (nodes) => view.setSelection(nodes),
  ownerOf,
  documentAt: (path) => {
    const doc = expansions.documentAt(path);
    return doc ? { doc, path } : null;
  },
  // Every clipboard mutation is a structural edit, so none of them wait on the typing debounce.
  applyToDoc: (owner, mutation) => applyToDoc(owner, mutation, { commit: 'now' }),
  deleteSelection: () => deleteSelection(),
});


// The header panel reads whatever flow it is handed and routes its edits back through `mutate`.
const graphPanel = createGraphPanel({
  elements: {
    panel: elements.graphPanel,
    toggle: elements.graphToggle,
    name: elements.graphName,
    description: elements.graphDescription,
    onError: elements.graphOnError,
    entrypoint: elements.graphEntrypoint,
    referenceRows: elements.graphReferenceRows,
    addReference: elements.graphAddReference,
  },
  openFlow: () => openFlow,
  edit: mutate,
  linkContext,
  runAction: (body) => session.runAction(body),
  hostRenamed: rippleInnerRefsAcrossWorkspace,
});

// The sidebar renders the workspace's paths and reports what the user picked; the actions it
// names live here. Constructed with `elements` rather than alongside the canvas, since its only
// collaborator is the context menu and that has no dependencies of its own.
const sidebarFiles = createSidebarFiles({
  fileList: elements.fileList,
  newFileButton: elements.newFileButton,
  newFileInput: elements.newFileInput,
  newFileError: elements.newFileError,
  contextMenu,
  files: () => workspaceFiles,
  activePath: () => openFlow?.path ?? null,
  openFile: (path) => openFlowFromSidebar(path),
  deleteFile: deleteFlowFile,
  duplicateFile: (path) => void duplicateFlowFile(path),
  renameFile: renameFlowFile,
  createFile: createFlowFile,
});

function modelFor(flow: Omit<OpenFlow, 'model'>): FlowModel {
  const model = FlowDoc.buildModel(flow.doc, flow.scope);
  model.sourcePath = flow.path;
  return model;
}

function refresh(): void {
  if (!openFlow) return;
  openFlow.model = modelFor(openFlow);
  expansions.invalidateSubModels();
  view.setModel(openFlow.model);
  renderBreadcrumb(openFlow);
  graphPanel.render(openFlow);
  editors.refreshFromDoc();
}

function mutate(mutation: () => void, options?: { commit?: CommitTiming }): void {
  if (!openFlow) return;
  applyToDoc({ doc: openFlow.doc, path: openFlow.path }, mutation, options);
}

function undo(): void {
  adoptRestoredDocuments(session.undo());
}

function redo(): void {
  adoptRestoredDocuments(session.redo());
}

// A restore replaces the document object at every path it touches, so the app's own handle on
// the open one has to be re-read rather than kept.
function adoptRestoredDocuments(changedPaths: string[]): void {
  const restoredOpenDocument = openFlow && changedPaths.includes(openFlow.path)
    ? session.documentAt(openFlow.path)
    : null;
  if (restoredOpenDocument) adoptOpenDocument(restoredOpenDocument);
  expansions.invalidateSubModels();
  refresh();
}

// Open a flow, building its model so the four parts are never momentarily out of step.
function setOpenFlow(path: string, doc: FlowDocument, scope: string | null): void {
  openFlow = { path, doc, scope, model: modelFor({ path, doc, scope }) };
}

// Swap in a reparse of the open file, from an undo or a watcher push.
function adoptOpenDocument(doc: FlowDocument): void {
  if (!openFlow) return;
  setOpenFlow(openFlow.path, doc, openFlow.scope);
  dropScopeIfMissing();
}

// A `graph:` block can leave the open document under the canvas — an undo past its creation, a
// watcher push, an extraction into its own file — stranding a scope that names it. Callers
// refresh straight after, which rebuilds the model against the corrected scope.
function dropScopeIfMissing(): void {
  if (!openFlow?.scope) return;
  if (FlowDoc.graphBlockNames(openFlow.doc).includes(openFlow.scope)) return;
  openFlow.scope = null;
}

const workspaceDelegate: WorkspaceDelegate = {
  filesChanged(files) {
    workspaceFiles = files;
    renderFileList();
    if (openFlow && !files.includes(openFlow.path)) void closeIfFileGone(openFlow.path);
  },
  fileRenamed(from, to) {
    // Another client renamed a file. The server broadcasts this before the follow-up file
    // list, so the open flow is retargeted here and is never mistaken for a deleted file.
    retargetFileState(from, to);
  },
  fileChanged(path, text) {
    // Manifest changes from other clients are UI state, not content — adopting them
    // mid-session would fight the local camera and selection.
    if (path === MANIFEST_FILE_NAME) return;
    if (!workspaceFiles.includes(path)) {
      workspaceFiles.push(path);
      workspaceFiles.sort();
      renderFileList();
    }
    if (path !== openFlow?.path && !expansions.watchesPath(path)) return;
    if (session.committedTextAt(path) === text) return;
    adoptWatchedText(path, text);
  },
  connectionChanged(connected) {
    elements.connectionDot.classList.toggle('connected', connected);
  },
};

function sendWrite(path: string, text: string): void {
  workspace?.writeFile(path, text);
}

function scheduleManifestSave(): void {
  if (workspace) uiState.scheduleSave();
}

// A watcher push replaces a document wholesale. Routing it through the session cancels any
// commit still pending for that path, which would otherwise fire holding the pre-push object
// and serialize it back over the content that just arrived.
function adoptWatchedText(path: string, text: string): void {
  const doc = session.adoptText(path, text);
  if (path === openFlow?.path) {
    adoptOpenDocument(doc);
    refresh();
    return;
  }
  expansions.invalidateSubModels();
  view.requestRender();
  editors.refreshFromDoc();
}

// `restoreSavedView` covers everything the manifest remembers about how this flow was last
// looked at — which frames were unfolded and where the camera sat. A dive turns it off: the
// destination is reached by an animation that places the camera itself, and restoring a
// remembered one mid-flight would fight it.
async function openFile(
  path: string,
  { presetText = null, restoreSavedView = true }: { presetText?: string | null; restoreSavedView?: boolean } = {},
): Promise<boolean> {
  let text = presetText;
  if (text == null) {
    text = (await workspace?.readFile(path)) ?? null;
    if (text == null) {
      // A listed file whose content cannot be read is gone (deleted externally, or a stale
      // list entry); keeping it clickable-but-dead is worse than dropping it. The next
      // filesChanged from the workspace restores it if the failure was transient.
      dropFromFileList(path);
      return false;
    }
  }
  // Flush before switching so a commit still debouncing against the outgoing file lands in it
  // rather than being evaluated later against whatever is open by then; reset then drops the
  // outgoing documents and their history, which no longer describe anything reachable.
  session.flush();
  session.reset();
  setOpenFlow(path, session.adoptText(path, text), null);
  editors.closeAll();
  view.clearSelection();
  elements.emptyState.classList.add('hidden');
  location.hash = path;
  const saved = uiState.savedViewOf(path);
  if (restoreSavedView && saved.openExpansions) expansions.restoreOpen(saved.openExpansions);
  refresh();
  if (restoreSavedView) {
    if (saved.camera) view.setViewNow(saved.camera);
    else view.fitToContent();
  }
  renderFileList();
  scheduleManifestSave();
  return true;
}

function dropFromFileList(path: string): void {
  const index = workspaceFiles.indexOf(path);
  if (index === -1) return;
  workspaceFiles.splice(index, 1);
  renderFileList();
}

function deleteFlowFile(path: string): void {
  workspace?.deleteFile(path);
  // Untrack before anything else: a commit still pending against this path would re-create the
  // file moments after it was deleted.
  session.forget(path);
  dropFromFileList(path);
  uiState.forgetFlow(path, workspaceFiles);
  if (openFlow?.path === path) closeCurrentFlow();
}

function closeCurrentFlow(): void {
  navigation.trail.length = 0;
  editors.closeAll();
  view.clearSelection();
  // Deliberately not flushed: the flow is closing because it was deleted or vanished, and a
  // pending commit would write it straight back.
  session.reset();
  openFlow = null;
  const next = uiState.startupFlow(workspaceFiles);
  if (next) void openFile(next);
  else showEmptyWorkspace();
}

// A files update that no longer lists the open flow usually means another client deleted
// it — but it can also be a transient race (a list rebuilt before a just-created file
// landed on disk), so confirm the file is really gone by reading it before closing.
async function closeIfFileGone(path: string): Promise<void> {
  const text = (await workspace?.readFile(path)) ?? null;
  if (text != null || openFlow?.path !== path) return;
  closeCurrentFlow();
}

function setScope(scopeName: string | null, { fit = true }: { fit?: boolean } = {}): void {
  if (!openFlow) return;
  openFlow.scope = scopeName;
  editors.closeAll();
  view.clearSelection();
  refresh();
  if (fit) view.fitToContent();
}

async function duplicateFlowFile(path: string): Promise<void> {
  const text = session.committedTextAt(path) ?? (await workspace?.readFile(path));
  if (text == null) return;
  registerCreatedFlowFile(copyFlowPath(workspaceFiles, path), text);
}

// Renames a file in place (same folder), then moves every handle that knows the old path —
// the session, the expansion cache, the open flow, the navigation trail, and the manifest —
// and finally rewrites every reference to it across the workspace. Resolves to null when the
// editor should close (a valid rename or an unchanged no-op), otherwise why the rename
// cannot happen. State only moves after the backend confirms the file actually moved, so a
// refused rename leaves the workspace and every reference untouched.
async function renameFlowFile(path: string, requested: string): Promise<string | null> {
  const error = validateFlowRename(workspaceFiles, path, requested);
  if (error) return error;
  const to = renameTargetPath(path, requested);
  if (!to || to === path) return null;
  // Pending commits must land before the move so a debounced write can't re-create the old
  // file after it moved; every backend serializes the rename after the flush's writes.
  session.flush();
  if (!workspace) {
    return 'The workspace is not connected — reopen a workspace before renaming a file.';
  }
  const renamed = await workspace.renameFile(path, to);
  if (!renamed) {
    return `Could not rename ${path} — the file may have changed, the name may be taken, or this browser cannot perform the rename.`;
  }
  retargetFileState(path, to);
  void rippleFileRename(path, to);
  return null;
}

// Moves every handle that knows the old path — the session, the expansion cache, the open
// flow, the navigation trail, and the manifest — after a file was renamed, whether by this
// tab or by another client.
function retargetFileState(from: string, to: string): void {
  const index = workspaceFiles.indexOf(from);
  if (index !== -1) workspaceFiles.splice(index, 1, to);
  else workspaceFiles.push(to);
  workspaceFiles.sort();
  session.retarget(from, to);
  let trailRetargeted = false;
  for (const entry of navigation.trail) {
    if (entry.path === from) {
      entry.path = to;
      trailRetargeted = true;
    }
  }
  if (openFlow?.path === from) {
    openFlow.path = to;
    location.hash = to;
    refresh();
  } else if (trailRetargeted) {
    // The trail can name the renamed file even when a deeper file is open; retargeting the
    // entry is not enough — the breadcrumb is only re-rendered by refresh.
    renderBreadcrumb(openFlow);
  }
  uiState.renameFlow(from, to);
  renderFileList();
}

// A rename reaches past the documents the expansion layer happens to have loaded: expand
// links and references rows pointing at the old path can sit in any file. The load spans a
// turn, so the rewrite resumes under the same generation guard the node/context ripples use —
// an undo or watcher push during the load abandons it rather than rewriting documents a
// restore just replaced.
async function rippleFileRename(from: string, to: string): Promise<void> {
  const continuation = session.suspendAction();
  // References resolve against the project root (spec §4.5), so the rewrite needs the
  // workspace's prefix under it — ".grafd/" in the default layout, '' when the workspace is
  // the project root itself.
  const workspacePrefix = workspace?.workspaceRootPrefix ?? '';
  await loadEveryWorkspaceDocument();
  continuation.resume(() => {
    // An edit that landed while the workspace was loading still has a pending commit.
    // Commit it first — recording its undo step — so the ripple's write never swallows a
    // user's edit without a history entry.
    session.flush();
    for (const entry of knownDocuments()) {
      const containingPath = entry.path === from ? to : entry.path;
      applyRippleToDoc(entry, () => rewriteFileReferences(entry.doc, containingPath, from, to, workspacePrefix));
    }
  });
}

function renderBreadcrumb(flow: OpenFlow | null): void {
  const crumbs: HTMLElement[] = [];
  navigation.trail.forEach((entry, index) => {
    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = crumbLabel(entry);
    crumb.title = entry.scope ? `${entry.path} › ${entry.scope}` : entry.path;
    crumb.addEventListener('click', () => navigateBackTo(index));
    crumbs.push(crumb, breadcrumbSeparator());
  });
  const current = document.createElement('span');
  current.className = 'crumb current';
  current.textContent = flow ? (flow.scope ? `${flow.path} › ${flow.scope}` : flow.path) : '';
  crumbs.push(current);
  elements.breadcrumb.replaceChildren(...crumbs);
}

function crumbLabel(entry: TrailEntry): string {
  if (entry.scope) return entry.scope;
  return entry.path.split('/').pop()!.replace(/\.flow$/, '');
}

function breadcrumbSeparator(): HTMLElement {
  const separator = document.createElement('span');
  separator.className = 'separator';
  separator.textContent = '/';
  return separator;
}

function centeredDefaultRect(worldPoint: Point): Rect {
  const { w, h } = DEFAULT_NODE_SIZE;
  return { x: Math.round(worldPoint.x - w / 2), y: Math.round(worldPoint.y - h / 2), w, h };
}

// The document and `graph:` block a node drawn on the canvas belongs to: the open file's
// current scope at the top level, or the subgraph an unfolded frame is showing — which may
// live in another file entirely. Resolved from the host's `expand` against the live
// documents rather than the frame geometry, which is rebuilt a frame behind every re-parse
// (undo, redo, a watcher update) and would write into a document already replaced.
function creationTargetFor(frameHost: FlowNode | null): { owner: DocumentOwner; scope: string | null } | null {
  if (!openFlow) return null;
  if (!frameHost) return { owner: { doc: openFlow.doc, path: openFlow.path }, scope: openFlow.scope };
  const host = liveNode(frameHost);
  const expandValue = getProp(host, 'expand');
  // Both misses mean the frame on screen no longer describes anything writable: its host lost
  // its `expand`, or the file that `expand` names is not loaded. Neither should be reachable —
  // a frame is only drawn once its subgraph resolved — but the canvas hands back geometry from
  // the frame it last drew, which a re-parse can invalidate. Creating nothing is the safe
  // answer; creating into a guess would put the node in the wrong file.
  if (!expandValue) return null;
  const hostOwner = ownerOf(host);
  const path = resolvedExpandPath(expandValue, hostOwner.path);
  if (!path) return { owner: hostOwner, scope: expandValue };
  const doc = expandTargetDoc(path);
  return doc ? { owner: { doc, path }, scope: null } : null;
}

function creationItems(target: { owner: DocumentOwner; scope: string | null }): FlowItem[] {
  return FlowDoc.ensureScopeItems(target.owner.doc, target.scope);
}

// Canvas geometry hands back the node objects of the document it last drew. A re-parse
// (undo, redo, a file change) replaces those objects, so anything about to be written is
// looked up again by id — mutating the detached copy would be silently discarded, or
// serialized back over the document that replaced it.
function liveNode(node: FlowNode): FlowNode {
  return (node.id ? findNode(node.id) : null) ?? node;
}

// A node added inside a frame has no locus until frame geometry is rebuilt; laying out now
// keeps the inline title editor from anchoring to subgraph coordinates read as world ones.
function focusNewNode(node: FlowNode): void {
  view.refreshDisplayGeometry();
  view.select(node);
  editors.openTitleEditor(node);
}

// Inline expansion animates the frame open or shut; wait for that layout to settle before
// anchoring the title overlay (same delay convertSelectionToSubgraph already used for the
// node editor).
function focusNodeTitleAfterLayout(node: FlowNode): void {
  view.refreshDisplayGeometry();
  view.select(node);
  setTimeout(() => editors.openTitleEditor(liveNode(node)), TOGGLE_DURATION_MS);
}

function commitCreatedNodeMembership(owner: DocumentOwner, node: FlowNode): void {
  const changes = FlowDoc.membershipChangesForNewNode(FlowDoc.buildModel(owner.doc, null), node);
  if (changes.length > 0) writeMovesAndMembership([], changes, []);
}

function runNodeCreationAction(owner: DocumentOwner, create: () => FlowNode | null): FlowNode | null {
  let node: FlowNode | null = null;
  session.runAction(() => {
    applyToDoc(owner, () => {
      node = create();
    }, { commit: 'now' });
    if (node) commitCreatedNodeMembership(owner, node);
  });
  return node;
}

function createNodeAndEdit(rect: Rect, frameHost: FlowNode | null = null, requestedName = 'Untitled'): FlowNode | null {
  const target = creationTargetFor(frameHost);
  if (!target) return null;
  const items = creationItems(target);
  const node = runNodeCreationAction(target.owner, () => FlowDoc.addNode(items, rect, requestedName));
  if (node) focusNewNode(node);
  return node;
}

function extractionTargetForSelection(): { owner: DocumentOwner; items: FlowItem[]; nodes: FlowNode[] } | null {
  const nodes = [...view.selection];
  if (nodes.length <= 1) return null;
  const owner = ownerOf(nodes[0]);
  const items = FlowDoc.containingItems(owner.doc, nodes[0]);
  for (const node of nodes) {
    const nodeOwner = ownerOf(node);
    if (nodeOwner.doc !== owner.doc || nodeOwner.path !== owner.path) return null;
    if (FlowDoc.containingItems(owner.doc, node) !== items) return null;
    if (!FlowDoc.nodesIn(items).includes(node)) return null;
  }
  return { owner, items, nodes };
}

function convertSelectionToSubgraph(): void {
  const target = extractionTargetForSelection();
  if (!target) return;
  editors.closeAll();
  const { owner, items, nodes } = target;
  const retargets: { identity: FlowDoc.ExpandIdentity; name: string }[] = [];
  for (const node of nodes) {
    const identity = FlowDoc.expandIdentityForNode(owner.doc, owner.path, node);
    if (identity) retargets.push({ identity, name: node.name });
  }
  for (const node of nodes) {
    if (node.id) expansions.discardToggle(node.id);
  }
  let host: FlowNode | null = null;
  session.runAction(() => {
    applyToDoc(owner, () => {
      host = FlowDoc.extractSubgraph(items, nodes, owner.doc).host;
      for (const { identity, name } of retargets) {
        FlowDoc.retargetInnerRefs([{ doc: owner.doc, path: owner.path }], identity, name, host.name);
      }
    }, { commit: 'now' });
    for (const { identity, name } of retargets) {
      void retargetInnersAcrossWorkspace(identity, name, host!.name, owner.doc);
    }
  });
  expansions.collapseFrom(host!);
  focusNodeTitleAfterLayout(host!);
}

// A plain node becomes a subgraph host by gaining a local `graph:` block of its own name — the
// mirrored pairing renames keep in step — and unfolds it straight away, empty, ready for the
// first inner node. A name already taken by a block adopts that block rather than duplicating it,
// which is what typing the same name into the node editor's expand field does.
function convertNodeToSubgraph(node: FlowNode): void {
  if (getProp(node, 'expand')) return;
  editors.closeAll();
  applyExpandEditAction(node, node.name);
  toggleInlineExpansion(node);
}

// A node whose `expand` is a local `graph:` reference can be promoted to its own .flow file;
// one already pointing at a file (the `[Label](path)` form) has nothing to extract.
function extractableBlockNameFor(node: FlowNode): string | null {
  const expandValue = getProp(node, 'expand');
  if (!expandValue || parseExpandLink(expandValue)) return null;
  return expandValue;
}

function registerCreatedFlowFile(path: string, text: string): void {
  sendWrite(path, text);
  if (!workspaceFiles.includes(path)) {
    workspaceFiles.push(path);
    workspaceFiles.sort();
  }
  renderFileList();
}

// The extracted file is that node's definition (spec §3.1), so it takes the node's name —
// the one the canvas shows. A block shared by several nodes has no single owner to name it
// after and keeps the block's own name.
function graphNameForExtraction(node: FlowNode, blockName: string, doc: FlowDocument): string {
  const hosts = FlowDoc.hostsOfExpansion([{ doc, path: null }], { kind: 'graph-block', name: blockName });
  return hosts.length === 1 ? node.name : blockName;
}

function extractSubgraphIntoFile(node: FlowNode): void {
  const blockName = extractableBlockNameFor(node);
  if (!blockName) return;
  editors.closeAll();
  const owner = ownerOf(node);
  const graphName = graphNameForExtraction(node, blockName, owner.doc);
  const path = extractedFlowPath(workspaceFiles, owner.path, graphName);
  const linkPath = path.split('/').pop()!;

  // The extracted file is new, so it has no prior text to restore and takes no part in the undo
  // step: the parent document's rewrite is the whole of what this action can put back.
  let extracted: FlowDocument | null = null;
  session.runAction(() => {
    applyToDoc(owner, () => {
      extracted = FlowDoc.extractGraphBlockToDocument(owner.doc, blockName, linkPath, graphName);
    }, { commit: 'now' });
  });
  if (!extracted) return;

  FlowDoc.ensureLayoutEverywhere(extracted);
  const text = serializeFlow(extracted);
  registerCreatedFlowFile(path, text);
  session.adoptText(path, text);
  // Extraction moves the block out of the owning document, so a scope naming it is now stale.
  if (owner.path === openFlow?.path) dropScopeIfMissing();
  refresh();
}

// One delete, however many documents own the selection and however many others name what it
// removed — in `{Inner}` refinements or in a `nodes:` list (R42).
function deleteNodesAction(nodes: FlowNode[]): void {
  session.runAction(() => {
    for (const { owner, itemGroups } of FlowDoc.groupNodesByOwner(nodes, ownerOf)) {
      // Captured before the delete, while the nodes are still resolvable in their document.
      const clears = expansionIdentitiesOf(owner, itemGroups);
      const expansionPaths = expansionPathsOf(owner, itemGroups);
      applyToDoc(owner, () => {
        for (const { items, nodes: group } of itemGroups) {
          FlowDoc.deleteNodes(items, group, owner.doc, { path: owner.path });
        }
      }, { commit: 'now' });
      // A deleted host stops reading whatever it read, so the file it expanded must stop
      // inheriting it — recomputed from the hosts that remain, stale `updates:` stripped (R40c).
      contextOps.syncInheritsForExpansionPaths(owner, expansionPaths);
      for (const { identity, name } of clears) {
        void retargetInnersAcrossWorkspace(identity, name, null, owner.doc);
      }
    }
  });
}

function expansionPathsOf(owner: DocumentOwner, itemGroups: FlowDoc.ItemGroup[]): string[] {
  const paths: string[] = [];
  for (const { nodes } of itemGroups) {
    for (const node of nodes) {
      const path = resolvedExpandPath(getProp(node, 'expand'), owner.path);
      if (path) paths.push(path);
    }
  }
  return paths;
}

// The expansions the given nodes host, paired with the names those expansions are reached by —
// what a rename or delete has to ripple through `{Inner}` refinements elsewhere.
function expansionIdentitiesOf(
  owner: DocumentOwner,
  itemGroups: FlowDoc.ItemGroup[],
): { identity: FlowDoc.ExpandIdentity; name: string }[] {
  const identities: { identity: FlowDoc.ExpandIdentity; name: string }[] = [];
  for (const { nodes } of itemGroups) {
    for (const node of nodes) {
      const identity = FlowDoc.expandIdentityForNode(owner.doc, owner.path, node);
      if (identity) identities.push({ identity, name: node.name });
    }
  }
  return identities;
}

function deleteSelection(): void {
  const nodes = [...view.selection];
  const edge = view.selectedEdge;
  const region = view.selectedRegionTarget();
  if (nodes.length > 0) {
    editors.closeAll();
    deleteNodesAction(nodes);
  } else if (edge) {
    editors.closeAll();
    applyEdit(edge.from, () => FlowDoc.deleteEdge(edge), { commit: 'now' });
  } else if (region) {
    contextOps.deleteRegion(region);
  }
}

// Opening a subgraph plays a seamless dive-in: the outgoing scene is held on screen while
// the destination loads, then both scenes render together — the subgraph riding inside the
// node's rectangle as the camera zooms through it, crossfading as it grows (see
// canvas-view's zoom transition).
//
// The node may live inside an unfolded frame, several levels down: the dive then lands
// straight on its subgraph and synthesizes a crumb for every level it skipped, so the trail
// reads as if the user had opened each level in turn.
async function openExpand(node: FlowNode): Promise<void> {
  if (!getProp(node, 'expand') || navigation.inProgress || !openFlow) return;
  navigation.inProgress = true;
  try {
    editors.closeAll();
    expansions.layout(openFlow.model, performance.now());
    expansions.collectLoci(openFlow.model);
    const dive = divePathTo(diveNavigationContext(openFlow), node);
    if (!dive) return;
    const anchor = expansions.diveAnchor(node);
    const nodeRect = anchor ? { ...anchor.frame } : { ...view.rect(node) };
    view.beginSceneHold(openFlow.model, view.view);

    if (!(await enterDiveTarget(dive.destination))) {
      view.releaseSceneHold();
      view.setViewNow(dive.entries[0].view);
      return;
    }

    navigation.trail.push(...dive.entries);
    renderBreadcrumb(openFlow);
    await view.zoomDiveIn({ nodeRect, inlineAnchor: anchor?.transform ?? null });
  } finally {
    navigation.inProgress = false;
  }
}

function diveNavigationContext(flow: OpenFlow, model: FlowModel = flow.model) {
  return {
    path: flow.path,
    scope: flow.scope,
    doc: flow.doc,
    model,
    liveView: view.view,
    fitViewForModel: (flowModel: FlowModel) => view.fitViewForModel(flowModel),
    ancestorHosts: (node: FlowNode) => expansions.ancestorHosts(node),
    modelOf: (node: FlowNode) => expansions.modelOf(node),
    documentAt: (path: string) => expansions.documentAt(path),
  };
}

async function enterDiveTarget(target: DiveTarget): Promise<boolean> {
  if (target.path !== openFlow?.path && !(await openDiveDocument(target))) return false;
  // Re-read across the await: opening the destination replaces the open flow wholesale.
  const flow = openFlow;
  if (!flow) return false;
  if (target.scope && !FlowDoc.graphBlockNames(flow.doc).includes(target.scope)) {
    mutate(() => flow.doc.items.push({ kind: 'graph', name: target.scope!, items: [] }), { commit: 'now' });
  }
  if (flow.scope !== target.scope) setScope(target.scope, { fit: false });
  return true;
}

async function openDiveDocument(target: DiveTarget): Promise<boolean> {
  if (workspaceFiles.includes(target.path)) return openFile(target.path, { restoreSavedView: false });
  if (!target.link) return false;
  const graphName = sanitizeName(target.link.label) || target.path.split('/').pop()!.replace(/\.flow$/, '');
  const text = `---\nname: ${graphName}\n---\n`;
  sendWrite(target.path, text);
  workspaceFiles.push(target.path);
  workspaceFiles.sort();
  return openFile(target.path, { presetText: text, restoreSavedView: false });
}

// Stepping back reverses the dive: the graph on screen shrinks back into the node it came
// from while the destination graph fades in around it, ending exactly on the camera that
// crumb was left at. Jumping several crumbs at once plays the same motion once, through the
// composed placement of every level it spans.
async function navigateBackTo(index: number): Promise<void> {
  if (navigation.inProgress || index >= navigation.trail.length || !openFlow) return;
  navigation.inProgress = true;
  try {
    editors.closeAll();
    const entry = navigation.trail[index];
    const dropped = navigation.trail.slice(index);
    const leavingModel = openFlow.model;
    navigation.trail.length = index;
    view.beginSceneHold(openFlow.model, view.view);
    if (entry.path !== openFlow.path) {
      const opened = await openFile(entry.path, { restoreSavedView: false });
      if (!opened) {
        view.releaseSceneHold();
        renderBreadcrumb(openFlow);
        return;
      }
    }
    // Re-read across the await: opening the crumb's file replaces the open flow wholesale.
    const flow = openFlow;
    if (!flow) return;
    if (flow.scope !== entry.scope) setScope(entry.scope, { fit: false });
    renderBreadcrumb(flow);
    const enteredNode = FlowDoc.findNodeById(flow.doc, entry.nodeId);
    if (!enteredNode?.pos) {
      view.releaseSceneHold();
      view.setViewNow(entry.view);
      return;
    }
    expansions.layout(flow.model, performance.now());
    expansions.collectLoci(flow.model);
    const anchor = backOutAnchorFor(diveNavigationContext(flow), dropped, leavingModel);
    const nodeRect = anchor ? anchor.rect : { ...view.rect(enteredNode) };
    await view.zoomBackOut({
      nodeRect,
      targetView: entry.view,
      inlineAnchor: anchor?.transform ?? null,
      childDrawnByParent: anchor?.drawnByDestination ?? false,
    });
  } finally {
    navigation.inProgress = false;
  }
}

function toggleInlineExpansion(node: FlowNode): void {
  if (!getProp(node, 'expand')) return;
  expansions.toggle(node);
  scheduleManifestSave();
}

// --- Editing routed by document ----------------------------------------------------------
//
// Nodes inside an unfolded frame may belong to another .flow file. Every mutation is routed
// to the document that owns the node and committed through the session, which debounces and
// undoes edits to the open file and to frame documents alike. The only thing the open file
// gets that a frame document does not is a model rebuild — a frame's geometry is derived on
// the next render instead.

// Every node the canvas or an editor can hand back came from the open document or from a frame
// document the expansion layer owns — there is no third source, and no node at all when nothing
// is open, so a miss here is a broken invariant rather than a case to fall back from.
function ownerOf(node: FlowNode): DocumentOwner {
  if (!openFlow) throw new Error('ownerOf: no flow is open');
  if (FlowDoc.allNodes(openFlow.doc).includes(node)) return { doc: openFlow.doc, path: openFlow.path };
  return expansions.ownerOf(node) ?? { doc: openFlow.doc, path: openFlow.path };
}

function applyToDoc(owner: DocumentOwner, mutation: () => void, { commit = 'debounce' }: { commit?: CommitTiming } = {}): void {
  // A frame document was loaded lazily by the expansion layer rather than opened, so its
  // pre-edit text is recorded here — the baseline the first undo of this edit restores.
  session.trackWithBaseline(owner.path, owner.doc);
  mutation();
  if (owner.doc === openFlow?.doc) {
    refresh();
  } else {
    expansions.invalidateSubModels();
    view.requestRender();
  }
  session.commitAfter(owner.path, commit);
}

// Applies a non-undoable rewrite to one document, mirroring applyToDoc's baseline capture and
// refresh routing. The baseline is recorded before the mutation so commitWithoutUndo sees the
// pre-rewrite text and writes the rewrite to disk. Documents the rewrite leaves unchanged are
// left alone: no baseline, no refresh, no write.
function applyRippleToDoc(owner: DocumentOwner, mutation: () => boolean): void {
  session.trackWithBaseline(owner.path, owner.doc);
  if (!mutation()) return;
  if (owner.doc === openFlow?.doc) {
    refresh();
  } else {
    expansions.invalidateSubModels();
    view.requestRender();
  }
  session.commitWithoutUndo(owner.path);
}

function applyEdit(node: FlowNode, mutation: () => void, options?: { commit?: CommitTiming }): void {
  applyToDoc(ownerOf(node), mutation, options);
}

function expandTargetDoc(path: string): FlowDocument | null {
  if (openFlow && path === openFlow.path) return openFlow.doc;
  return expansions.documentAt(path);
}

function expandTargetOwner(node: FlowNode): DocumentOwner | null {
  const path = resolvedExpandPath(getProp(node, 'expand'), ownerOf(node).path);
  if (!path) return null;
  const doc = expandTargetDoc(path);
  return doc ? { doc, path } : null;
}

function descriptionOf(node: FlowNode): string {
  return descriptionForNode(node, expandTargetOwner(node)?.doc ?? null);
}

function applyDescriptionEdit(node: FlowNode, text: string): void {
  const quoted = text ? quoteValue(text) : null;
  writeToNodeOrExpandTarget(node, {
    onNode: () => applyEdit(node, () => setProp(node, 'description', quoted)),
    onExpandTarget: (target) => writeExpandDescription(node, target, quoted),
  });
}

// An expanded node's definition lives in the target file's preamble (spec §3.1), so a field
// edited on such a node is written there rather than on the node itself. Which of the two
// applies is a property of the node, not of the field — description and references resolve it
// identically, down to the case where the prefetch of the target is still in flight.
interface ExpandFieldWriters {
  onNode(): void;
  onExpandTarget(target: DocumentOwner): void;
}

function writeToNodeOrExpandTarget(node: FlowNode, writers: ExpandFieldWriters): void {
  const path = resolvedExpandPath(getProp(node, 'expand'), ownerOf(node).path);
  if (!path) {
    writers.onNode();
    return;
  }
  const doc = expandTargetDoc(path);
  if (doc) {
    writers.onExpandTarget({ doc, path });
    return;
  }
  // Prefetch may still be in flight when the user starts typing; finish the load then write
  // to the preamble so the keystroke does not land on the referencing node.
  void expansions.ensureDocument(path).then((loaded) => {
    if (!stillExpandsTo(node, path)) return;
    if (loaded) writers.onExpandTarget({ doc: loaded, path });
    else writers.onNode();
  });
}

// The node can be re-parsed, deleted, repointed, or its whole flow closed while the fetch is in
// flight; a write resolved against the old state would land somewhere the user did not edit.
function stillExpandsTo(node: FlowNode, path: string): boolean {
  if (!openFlow || !node.id || findNode(node.id) !== node) return false;
  return resolvedExpandPath(getProp(node, 'expand'), ownerOf(node).path) === path;
}

function referencesOf(node: FlowNode): Reference[] {
  return referencesForNode(node, expandTargetOwner(node)?.doc ?? null);
}

function applyReferencesEdit(node: FlowNode, references: Reference[]): void {
  const normalized = FlowDoc.normalizeReferences(references);
  writeToNodeOrExpandTarget(node, {
    onNode: () => applyEdit(node, () => FlowDoc.setNodeReferences(node, normalized)),
    onExpandTarget: (target) => writeExpandReferences(node, target, normalized),
  });
}

function linkContext(): LinkContext {
  return {
    projectRoot: workspace?.projectRoot ?? null,
    editorLinkScheme: currentPreferences.editorLinkScheme,
  };
}

function writeExpandDescription(node: FlowNode, target: DocumentOwner, quoted: string | null): void {
  applyToDoc(target, () => setPreambleField(target.doc, 'description', quoted));
  if (getProp(node, 'description') != null) {
    applyEdit(node, () => setProp(node, 'description', null));
  }
}

function writeExpandReferences(node: FlowNode, target: DocumentOwner, references: Reference[]): void {
  applyToDoc(target, () => setPreambleReferences(target.doc, references));
  if (node.references.length > 0) {
    applyEdit(node, () => FlowDoc.setNodeReferences(node, []));
  }
}

async function ensureExpandTarget(node: FlowNode): Promise<void> {
  const path = resolvedExpandPath(getProp(node, 'expand'), ownerOf(node).path);
  if (!path) return;
  await expansions.ensureDocument(path);
}

function findNode(nodeId: string): FlowNode | null {
  const inOpenFlow = openFlow ? FlowDoc.findNodeById(openFlow.doc, nodeId) : null;
  return inOpenFlow ?? expansions.findNodeById(nodeId);
}

function findEdge(spec: EdgeSpec): ModelEdge | null {
  return openFlow?.model.edges.find((edge) => edge.spec === spec) ?? expansions.findEdgeBySpec(spec);
}

function knownDocuments(): DocumentOwner[] {
  const docs: DocumentOwner[] = [];
  if (openFlow) docs.push({ doc: openFlow.doc, path: openFlow.path });
  for (const entry of expansions.loadedDocuments()) {
    if (entry.doc !== openFlow?.doc) docs.push(entry);
  }
  return docs;
}

// Every .flow file in the workspace, parsed. `{Inner}` refinements that name a node inside an
// external file can sit in a file nobody has opened this session, so a rename of such a node
// has to reach past the documents the expansion layer happens to have loaded. Loads are cached
// by the expansion layer, so this costs one pass per session.
async function loadEveryWorkspaceDocument(): Promise<void> {
  const paths = workspaceFiles.filter((path) => path !== openFlow?.path && path.endsWith('.flow'));
  // ensureDocument awaits loads already in flight as well as starting new ones, so a ripple
  // never rewrites without the copy that was being fetched when it began.
  await Promise.all(paths.map((path) => expansions.ensureDocument(path)));
}

async function retargetInnersAcrossWorkspace(
  identity: FlowDoc.ExpandIdentity | null,
  oldName: string,
  newName: string | null,
  alreadyUpdated: FlowDocument,
): Promise<void> {
  if (!identity) return;
  // A ripple that has to load the workspace resumes in a later turn, as the rest of the rename
  // that started it: it belongs to that undo step, and it is dropped if an undo or a watcher
  // push has re-parsed the documents in the meantime — applying it then would rewrite names the
  // restore just put back.
  const continuation = session.suspendAction();
  // A local `graph:` block is only referenceable from its own file, so its inner names cannot
  // be spelled anywhere else and the workspace-wide load would be wasted.
  if (identity.kind === 'external-path') await loadEveryWorkspaceDocument();
  continuation.resume(() => {
    for (const entry of knownDocuments()) {
      if (entry.doc === alreadyUpdated) continue;
      if (!FlowDoc.hasInnerRefs([entry], identity, oldName)) continue;
      applyToDoc(entry, () => {
        FlowDoc.retargetInnerRefs([entry], identity, oldName, newName);
      }, { commit: 'now' });
    }
  });
}

// Renaming within the owning document is only half the job: `{Inner}` refinements that name
// this node resolve against its containing expansion and can be written in any other file.
function rippleInnerRefsAcrossWorkspace(node: FlowNode, oldName: string): void {
  const owner = ownerOf(node);
  void retargetInnersAcrossWorkspace(
    FlowDoc.expandIdentityForNode(owner.doc, owner.path, node),
    oldName,
    node.name,
    owner.doc,
  );
}

// Renaming a block renames its sole host with it, and that host's name can be spelled in
// `{Inner}` refinements anywhere in the workspace — one edit, one undo step.
function applyExpandEditAction(node: FlowNode, requestedValue: string): string {
  return session.runAction(() => repointOrRenameExpansion(node, requestedValue));
}

// An edit to a node's `expand` carries one of two intents. Naming an existing `graph:` block —
// or any `[Label](path)` link — repoints the node. Typing an unused name renames the block when
// this node is its only host, so the block the node just had is never left orphaned; a block
// with other hosts is not renamed out from under them, and the new name gets a block of its own
// so the value still resolves (spec §10.3).
function repointOrRenameExpansion(node: FlowNode, requestedValue: string): string {
  const owner = ownerOf(node);
  const requested = collapseToSingleLine(requestedValue).trim();
  const repointing = !requested || parseExpandLink(requested) != null
    || FlowDoc.graphBlockNamed(owner.doc, requested) != null;
  if (repointing) {
    const previousPath = resolvedExpandPath(getProp(node, 'expand'), owner.path);
    applyToDoc(owner, () => {
      setProp(node, 'expand', requested || null);
      // Inner nodes of a local `graph:` this host just left (or joined) read through it, so
      // `updates:` in this file are stripped against the new through-host set (R40c).
      FlowDoc.removeUnreadableUpdates(owner.doc);
    }, { commit: 'now' });
    const nextPath = resolvedExpandPath(getProp(node, 'expand'), owner.path);
    contextOps.syncInheritsForExpansionPaths(
      owner,
      [previousPath, nextPath].filter((path): path is string => path != null),
    );
    return getProp(node, 'expand') ?? '';
  }

  const soleBlock = FlowDoc.graphBlockSolelyHostedBy(owner.doc, node);
  const oldNodeName = node.name;
  const oldBlockName = soleBlock?.name ?? null;
  applyToDoc(owner, () => {
    if (soleBlock) {
      FlowDoc.renameGraphBlock(owner.doc, soleBlock, requested, { path: owner.path });
    } else {
      setProp(node, 'expand', requested);
      FlowDoc.ensureScopeItems(owner.doc, requested);
    }
  }, { commit: 'now' });
  if (soleBlock && openFlow && owner.doc === openFlow.doc && openFlow.scope === oldBlockName) {
    openFlow.scope = soleBlock.name;
    refresh();
  }
  if (node.name !== oldNodeName) rippleInnerRefsAcrossWorkspace(node, oldNodeName);
  return getProp(node, 'expand') ?? '';
}

// The node's own document, the `{Inner}` refinements naming it elsewhere, and the `nodes:` lists
// it appears in are one rename, however many files that reaches (R41).
function renameNodeAction(node: FlowNode, requestedName: string): string {
  const owner = ownerOf(node);
  const oldName = node.name;
  let finalName = oldName;
  session.runAction(() => {
    applyToDoc(owner, () => {
      finalName = FlowDoc.renameNode(
        FlowDoc.containingItems(owner.doc, node),
        node,
        requestedName,
        owner.doc,
        { path: owner.path },
      );
    });
    if (finalName !== oldName) rippleInnerRefsAcrossWorkspace(node, oldName);
  });
  return finalName;
}

// A `{Inner}` refinement names an entry inside an expansion, but which expansion depends on the
// end of the edge it refines: the §5.7 target refinement resolves against the edge target's
// expansion, the §5.8 source refinement against the source node's own.
type RefinedEnd = 'target' | 'source';

function refinedExpansionOf(
  edge: ModelEdge,
  end: RefinedEnd,
): { owner: DocumentOwner; expandValue: string } | null {
  if (edge.kind !== 'flow') return null;
  const owner = ownerOf(edge.from);
  const refined = end === 'source'
    ? edge.from
    : FlowDoc.nodesIn(FlowDoc.containingItems(owner.doc, edge.from))
      .find((node) => node.name === edge.spec.target);
  const expandValue = refined ? getProp(refined, 'expand') : null;
  return expandValue ? { owner, expandValue } : null;
}

function innerOptions(edge: ModelEdge, end: RefinedEnd): string[] {
  const refined = refinedExpansionOf(edge, end);
  if (!refined) return [];
  return FlowDoc.expandEntryNames(
    refined.expandValue,
    refined.owner.doc,
    refined.owner.path,
    expandTargetDoc,
  ) ?? [];
}

async function ensureInnerDocument(edge: ModelEdge, end: RefinedEnd): Promise<void> {
  const refined = refinedExpansionOf(edge, end);
  if (!refined) return;
  const path = resolvedExpandPath(refined.expandValue, refined.owner.path);
  if (path) await expansions.ensureDocument(path);
}

// One gesture is one undo step, whatever it moved and wherever that landed: the nodes, the
// regions they joined or left, and the `inherits` of what those members expand into (R19).
function commitMovesFor(
  nodes: FlowNode[],
  membershipChanges: MembershipChange[] = [],
  alsoTouched: DocumentOwner[] = [],
): void {
  session.runAction(() => writeMovesAndMembership(nodes, membershipChanges, alsoTouched));
}

function writeMovesAndMembership(
  nodes: FlowNode[],
  membershipChanges: MembershipChange[],
  alsoTouched: DocumentOwner[],
): void {
  const paths = new Set<string>();
  if (openFlow) paths.add(openFlow.path);
  for (const owner of alsoTouched) {
    session.trackWithoutBaseline(owner.path, owner.doc);
    paths.add(owner.path);
  }
  for (const node of nodes) {
    const owner = ownerOf(node);
    // A drag mutates `pos` in place and only reports the move once it is over, so a frame
    // document first touched by one has no pre-move text to diff against. Registering it
    // without a baseline keeps the move from being mistaken for a no-op and dropped.
    session.trackWithoutBaseline(owner.path, owner.doc);
    paths.add(owner.path);
  }
  // Membership joins the same batch rather than committing on its own, so dropping a node into a
  // region is one undo step with the move that carried it there (R19). A block always lives in
  // the file its members do, so the node's owner is the document to write.
  const membersByOwner = new Map<DocumentOwner, string[]>();
  const ownersWithLeaves = new Set<DocumentOwner>();
  for (const change of membershipChanges) {
    const owner = ownerOf(change.node);
    session.trackWithoutBaseline(owner.path, owner.doc);
    paths.add(owner.path);
    if (change.joins) {
      FlowDoc.addContextMember(change.block, change.node.name);
    } else {
      FlowDoc.removeContextMember(change.block, change.node.name);
      ownersWithLeaves.add(owner);
    }
    membersByOwner.set(owner, [...(membersByOwner.get(owner) ?? []), change.node.name]);
  }
  // A node that left a region can no longer read it, and neither can the inner nodes that
  // read through it as a local-graph host, so the whole file is stripped (R40c).
  for (const owner of ownersWithLeaves) {
    FlowDoc.removeUnreadableUpdates(owner.doc);
  }
  if (membershipChanges.length > 0) expansions.invalidateSubModels();
  refresh();
  for (const path of paths) session.commit(path);
  for (const [owner, memberNames] of membersByOwner) {
    contextOps.syncInheritsForMembers(owner, memberNames);
  }
}

// An edge dragged from inside a frame onto empty canvas. Released inside the same frame it
// creates a sibling in that subgraph; released one level out it creates a node in the graph
// that owns the frame, reached from inside by an `{Inner Source}` edge on the host (§5.8).
function createNodeForEmptyDrop(
  fromNode: FlowNode,
  drop: Extract<EdgeDrop, { kind: 'empty-inner' | 'empty-outer' }>,
): void {
  const rect = centeredDefaultRect(drop.point);
  const host = liveNode(drop.host);
  let created: FlowNode | null = null;
  if (drop.kind === 'empty-inner') {
    const target = creationTargetFor(host);
    if (!target) return;
    const source = liveNode(fromNode);
    const items = creationItems(target);
    created = runNodeCreationAction(target.owner, () => {
      const node = FlowDoc.addNode(items, rect);
      FlowDoc.addEdge(source, node.name);
      return node;
    });
  } else {
    const owner = ownerOf(host);
    const items = FlowDoc.containingItems(owner.doc, host);
    created = runNodeCreationAction(owner, () => {
      const node = FlowDoc.addNode(items, rect);
      FlowDoc.addEdge(host, node.name, null, null, drop.innerName);
      return node;
    });
  }
  if (created) focusNewNode(created);
}

function editCreatedEdge(spec: EdgeSpec | null): void {
  const createdEdge = spec ? findEdge(spec) : null;
  if (!createdEdge) return;
  view.selectedEdge = createdEdge;
  editors.openEdgeEditor(createdEdge);
}

function addEdgeToExistingNode(fromNode: FlowNode, targetName: string, innerName: string | null): void {
  let createdSpec: EdgeSpec | null = null;
  mutate(() => {
    createdSpec = FlowDoc.addEdge(fromNode, targetName, null, innerName);
  }, { commit: 'now' });
  editCreatedEdge(createdSpec);
}

// Invents the node the edge points at. A ghost already carries the name the document asked for,
// so only a node conjured out of empty canvas still needs one — and gets inline title editing
// rather than the edge editor.
function addEdgeToNewNode(fromNode: FlowNode, rect: Rect, ghostName: string | null): void {
  const flow = openFlow;
  if (!flow) return;
  let createdSpec: EdgeSpec | null = null;
  const items = FlowDoc.scopeItems(flow.doc, flow.scope);
  const owner = { doc: flow.doc, path: flow.path };
  const createdNode = runNodeCreationAction(owner, () => {
    const node = FlowDoc.addNode(items, rect, ghostName ?? undefined);
    createdSpec = FlowDoc.addEdge(fromNode, node.name, null, null);
    return node;
  });

  if (!ghostName && createdNode) {
    focusNewNode(createdNode);
    return;
  }
  editCreatedEdge(createdSpec);
}

function completeEdge(fromNode: FlowNode, drop: EdgeDrop): void {
  if (!openFlow) return;
  switch (drop.kind) {
    case 'source':
    case 'rejected':
      return;
    case 'out-of-frame': {
      // §5.8: the `{Inner Source}` edge is declared on the host, so it lives in the parent
      // graph rather than inside the subgraph the drag left.
      let createdSpec: EdgeSpec | null = null;
      applyEdit(drop.host, () => {
        createdSpec = FlowDoc.addEdge(drop.host, drop.target.name, null, null, drop.innerName);
      }, { commit: 'now' });
      editCreatedEdge(createdSpec);
      return;
    }
    case 'node':
      // An edge between two nodes inside a frame belongs to the .flow file that owns them.
      if (expansions.isEmbedded(fromNode)) {
        applyEdit(fromNode, () => FlowDoc.addEdge(fromNode, drop.target.name), { commit: 'now' });
        return;
      }
      addEdgeToExistingNode(fromNode, drop.target.name, null);
      return;
    case 'into-frame':
      addEdgeToExistingNode(fromNode, drop.target.name, drop.innerName);
      return;
    case 'ghost':
      addEdgeToNewNode(fromNode, drop.ghost.pos, drop.ghost.name);
      return;
    case 'empty':
      addEdgeToNewNode(fromNode, centeredDefaultRect(drop.point), null);
      return;
    case 'empty-inner':
    case 'empty-outer':
      createNodeForEmptyDrop(fromNode, drop);
      return;
  }
}

// Declared before the view because the view owns it for its whole life. Both callbacks below
// only dereference `view` and `editors` when something calls them, which never happens during
// construction, so the forward references are safe.
const expansions = new ExpansionLayer({
  onNeedsRender: () => {
    view.requestRender();
    editors.refreshFromDoc();
  },
  readExternalFile: (path) => workspace?.readFile(path) ?? Promise.resolve(null),
});

const view = new CanvasView(elementById<HTMLCanvasElement>('canvas'), {
  createNode: (rect, frameHost) => {
    if (openFlow) createNodeAndEdit(rect, frameHost);
  },
  quickCreateNode: (point, frameHost) => {
    if (openFlow) createNodeAndEdit(centeredDefaultRect(point), frameHost);
  },
  nodeClicked: (node) => editors.openNodeEditor(node),
  canvasClicked: () => editors.closeAll(),
  moveCommitted: (nodes, membershipChanges) => commitMovesFor(nodes ?? [], membershipChanges ?? []),
  regionMoved: (region, movedNodes, membershipChanges) =>
    commitMovesFor(movedNodes, membershipChanges, [contextOps.ownerOfRegion(region)]),
  regionResized: (region, membershipChanges) =>
    commitMovesFor([], membershipChanges, [contextOps.ownerOfRegion(region)]),
  deleteRegion: (region) => contextOps.deleteRegion(region),
  createRegion: (rect, frameHost, memberNames) => contextOps.createRegionAndName(rect, frameHost, memberNames),
  regionClicked: (region) => editors.openRegionEditor(region),
  completeEdge,
  editEdge: (edge) => editors.openEdgeEditor(edge),
  editNodeTitle: (node) => editors.openTitleEditor(node),
  editRegionTitle: (region) => editors.openRegionNameEditor(region),
  openExpand,
  toggleExpand: toggleInlineExpansion,
  materializeGhost: (ghost) => {
    if (openFlow) createNodeAndEdit(ghost.pos, null, ghost.name);
  },
  contextMenu: openCanvasContextMenu,
  viewChanged: () => {
    editors.reposition();
    if (openFlow) scheduleManifestSave();
  },
  afterRender: () => {
    editors.reposition();
    elements.zoomLevel.textContent = `${Math.round(view.view.scale * 100)}%`;
  },
}, expansions);

const editors: Editors = createEditors({
  view,
  regionDescriptionOf: (region) => unquote(getBlockProp(region.block, 'description')),
  applyRegionDescriptionEdit: (region, text) => {
    const owner = contextOps.ownerOfRegion(region);
    applyToDoc(owner, () => setBlockProp(region.block, 'description', text ? quoteValue(text) : null));
  },
  regionReferencesOf: (region) => region.block.references,
  applyRegionReferencesEdit: (region, references) => {
    const owner = contextOps.ownerOfRegion(region);
    applyToDoc(owner, () => { region.block.references = FlowDoc.normalizeReferences(references); });
  },
  selectMember: (region, memberName) => {
    const node = FlowDoc.nodesIn(region.doc.items).find((candidate) => candidate.name === memberName);
    if (node) view.select(node);
  },
  deleteRegion: (region) => contextOps.deleteRegion(region),
  readableContexts: (node) => contextOps.readableContexts(node),
  findNode,
  findEdge,
  renameNode: renameNodeAction,
  applyEdit,
  applyEditNow: (node, mutation) => applyEdit(node, mutation, { commit: 'now' }),
  applyExpandEdit: applyExpandEditAction,
  expandOptions: (node) => FlowDoc.graphBlockNames(ownerOf(node).doc),
  descriptionOf,
  applyDescriptionEdit,
  referencesOf,
  applyReferencesEdit,
  linkContext,
  ensureExpandTarget,
  ensureInnerTargets: (edge) => ensureInnerDocument(edge, 'target'),
  ensureInnerSources: (edge) => ensureInnerDocument(edge, 'source'),
  openExpand,
  toggleExpand: toggleInlineExpansion,
  deleteNodes: deleteNodesAction,
  innerTargetOptions: (edge) => innerOptions(edge, 'target'),
  innerSourceOptions: (edge) => innerOptions(edge, 'source'),
  renameRegion: (region, name) => contextOps.renameRegion(region, name),
});

contextOps = createContextOrchestration({
  openFlowDoc: () => openFlow ? { doc: openFlow.doc, path: openFlow.path } : null,
  ownerOf,
  creationTargetFor,
  extractionTargetForSelection,
  applyToDoc,
  runAction: (body) => session.runAction(body),
  suspendAction: () => session.suspendAction(),
  selectRegion: (name) => view.selectRegion(name),
  clearSelection: () => view.clearSelection(),
  openRegionNameEditor: (region, rename) => editors.openRegionNameEditor(region, rename),
  openRegionEditor: (region) => editors.openRegionEditor(region),
  openConfirmMenu: (items, at) => contextMenu.open(items, at),
  inherits: {
    suspendAction: () => session.suspendAction(),
    expandTargetDoc,
    ensureDocument: (path) => expansions.ensureDocument(path),
    applyToDoc,
  },
  workspaceRename: {
    suspendAction: () => session.suspendAction(),
    loadEveryWorkspaceDocument,
    knownDocuments,
    applyToDoc,
  },
});

function screenshotFileStem(): string {
  if (!openFlow) return 'grafd';
  const baseName = openFlow.path.split('/').pop()!.replace(/\.flow$/, '');
  const scoped = openFlow.scope ? `${baseName}-${openFlow.scope}` : baseName;
  return safeFileStem(scoped) || 'grafd';
}

const screenshot = createScreenshotDialog({ view, fileStem: screenshotFileStem });

function applyPreferences(preferences: Preferences): void {
  currentPreferences = preferences;
  view.gridIsVisible = preferences.showCanvasGrid;
  view.doubleClickOpensSubgraph = preferences.openSubgraphOnDoubleClick;
  applyTheme(preferences.theme);
  applySidebarVisibility(preferences.sidebarCollapsed);
  view.requestRender();
}

// The canvas needs no part in this: it observes its own container and re-syncs when the
// sidebar stops taking width. The dataset key mirrors the pre-paint script in index.html.
function applySidebarVisibility(collapsed: boolean): void {
  if (collapsed) document.documentElement.dataset.sidebar = 'collapsed';
  else delete document.documentElement.dataset.sidebar;
  elements.sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  elements.sidebarReveal.setAttribute('aria-expanded', String(!collapsed));
}

// Unlike the user-level preferences, the workspace's display settings are read back from the
// manifest the editor already has open rather than from storage of their own.
async function applyWorkspaceDisplay(): Promise<void> {
  view.baseRoughness = uiState.roughness();
  await applyCanvasFont(uiState.font());
  view.requestRender();
}

const preferencesDialog = createPreferencesDialog(applyPreferences, {
  roughness: () => uiState.roughness(),
  setRoughness: (value) => {
    uiState.setRoughness(value);
    void applyWorkspaceDisplay();
  },
  font: () => uiState.font(),
  setFont: (value) => {
    uiState.setFont(value);
    void applyWorkspaceDisplay();
  },
});

// Only one modal is ever up at a time; Escape closes whichever it is.
const modals: Modal[] = [screenshot, preferencesDialog];

function openModal(): Modal | null {
  return modals.find((modal) => modal.isOpen()) ?? null;
}

function openCanvasContextMenu(target: ContextTarget, screenPoint: Point): void {
  if (!openFlow) return;
  const items =
    target.kind === 'node' ? nodeMenuItems(target.node)
    : target.kind === 'edge' ? edgeMenuItems(target.edge)
    : target.kind === 'region' ? contextOps.regionMenuItems(target.region, screenPoint)
    : canvasMenuItems(target.world);
  contextMenu.open(items, screenPoint);
}

function nodeMenuItems(node: FlowNode): MenuItem[] {
  const selectionCount = view.selection.size;
  const items: MenuItem[] = [];
  if (selectionCount <= 1) items.push({ label: 'Edit', onSelect: () => editors.openNodeEditor(node) });
  items.push({ label: selectionCount > 1 ? `Duplicate ${selectionCount} nodes` : 'Duplicate', onSelect: clipboard.duplicateSelection });
  if (selectionCount > 1) {
    items.push({
      label: `Convert ${selectionCount} nodes to subgraph`,
      disabled: extractionTargetForSelection() === null,
      onSelect: convertSelectionToSubgraph,
    });
    items.push({
      label: `Group ${selectionCount} nodes into a region`,
      disabled: !contextOps.canGroupSelectionIntoContext(),
      onSelect: () => contextOps.groupSelectionIntoContext(),
    });
  }
  items.push({ label: 'Copy', onSelect: clipboard.copy });
  items.push({ label: 'Cut', onSelect: clipboard.cut });
  if (getProp(node, 'expand')) {
    items.push({ label: 'Open ⤢', onSelect: () => void openExpand(node) });
    items.push({
      label: expansions.isOpen(node.id) ? 'Collapse ⊟' : 'Expand ⊞',
      onSelect: () => toggleInlineExpansion(node),
    });
    if (selectionCount <= 1 && extractableBlockNameFor(node)) {
      items.push({ label: 'Extract into file', onSelect: () => extractSubgraphIntoFile(node) });
    }
  } else if (selectionCount <= 1) {
    items.push({ label: 'Convert to subgraph', onSelect: () => convertNodeToSubgraph(node) });
  }
  if (selectionCount <= 1) {
    const isEntrypoint = getProp(node, 'entrypoint') === 'true';
    items.push({
      label: isEntrypoint ? 'Unset entrypoint' : 'Set as entrypoint',
      onSelect: () => applyEdit(node, () => setProp(node, 'entrypoint', isEntrypoint ? null : 'true'), { commit: 'now' }),
    });
  }
  items.push({ separator: true });
  items.push({ label: selectionCount > 1 ? `Delete ${selectionCount} nodes` : 'Delete', danger: true, onSelect: deleteSelection });
  return items;
}

function edgeMenuItems(edge: ModelEdge): MenuItem[] {
  return [
    { label: 'Edit label', onSelect: () => editors.openEdgeEditor(edge) },
    { separator: true },
    { label: 'Delete edge', danger: true, onSelect: deleteSelection },
  ];
}

function canvasMenuItems(world: Point): MenuItem[] {
  const creation = view.creationTargetAt(world);
  return [
    {
      label: 'Add node here',
      onSelect: () => createNodeAndEdit(centeredDefaultRect(creation.point), creation.frameHost),
    },
    { label: 'Paste', disabled: !clipboard.hasNodes(), onSelect: () => clipboard.paste(world) },
    { separator: true },
    { label: 'Fit to content', onSelect: () => view.fitToContent() },
    { label: 'Reset zoom', onSelect: () => view.setZoom(1) },
  ];
}

function setTool(tool: Tool): void {
  view.setTool(tool);
  elements.toolSelectButton.classList.toggle('active', tool === 'select');
  elements.toolNodeButton.classList.toggle('active', tool === 'node');
  elements.toolContextButton.classList.toggle('active', tool === 'context');
}

function wireViewControls(): void {
  elements.toolSelectButton.addEventListener('click', () => setTool('select'));
  elements.toolNodeButton.addEventListener('click', () => setTool('node'));
  elements.toolContextButton.addEventListener('click', () => setTool('context'));
  elements.zoomIn.addEventListener('click', () => view.stepZoom(1));
  elements.zoomOut.addEventListener('click', () => view.stepZoom(-1));
  elements.zoomLevel.addEventListener('click', () => view.setZoom(1));
  elements.zoomFit.addEventListener('click', () => view.fitToContent());
}

// Returns null once the flow exists and is open, otherwise why it could not be created — the
// sidebar shows that beneath its name box.
function createFlowFile(path: string): string | null {
  const existing = findExistingFile(workspaceFiles, path);
  if (existing) return `${existing} already exists — pick another name.`;
  const graphName = path.split('/').pop()!.replace(/\.flow$/, '');
  const text = `---\nname: ${graphName}\n---\n`;
  sendWrite(path, text);
  workspaceFiles.push(path);
  workspaceFiles.sort();
  uiState.adoptEntrypointIfUnset(path);
  openFlowFromSidebar(path, text);
  return null;
}

// Picking a file from the sidebar snaps to it and clears the dive trail — the crumbs describe
// a path through the flow that was open, which the new one has nothing to do with.
function openFlowFromSidebar(path: string, presetText: string | null = null): void {
  navigation.trail.length = 0;
  void openFile(path, { presetText });
}

function renderFileList(): void {
  sidebarFiles.render();
}

function toggleSidebar(): void {
  // The context menu is placed in viewport coordinates and only re-closes on window resize, so
  // it would otherwise be left pointing at whatever the canvas slid underneath it.
  contextMenu.close();
  const preferences = { ...currentPreferences, sidebarCollapsed: !currentPreferences.sidebarCollapsed };
  savePreferences(preferences);
  applyPreferences(preferences);
  if (!preferences.sidebarCollapsed) elements.sidebarToggle.focus();
  else elements.sidebarReveal.focus();
}

function wireSidebarToggle(): void {
  elements.sidebarToggle.addEventListener('click', toggleSidebar);
  elements.sidebarReveal.addEventListener('click', toggleSidebar);
}

function wireHelp(): void {
  const toggleHelp = () => elements.helpOverlay.classList.toggle('hidden');
  elements.helpToggle.addEventListener('click', toggleHelp);
  elements.helpOverlay.addEventListener('click', toggleHelp);
}

function isTypingTarget(element: EventTarget | null): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function wireKeyboard(): void {
  window.addEventListener('keydown', (event) => {
    const modal = openModal();

    if (isTypingTarget(event.target)) {
      if (event.key === 'Escape') {
        if (modal) modal.close();
        else event.target.blur();
      }
      return;
    }

    if (modal) {
      if (event.key === 'Escape') modal.close();
      return;
    }

    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (ctrl && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    } else if (ctrl && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      toggleSidebar();
    } else if (ctrl && event.key.toLowerCase() === 'c') {
      if (view.selection.size === 0) return;
      event.preventDefault();
      clipboard.copy();
    } else if (ctrl && event.key.toLowerCase() === 'x') {
      if (view.selection.size === 0) return;
      event.preventDefault();
      clipboard.cut();
    } else if (ctrl && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      clipboard.paste();
    } else if (ctrl && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      clipboard.duplicateSelection();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      deleteSelection();
    } else if (ctrl && event.key === '0') {
      event.preventDefault();
      view.fitToContent();
    } else if (ctrl && (event.key === '=' || event.key === '+')) {
      event.preventDefault();
      view.stepZoom(1);
    } else if (ctrl && event.key === '-') {
      event.preventDefault();
      view.stepZoom(-1);
    } else if (!ctrl && (event.key.toLowerCase() === 'v' || event.key === '1')) {
      setTool('select');
    } else if (!ctrl && (event.key.toLowerCase() === 'n' || event.key === '2')) {
      setTool('node');
    } else if (!ctrl && (event.key.toLowerCase() === 'c' || event.key === '3')) {
      setTool('context');
    } else if (event.key === 'Escape') {
      contextMenu.close();
      editors.closeAll();
      const helpWasOpen = !elements.helpOverlay.classList.contains('hidden');
      elements.helpOverlay.classList.add('hidden');
      if (!helpWasOpen && navigation.trail.length > 0) {
        void navigateBackTo(navigation.trail.length - 1);
      } else if (!helpWasOpen) {
        view.clearSelection();
      }
    } else if (event.key === '?') {
      elements.helpOverlay.classList.toggle('hidden');
    }
  });
}

// --- Workspaces --------------------------------------------------------------------------

function createDefaultWorkspace(): Workspace {
  return defaultWorkspaceKind === 'server' ? new ServerWorkspace() : new BrowserWorkspace();
}

function resetSessionState(): void {
  editors.closeAll();
  view.clearSelection();
  expansions.reset();
  navigation.trail.length = 0;
  session.reset();
  workspaceFiles = [];
  openFlow = null;
}

async function switchWorkspace(next: Workspace, { preferHash = false } = {}): Promise<void> {
  if (workspace) {
    session.flush();
    uiState.saveNow();
    workspace.stop();
  }
  workspace = null;
  resetSessionState();
  workspace = next;
  try {
    workspaceFiles = await next.start(workspaceDelegate);
  } catch (error) {
    console.error('Failed to open workspace', error);
    workspaceFiles = [];
  }
  uiState.adopt(await next.readFile(MANIFEST_FILE_NAME), workspaceFiles);
  await applyWorkspaceDisplay();
  renderFileList();
  renderWorkspaceBar();

  const hashPath = decodeURIComponent(location.hash.slice(1));
  const startupPath =
    preferHash && hashPath && workspaceFiles.includes(hashPath) ? hashPath : uiState.startupFlow(workspaceFiles);
  if (startupPath) {
    await openFile(startupPath);
  } else {
    showEmptyWorkspace();
  }
}

function showEmptyWorkspace(): void {
  location.hash = '';
  elements.graphPanel.classList.add('collapsed');
  elements.graphToggle.textContent = '☰ graph';
  elements.emptyState.classList.remove('hidden');
  elements.emptyStateHint.textContent =
    workspace?.kind === 'browser'
      ? 'Create your first flow with “+ New flow” — it is saved in this browser. Or open a local folder of .flow files.'
      : 'Create a new flow with “+ New flow”, or select one from the sidebar.';
  renderBreadcrumb(null);
  renderFileList();
  view.setModel(FlowDoc.buildModel(parseFlow('---\nname: empty\n---\n'), null));
}

function renderWorkspaceBar(): void {
  if (!workspace) return;
  const names: Record<Workspace['kind'], string> = {
    server: 'server workspace',
    browser: 'browser storage',
    folder: `📁 ${workspace.label}`,
  };
  elements.workspaceName.textContent = names[workspace.kind];
  elements.workspaceName.title =
    workspace.kind === 'folder' ? `Local folder “${workspace.label}”` : names[workspace.kind];
}

async function exportWorkspace(): Promise<void> {
  if (!workspace) return;
  session.flush();
  try {
    await exportWorkspaceAsZip({
      files: [...workspaceFiles],
      // Tracked documents are exported from their committed text: the flush above has just
      // brought it up to date, and it needs no round-trip through the workspace backend.
      readFile: (path) => {
        const committed = session.committedTextAt(path);
        return committed != null ? Promise.resolve(committed) : workspace!.readFile(path);
      },
      manifest: uiState.forExport(workspaceFiles),
      workspaceLabel: workspace.kind === 'folder' ? workspace.label : 'grafd-workspace',
    });
  } catch (error) {
    console.error('Export failed', error);
    reportWorkspaceError('Export failed — see the browser console.');
  }
}

// Failures are reported through the workspace menu the action was started from. `alert` would
// be the obvious choice, but dialog boxes are suppressed in several embedded browser hosts —
// the same reason the new-file input and the delete confirmation are inline.
function reportWorkspaceError(message: string): void {
  contextMenu.toggleFromButton(elements.workspaceMenuButton, [
    { label: `⚠ ${message}`, danger: true, onSelect: () => {} },
  ]);
}

async function openWorkspaceFolder(): Promise<void> {
  const folder = await pickWorkspaceFolder();
  if (folder) await switchWorkspace(new FolderWorkspace(folder));
}

function workspaceMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  if (workspace?.kind === 'folder') {
    items.push({ label: '↩ Leave folder', onSelect: () => void switchWorkspace(createDefaultWorkspace()) });
  } else if (folderPickingIsSupported()) {
    items.push({ label: '📂 Open folder…', onSelect: () => void openWorkspaceFolder() });
  }
  items.push({ label: '⇩ Export .zip', onSelect: () => void exportWorkspace() });
  items.push({ label: '🖼 Export image…', disabled: !openFlow, onSelect: () => screenshot.open() });
  items.push({ separator: true });
  items.push({ label: '⚙ Preferences…', onSelect: () => preferencesDialog.open() });
  return items;
}

function wireWorkspaceControls(): void {
  elements.workspaceMenuButton.addEventListener('click', () => {
    contextMenu.toggleFromButton(elements.workspaceMenuButton, workspaceMenuItems());
  });
}

async function boot(): Promise<void> {
  wireViewControls();
  wireSidebarToggle();
  wireHelp();
  wireKeyboard();
  wireWorkspaceControls();
  applyPreferences(loadPreferences());
  setTool('select');

  defaultWorkspaceKind = (await serverIsAvailable()) ? 'server' : 'browser';
  await switchWorkspace(createDefaultWorkspace(), { preferHash: true });
}

boot();
