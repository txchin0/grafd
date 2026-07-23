// App shell: file list, workspace sync, undo/redo, keyboard shortcuts, and the glue between
// canvas gestures (canvas-view.ts), document mutations (flow-doc.ts), the floating editors
// (editors.ts), and inline subgraph expansion (expansion.ts).
//
// Files live in the active workspace (workspace.ts): the Graf server when one is answering
// (self-hosted mode), browser storage when the app is statically hosted (serverless mode),
// or a local folder opened through the File System Access API in either mode. UI state —
// entrypoint, active flow, per-flow cameras — persists to the workspace's
// graf.manifest.json.
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
  getPreambleField,
  setPreambleField,
  getProp,
  setProp,
  quoteValue,
  unquote,
  collapseToSingleLine,
  parseListValue,
  formatListValue,
  parseExpandLink,
  resolveLinkPath,
  resolvedExpandPath,
  descriptionForNode,
  sanitizeName,
  type EdgeSpec,
  type ExpandLink,
  type FlowDocument,
  type FlowNode,
  type GraphItem,
  type Rect,
} from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import type { FlowModel, GhostNode, ModelEdge, Point } from './flow-doc.js';
import { CanvasView, type Tool, type View } from './canvas-view.js';
import { ExpansionLayer, type DocumentOwner } from './expansion.js';
import { createEditors, type Editors } from './editors.js';
import {
  MANIFEST_FILE_NAME,
  chooseStartupFlow,
  defaultEntrypoint,
  emptyManifest,
  parseManifest,
  serializeManifest,
  type WorkspaceManifest,
} from '../shared/manifest.js';
import type { Workspace, WorkspaceDelegate } from './workspace.js';
import { ServerWorkspace, serverIsAvailable } from './workspace-server.js';
import { BrowserWorkspace } from './workspace-browser.js';
import { FolderWorkspace, folderPickingIsSupported, pickWorkspaceFolder } from './workspace-folder.js';
import { exportWorkspaceAsZip } from './export.js';
import { buildFileTree, type TreeFile, type TreeFolder } from './file-tree.js';

interface AppState {
  files: string[];
  path: string | null;
  text: string;
  doc: FlowDocument | null;
  scope: string | null;
  model: FlowModel | null;
}

interface TrailEntry {
  path: string;
  scope: string | null;
  nodeId: string | null;
  view: View;
}

type CommitTiming = 'debounce' | 'now';

const COMMIT_DEBOUNCE_MS = 300;
const UNDO_LIMIT = 100;

const state: AppState = {
  files: [],
  path: null,
  text: '',
  doc: null,
  scope: null,
  model: null,
};

const navigation = { trail: [] as TrailEntry[], inProgress: false };

const undoStack: string[] = [];
const redoStack: string[] = [];
let commitTimer: ReturnType<typeof setTimeout> | undefined;

let workspace: Workspace | null = null;
let defaultWorkspaceKind: 'server' | 'browser' = 'browser';
let manifest: WorkspaceManifest = emptyManifest();
let manifestSaveTimer: ReturnType<typeof setTimeout> | undefined;

const MANIFEST_SAVE_DEBOUNCE_MS = 800;

function elementById<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const elements = {
  fileList: elementById<HTMLUListElement>('file-list'),
  newFileButton: elementById<HTMLButtonElement>('new-file-button'),
  newFileInput: elementById<HTMLInputElement>('new-file-input'),
  breadcrumb: elementById<HTMLElement>('breadcrumb'),
  emptyState: elementById<HTMLDivElement>('empty-state'),
  emptyStateHint: elementById<HTMLParagraphElement>('empty-state-hint'),
  connectionDot: elementById<HTMLSpanElement>('connection-dot'),
  workspaceName: elementById<HTMLSpanElement>('workspace-name'),
  openFolderButton: elementById<HTMLButtonElement>('open-folder-button'),
  closeFolderButton: elementById<HTMLButtonElement>('close-folder-button'),
  exportButton: elementById<HTMLButtonElement>('export-button'),
  helpToggle: elementById<HTMLButtonElement>('help-toggle'),
  helpOverlay: elementById<HTMLDivElement>('help-overlay'),
  toolSelectButton: elementById<HTMLButtonElement>('tool-select-button'),
  toolNodeButton: elementById<HTMLButtonElement>('tool-node-button'),
  zoomIn: elementById<HTMLButtonElement>('zoom-in-button'),
  zoomOut: elementById<HTMLButtonElement>('zoom-out-button'),
  zoomLevel: elementById<HTMLButtonElement>('zoom-level-button'),
  zoomFit: elementById<HTMLButtonElement>('zoom-fit-button'),
  graphPanel: elementById<HTMLDivElement>('graph-panel'),
  graphToggle: elementById<HTMLButtonElement>('gp-toggle'),
  graphName: elementById<HTMLInputElement>('gp-name'),
  graphDescription: elementById<HTMLTextAreaElement>('gp-description'),
  graphContext: elementById<HTMLInputElement>('gp-context'),
  graphOnError: elementById<HTMLInputElement>('gp-on-error'),
  graphEntrypoint: elementById<HTMLInputElement>('gp-entrypoint'),
};

