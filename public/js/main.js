// App shell: file list, WebSocket sync with the server, undo/redo, keyboard shortcuts, and
// the glue between canvas gestures (canvas-view.js), document mutations (flow-doc.js), the
// floating editors (editors.js), and inline subgraph expansion (expansion.js).
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

import { parseFlow, serializeFlow, getPreambleField, setPreambleField, getProp, quoteValue, unquote, collapseToSingleLine, parseListValue, formatListValue, parseExpandLink, resolveLinkPath, sanitizeName } from '/shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import { CanvasView } from './canvas-view.js';
import { ExpansionLayer } from './expansion.js';
import { createEditors } from './editors.js';

const COMMIT_DEBOUNCE_MS = 300;
const UNDO_LIMIT = 100;

const state = {
  files: [],
  path: null,
  text: '',
  doc: null,
  scope: null,
  model: null,
};

const navigation = { trail: [], inProgress: false };

const undoStack = [];
const redoStack = [];
let commitTimer = null;
let socket = null;
const pendingWrites = new Map();

const elements = {
  fileList: document.getElementById('file-list'),
  newFileButton: document.getElementById('new-file-button'),
  newFileInput: document.getElementById('new-file-input'),
  breadcrumb: document.getElementById('breadcrumb'),
  emptyState: document.getElementById('empty-state'),
  connectionDot: document.getElementById('connection-dot'),
  helpToggle: document.getElementById('help-toggle'),
  helpOverlay: document.getElementById('help-overlay'),
  toolSelectButton: document.getElementById('tool-select-button'),
  toolNodeButton: document.getElementById('tool-node-button'),
  zoomIn: document.getElementById('zoom-in-button'),
  zoomOut: document.getElementById('zoom-out-button'),
  zoomLevel: document.getElementById('zoom-level-button'),
  zoomFit: document.getElementById('zoom-fit-button'),
  graphPanel: document.getElementById('graph-panel'),
  graphToggle: document.getElementById('gp-toggle'),
  graphName: document.getElementById('gp-name'),
  graphDescription: document.getElementById('gp-description'),
  graphContext: document.getElementById('gp-context'),
  graphOnError: document.getElementById('gp-on-error'),
  graphEntrypoint: document.getElementById('gp-entrypoint'),
};

function scopeItemsNow() {
  return FlowDoc.scopeItems(state.doc, state.scope);
}

function refresh() {
  if (!state.doc) return;
  state.model = FlowDoc.buildModel(state.doc, state.scope);
  state.model.sourceDoc = state.doc;
  state.model.sourcePath = state.path;
  expansions.invalidateSubModels();
  view.setModel(state.model);
  renderBreadcrumb();
  renderGraphPanel();
  editors.refreshFromDoc();
}

function mutate(mutation, { commit = 'debounce' } = {}) {
  if (!state.doc) return;
  mutation();
  refresh();
  if (commit === 'now') commitNow();
  else scheduleCommit();
}

function scheduleCommit() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commitNow, COMMIT_DEBOUNCE_MS);
}

function commitNow() {
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

function applyHistoryText(text) {
  state.text = text;
  state.doc = parseFlow(text);
  FlowDoc.assignMissingIds(state.doc);
  if (state.scope && !FlowDoc.graphBlockNames(state.doc).includes(state.scope)) state.scope = null;
  refresh();
  sendWrite(state.path, text);
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(state.text);
  applyHistoryText(undoStack.pop());
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(state.text);
  applyHistoryText(redoStack.pop());
}

function connectSocket() {
  socket = new WebSocket(`ws://${location.host}`);
  socket.addEventListener('open', () => {
    elements.connectionDot.classList.add('connected');
    for (const [path, text] of pendingWrites) socket.send(JSON.stringify({ type: 'write', path, text }));
    pendingWrites.clear();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
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

function sendWrite(path, text) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'write', path, text }));
  } else {
    pendingWrites.set(path, text);
  }
}

