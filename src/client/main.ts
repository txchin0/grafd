// App shell: the page around the canvas — the sidebar's file tree, the breadcrumb, the graph
// panel, the floating editors, menus and modals, the toolbar, preferences and keyboard
// shortcuts — wired to the editor core (editor-core.ts), which owns the open flow, the
// workspace and every edit. Nothing here edits a document; it renders what the core reports
// and hands the user's choices back to it.
//
// Files live in the active workspace (workspace.ts): the Grafd server when one is answering
// (self-hosted mode), browser storage when the app is statically hosted (serverless mode),
// or a local folder opened through the File System Access API in either mode. UI state —
// entrypoint, active flow, per-flow cameras — persists to the workspace's
// grafd.manifest.json.

import { quoteValue, unquote } from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import type { DrawStyle, Tool } from './canvas/canvas-view.js';
import { createColorSwatches, createStrokeWidthPicker } from './visual-pickers.js';
import { createContextMenu, type MenuItem } from './context-menu.js';
import type { Modal } from './modal.js';
import { createPreferencesDialog } from './preferences-dialog.js';
import { applyCanvasFont } from './canvas-font.js';
import { loadPreferences, savePreferences, type Preferences } from './preferences.js';
import type { LinkContext } from './reference-link.js';
import { applyTheme } from './theme.js';
import type { TrailEntry } from './canvas/dive-navigation.js';
import { createEditors, type Editors } from './editors.js';
import type { Workspace } from './workspace.js';
import { ServerWorkspace, serverIsAvailable } from './workspace-server.js';
import { BrowserWorkspace } from './workspace-browser.js';
import { FolderWorkspace, folderPickingIsSupported, pickWorkspaceFolder } from './workspace-folder.js';
import { exportWorkspaceAsZip } from './export.js';
import { safeFileStem } from './download.js';
import { createScreenshotDialog } from './screenshot.js';
import { createSidebarFiles } from './sidebar-files.js';
import { createGraphPanel } from './graph-panel.js';
import { getBlockProp, setBlockProp } from './context/index.js';
import { createEditorCore } from './editor-core.js';

let currentPreferences: Preferences = loadPreferences();
applyTheme(currentPreferences.theme);
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
  helpClose: elementById<HTMLButtonElement>('help-close'),
  toolSelectButton: elementById<HTMLButtonElement>('tool-select-button'),
  toolNodeButton: elementById<HTMLButtonElement>('tool-node-button'),
  toolContextButton: elementById<HTMLButtonElement>('tool-context-button'),
  toolDrawButton: elementById<HTMLButtonElement>('tool-draw-button'),
  drawStyle: elementById<HTMLDivElement>('draw-style'),
  drawColor: elementById<HTMLDivElement>('draw-color'),
  drawWidth: elementById<HTMLDivElement>('draw-width'),
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

const contextMenu = createContextMenu();

// The shell callbacks below reach the editors, the graph panel and the sidebar, which are built
// from the core and so exist only after it. The core calls them in response to edits and
// workspace events, never while it is being constructed, so the forward references are safe.
const core = createEditorCore({
  canvas: elementById<HTMLCanvasElement>('canvas'),
  shell: {
    editors: {
      openNodeEditor: (node, options) => editors.openNodeEditor(node, options),
      openEdgeEditor: (edge) => editors.openEdgeEditor(edge),
      openRegionEditor: (region) => editors.openRegionEditor(region),
      openTitleEditor: (node) => editors.openTitleEditor(node),
      openRegionNameEditor: (region, rename) => editors.openRegionNameEditor(region, rename),
      closeAll: () => editors.closeAll(),
      reposition: () => editors.reposition(),
      refreshFromDoc: () => editors.refreshFromDoc(),
    },
    openMenu: (items, at) => contextMenu.open(items, at),
    openFlowChanged: (flow) => {
      renderBreadcrumb();
      graphPanel.render(flow);
    },
    trailChanged: () => renderBreadcrumb(),
    fileListChanged: () => renderFileList(),
    workspaceChanged: () => renderWorkspaceBar(),
    connectionChanged: (connected) => {
      elements.connectionDot.classList.toggle('connected', connected);
    },
    flowShown: (path) => {
      elements.emptyState.classList.add('hidden');
      location.hash = path;
    },
    workspaceEmpty: () => showEmptyWorkspace(),
    canvasRendered: () => {
      editors.reposition();
      showDrawStyleWhenRelevant();
      elements.zoomLevel.textContent = `${Math.round(view.view.scale * 100)}%`;
    },
    applyWorkspaceDisplay: () => applyWorkspaceDisplay(),
  },
});
const { view } = core;

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
  openFlow: () => core.openFlow(),
  edit: core.mutate,
  renameGraph: core.renameGraph,
  linkContext,
  runAction: (body) => core.session.runAction(body),
  hostRenamed: core.rippleInnerRefsAcrossWorkspace,
});