function scopeItemsNow() {
  return FlowDoc.scopeItems(state.doc!, state.scope);
}

function refresh(): void {
  if (!state.doc) return;
  state.model = FlowDoc.buildModel(state.doc, state.scope);
  state.model.sourcePath = state.path;
  expansions.invalidateSubModels();
  view.setModel(state.model);
  renderBreadcrumb();
  renderGraphPanel();
  editors.refreshFromDoc();
}

function mutate(mutation: () => void, { commit = 'debounce' }: { commit?: CommitTiming } = {}): void {
  if (!state.doc) return;
  mutation();
  refresh();
  if (commit === 'now') commitNow();
  else scheduleCommit();
}

function scheduleCommit(): void {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commitNow, COMMIT_DEBOUNCE_MS);
}

function commitNow(): void {
  clearTimeout(commitTimer);
  if (!state.doc || !state.path) return;
  FlowDoc.ensureLayoutEverywhere(state.doc);
  const newText = serializeFlow(state.doc);
  if (newText === state.text) return;
  undoStack.push(state.text);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  state.text = newText;
  sendWrite(state.path, newText);
}

function applyHistoryText(text: string): void {
  state.text = text;
  state.doc = parseFlow(text);
  FlowDoc.assignMissingIds(state.doc);
  if (state.scope && !FlowDoc.graphBlockNames(state.doc).includes(state.scope)) state.scope = null;
  refresh();
  sendWrite(state.path!, text);
}

function undo(): void {
  if (undoStack.length === 0) return;
  redoStack.push(state.text);
  applyHistoryText(undoStack.pop()!);
}

function redo(): void {
  if (redoStack.length === 0) return;
  undoStack.push(state.text);
  applyHistoryText(redoStack.pop()!);
}

const workspaceDelegate: WorkspaceDelegate = {
  filesChanged(files) {
    state.files = files;
    renderFileList();
    if (state.path && !files.includes(state.path)) void closeIfFileGone(state.path);
  },
  fileChanged(path, text) {
    // Manifest changes from other clients are UI state, not content — adopting them
    // mid-session would fight the local camera and selection.
    if (path === MANIFEST_FILE_NAME) return;
    if (!state.files.includes(path)) {
      state.files.push(path);
      state.files.sort();
      renderFileList();
    }
    // Open path: one parse via adoptExternalText, which re-seeds the expansion cache with
    // the same object as state.doc. Handling the cache first would create a divergent copy.
    if (path === state.path) {
      if (text !== state.text) adoptExternalText(text);
    } else if (expansions.watchesPath(path)) {
      expansions.adoptExternalText(path, text);
    }
  },
  connectionChanged(connected) {
    elements.connectionDot.classList.toggle('connected', connected);
  },
};

function sendWrite(path: string, text: string): void {
  workspace?.writeFile(path, text);
}

function recordUiState(): void {
  manifest.ui.activeFlow = state.path;
  if (state.path) {
    const { x, y, scale } = view.view;
    manifest.ui.cameras[state.path] = { x, y, scale };
    manifest.ui.expansions[state.path] = expansions.openVisibleNodeIds();
  }
}

function scheduleManifestSave(): void {
  clearTimeout(manifestSaveTimer);
  manifestSaveTimer = setTimeout(saveManifestNow, MANIFEST_SAVE_DEBOUNCE_MS);
}

function saveManifestNow(): void {
  clearTimeout(manifestSaveTimer);
  manifestSaveTimer = undefined;
  if (!workspace) return;
  recordUiState();
  sendWrite(MANIFEST_FILE_NAME, serializeManifest(manifest));
}

function adoptExternalText(text: string): void {
  state.text = text;
  state.doc = parseFlow(text);
  FlowDoc.assignMissingIds(state.doc);
  expansions.adoptDocument(state.path!, state.doc);
  if (state.scope && !FlowDoc.graphBlockNames(state.doc).includes(state.scope)) state.scope = null;
  refresh();
}

async function openFile(
  path: string,
  { presetText = null, fit = true }: { presetText?: string | null; fit?: boolean } = {},
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
  state.path = path;
  state.text = text;
  state.doc = parseFlow(text);
  FlowDoc.assignMissingIds(state.doc);
  expansions.adoptDocument(path, state.doc);
  state.scope = null;
  undoStack.length = 0;
  redoStack.length = 0;
  editors.closeAll();
  view.clearSelection();
  elements.emptyState.classList.add('hidden');
  location.hash = path;
  if (fit) {
    const savedExpansions = manifest.ui.expansions[path];
    if (savedExpansions) expansions.restoreOpen(savedExpansions);
  }
  refresh();
  if (fit) {
    const savedCamera = manifest.ui.cameras[path];
    if (savedCamera) view.setViewNow(savedCamera);
    else view.fitToContent();
  }
  renderFileList();
  scheduleManifestSave();
  return true;
}

