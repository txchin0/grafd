// App shell: file list, WebSocket sync with the server, undo/redo, keyboard shortcuts, and
// the glue between canvas gestures (canvas-view.js), document mutations (flow-doc.js), and
// the floating editors (editors.js).
//
// Sync model: the serialized file text is the source of truth. Every mutation edits the
// parsed AST, re-renders immediately, and writes the re-serialized text to the server
// (debounced for typing, immediate for drags). File changes on disk arrive as `file`
// messages and replace the AST wholesale; selection and open editors survive via node UUIDs.

import { parseFlow, serializeFlow, getPreambleField, setPreambleField, getProp, quoteValue, unquote, collapseToSingleLine, parseListValue, formatListValue, parseExpandLink, sanitizeName } from '/shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import { CanvasView } from './canvas-view.js';
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

const undoStack = [];
const redoStack = [];
let commitTimer = null;
let socket = null;
const pendingWrites = new Map();

const elements = {
  fileList: document.getElementById('file-list'),
  newFileButton: document.getElementById('new-file-button'),
  breadcrumb: document.getElementById('breadcrumb'),
  emptyState: document.getElementById('empty-state'),
  connectionDot: document.getElementById('connection-dot'),
  helpToggle: document.getElementById('help-toggle'),
  helpOverlay: document.getElementById('help-overlay'),
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

async function openFile(path, presetText = null) {
  let text = presetText;
  if (text == null) {
    const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) return;
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
  view.fitToContent();
  renderFileList();
}

function setScope(scopeName) {
  state.scope = scopeName;
  editors.closeAll();
  view.clearSelection();
  refresh();
  view.fitToContent();
}

function renderFileList() {
  elements.fileList.replaceChildren(
    ...state.files.map((path) => {
      const item = document.createElement('li');
      item.textContent = path;
      item.title = path;
      item.classList.toggle('active', path === state.path);
      item.addEventListener('click', () => openFile(path));
      return item;
    }),
  );
}

function renderBreadcrumb() {
  const crumbs = [];
  const fileCrumb = document.createElement('span');
  fileCrumb.className = 'crumb' + (state.scope ? '' : ' current');
  fileCrumb.textContent = state.path ?? '';
  if (state.scope) fileCrumb.addEventListener('click', () => setScope(null));
  crumbs.push(fileCrumb);

  if (state.scope) {
    const separator = document.createElement('span');
    separator.className = 'separator';
    separator.textContent = '›';
    const scopeCrumb = document.createElement('span');
    scopeCrumb.className = 'crumb current';
    scopeCrumb.textContent = `graph: ${state.scope}`;
    crumbs.push(separator, scopeCrumb);
  }
  elements.breadcrumb.replaceChildren(...crumbs);
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
  mutate(() => FlowDoc.deleteNodes(scopeItemsNow(), nodes), { commit: 'now' });
}

function deleteSelection() {
  const nodes = [...view.selection];
  const edge = view.selectedEdge;
  if (nodes.length > 0) {
    editors.closeAll();
    deleteNodesAction(nodes);
  } else if (edge) {
    editors.closeAll();
    mutate(() => FlowDoc.deleteEdge(edge), { commit: 'now' });
  }
}

function openExpand(node) {
  const expandValue = getProp(node, 'expand');
  if (!expandValue) return;

  const link = parseExpandLink(expandValue);
  if (link) {
    openExternalFlow(link);
    return;
  }
  if (!FlowDoc.graphBlockNames(state.doc).includes(expandValue)) {
    mutate(() => state.doc.items.push({ kind: 'graph', name: expandValue, items: [] }), { commit: 'now' });
  }
  setScope(expandValue);
}

function openExternalFlow(link) {
  const resolved = resolveRelativePath(directoryOf(state.path), link.path);
  if (state.files.includes(resolved)) {
    openFile(resolved);
    return;
  }
  const graphName = sanitizeName(link.label) || resolved.split('/').pop().replace(/\.flow$/, '');
  const text = `---\nname: ${graphName}\n---\n`;
  sendWrite(resolved, text);
  state.files.push(resolved);
  state.files.sort();
  openFile(resolved, text);
}

function directoryOf(path) {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash === -1 ? '' : path.slice(0, lastSlash);
}

function resolveRelativePath(baseDirectory, relativePath) {
  const segments = baseDirectory ? baseDirectory.split('/') : [];
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

function completeEdge(fromNode, targetNode, worldPoint, extra) {
  if (!state.doc || extra?.droppedOnSource) return;

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
  moveCommitted: () => {
    refresh();
    commitNow();
  },
  completeEdge,
  editEdge: (edge) => editors.openEdgeEditor(edge),
  openExpand,
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

const editors = createEditors({
  view,
  getDoc: () => state.doc,
  getModel: () => state.model,
  getScopeItems: scopeItemsNow,
  apply: (mutation) => mutate(mutation),
  openExpand,
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

function wireViewControls() {
  elements.zoomIn.addEventListener('click', () => view.setZoom(view.view.scale * 1.2));
  elements.zoomOut.addEventListener('click', () => view.setZoom(view.view.scale / 1.2));
  elements.zoomLevel.addEventListener('click', () => view.setZoom(1));
  elements.zoomFit.addEventListener('click', () => view.fitToContent());
}

function wireNewFileButton() {
  elements.newFileButton.addEventListener('click', () => {
    const suggested = `untitled-${state.files.length + 1}.flow`;
    let name = window.prompt('New flow file name', suggested);
    if (!name) return;
    name = name.trim().replace(/\\/g, '/');
    if (!name.endsWith('.flow')) name += '.flow';
    const graphName = name.split('/').pop().replace(/\.flow$/, '');
    const text = `---\nname: ${graphName}\n---\n`;
    sendWrite(name, text);
    if (!state.files.includes(name)) {
      state.files.push(name);
      state.files.sort();
    }
    openFile(name, text);
  });
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
  wireNewFileButton();
  wireHelp();
  wireKeyboard();
  connectSocket();

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