// The sidebar renders the workspace's paths and reports what the user picked; the actions it
// names live in the core.
const sidebarFiles = createSidebarFiles({
  fileList: elements.fileList,
  newFileButton: elements.newFileButton,
  newFileInput: elements.newFileInput,
  newFileError: elements.newFileError,
  contextMenu,
  files: () => core.workspaceFiles(),
  activePath: () => core.openFlow()?.path ?? null,
  openFile: (path) => core.openFlowFromSidebar(path),
  deleteFile: core.deleteFlowFile,
  duplicateFile: (path) => void core.duplicateFlowFile(path),
  renameFile: core.renameFlowFile,
  createFile: core.createFlowFile,
});

const editors: Editors = createEditors({
  view,
  regionDescriptionOf: (region) => unquote(getBlockProp(region.block, 'description')),
  applyRegionDescriptionEdit: (region, text) => {
    const owner = core.contextOps.ownerOfRegion(region);
    core.applyToDoc(owner, () => setBlockProp(region.block, 'description', text ? quoteValue(text) : null));
  },
  regionReferencesOf: (region) => region.block.references,
  applyRegionReferencesEdit: (region, references) => {
    const owner = core.contextOps.ownerOfRegion(region);
    core.applyToDoc(owner, () => { region.block.references = FlowDoc.normalizeReferences(references); });
  },
  selectMember: (region, memberName) => {
    const node = FlowDoc.nodesIn(region.doc.items).find((candidate) => candidate.name === memberName);
    if (node) view.select(node);
  },
  deleteRegion: (region) => core.contextOps.deleteRegion(region),
  readableContexts: (node) => core.contextOps.readableContexts(node),
  findNode: core.findNode,
  findEdge: (reference) => core.findEdgeWhere((edge) => FlowDoc.isSameEdge(edge, reference)),
  renameNode: core.renameNodeAction,
  applyEdit: core.applyEdit,
  applyEditNow: (node, mutation) => core.applyEdit(node, mutation, { commit: 'now' }),
  applyExpandEdit: core.applyExpandEditAction,
  expandOptions: (node) => FlowDoc.graphBlockNames(core.ownerOf(node).doc),
  descriptionOf: core.descriptionOf,
  applyDescriptionEdit: core.applyDescriptionEdit,
  referencesOf: core.referencesOf,
  applyReferencesEdit: core.applyReferencesEdit,
  linkContext,
  ensureExpandTarget: core.ensureExpandTarget,
  ensureInnerTargets: (edge) => core.ensureInnerDocument(edge, 'target'),
  ensureInnerSources: (edge) => core.ensureInnerDocument(edge, 'source'),
  openExpand: core.openExpand,
  toggleExpand: core.toggleInlineExpansion,
  deleteNodes: core.deleteNodesAction,
  innerTargetOptions: (edge) => core.innerOptions(edge, 'target'),
  innerSourceOptions: (edge) => core.innerOptions(edge, 'source'),
  renameRegion: (region, name) => core.contextOps.renameRegion(region, name),
  shapeOf: (node) => core.layerSync.shapeOf(core.ownerOf(node), node),
  applyShapeEdit: (node, shape) => {
    const owner = core.ownerOf(node);
    core.applyLayerEdit(owner, () => core.layerSync.setShape(owner, node, shape));
  },
  edgeStyleOf: (edge) => core.layerSync.edgeStyleOf(core.ownerOf(edge.from), edge),
  applyEdgeStyleEdit: core.applyEdgeStyleEdit,
});

function linkContext(): LinkContext {
  return {
    projectRoot: core.workspace()?.projectRoot ?? null,
    editorLinkScheme: currentPreferences.editorLinkScheme,
  };
}