function dropFromFileList(path: string): void {
  const index = state.files.indexOf(path);
  if (index === -1) return;
  state.files.splice(index, 1);
  renderFileList();
}

function deleteFlowFile(path: string): void {
  workspace?.deleteFile(path);
  dropFromFileList(path);
  delete manifest.ui.cameras[path];
  delete manifest.ui.expansions[path];
  if (manifest.ui.activeFlow === path) manifest.ui.activeFlow = null;
  if (manifest.entrypoint === path) manifest.entrypoint = defaultEntrypoint(state.files);
  scheduleManifestSave();
  if (state.path === path) closeCurrentFlow();
}

function closeCurrentFlow(): void {
  navigation.trail.length = 0;
  editors.closeAll();
  view.clearSelection();
  state.path = null;
  state.text = '';
  state.doc = null;
  state.scope = null;
  state.model = null;
  const next = chooseStartupFlow(manifest, state.files);
  if (next) void openFile(next);
  else showEmptyWorkspace();
}

// A files update that no longer lists the open flow usually means another client deleted
// it — but it can also be a transient race (a list rebuilt before a just-created file
// landed on disk), so confirm the file is really gone by reading it before closing.
async function closeIfFileGone(path: string): Promise<void> {
  const text = (await workspace?.readFile(path)) ?? null;
  if (text != null || state.path !== path) return;
  closeCurrentFlow();
}

function setScope(scopeName: string | null, { fit = true }: { fit?: boolean } = {}): void {
  state.scope = scopeName;
  editors.closeAll();
  view.clearSelection();
  refresh();
  if (fit) view.fitToContent();
}

const collapsedFolders = new Set<string>();

function renderFileList(): void {
  const rows: HTMLElement[] = [];
  appendFolderRows(buildFileTree(state.files), 0, rows);
  elements.fileList.replaceChildren(...rows);
}

function appendFolderRows(folder: TreeFolder, depth: number, rows: HTMLElement[]): void {
  for (const child of folder.folders) {
    rows.push(folderRow(child, depth));
    if (!collapsedFolders.has(child.path)) appendFolderRows(child, depth + 1, rows);
  }
  for (const file of folder.files) rows.push(fileRow(file, depth));
}

function applyTreeIndent(row: HTMLElement, depth: number): void {
  row.style.paddingLeft = `${10 + depth * 14}px`;
}

function folderRow(folder: TreeFolder, depth: number): HTMLElement {
  const row = document.createElement('li');
  row.className = 'folder-row';
  row.title = folder.path;
  applyTreeIndent(row, depth);
  const caret = document.createElement('span');
  caret.className = 'folder-caret';
  caret.textContent = collapsedFolders.has(folder.path) ? '▸' : '▾';
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = folder.name;
  row.append(caret, name);
  row.addEventListener('click', () => {
    if (collapsedFolders.has(folder.path)) collapsedFolders.delete(folder.path);
    else collapsedFolders.add(folder.path);
    renderFileList();
  });
  return row;
}

function fileRow(file: TreeFile, depth: number): HTMLElement {
  const row = document.createElement('li');
  row.className = 'file-row';
  row.title = file.path;
  row.classList.toggle('active', file.path === state.path);
  applyTreeIndent(row, depth);
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = file.name;
  row.append(name, deleteButtonFor(file.path));
  row.addEventListener('click', () => {
    navigation.trail.length = 0;
    openFile(file.path);
  });
  return row;
}

// Deleting takes two clicks on the same button — an inline confirmation, because dialog
// boxes (confirm/prompt) are suppressed in several embedded browser hosts.
function deleteButtonFor(path: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-delete';
  button.textContent = '✕';
  button.title = `Delete ${path}`;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = 'sure?';
      return;
    }
    deleteFlowFile(path);
  });
  button.addEventListener('mouseleave', () => {
    button.classList.remove('armed');
    button.textContent = '✕';
  });
  return button;
}