function adoptExternalText(text) {
  state.text = text;
  state.doc = parseFlow(text);
  FlowDoc.assignMissingIds(state.doc);
  if (state.scope && !FlowDoc.graphBlockNames(state.doc).includes(state.scope)) state.scope = null;
  refresh();
}

async function openFile(path, { presetText = null, fit = true } = {}) {
  let text = presetText;
  if (text == null) {
    const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) return false;
    text = (await response.json()).text;
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

function setScope(scopeName, { fit = true } = {}) {
  state.scope = scopeName;
  editors.closeAll();
  view.clearSelection();
  refresh();
  if (fit) view.fitToContent();
}

function renderFileList() {
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

function renderBreadcrumb() {
  const crumbs = [];
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

function crumbLabel(entry) {
  if (entry.scope) return entry.scope;
  return entry.path.split('/').pop().replace(/\.flow$/, '');
}

function breadcrumbSeparator() {
  const separator = document.createElement('span');
  separator.className = 'separator';
  separator.textContent = '/';
  return separator;
}

function renderGraphPanel() {
  const scoped = state.scope != null;
  const displayName = scoped
    ? state.scope
    : unquote(getPreambleField(state.doc, 'name') ?? '') || state.path || 'graph';
  elements.graphToggle.textContent = `☰ ${displayName}`;

  setUnlessFocused(elements.graphName, displayName);
  setUnlessFocused(elements.graphDescription, scoped ? '' : unquote(getPreambleField(state.doc, 'description') ?? ''));
  setUnlessFocused(elements.graphContext, scoped ? '' : parseListValue(getPreambleField(state.doc, 'context')).join(', '));
  setUnlessFocused(elements.graphOnError, scoped ? '' : (getPreambleField(state.doc, 'on_error') ?? ''));
  elements.graphEntrypoint.checked = !scoped && getPreambleField(state.doc, 'entrypoint') === 'true';

  for (const field of [elements.graphDescription, elements.graphContext, elements.graphOnError, elements.graphEntrypoint]) {
    field.disabled = scoped;
  }
}

function setUnlessFocused(field, value) {
  if (document.activeElement !== field) field.value = value;
}

function centeredDefaultRect(worldPoint) {
  const { w, h } = FlowDoc.DEFAULT_NODE_SIZE;
  return { x: Math.round(worldPoint.x - w / 2), y: Math.round(worldPoint.y - h / 2), w, h };
}

function createNodeAndEdit(rect, requestedName = 'Untitled') {
  let node = null;
  mutate(() => {
    node = FlowDoc.addNode(scopeItemsNow(), rect, requestedName);
  }, { commit: 'now' });
  view.select(node);
  editors.openNodeEditor(node, { focusTitle: true });
  return node;
}

function deleteNodesAction(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const owner = ownerOf(node);
    if (!groups.has(owner.doc)) groups.set(owner.doc, { owner, nodes: [] });
    groups.get(owner.doc).nodes.push(node);
  }
  for (const { owner, nodes: docNodes } of groups.values()) {
    applyToDoc(owner, () => {
      const byItems = new Map();
      for (const node of docNodes) {
        const items = FlowDoc.containingItems(owner.doc, node);
        if (!byItems.has(items)) byItems.set(items, []);
        byItems.get(items).push(node);
      }
      for (const [items, list] of byItems) FlowDoc.deleteNodes(items, list);
    }, { commit: 'now' });
  }
}

function deleteSelection() {
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
async function openExpand(node) {
  const expandValue = getProp(node, 'expand');
  if (!expandValue || navigation.inProgress || expansions.isEmbedded(node)) return;
  navigation.inProgress = true;
  try {
    editors.closeAll();
    const origin = { path: state.path, scope: state.scope, nodeId: node.id, view: { ...view.view } };
    const nodeRect = { ...view.rect(node) };
    view.beginSceneHold(state.model, view.view);

    const link = parseExpandLink(expandValue);
    let swapped = true;
    if (link) {
      swapped = await openExternalFlow(link);
    } else {
      if (!FlowDoc.graphBlockNames(state.doc).includes(expandValue)) {
        mutate(() => state.doc.items.push({ kind: 'graph', name: expandValue, items: [] }), { commit: 'now' });
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

async function openExternalFlow(link) {
  const resolved = resolveLinkPath(state.path, link.path);
  if (state.files.includes(resolved)) {
    return openFile(resolved, { fit: false });
  }
  const graphName = sanitizeName(link.label) || resolved.split('/').pop().replace(/\.flow$/, '');
  const text = `---\nname: ${graphName}\n---\n`;
  sendWrite(resolved, text);
  state.files.push(resolved);
  state.files.sort();
  return openFile(resolved, { presetText: text, fit: false });
}

// Stepping back one crumb reverses the dive: the subgraph shrinks back into the node it
// came from while the parent graph fades in around it, ending exactly on the camera we
// left. Jumping several crumbs at once just snaps.
async function navigateBackTo(index) {
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
    view.beginSceneHold(state.model, view.view);
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
    const enteredNode = FlowDoc.findNodeById(state.doc, entry.nodeId);
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

async function snapToEntry(entry) {
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

function toggleInlineExpansion(node) {
  if (!getProp(node, 'expand')) return;
  expansions.toggle(node);
}

// --- Editing routed by document ----------------------------------------------------------
//
// Nodes inside an unfolded frame may belong to another .flow file. Every mutation is routed
// to the document that owns the node: the current file goes through the normal
// mutate/undo/commit pipeline, external documents are serialized and written straight to
// their own path (no undo — the file watcher keeps other views in sync).

const externalCommitTimers = new Map();

function ownerOf(node) {
  if (FlowDoc.allNodes(state.doc).includes(node)) return { doc: state.doc, path: state.path };
  return expansions.ownerOf(node) ?? { doc: state.doc, path: state.path };
}

function commitExternalNow(doc, path) {
  clearTimeout(externalCommitTimers.get(path));
  externalCommitTimers.delete(path);
  FlowDoc.ensureLayoutEverywhere(doc);
  sendWrite(path, serializeFlow(doc));
}

function applyToDoc(owner, mutation, { commit = 'debounce' } = {}) {
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

function applyEdit(node, mutation, options) {
  applyToDoc(ownerOf(node), mutation, options);
}

function findNode(nodeId) {
  return FlowDoc.findNodeById(state.doc, nodeId) ?? expansions.findNodeById(nodeId);
}

function findEdge(spec) {
  return state.model?.edges.find((edge) => edge.spec === spec) ?? expansions.findEdgeBySpec(spec);
}

function itemsFor(node) {
  return FlowDoc.containingItems(ownerOf(node).doc, node);
}

function commitMovesFor(nodes) {
  const externalOwners = new Map();
  for (const node of nodes) {
    const owner = ownerOf(node);
    if (owner.doc !== state.doc) externalOwners.set(owner.path, owner);
  }
  refresh();
  commitNow();
  for (const owner of externalOwners.values()) commitExternalNow(owner.doc, owner.path);
}

function completeEdge(fromNode, targetNode, worldPoint, extra) {
  if (!state.doc || extra?.droppedOnSource) return;

  if (expansions.isEmbedded(fromNode)) {
    // Inside a frame, edges only connect existing nodes of that subgraph — dropping on
    // empty canvas would otherwise spawn a node in the wrong graph.
    if (!targetNode) return;
    applyEdit(fromNode, () => FlowDoc.addEdge(fromNode, targetNode.name), { commit: 'now' });
    return;
  }

  let createdNode = null;
  let createdSpec = null;
  mutate(() => {
    let targetName;
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
  const createdEdge = state.model.edges.find((edge) => edge.spec === createdSpec);
  if (createdEdge) {
    view.selectedEdge = createdEdge;
    editors.openEdgeEditor(createdEdge);
  }
}

const view = new CanvasView(document.getElementById('canvas'), {
  createNode: (rect) => state.doc && createNodeAndEdit(rect),
  quickCreateNode: (worldPoint) => state.doc && createNodeAndEdit(centeredDefaultRect(worldPoint)),
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

function wireGraphPanel() {
  elements.graphToggle.addEventListener('click', () => {
    elements.graphPanel.classList.toggle('collapsed');
  });

  elements.graphName.addEventListener('change', () => {
    if (!state.doc) return;
    if (state.scope) {
      const graphItem = state.doc.items.find((item) => item.kind === 'graph' && item.name === state.scope);
      if (!graphItem) return;
      mutate(() => {
        state.scope = FlowDoc.renameGraphBlock(state.doc, graphItem, elements.graphName.value);
      }, { commit: 'now' });
    } else {
      mutate(() => setPreambleField(state.doc, 'name', collapseToSingleLine(elements.graphName.value)));
    }
  });

  elements.graphDescription.addEventListener('input', () => {
    if (!state.doc || state.scope) return;
    const text = collapseToSingleLine(elements.graphDescription.value);
    mutate(() => setPreambleField(state.doc, 'description', text ? quoteValue(text) : null));
  });

  elements.graphContext.addEventListener('change', () => {
    if (!state.doc || state.scope) return;
    const entries = elements.graphContext.value.split(',').map((entry) => entry.trim()).filter(Boolean);
    mutate(() => setPreambleField(state.doc, 'context', entries.length ? formatListValue(entries) : null));
  });

  elements.graphOnError.addEventListener('change', () => {
    if (!state.doc || state.scope) return;
    mutate(() => setPreambleField(state.doc, 'on_error', elements.graphOnError.value.trim() || null));
  });

  elements.graphEntrypoint.addEventListener('change', () => {
    if (!state.doc || state.scope) return;
    mutate(() => setPreambleField(state.doc, 'entrypoint', elements.graphEntrypoint.checked ? 'true' : null));
  });
}

function setTool(tool) {
  view.setTool(tool);
  elements.toolSelectButton.classList.toggle('active', tool === 'select');
  elements.toolNodeButton.classList.toggle('active', tool === 'node');
}

function wireViewControls() {
  elements.toolSelectButton.addEventListener('click', () => setTool('select'));
  elements.toolNodeButton.addEventListener('click', () => setTool('node'));
  elements.zoomIn.addEventListener('click', () => view.setZoom(view.view.scale * 1.2));
  elements.zoomOut.addEventListener('click', () => view.setZoom(view.view.scale / 1.2));
  elements.zoomLevel.addEventListener('click', () => view.setZoom(1));
  elements.zoomFit.addEventListener('click', () => view.fitToContent());
}

// An inline input instead of window.prompt: prompt dialogs are suppressed in several
// embedded browser hosts, which made the button appear dead.
function wireNewFileForm() {
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

function createFlowFile(rawName) {
  let name = rawName.trim().replace(/\\/g, '/');
  if (!name) return;
  if (!name.endsWith('.flow')) name += '.flow';
  const graphName = name.split('/').pop().replace(/\.flow$/, '');
  const text = `---\nname: ${graphName}\n---\n`;
  sendWrite(name, text);
  if (!state.files.includes(name)) {
    state.files.push(name);
    state.files.sort();
  }
  navigation.trail.length = 0;
  openFile(name, { presetText: text });
}

function wireHelp() {
  const toggleHelp = () => elements.helpOverlay.classList.toggle('hidden');
  elements.helpToggle.addEventListener('click', toggleHelp);
  elements.helpOverlay.addEventListener('click', toggleHelp);
}

function isTypingTarget(element) {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function wireKeyboard() {
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

async function boot() {
  wireGraphPanel();
  wireViewControls();
  wireNewFileForm();
  wireHelp();
  wireKeyboard();
  connectSocket();
  setTool('select');

  const response = await fetch('/api/files');
  state.files = (await response.json()).files;
  renderFileList();

  const requestedPath = decodeURIComponent(location.hash.slice(1));
  if (requestedPath && state.files.includes(requestedPath)) {
    openFile(requestedPath);
  } else if (state.files.length > 0) {
    openFile(state.files[0]);
  }
}

boot();