function renderBreadcrumb(): void {
  const flow = core.openFlow();
  const crumbs: HTMLElement[] = [];
  core.trail().forEach((entry, index) => {
    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = crumbLabel(entry);
    crumb.title = entry.scope ? `${entry.path} › ${entry.scope}` : entry.path;
    crumb.addEventListener('click', () => core.navigateBackTo(index));
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

function screenshotFileStem(): string {
  const flow = core.openFlow();
  if (!flow) return 'grafd';
  const baseName = flow.path.split('/').pop()!.replace(/\.flow$/, '');
  const scoped = flow.scope ? `${baseName}-${flow.scope}` : baseName;
  return safeFileStem(scoped) || 'grafd';
}

const screenshot = createScreenshotDialog({ view, fileStem: screenshotFileStem });

function applyPreferences(preferences: Preferences): void {
  currentPreferences = preferences;
  view.gridIsVisible = preferences.showCanvasGrid;
  view.doubleClickOpensSubgraph = preferences.openSubgraphOnDoubleClick;
  applyTheme(preferences.theme);
  applySidebarVisibility(preferences.sidebarCollapsed);
  setDrawStyle({ color: preferences.drawColor, width: preferences.drawWidth });
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
  view.baseRoughness = core.uiState.roughness();
  await applyCanvasFont(core.uiState.font());
  view.requestRender();
}

const preferencesDialog = createPreferencesDialog(applyPreferences, {
  roughness: () => core.uiState.roughness(),
  setRoughness: (value) => {
    core.uiState.setRoughness(value);
    void applyWorkspaceDisplay();
  },
  font: () => core.uiState.font(),
  setFont: (value) => {
    core.uiState.setFont(value);
    void applyWorkspaceDisplay();
  },
});

// Only one modal is ever up at a time; Escape closes whichever it is.
const modals: Modal[] = [screenshot, preferencesDialog];

function openModal(): Modal | null {
  return modals.find((modal) => modal.isOpen()) ?? null;
}

let currentTool: Tool = 'select';

function setTool(tool: Tool): void {
  currentTool = tool;
  view.setTool(tool);
  elements.toolSelectButton.classList.toggle('active', tool === 'select');
  elements.toolNodeButton.classList.toggle('active', tool === 'node');
  elements.toolContextButton.classList.toggle('active', tool === 'context');
  elements.toolDrawButton.classList.toggle('active', tool === 'draw');
  showDrawStyleWhenRelevant();
}

// The pen's colour and width show while drawing, and while strokes are selected — a swatch
// picked outside the draw tool then recolours them as well. With the pen in hand it only sets
// the pen: strokes still selected from before are not what the user is choosing a colour for.
function showDrawStyleWhenRelevant(): void {
  const relevant = currentTool === 'draw' || view.selectedDrawings.length > 0;
  if (elements.drawStyle.hidden === relevant) elements.drawStyle.hidden = !relevant;
}

const drawColorPicker = createColorSwatches(elements.drawColor, (color) => {
  const selected = view.selectedDrawings;
  if (selected.length > 0 && currentTool !== 'draw') core.drawingOps.recolorDrawings(selected, color);
  setDrawStyle({ ...view.drawStyle, color });
});
const drawWidthPicker = createStrokeWidthPicker(elements.drawWidth, (width) => setDrawStyle({ ...view.drawStyle, width }));

function setDrawStyle(style: DrawStyle): void {
  view.drawStyle = style;
  drawColorPicker.fill(style.color);
  drawWidthPicker.fill(style.width);
  if (style.color === currentPreferences.drawColor && style.width === currentPreferences.drawWidth) return;
  const preferences = { ...currentPreferences, drawColor: style.color, drawWidth: style.width };
  savePreferences(preferences);
  currentPreferences = preferences;
}

function wireViewControls(): void {
  elements.toolSelectButton.addEventListener('click', () => setTool('select'));
  elements.toolNodeButton.addEventListener('click', () => setTool('node'));
  elements.toolContextButton.addEventListener('click', () => setTool('context'));
  elements.toolDrawButton.addEventListener('click', () => setTool('draw'));
  elements.zoomIn.addEventListener('click', () => view.stepZoom(1));
  elements.zoomOut.addEventListener('click', () => view.stepZoom(-1));
  elements.zoomLevel.addEventListener('click', () => view.setZoom(1));
  elements.zoomFit.addEventListener('click', () => view.fitToContent());
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
  const closeHelp = () => elements.helpOverlay.classList.add('hidden');
  elements.helpToggle.addEventListener('click', toggleHelp);
  elements.helpClose.addEventListener('click', closeHelp);
  document.addEventListener('pointerdown', (event) => {
    if (isOutsideHelp(event.target)) closeHelp();
  }, true);
}

// The toggle is excluded so its own click, which follows this pointerdown, can still close it.
function isOutsideHelp(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  return !elements.helpOverlay.contains(target) && !elements.helpToggle.contains(target);
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
      if (event.shiftKey) core.redo();
      else core.undo();
    } else if (ctrl && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      core.redo();
    } else if (ctrl && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      view.selectAll();
    } else if (ctrl && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      toggleSidebar();
    } else if (ctrl && event.key.toLowerCase() === 'c') {
      if (!core.hasCopyableSelection()) return;
      event.preventDefault();
      core.clipboard.copy();
    } else if (ctrl && event.key.toLowerCase() === 'x') {
      if (!core.hasCopyableSelection()) return;
      event.preventDefault();
      core.clipboard.cut();
    } else if (ctrl && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      core.clipboard.paste();
    } else if (ctrl && event.key.toLowerCase() === 'g') {
      if (view.selectedDrawings.length === 0) return;
      event.preventDefault();
      if (event.shiftKey) core.ungroupSelectedDrawings();
      else core.groupSelectedDrawings();
    } else if (ctrl && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      core.clipboard.duplicateSelection();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      core.deleteSelection();
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
    } else if (!ctrl && (event.key.toLowerCase() === 'd' || event.key === '4')) {
      setTool('draw');
    } else if (event.key === 'Escape' && view.cancelGesture()) {
      event.preventDefault();
    } else if (event.key === 'Escape') {
      contextMenu.close();
      editors.closeAll();
      const helpWasOpen = !elements.helpOverlay.classList.contains('hidden');
      elements.helpOverlay.classList.add('hidden');
      const trailLength = core.trail().length;
      if (!helpWasOpen && trailLength > 0) {
        void core.navigateBackTo(trailLength - 1);
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

function showEmptyWorkspace(): void {
  location.hash = '';
  elements.graphPanel.classList.add('collapsed');
  elements.graphToggle.textContent = '☰ graph';
  elements.emptyState.classList.remove('hidden');
  elements.emptyStateHint.textContent =
    core.workspace()?.kind === 'browser'
      ? 'Create your first flow with “+ New flow” — it is saved in this browser. Or open a local folder of .flow files.'
      : 'Create a new flow with “+ New flow”, or select one from the sidebar.';
  renderBreadcrumb();
  renderFileList();
}

function renderWorkspaceBar(): void {
  const workspace = core.workspace();
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
  const workspace = core.workspace();
  if (!workspace) return;
  core.session.flush();
  try {
    await exportWorkspaceAsZip({
      files: [...core.workspaceFiles()],
      // Tracked documents are exported from their committed text: the flush above has just
      // brought it up to date, and it needs no round-trip through the workspace backend.
      readFile: (path) => {
        const committed = core.session.committedTextAt(path);
        return committed != null ? Promise.resolve(committed) : core.workspace()!.readFile(path);
      },
      manifest: core.uiState.forExport(core.workspaceFiles()),
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
  if (folder) await core.switchWorkspace(new FolderWorkspace(folder));
}

function workspaceMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  if (core.workspace()?.kind === 'folder') {
    items.push({ label: '↩ Leave folder', onSelect: () => void core.switchWorkspace(createDefaultWorkspace()) });
  } else if (folderPickingIsSupported()) {
    items.push({ label: '📂 Open folder…', onSelect: () => void openWorkspaceFolder() });
  }
  items.push({ label: '⇩ Export .zip', onSelect: () => void exportWorkspace() });
  items.push({ label: '🖼 Export image…', disabled: !core.openFlow(), onSelect: () => screenshot.open() });
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
  // A reload lands back on the flow it was showing, which the location hash recorded.
  await core.switchWorkspace(createDefaultWorkspace(), { preferredPath: decodeURIComponent(location.hash.slice(1)) });
}

boot();