function renderBreadcrumb(): void {
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
  current.textContent = state.scope ? `${state.path} › ${state.scope}` : (state.path ?? '');
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

function renderGraphPanel(): void {
  const scoped = state.scope != null;
  const displayName = scoped
    ? state.scope!
    : unquote(getPreambleField(state.doc!, 'name') ?? '') || state.path || 'graph';
  elements.graphToggle.textContent = `☰ ${displayName}`;

  setUnlessFocused(elements.graphName, displayName);
  setUnlessFocused(elements.graphDescription, scoped ? '' : unquote(getPreambleField(state.doc!, 'description') ?? ''));
  setUnlessFocused(elements.graphContext, scoped ? '' : parseListValue(getPreambleField(state.doc!, 'context')).join(', '));
  setUnlessFocused(elements.graphOnError, scoped ? '' : (getPreambleField(state.doc!, 'on_error') ?? ''));
  elements.graphEntrypoint.checked = !scoped && getPreambleField(state.doc!, 'entrypoint') === 'true';

  for (const field of [elements.graphDescription, elements.graphContext, elements.graphOnError, elements.graphEntrypoint]) {
    field.disabled = scoped;
  }
}

function setUnlessFocused(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  if (document.activeElement !== field) field.value = value;
}

function centeredDefaultRect(worldPoint: Point): Rect {
  const { w, h } = FlowDoc.DEFAULT_NODE_SIZE;
  return { x: Math.round(worldPoint.x - w / 2), y: Math.round(worldPoint.y - h / 2), w, h };
}

function createNodeAndEdit(rect: Rect, requestedName = 'Untitled'): FlowNode {
  let node: FlowNode | null = null;
  mutate(() => {
    node = FlowDoc.addNode(scopeItemsNow(), rect, requestedName);
  }, { commit: 'now' });
  view.select(node!);
  editors.openNodeEditor(node!, { focusTitle: true });
  return node!;
}

function deleteNodesAction(nodes: FlowNode[]): void {
  const groups = new Map<FlowDocument, { owner: DocumentOwner; nodes: FlowNode[] }>();
  for (const node of nodes) {
    const owner = ownerOf(node);
    if (!groups.has(owner.doc)) groups.set(owner.doc, { owner, nodes: [] });
    groups.get(owner.doc)!.nodes.push(node);
  }
  for (const { owner, nodes: docNodes } of groups.values()) {
    const clears: { identity: FlowDoc.ExpandIdentity; name: string }[] = [];
    for (const node of docNodes) {
      const identity = FlowDoc.expandIdentityForNode(owner.doc, owner.path, node);
      if (identity) clears.push({ identity, name: node.name });
    }
    applyToDoc(owner, () => {
      const byItems = new Map<ReturnType<typeof FlowDoc.containingItems>, FlowNode[]>();
      for (const node of docNodes) {
        const items = FlowDoc.containingItems(owner.doc, node);
        if (!byItems.has(items)) byItems.set(items, []);
        byItems.get(items)!.push(node);
      }
      for (const [items, list] of byItems) {
        FlowDoc.deleteNodes(items, list, owner.doc, { path: owner.path });
      }
    }, { commit: 'now' });
    for (const { identity, name } of clears) {
      retargetInnersAcrossWorkspace(identity, name, null, owner.doc);
    }
  }
}

function deleteSelection(): void {
  const nodes = [...view.selection];
  const edge = view.selectedEdge;
  if (nodes.length > 0) {
    editors.closeAll();
    deleteNodesAction(nodes);
  } else if (edge) {
    editors.closeAll();
    applyEdit(edge.from, () => FlowDoc.deleteEdge(edge), { commit: 'now' });
  }
}

// Opening a subgraph plays a seamless dive-in: the outgoing scene is held on screen while
// the destination loads, then both scenes render together — the subgraph riding inside the
// node's rectangle as the camera zooms through it, crossfading as it grows (see
// canvas-view's zoom transition).
async function openExpand(node: FlowNode): Promise<void> {
  const expandValue = getProp(node, 'expand');
  if (!expandValue || navigation.inProgress || expansions.isEmbedded(node)) return;
  navigation.inProgress = true;
  try {
    editors.closeAll();
    const origin: TrailEntry = { path: state.path!, scope: state.scope, nodeId: node.id, view: { ...view.view } };
    const nodeRect = { ...view.rect(node) };
    view.beginSceneHold(state.model!, view.view);

    const link = parseExpandLink(expandValue);
    let swapped = true;
    if (link) {
      swapped = await openExternalFlow(link);
    } else {
      if (!FlowDoc.graphBlockNames(state.doc!).includes(expandValue)) {
        mutate(() => state.doc!.items.push({ kind: 'graph', name: expandValue, items: [] }), { commit: 'now' });
      }
      setScope(expandValue, { fit: false });
    }
    if (!swapped) {
      view.releaseSceneHold();
      view.setViewNow(origin.view);
      return;
    }

    navigation.trail.push(origin);
    renderBreadcrumb();
    await view.zoomDiveIn({ nodeRect });
  } finally {
    navigation.inProgress = false;
  }
}

async function openExternalFlow(link: ExpandLink): Promise<boolean> {
  const resolved = resolveLinkPath(state.path, link.path);
  if (state.files.includes(resolved)) {
    return openFile(resolved, { fit: false });
  }
  const graphName = sanitizeName(link.label) || resolved.split('/').pop()!.replace(/\.flow$/, '');
  const text = `---\nname: ${graphName}\n---\n`;
  sendWrite(resolved, text);
  state.files.push(resolved);
  state.files.sort();
  return openFile(resolved, { presetText: text, fit: false });
}

// Stepping back one crumb reverses the dive: the subgraph shrinks back into the node it
// came from while the parent graph fades in around it, ending exactly on the camera we
// left. Jumping several crumbs at once just snaps.
async function navigateBackTo(index: number): Promise<void> {
  if (navigation.inProgress || index >= navigation.trail.length) return;
  navigation.inProgress = true;
  try {
    editors.closeAll();
    const entry = navigation.trail[index];
    const singleStep = index === navigation.trail.length - 1;
    navigation.trail.length = index;
    if (!singleStep) {
      await snapToEntry(entry);
      return;
    }
    view.beginSceneHold(state.model!, view.view);
    if (entry.path !== state.path) {
      const opened = await openFile(entry.path, { fit: false });
      if (!opened) {
        view.releaseSceneHold();
        renderBreadcrumb();
        return;
      }
    }
    if (state.scope !== entry.scope) setScope(entry.scope, { fit: false });
    renderBreadcrumb();
    const enteredNode = FlowDoc.findNodeById(state.doc!, entry.nodeId);
    if (!enteredNode?.pos) {
      view.releaseSceneHold();
      view.setViewNow(entry.view);
      return;
    }
    await view.zoomBackOut({ nodeRect: { ...enteredNode.pos }, targetView: entry.view });
  } finally {
    navigation.inProgress = false;
  }
}

async function snapToEntry(entry: TrailEntry): Promise<void> {
  if (entry.path !== state.path) {
    const opened = await openFile(entry.path, { fit: false });
    if (!opened) {
      renderBreadcrumb();
      return;
    }
  }
  if (state.scope !== entry.scope) setScope(entry.scope, { fit: false });
  renderBreadcrumb();
  view.setViewNow(entry.view);
}

function toggleInlineExpansion(node: FlowNode): void {
  if (!getProp(node, 'expand')) return;
  expansions.toggle(node);
  scheduleManifestSave();
}

// --- Editing routed by document ----------------------------------------------------------
//
// Nodes inside an unfolded frame may belong to another .flow file. Every mutation is routed
// to the document that owns the node: the current file goes through the normal
// mutate/undo/commit pipeline, external documents are serialized and written straight to
// their own path (no undo — the file watcher keeps other views in sync).

const pendingExternalCommits = new Map<string, { timer: ReturnType<typeof setTimeout>; doc: FlowDocument }>();

function ownerOf(node: FlowNode): DocumentOwner {
  if (FlowDoc.allNodes(state.doc!).includes(node)) return { doc: state.doc!, path: state.path! };
  return expansions.ownerOf(node) ?? { doc: state.doc!, path: state.path! };
}

function commitExternalNow(doc: FlowDocument, path: string): void {
  clearTimeout(pendingExternalCommits.get(path)?.timer);
  pendingExternalCommits.delete(path);
  FlowDoc.ensureLayoutEverywhere(doc);
  sendWrite(path, serializeFlow(doc));
}

function applyToDoc(owner: DocumentOwner, mutation: () => void, { commit = 'debounce' }: { commit?: CommitTiming } = {}): void {
  if (owner.doc === state.doc) {
    mutate(mutation, { commit });
    return;
  }
  mutation();
  expansions.invalidateSubModels();
  view.requestRender();
  if (commit === 'now') {
    commitExternalNow(owner.doc, owner.path);
  } else {
    clearTimeout(pendingExternalCommits.get(owner.path)?.timer);
    pendingExternalCommits.set(owner.path, {
      doc: owner.doc,
      timer: setTimeout(() => commitExternalNow(owner.doc, owner.path), COMMIT_DEBOUNCE_MS),
    });
  }
}

function applyEdit(node: FlowNode, mutation: () => void, options?: { commit?: CommitTiming }): void {
  applyToDoc(ownerOf(node), mutation, options);
}

function expandTargetDoc(path: string): FlowDocument | null {
  if (state.doc && path === state.path) return state.doc;
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
  const path = resolvedExpandPath(getProp(node, 'expand'), ownerOf(node).path);
  if (!path) {
    applyEdit(node, () => setProp(node, 'description', quoted));
    return;
  }
  const doc = expandTargetDoc(path);
  if (doc) {
    writeExpandDescription(node, { doc, path }, quoted);
    return;
  }
  // Prefetch may still be in flight when the user starts typing; finish the load then write
  // to the preamble so the keystroke does not land on the referencing node.
  void expansions.ensureDocument(path).then((loaded) => {
    if (!node.id || findNode(node.id) !== node) return;
    if (resolvedExpandPath(getProp(node, 'expand'), ownerOf(node).path) !== path) return;
    if (loaded) writeExpandDescription(node, { doc: loaded, path }, quoted);
    else applyEdit(node, () => setProp(node, 'description', quoted));
  });
}

function writeExpandDescription(node: FlowNode, target: DocumentOwner, quoted: string | null): void {
  applyToDoc(target, () => setPreambleField(target.doc, 'description', quoted));
  if (getProp(node, 'description') != null) {
    applyEdit(node, () => setProp(node, 'description', null));
  }
}

async function ensureExpandTarget(node: FlowNode): Promise<void> {
  const path = resolvedExpandPath(getProp(node, 'expand'), ownerOf(node).path);
  if (!path) return;
  await expansions.ensureDocument(path);
}

function findNode(nodeId: string): FlowNode | null {
  return FlowDoc.findNodeById(state.doc!, nodeId) ?? expansions.findNodeById(nodeId);
}

function findEdge(spec: EdgeSpec): ModelEdge | null {
  return state.model?.edges.find((edge) => edge.spec === spec) ?? expansions.findEdgeBySpec(spec);
}

function knownDocuments(): DocumentOwner[] {
  const docs: DocumentOwner[] = [];
  if (state.doc && state.path) docs.push({ doc: state.doc, path: state.path });
  for (const entry of expansions.loadedDocuments()) {
    if (entry.doc !== state.doc) docs.push(entry);
  }
  return docs;
}

function retargetInnersAcrossWorkspace(
  identity: FlowDoc.ExpandIdentity | null,
  oldName: string,
  newName: string | null,
  alreadyUpdated: FlowDocument,
): void {
  if (!identity) return;
  for (const entry of knownDocuments()) {
    if (entry.doc === alreadyUpdated) continue;
    if (!FlowDoc.hasInnerRefs([entry], identity, oldName)) continue;
    applyToDoc(entry, () => {
      FlowDoc.retargetInnerRefs([entry], identity, oldName, newName);
    }, { commit: 'now' });
  }
}

function renameNodeAction(node: FlowNode, requestedName: string): string {
  const owner = ownerOf(node);
  const oldName = node.name;
  let finalName = oldName;
  applyToDoc(owner, () => {
    finalName = FlowDoc.renameNode(
      FlowDoc.containingItems(owner.doc, node),
      node,
      requestedName,
      owner.doc,
      { path: owner.path },
    );
  });
  if (finalName !== oldName) {
    retargetInnersAcrossWorkspace(
      FlowDoc.expandIdentityForNode(owner.doc, owner.path, node),
      oldName,
      finalName,
      owner.doc,
    );
  }
  return finalName;
}

function innerTargetOptions(edge: ModelEdge): string[] {
  if (edge.kind !== 'flow') return [];
  const owner = ownerOf(edge.from);
  const targetNode = FlowDoc.nodesIn(FlowDoc.containingItems(owner.doc, edge.from))
    .find((node) => node.name === edge.spec.target);
  const expandValue = targetNode ? getProp(targetNode, 'expand') : null;
  if (!expandValue) return [];
  return FlowDoc.expandEntryNames(
    expandValue,
    owner.doc,
    owner.path,
    (path) => expandTargetDoc(path),
  ) ?? [];
}

async function ensureInnerTargets(edge: ModelEdge): Promise<void> {
  if (edge.kind !== 'flow') return;
  const owner = ownerOf(edge.from);
  const targetNode = FlowDoc.nodesIn(FlowDoc.containingItems(owner.doc, edge.from))
    .find((node) => node.name === edge.spec.target);
  const path = resolvedExpandPath(targetNode ? getProp(targetNode, 'expand') : null, owner.path);
  if (path) await expansions.ensureDocument(path);
}

function commitMovesFor(nodes: FlowNode[]): void {
  const externalOwners = new Map<string, DocumentOwner>();
  for (const node of nodes) {
    const owner = ownerOf(node);
    if (owner.doc !== state.doc) externalOwners.set(owner.path, owner);
  }
  refresh();
  commitNow();
  for (const owner of externalOwners.values()) commitExternalNow(owner.doc, owner.path);
}

function completeEdge(
  fromNode: FlowNode,
  targetNode: FlowNode | null,
  worldPoint: Point,
  extra?: {
    droppedOnSource: boolean;
    ghostTarget: GhostNode | null;
    innerName?: string;
  },
): void {
  if (!state.doc || extra?.droppedOnSource) return;

  if (expansions.isEmbedded(fromNode)) {
    // Inside a frame, edges only connect existing nodes of that subgraph — dropping on
    // empty canvas would otherwise spawn a node in the wrong graph.
    if (!targetNode) return;
    applyEdit(fromNode, () => FlowDoc.addEdge(fromNode, targetNode.name), { commit: 'now' });
    return;
  }

  let createdNode: FlowNode | null = null;
  let createdSpec: EdgeSpec | null = null;
  mutate(() => {
    let targetName: string;
    if (targetNode) {
      targetName = targetNode.name;
    } else if (extra?.ghostTarget) {
      createdNode = FlowDoc.addNode(scopeItemsNow(), extra.ghostTarget.pos, extra.ghostTarget.name);
      targetName = createdNode.name;
    } else {
      createdNode = FlowDoc.addNode(scopeItemsNow(), centeredDefaultRect(worldPoint));
      targetName = createdNode.name;
    }
    createdSpec = FlowDoc.addEdge(fromNode, targetName, null, extra?.innerName ?? null);
  }, { commit: 'now' });

  if (createdNode && !extra?.ghostTarget) {
    view.select(createdNode);
    editors.openNodeEditor(createdNode, { focusTitle: true });
    return;
  }
  const createdEdge = state.model!.edges.find((edge) => edge.spec === createdSpec);
  if (createdEdge) {
    view.selectedEdge = createdEdge;
    editors.openEdgeEditor(createdEdge);
  }
}

const view = new CanvasView(elementById<HTMLCanvasElement>('canvas'), {
  createNode: (rect) => {
    if (state.doc) createNodeAndEdit(rect);
  },
  quickCreateNode: (worldPoint) => {
    if (state.doc) createNodeAndEdit(centeredDefaultRect(worldPoint));
  },
  nodeClicked: (node) => editors.openNodeEditor(node),
  canvasClicked: () => editors.closeAll(),
  moveCommitted: (nodes) => commitMovesFor(nodes ?? []),
  completeEdge,
  editEdge: (edge) => editors.openEdgeEditor(edge),
  openExpand,
  toggleExpand: toggleInlineExpansion,
  materializeGhost: (ghost) => {
    if (!state.doc) return;
    const node = createNodeAndEdit(ghost.pos, ghost.name);
    view.select(node);
  },
  viewChanged: () => {
    editors.reposition();
    if (state.path) scheduleManifestSave();
  },
  afterRender: () => {
    editors.reposition();
    elements.zoomLevel.textContent = `${Math.round(view.view.scale * 100)}%`;
  },
});

const expansions = new ExpansionLayer({
  onNeedsRender: () => {
    view.requestRender();
    editors.refreshFromDoc();
  },
  readExternalFile: (path) => workspace?.readFile(path) ?? Promise.resolve(null),
});
view.expansionLayer = expansions;

const editors: Editors = createEditors({
  view,
  findNode,
  findEdge,
  renameNode: renameNodeAction,
  applyEdit,
  applyEditNow: (node, mutation) => applyEdit(node, mutation, { commit: 'now' }),
  descriptionOf,
  applyDescriptionEdit,
  ensureExpandTarget,
  ensureInnerTargets,
  canOpen: (node) => !expansions.isEmbedded(node),
  openExpand,
  toggleExpand: toggleInlineExpansion,
  deleteNodes: deleteNodesAction,
  innerTargetOptions,
});

function wireGraphPanel(): void {
  elements.graphToggle.addEventListener('click', () => {
    elements.graphPanel.classList.toggle('collapsed');
  });

  elements.graphName.addEventListener('change', () => {
    if (!state.doc) return;
    if (state.scope) {
      const graphItem = state.doc.items.find(
        (item): item is GraphItem => item.kind === 'graph' && item.name === state.scope,
      );
      if (!graphItem) return;
      mutate(() => {
        state.scope = FlowDoc.renameGraphBlock(state.doc!, graphItem, elements.graphName.value);
      }, { commit: 'now' });
    } else {
      mutate(() => setPreambleField(state.doc!, 'name', collapseToSingleLine(elements.graphName.value)));
    }
  });

  elements.graphDescription.addEventListener('input', () => {
    if (!state.doc || state.scope) return;
    const text = collapseToSingleLine(elements.graphDescription.value);
    mutate(() => setPreambleField(state.doc!, 'description', text ? quoteValue(text) : null));
  });

  elements.graphContext.addEventListener('change', () => {
    if (!state.doc || state.scope) return;
    const entries = elements.graphContext.value.split(',').map((entry) => entry.trim()).filter(Boolean);
    mutate(() => setPreambleField(state.doc!, 'context', entries.length ? formatListValue(entries) : null));
  });

  elements.graphOnError.addEventListener('change', () => {
    if (!state.doc || state.scope) return;
    mutate(() => setPreambleField(state.doc!, 'on_error', elements.graphOnError.value.trim() || null));
  });

  elements.graphEntrypoint.addEventListener('change', () => {
    if (!state.doc || state.scope) return;
    mutate(() => setPreambleField(state.doc!, 'entrypoint', elements.graphEntrypoint.checked ? 'true' : null));
  });
}

function setTool(tool: Tool): void {
  view.setTool(tool);
  elements.toolSelectButton.classList.toggle('active', tool === 'select');
  elements.toolNodeButton.classList.toggle('active', tool === 'node');
}

function wireViewControls(): void {
  elements.toolSelectButton.addEventListener('click', () => setTool('select'));
  elements.toolNodeButton.addEventListener('click', () => setTool('node'));
  elements.zoomIn.addEventListener('click', () => view.stepZoom(1));
  elements.zoomOut.addEventListener('click', () => view.stepZoom(-1));
  elements.zoomLevel.addEventListener('click', () => view.setZoom(1));
  elements.zoomFit.addEventListener('click', () => view.fitToContent());
}

// An inline input instead of window.prompt: prompt dialogs are suppressed in several
// embedded browser hosts, which made the button appear dead.
function wireNewFileForm(): void {
  const showInput = () => {
    elements.newFileButton.classList.add('hidden');
    elements.newFileInput.classList.remove('hidden');
    elements.newFileInput.value = `untitled-${state.files.length + 1}.flow`;
    elements.newFileInput.focus();
    elements.newFileInput.select();
  };
  const hideInput = () => {
    elements.newFileInput.classList.add('hidden');
    elements.newFileButton.classList.remove('hidden');
  };
  elements.newFileButton.addEventListener('click', showInput);
  elements.newFileInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      createFlowFile(elements.newFileInput.value);
      hideInput();
    } else if (event.key === 'Escape') {
      hideInput();
    }
    event.stopPropagation();
  });
  elements.newFileInput.addEventListener('blur', hideInput);
}

