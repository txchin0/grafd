// App shell: file list, WebSocket sync with the server, undo/redo, keyboard shortcuts, and
// the glue between canvas gestures (canvas-view.ts), document mutations (flow-doc.ts), the
// floating editors (editors.ts), and inline subgraph expansion (expansion.ts).
//
// Sync model: the serialized file text is the source of truth. Every mutation edits the
// parsed AST, re-renders immediately, and writes the re-serialized text to the server
// (debounced for typing, immediate for drags). File changes on disk arrive as `file`
// messages and replace the AST wholesale; selection and open editors survive via node UUIDs.
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
  quoteValue,
  unquote,
  collapseToSingleLine,
  parseListValue,
  formatListValue,
  parseExpandLink,
  resolveLinkPath,
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
import { createEditors } from './editors.js';

type ServerMessage =
  | { type: 'files'; files: string[] }
  | { type: 'file'; path: string; text: string };

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
let socket: WebSocket | null = null;
const pendingWrites = new Map<string, string>();

function elementById<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const elements = {
  fileList: elementById<HTMLUListElement>('file-list'),
  newFileButton: elementById<HTMLButtonElement>('new-file-button'),
  newFileInput: elementById<HTMLInputElement>('new-file-input'),
  breadcrumb: elementById<HTMLElement>('breadcrumb'),
  emptyState: elementById<HTMLDivElement>('empty-state'),
  connectionDot: elementById<HTMLSpanElement>('connection-dot'),
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

function connectSocket(): void {
  socket = new WebSocket(`ws://${location.host}`);
  socket.addEventListener('open', () => {
    elements.connectionDot.classList.add('connected');
    for (const [path, text] of pendingWrites) socket!.send(JSON.stringify({ type: 'write', path, text }));
    pendingWrites.clear();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    if (message.type === 'files') {
      state.files = message.files;
      renderFileList();
    } else if (message.type === 'file') {
      if (!state.files.includes(message.path)) {
        state.files.push(message.path);
        state.files.sort();
        renderFileList();
      }
      if (expansions.watchesPath(message.path)) {
        expansions.adoptExternalText(message.path, message.text);
      }
      if (message.path === state.path && message.text !== state.text) {
        adoptExternalText(message.text);
      }
    }
  });
  socket.addEventListener('close', () => {
    elements.connectionDot.classList.remove('connected');
    setTimeout(connectSocket, 1000);
  });
}

function sendWrite(path: string, text: string): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'write', path, text }));
  } else {
    pendingWrites.set(path, text);
  }
}

function adoptExternalText(text: string): void {
  state.text = text;
  state.doc = parseFlow(text);
  FlowDoc.assignMissingIds(state.doc);
  if (state.scope && !FlowDoc.graphBlockNames(state.doc).includes(state.scope)) state.scope = null;
  refresh();
}

async function openFile(
  path: string,
  { presetText = null, fit = true }: { presetText?: string | null; fit?: boolean } = {},
): Promise<boolean> {
  let text = presetText;
  if (text == null) {
    const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) return false;
    text = ((await response.json()) as { text: string }).text;
  }
  state.path = path;
  state.text = text;
  state.doc = parseFlow(text);
  FlowDoc.assignMissingIds(state.doc);
  state.scope = null;
  undoStack.length = 0;
  redoStack.length = 0;
  editors.closeAll();
  view.clearSelection();
  elements.emptyState.classList.add('hidden');
  location.hash = path;
  refresh();
  if (fit) view.fitToContent();
  renderFileList();
  return true;
}

function setScope(scopeName: string | null, { fit = true }: { fit?: boolean } = {}): void {
  state.scope = scopeName;
  editors.closeAll();
  view.clearSelection();
  refresh();
  if (fit) view.fitToContent();
}

function renderFileList(): void {
  elements.fileList.replaceChildren(
    ...state.files.map((path) => {
      const item = document.createElement('li');
      item.textContent = path;
      item.title = path;
      item.classList.toggle('active', path === state.path);
      item.addEventListener('click', () => {
        navigation.trail.length = 0;
        openFile(path);
      });
      return item;
    }),
  );
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
    applyToDoc(owner, () => {
      const byItems = new Map<ReturnType<typeof FlowDoc.containingItems>, FlowNode[]>();
      for (const node of docNodes) {
        const items = FlowDoc.containingItems(owner.doc, node);
        if (!byItems.has(items)) byItems.set(items, []);
        byItems.get(items)!.push(node);
      }
      for (const [items, list] of byItems) FlowDoc.deleteNodes(items, list);
    }, { commit: 'now' });
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
}

// --- Editing routed by document ----------------------------------------------------------
//
// Nodes inside an unfolded frame may belong to another .flow file. Every mutation is routed
// to the document that owns the node: the current file goes through the normal
// mutate/undo/commit pipeline, external documents are serialized and written straight to
// their own path (no undo — the file watcher keeps other views in sync).

const externalCommitTimers = new Map<string, ReturnType<typeof setTimeout>>();

function ownerOf(node: FlowNode): DocumentOwner {
  if (FlowDoc.allNodes(state.doc!).includes(node)) return { doc: state.doc!, path: state.path! };
  return expansions.ownerOf(node) ?? { doc: state.doc!, path: state.path! };
}

function commitExternalNow(doc: FlowDocument, path: string): void {
  clearTimeout(externalCommitTimers.get(path));
  externalCommitTimers.delete(path);
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
    clearTimeout(externalCommitTimers.get(owner.path));
    externalCommitTimers.set(
      owner.path,
      setTimeout(() => commitExternalNow(owner.doc, owner.path), COMMIT_DEBOUNCE_MS),
    );
  }
}

function applyEdit(node: FlowNode, mutation: () => void, options?: { commit?: CommitTiming }): void {
  applyToDoc(ownerOf(node), mutation, options);
}

function findNode(nodeId: string): FlowNode | null {
  return FlowDoc.findNodeById(state.doc!, nodeId) ?? expansions.findNodeById(nodeId);
}

function findEdge(spec: EdgeSpec): ModelEdge | null {
  return state.model?.edges.find((edge) => edge.spec === spec) ?? expansions.findEdgeBySpec(spec);
}

function itemsFor(node: FlowNode) {
  return FlowDoc.containingItems(ownerOf(node).doc, node);
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
  extra?: { droppedOnSource: boolean; ghostTarget: GhostNode | null },
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
    createdSpec = FlowDoc.addEdge(fromNode, targetName);
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
  viewChanged: () => editors.reposition(),
  afterRender: () => {
    editors.reposition();
    elements.zoomLevel.textContent = `${Math.round(view.view.scale * 100)}%`;
  },
});

const expansions = new ExpansionLayer({ onNeedsRender: () => view.requestRender() });
view.expansionLayer = expansions;

const editors = createEditors({
  view,
  findNode,
  findEdge,
  itemsFor,
  applyEdit,
  applyEditNow: (node, mutation) => applyEdit(node, mutation, { commit: 'now' }),
  canOpen: (node) => !expansions.isEmbedded(node),
  openExpand,
  toggleExpand: toggleInlineExpansion,
  deleteNodes: deleteNodesAction,
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
  elements.zoomIn.addEventListener('click', () => view.setZoom(view.view.scale * 1.2));
  elements.zoomOut.addEventListener('click', () => view.setZoom(view.view.scale / 1.2));
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
      view.setZoom(view.view.scale * 1.2);
    } else if (ctrl && event.key === '-') {
      event.preventDefault();
      view.setZoom(view.view.scale / 1.2);
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

async function boot(): Promise<void> {
  wireGraphPanel();
  wireViewControls();
  wireNewFileForm();
  wireHelp();
  wireKeyboard();
  connectSocket();
  setTool('select');

  const response = await fetch('/api/files');
  state.files = ((await response.json()) as { files: string[] }).files;
  renderFileList();

  const requestedPath = decodeURIComponent(location.hash.slice(1));
  if (requestedPath && state.files.includes(requestedPath)) {
    openFile(requestedPath);
  } else if (state.files.length > 0) {
    openFile(state.files[0]);
  }
}

boot();