function createFlowFile(rawName: string): void {
  let name = rawName.trim().replace(/\\/g, '/');
  if (!name) return;
  if (!name.endsWith('.flow')) name += '.flow';
  const graphName = name.split('/').pop()!.replace(/\.flow$/, '');
  const text = `---\nname: ${graphName}\n---\n`;
  sendWrite(name, text);
  if (!state.files.includes(name)) {
    state.files.push(name);
    state.files.sort();
  }
  if (!manifest.entrypoint) manifest.entrypoint = name;
  navigation.trail.length = 0;
  openFile(name, { presetText: text });
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
    if (isTypingTarget(event.target)) {
      if (event.key === 'Escape') event.target.blur();
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
    } else if (!ctrl && event.key.toLowerCase() === 'v') {
      setTool('select');
    } else if (!ctrl && event.key.toLowerCase() === 'n') {
      setTool('node');
    } else if (event.key === 'Escape') {
      editors.closeAll();
      view.clearSelection();
      elements.helpOverlay.classList.add('hidden');
    } else if (event.key === '?') {
      elements.helpOverlay.classList.toggle('hidden');
    }
  });
}

// --- Workspaces --------------------------------------------------------------------------

function createDefaultWorkspace(): Workspace {
  return defaultWorkspaceKind === 'server' ? new ServerWorkspace() : new BrowserWorkspace();
}

function flushPendingCommits(): void {
  commitNow();
  for (const [path, pending] of [...pendingExternalCommits]) commitExternalNow(pending.doc, path);
}

function resetSessionState(): void {
  editors.closeAll();
  view.clearSelection();
  expansions.reset();
  navigation.trail.length = 0;
  undoStack.length = 0;
  redoStack.length = 0;
  clearTimeout(commitTimer);
  for (const pending of pendingExternalCommits.values()) clearTimeout(pending.timer);
  pendingExternalCommits.clear();
  state.files = [];
  state.path = null;
  state.text = '';
  state.doc = null;
  state.scope = null;
  state.model = null;
  manifest = emptyManifest();
}

async function switchWorkspace(next: Workspace, { preferHash = false } = {}): Promise<void> {
  if (workspace) {
    flushPendingCommits();
    saveManifestNow();
    workspace.stop();
  }
  workspace = null;
  resetSessionState();
  workspace = next;
  try {
    state.files = await next.start(workspaceDelegate);
  } catch (error) {
    console.error('Failed to open workspace', error);
    state.files = [];
  }
  manifest = parseManifest(await next.readFile(MANIFEST_FILE_NAME)) ?? emptyManifest();
  if (!manifest.entrypoint) manifest.entrypoint = defaultEntrypoint(state.files);
  renderFileList();
  renderWorkspaceBar();

  const hashPath = decodeURIComponent(location.hash.slice(1));
  const startupPath =
    preferHash && hashPath && state.files.includes(hashPath) ? hashPath : chooseStartupFlow(manifest, state.files);
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
  renderBreadcrumb();
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
  elements.closeFolderButton.classList.toggle('hidden', workspace.kind !== 'folder');
  elements.openFolderButton.classList.toggle('hidden', !folderPickingIsSupported() || workspace.kind === 'folder');
}

async function exportWorkspace(): Promise<void> {
  if (!workspace) return;
  flushPendingCommits();
  recordUiState();
  if (!manifest.entrypoint) manifest.entrypoint = defaultEntrypoint(state.files);
  try {
    await exportWorkspaceAsZip({
      files: [...state.files],
      readFile: (path) => (path === state.path ? Promise.resolve(state.text) : workspace!.readFile(path)),
      manifest,
      workspaceLabel: workspace.kind === 'folder' ? workspace.label : 'graf-workspace',
    });
  } catch (error) {
    console.error('Export failed', error);
    alert('Export failed — see the browser console for details.');
  }
}

function wireWorkspaceControls(): void {
  elements.openFolderButton.addEventListener('click', async () => {
    const folder = await pickWorkspaceFolder();
    if (folder) await switchWorkspace(new FolderWorkspace(folder));
  });
  elements.closeFolderButton.addEventListener('click', () => {
    void switchWorkspace(createDefaultWorkspace());
  });
  elements.exportButton.addEventListener('click', () => void exportWorkspace());
}

async function boot(): Promise<void> {
  wireGraphPanel();
  wireViewControls();
  wireNewFileForm();
  wireHelp();
  wireKeyboard();
  wireWorkspaceControls();
  setTool('select');

  defaultWorkspaceKind = (await serverIsAvailable()) ? 'server' : 'browser';
  await switchWorkspace(createDefaultWorkspace(), { preferHash: true });
}

boot();
