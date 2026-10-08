// The editor without its page: the open flow, the workspace it came from, every document an edit
// can reach, and the commands that edit them — the glue between canvas gestures
// (canvas-view.ts), document mutations (flow-doc.ts) and inline subgraph expansion
// (expansion.ts). It touches no DOM of its own. The floating editors, menus, breadcrumb, sidebar
// and graph panel are reached through the `EditorShell` the page hands it (main.ts), which is
// what lets a test drive the whole editing stack — pointer events in, files out — headless.
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
  resolvedExpandPath,
  descriptionForNode,
  referencesForNode,
  setPreambleReferences,
  sanitizeName,
  type ContextBlock,
  type EdgeSpec,
  type FlowDocument,
  type FlowItem,
  type FlowNode,
  type Rect,
  type Reference,
} from '../shared/flow-format.js';
import { DEFAULT_NODE_SIZE } from '../shared/auto-layout.js';
import * as FlowDoc from './flow-doc.js';
import type { FlowModel, MembershipChange, ModelContext, ModelEdge } from './flow-doc.js';
import type { Point } from './geometry.js';
import { CanvasView, type ContextTarget, type EdgeDrop } from './canvas/canvas-view.js';
import type { DrawingMove } from './canvas/drawing-selection.js';
import { createDrawingOps } from './drawing-ops.js';
import type { MenuItem } from './context-menu.js';
import type { EditorCommand } from './editor-commands.js';
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
import type { Editors } from './editors.js';
import { EditSession, type CommitTiming } from './edit-session.js';
import { MANIFEST_FILE_NAME } from '../shared/manifest.js';
import {
  canvasLayerPathOf,
  isCanvasLayerPath,
  parseCanvasLayer,
  serializeCanvasLayer,
} from '../shared/canvas-layer.js';
import { drawingsForExtractedDocument } from '../shared/canvas-drawings.js';
import { CanvasLayerStore } from './canvas-layer-store.js';
import { createCanvasLayerSync } from './canvas-layer-sync.js';
import type { EdgeStylePatch } from '../shared/canvas-edge-style.js';
import { dressModel } from './model-visuals.js';
import type { Workspace, WorkspaceDelegate } from './workspace.js';
import { createClipboard } from './clipboard.js';
import { createWorkspaceUiState } from './workspace-ui-state.js';
import type { OpenFlow } from './open-flow.js';
import { createContextOrchestration, type ContextOrchestration } from './context/index.js';
import { copyFlowPath, extractedFlowPath, findExistingFile } from './flow-paths.js';
import { renameTargetPath, rewriteFileReferences, validateFlowRename } from './file-rename.js';

// The floating editors the core opens and closes as its commands require.
export type EditorOverlays = Pick<
  Editors,
  | 'openNodeEditor'
  | 'openEdgeEditor'
  | 'openRegionEditor'
  | 'openTitleEditor'
  | 'openRegionNameEditor'
  | 'closeAll'
  | 'reposition'
  | 'refreshFromDoc'
>;

// What the core asks of the page around the canvas. Every member is chrome the core reports
// to rather than reads from, so a headless run can stand in for all of it.
export interface EditorShell {
  editors: EditorOverlays;
  openMenu(items: MenuItem[], at: Point): void;
  // Escape closes the context menu and the help overlay. True when help was showing: an Escape
  // that closes it is spent on that alone.
  closePopups(): boolean;
  // The open flow was rebuilt: the breadcrumb and the graph panel describe it.
  openFlowChanged(flow: OpenFlow): void;
  // Only the dive trail moved; the breadcrumb is the one thing showing it.
  trailChanged(): void;
  fileListChanged(): void;
  workspaceChanged(): void;
  connectionChanged(connected: boolean): void;
  // A flow is on screen under this path (the location hash records it for a reload).
  flowShown(path: string): void;
  workspaceEmpty(): void;
  canvasRendered(): void;
  // Display settings are read from the workspace manifest the core has just adopted.
  applyWorkspaceDisplay(): Promise<void>;
}

export interface EditorCoreOptions {
  canvas: HTMLCanvasElement;
  shell: EditorShell;
}

export type EditorCore = ReturnType<typeof createEditorCore>;

export function createEditorCore({ canvas, shell }: EditorCoreOptions) {
  const { editors } = shell;

  let openFlow: OpenFlow | null = null;
  let workspaceFiles: string[] = [];

  const navigation = { trail: [] as TrailEntry[], inProgress: false };

  // Each .flow's canvas layer — the cosmetic sidecar holding node shapes and edge colours —
  // loaded beside the document it dresses.
  const layers = new CanvasLayerStore({
    readFile: (path) => workspace?.readFile(path) ?? Promise.resolve(null),
    onLoaded: () => refresh(),
  });
  const layerSync = createCanvasLayerSync(() => session, layers);

  // Every document an edit can reach — the open file and any external file unfolded inside a
  // frame, and their canvas layers — is tracked by one session, which owns their committed
  // texts, their debounced writes, and the undo history spanning all of them (edit-session.ts).
  const session = new EditSession({
    writeFile: sendWrite,
    deleteFile: (path) => workspace?.deleteFile(path),
    adoptDocument: (path, doc) => expansions.adoptDocument(path, doc),
    adoptLayer: (flowPath, layer) => layers.adopt(flowPath, layer),
    retargetDocument: (from, to) => {
      expansions.retargetPath(from, to);
      layers.retarget(from, to);
    },
    observer: layerSync.observer,
  });

  let workspace: Workspace | null = null;

  // grafd.manifest.json — the workspace entrypoint plus the camera, open frames and active flow
  // this browser last left behind. Sampled from the live view at save time.
  const uiState = createWorkspaceUiState({
    writeFile: sendWrite,
    activePath: () => openFlow?.path ?? null,
    camera: () => view.view,
    openExpansionIds: () => expansions.openVisibleNodeIds(),
  });

  // Region/context-block orchestration. Declared early so CanvasView callbacks can close over it;
  // assigned after the view exists — those callbacks only run on user gestures.
  let contextOps: ContextOrchestration;

  // What the draw tool and selected strokes write. Like the clipboard below, it reaches
  // everything through callbacks, so it can be built before the view exists.
  const drawingOps = createDrawingOps({
    session: () => session,
    layerSync,
    creationTargetFor: (frameHost) => creationTargetFor(frameHost),
    ensureScope: (target) => {
      if (target.scope == null || FlowDoc.graphBlockNames(target.owner.doc).includes(target.scope)) return;
      applyToDoc(target.owner, () => creationItems(target), { commit: 'now' });
    },
    documentOwnerAt: (path) => {
      const doc = expandTargetDoc(path);
      return doc ? { doc, path } : null;
    },
    rerenderAfterEditTo: (owner) => rerenderAfterEditTo(owner),
    notify: (text) => view.flashNotice(text),
  });

  // Copy/cut/paste/duplicate. Built here rather than beside the canvas because everything it
  // needs — the selection, the owning document of a node, the routed mutation — is reached
  // through callbacks, so nothing it depends on has to exist yet.
  const clipboard = createClipboard({
    openFlow: () => openFlow,
    selection: () => [...view.selection],
    selectedRegions: () => view.selectedRegionTargets(),
    selectedDrawings: () => view.selectedDrawings,
    select: (nodes, regions, drawings) => {
      const contexts = regions
        .map((block) => view.model.contexts.find((context) => context.block === block))
        .filter((context): context is ModelContext => context != null);
      view.setSelection(nodes, contexts, drawings);
    },
    ownerOf,
    ownerOfRegion: (region) => contextOps.ownerOfRegion(region),
    documentAt: (path) => {
      const doc = expansions.documentAt(path);
      return doc ? { doc, path } : null;
    },
    // Every clipboard mutation is a structural edit, so none of them wait on the typing debounce.
    applyToDoc: (owner, mutation) => applyToDoc(owner, mutation, { commit: 'now' }),
    deleteSelection: () => deleteSelection(),
    captureVisuals: (owner, nodes) => layerSync.captureVisuals(owner, nodes),
    applyCapturedVisuals: (owner, copies, visuals) => layerSync.applyCapturedVisuals(owner, copies, visuals),
    copyDrawings: (selections) => drawingOps.copyDrawings(selections),
    pasteDrawings: (target, drawings, offset) => drawingOps.pasteDrawings(target, drawings, offset),
    runAction: (body) => session.runAction(body),
  });

  function modelFor(flow: Omit<OpenFlow, 'model'>): FlowModel {
    const model = FlowDoc.buildModel(flow.doc, flow.scope);
    model.sourcePath = flow.path;
    return dressModel(model, layers.layerFor(flow.path));
  }

  function refresh(): void {
    if (!openFlow) return;
    openFlow.model = modelFor(openFlow);
    expansions.invalidateSubModels();
    view.setModel(openFlow.model);
    shell.openFlowChanged(openFlow);
    editors.refreshFromDoc();
  }

  // A graph's name is required, so a name typed empty is refused rather than written.
  function renameGraph(requestedName: string): void {
    const flow = openFlow;
    const name = collapseToSingleLine(requestedName).trim();
    if (!flow || flow.scope || !name) return;
    mutate(() => setPreambleField(flow.doc, 'name', name));
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
      shell.fileListChanged();
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
      if (isCanvasLayerPath(path)) {
        if (layerSync.adoptWatchedLayer(path, text)) refresh();
        return;
      }
      if (!workspaceFiles.includes(path)) {
        workspaceFiles.push(path);
        workspaceFiles.sort();
        shell.fileListChanged();
      }
      if (path !== openFlow?.path && !expansions.watchesPath(path)) return;
      if (session.committedTextAt(path) === text) return;
      adoptWatchedText(path, text);
    },
    fileDeleted(path) {
      if (isCanvasLayerPath(path) && layerSync.adoptWatchedLayer(path, null)) refresh();
    },
    connectionChanged(connected) {
      shell.connectionChanged(connected);
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
    // Loaded before the document is shown, so the first frame already draws its visuals.
    await layers.ensure(path);
    // Flush before switching so a commit still debouncing against the outgoing file lands in it
    // rather than being evaluated later against whatever is open by then; reset then drops the
    // outgoing documents and their history, which no longer describe anything reachable.
    session.flush();
    session.reset();
    setOpenFlow(path, session.adoptText(path, text), null);
    editors.closeAll();
    view.clearSelection();
    shell.flowShown(path);
    const saved = uiState.savedViewOf(path);
    if (restoreSavedView && saved.openExpansions) expansions.restoreOpen(saved.openExpansions);
    refresh();
    if (restoreSavedView) {
      if (saved.camera) view.setViewNow(saved.camera);
      else view.fitToContent();
    }
    shell.fileListChanged();
    scheduleManifestSave();
    return true;
  }

  function dropFromFileList(path: string): void {
    const index = workspaceFiles.indexOf(path);
    if (index === -1) return;
    workspaceFiles.splice(index, 1);
    shell.fileListChanged();
  }

  function deleteFlowFile(path: string): void {
    workspace?.deleteFile(path);
    // Untrack before anything else: a commit still pending against this path would re-create the
    // file moments after it was deleted.
    session.forget(path);
    layers.forget(path);
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

  // The copy keeps every node id, which are unique per file, so the source's layer applies to it
  // unchanged.
  async function duplicateFlowFile(path: string): Promise<void> {
    const text = session.committedTextAt(path) ?? (await workspace?.readFile(path));
    if (text == null) return;
    const layer = await layers.ensure(path);
    const layerText = layer ? serializeCanvasLayer(layer) : null;
    registerCreatedFlowFile(copyFlowPath(workspaceFiles, path), text, layerText);
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
      shell.flowShown(to);
      refresh();
    } else if (trailRetargeted) {
      // The trail can name the renamed file even when a deeper file is open; retargeting the
      // entry is not enough — the breadcrumb is only re-rendered by refresh.
      shell.trailChanged();
    }
    uiState.renameFlow(from, to);
    shell.fileListChanged();
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

  function commitCreatedNodeMembership(owner: DocumentOwner, node: FlowNode, scope: string | null): void {
    const changes = FlowDoc.membershipChangesForNewNode(FlowDoc.buildModel(owner.doc, scope), node);
    if (changes.length > 0) writeMovesAndMembership([], changes, []);
  }

  function runNodeCreationAction(
    owner: DocumentOwner,
    create: () => FlowNode | null,
    scope: string | null = null,
  ): FlowNode | null {
    let node: FlowNode | null = null;
    session.runAction(() => {
      applyToDoc(owner, () => {
        node = create();
      }, { commit: 'now' });
      if (node) commitCreatedNodeMembership(owner, node, scope);
    });
    return node;
  }

  function createNodeAndEdit(rect: Rect, frameHost: FlowNode | null = null, requestedName = 'Untitled'): FlowNode | null {
    const target = creationTargetFor(frameHost);
    if (!target) return null;
    const items = creationItems(target);
    const node = runNodeCreationAction(target.owner, () => FlowDoc.addNode(items, rect, requestedName), target.scope);
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
    const scope = FlowDoc.scopeNameOfItems(owner.doc, items);
    const framesWhenFolded = FlowDoc.regionFramesOf(FlowDoc.buildModel(owner.doc, scope));
    let host: FlowNode | null = null;
    session.runAction(() => {
      applyToDoc(owner, () => keepingEmptiedRegionsInPlace(owner.doc, () => {
        host = FlowDoc.extractSubgraph(items, nodes, owner.doc).host;
        for (const { identity, name } of retargets) {
          FlowDoc.retargetInnerRefs([{ doc: owner.doc, path: owner.path }], identity, name, host!.name);
        }
      }), { commit: 'now' });
      joinRegionsEnclosingHost(owner, host!, scope, framesWhenFolded);
      for (const { identity, name } of retargets) {
        void retargetInnersAcrossWorkspace(identity, name, host!.name, owner.doc);
      }
    });
    expansions.collapseFrom(host!);
    focusNodeTitleAfterLayout(host!);
  }

  // R9b: a subgraph host joins the regions it landed inside, like any node made there (R9a),
  // measured against the frames the selection was folded in. It only ever joins: a region that
  // held the whole selection keeps the host that stands in for it even where the host overhangs.
  function joinRegionsEnclosingHost(
    owner: DocumentOwner,
    host: FlowNode,
    scope: string | null,
    framesWhenFolded: ReadonlyMap<ContextBlock, Rect>,
  ): void {
    const model = FlowDoc.buildModel(owner.doc, scope);
    const joins = FlowDoc.membershipChangesForMove(model, [host], framesWhenFolded).filter((change) => change.joins);
    if (joins.length > 0) writeMovesAndMembership([], joins, []);
  }

  // A plain node becomes a subgraph host by gaining a local `graph:` block of its own name — the
  // mirrored pairing renames keep in step — and unfolds it straight away, empty, ready for the
  // first inner node. A name already taken by a block adopts that block rather than duplicating
  // it, which is what typing the same name into the node editor's expand field does.
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

  // A layer left at a new file's path belongs to a .flow that was deleted outside the editor; it
  // is replaced (or removed) rather than inherited by an unrelated graph.
  function registerCreatedFlowFile(path: string, text: string, layerText: string | null = null): void {
    sendWrite(path, text);
    const layerPath = canvasLayerPathOf(path);
    if (layerText != null) sendWrite(layerPath, layerText);
    else workspace?.deleteFile(layerPath);
    layers.adopt(path, parseCanvasLayer(layerText));
    if (!workspaceFiles.includes(path)) {
      workspaceFiles.push(path);
      workspaceFiles.sort();
    }
    shell.fileListChanged();
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

    // Captured before the block leaves the parent: the parent's commit drops the visuals of the
    // nodes that moved out, and the new file is written from a re-parse with no link to them.
    const blockNodes = FlowDoc.nodesIn(FlowDoc.scopeItems(owner.doc, blockName));
    const blockVisuals = layerSync.captureVisuals(owner, blockNodes);
    const parentDrawings = layerSync.drawingContentOf(owner) ?? { drawings: [], groups: [] };

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
    // Moved or copied (the block stays when the parent still uses it), each extracted node keeps
    // its name, which is what pairs it with the node it came from.
    const extractedByName = new Map(FlowDoc.nodesIn((extracted as FlowDocument).items).map((node) => [node.name, node]));
    const copies = blockNodes.map((node) => extractedByName.get(node.name) ?? null);
    const carriedBlockNames = new Set(FlowDoc.graphBlockNames(extracted));
    const carried = drawingsForExtractedDocument(parentDrawings, blockName, carriedBlockNames);
    registerCreatedFlowFile(path, text, layerSync.layerTextForNewDocument(extracted, copies, blockVisuals, carried));
    session.adoptText(path, text);
    // Extraction moves the block out of the owning document, so a scope naming it is now stale.
    if (owner.path === openFlow?.path) dropScopeIfMissing();
    refresh();
  }

  // One delete, however many documents own the selection and however many others name what it
  // removed — in `{Inner}` refinements or in a `nodes:` list (R42). The action boundary is the
  // caller's: a mixed selection delete runs this and the region deletion in one step.
  function deleteNodesAction(nodes: FlowNode[]): void {
    session.runAction(() => writeNodesDeletion(nodes));
    // A node inside a frame of another file is not looked for again when its frame redraws, so
    // what was deleted is let go of here rather than left selected.
    for (const node of nodes) view.selection.delete(node);
    view.requestRender();
  }

  function writeNodesDeletion(nodes: FlowNode[]): void {
    for (const { owner, itemGroups } of FlowDoc.groupNodesByOwner(nodes, ownerOf)) {
      // Captured before the delete, while the nodes are still resolvable in their document.
      const clears = expansionIdentitiesOf(owner, itemGroups);
      const expansionPaths = expansionPathsOf(owner, itemGroups);
      applyToDoc(owner, () => keepingEmptiedRegionsInPlace(owner.doc, () => {
        for (const { items, nodes: group } of itemGroups) {
          FlowDoc.deleteNodes(items, group, owner.doc, { path: owner.path });
        }
      }), { commit: 'now' });
      // A deleted host stops reading whatever it read, so the file it expanded must stop
      // inheriting it — recomputed from the hosts that remain, stale `updates:` stripped (R40c).
      contextOps.syncInheritsForExpansionPaths(owner, expansionPaths);
      for (const { identity, name } of clears) {
        void retargetInnersAcrossWorkspace(identity, name, null, owner.doc);
      }
    }
  }

  // An edit that takes every member out of a region with no drawn area leaves that region where
  // it was, drawn, rather than invisible in the file (R18a).
  function keepingEmptiedRegionsInPlace(doc: FlowDocument, edit: () => void): void {
    const framesBefore = FlowDoc.framesOfUndrawnRegions(FlowDoc.buildModel(doc, null));
    edit();
    FlowDoc.keepEmptiedRegionsInPlace(framesBefore, (block) => block.members);
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
    const edges = view.selectedEdges;
    const regions = view.selectedRegionTargets();
    const drawings = view.selectedDrawings;
    const selectedKinds = [nodes.length, edges.length, regions.length, drawings.length].filter((count) => count > 0).length;
    if (selectedKinds > 1) {
      editors.closeAll();
      // One mixed delete is one undo step: the edges, the nodes, the blocks, the strokes, the
      // stripped `updates:` and the `inherits` rewrites all land together. Edges go first, while
      // every node declaring one is still there to write it out of.
      session.runAction(() => {
        if (edges.length > 0) writeEdgeDeletions(edges);
        if (nodes.length > 0) writeNodesDeletion(nodes);
        if (regions.length > 0) contextOps.writeRegionDeletions(regions);
        if (drawings.length > 0) drawingOps.deleteDrawings(drawings);
      });
      view.clearSelection();
    } else if (drawings.length > 0) {
      drawingOps.deleteDrawings(drawings);
      view.clearSelection();
    } else if (nodes.length > 0) {
      editors.closeAll();
      deleteNodesAction(nodes);
    } else if (edges.length > 0) {
      editors.closeAll();
      session.runAction(() => writeEdgeDeletions(edges));
    } else if (regions.length > 0) {
      contextOps.deleteRegions(regions);
    }
  }

  function writeEdgeDeletions(edges: readonly ModelEdge[]): void {
    for (const edge of edges) applyEdit(edge.from, () => FlowDoc.deleteEdge(edge), { commit: 'now' });
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
      shell.trailChanged();
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
    registerCreatedFlowFile(target.path, text);
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
          shell.trailChanged();
          return;
        }
      }
      // Re-read across the await: opening the crumb's file replaces the open flow wholesale.
      const flow = openFlow;
      if (!flow) return;
      if (flow.scope !== entry.scope) setScope(entry.scope, { fit: false });
      shell.trailChanged();
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
    rerenderAfterEditTo(owner);
    session.commitAfter(owner.path, commit);
  }

  // Applies a non-undoable rewrite to one document, mirroring applyToDoc's baseline capture and
  // refresh routing. The baseline is recorded before the mutation so commitWithoutUndo sees the
  // pre-rewrite text and writes the rewrite to disk. Documents the rewrite leaves unchanged are
  // left alone: no baseline, no refresh, no write.
  function applyRippleToDoc(owner: DocumentOwner, mutation: () => boolean): void {
    session.trackWithBaseline(owner.path, owner.doc);
    if (!mutation()) return;
    rerenderAfterEditTo(owner);
    session.commitWithoutUndo(owner.path);
  }

  // The open flow rebuilds its whole model; a frame's document only invalidates the sub-models
  // drawn from it.
  function rerenderAfterEditTo(owner: DocumentOwner): void {
    if (owner.doc === openFlow?.doc) {
      refresh();
    } else {
      expansions.invalidateSubModels();
      view.requestRender();
    }
  }

  // A shape or colour lives in the owning file's canvas layer, so only the layer is written; the
  // .flow is untouched.
  function applyLayerEdit(owner: DocumentOwner, edit: () => boolean): void {
    if (edit()) rerenderAfterEditTo(owner);
  }

  // The layer an edge's look is written to is that of the file declaring it — for an edge inside
  // an unfolded frame, the subgraph's file.
  function applyEdgeStyleEdit(edge: ModelEdge, patch: EdgeStylePatch): void {
    const owner = ownerOf(edge.from);
    applyLayerEdit(owner, () => layerSync.setEdgeStyle(owner, edge, patch));
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

  function findEdgeWhere(matches: (edge: ModelEdge) => boolean): ModelEdge | null {
    return openFlow?.model.edges.find(matches) ?? expansions.findEdgeWhere(matches);
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
    drawingMoves: DrawingMove[] = [],
  ): void {
    session.runAction(() => {
      const movesGraph = nodes.length > 0 || membershipChanges.length > 0 || alsoTouched.length > 0;
      if (movesGraph) writeMovesAndMembership(nodes, membershipChanges, alsoTouched);
      if (drawingMoves.length > 0) drawingOps.moveDrawings(drawingMoves);
    });
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
    const membersByOwner = new Map<DocumentOwner, FlowNode[]>();
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
      membersByOwner.set(owner, [...(membersByOwner.get(owner) ?? []), change.node]);
    }
    // A node that left a region can no longer read it, and neither can the inner nodes that
    // read through it as a local-graph host, so the whole file is stripped (R40c).
    for (const owner of ownersWithLeaves) {
      FlowDoc.removeUnreadableUpdates(owner.doc);
    }
    if (membershipChanges.length > 0) expansions.invalidateSubModels();
    refresh();
    for (const path of paths) session.commit(path);
    for (const [owner, members] of membersByOwner) {
      contextOps.syncInheritsForMembers(owner, members);
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
      }, target.scope);
    } else {
      const owner = ownerOf(host);
      const items = FlowDoc.containingItems(owner.doc, host);
      created = runNodeCreationAction(owner, () => {
        const node = FlowDoc.addNode(items, rect);
        FlowDoc.addEdge(host, node.name, null, null, drop.innerName);
        return node;
      }, FlowDoc.containingGraphBlockName(owner.doc, host));
    }
    if (created) focusNewNode(created);
  }

  function editCreatedEdge(spec: EdgeSpec | null): void {
    const createdEdge = spec ? findEdgeWhere((edge) => edge.spec === spec) : null;
    if (!createdEdge) return;
    view.selectedEdge = createdEdge;
    editors.openEdgeEditor(createdEdge);
  }

  // A second edge identical to an unlabelled one already there would say nothing new, so a drag
  // that would draw one opens the existing edge to be labelled instead.
  function addEdgeToExistingNode(fromNode: FlowNode, targetName: string, innerName: string | null): void {
    const existing = FlowDoc.findUnlabelledEdge(fromNode, targetName, innerName);
    if (existing) {
      editCreatedEdge(existing);
      return;
    }
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
    }, flow.scope);

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
        const existing = FlowDoc.findUnlabelledEdge(drop.host, drop.target.name, null, drop.innerName);
        if (existing) {
          editCreatedEdge(existing);
          return;
        }
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
          if (FlowDoc.findUnlabelledEdge(fromNode, drop.target.name)) return;
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
  // only dereference `view` and the editors when something calls them, which never happens
  // during construction, so the forward references are safe.
  const expansions = new ExpansionLayer({
    onNeedsRender: () => {
      view.requestRender();
      editors.refreshFromDoc();
    },
    readExternalFile: (path) => workspace?.readFile(path) ?? Promise.resolve(null),
    layerFor: (path) => layers.layerFor(path),
    loadCanvasLayer: (path) => layers.ensure(path),
  });

  const view = new CanvasView(canvas, {
    createNode: (rect, frameHost) => {
      if (openFlow) createNodeAndEdit(rect, frameHost);
    },
    quickCreateNode: (point, frameHost) => {
      if (openFlow) createNodeAndEdit(centeredDefaultRect(point), frameHost);
    },
    nodeClicked: (node) => editors.openNodeEditor(node),
    canvasClicked: () => editors.closeAll(),
    moveCommitted: (nodes, membershipChanges, drawingMoves) =>
      commitMovesFor(nodes ?? [], membershipChanges ?? [], [], drawingMoves ?? []),
    regionMoved: (regions, movedNodes, membershipChanges, drawingMoves) =>
      commitMovesFor(movedNodes, membershipChanges, regions.map((region) => contextOps.ownerOfRegion(region)), drawingMoves),
    createStroke: (points, frameHost, style) => {
      if (openFlow) drawingOps.createStroke(points, frameHost, style);
    },
    resizeDrawings: (drawings, transform) => drawingOps.resizeDrawings(drawings, transform),
    regionResized: (region, membershipChanges) =>
      commitMovesFor([], membershipChanges, [contextOps.ownerOfRegion(region)]),
    deleteRegion: (region) => contextOps.deleteRegion(region),
    createRegion: (rect, frameHost, memberNames) => contextOps.createRegionAndName(rect, frameHost, memberNames),
    regionClicked: (region) => editors.openRegionEditor(region),
    completeEdge,
    editEdge: (edge) => editors.openEdgeEditor(edge),
    bendEdge: (edge, bend) => applyEdgeStyleEdit(edge, { bend }),
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
    afterRender: () => shell.canvasRendered(),
  }, expansions);

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
    openConfirmMenu: (items, at) => shell.openMenu(items, at),
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

  function openCanvasContextMenu(target: ContextTarget, screenPoint: Point): void {
    if (!openFlow) return;
    shell.openMenu(menuItemsFor(target, screenPoint), screenPoint);
  }

  function menuItemsFor(target: ContextTarget, screenPoint: Point): MenuItem[] {
    return target.kind === 'node' ? nodeMenuItems(target.node, screenPoint)
      : target.kind === 'edge' ? edgeMenuItems(target.edge)
      : target.kind === 'region' ? contextOps.regionMenuItems(target.region, screenPoint)
      : target.kind === 'drawing' ? drawingMenuItems()
      : canvasMenuItems(target.world);
  }

  function nodeMenuItems(node: FlowNode, screenPoint: Point): MenuItem[] {
    const selectionCount = view.selection.size;
    const regionCount = view.selectedRegions.size;
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
    if (regionCount > 0) {
      items.push({
        label: `Delete ${regionCount} ${regionCount === 1 ? 'region' : 'regions'} (keeps its nodes)`,
        danger: true,
        onSelect: () => {
          const regions = view.selectedRegionTargets();
          contextOps.confirmRegionDeletions(regions, screenPoint, () => contextOps.deleteRegions(regions));
        },
      });
    }
    return items;
  }

  function edgeMenuItems(edge: ModelEdge): MenuItem[] {
    const items: MenuItem[] = [{ label: 'Edit label', onSelect: () => editors.openEdgeEditor(edge) }];
    if (layerSync.edgeStyleOf(ownerOf(edge.from), edge).bend) {
      items.push({ label: 'Straighten', onSelect: () => applyEdgeStyleEdit(edge, { bend: null }) });
    }
    items.push({ separator: true });
    items.push({ label: 'Delete edge', danger: true, onSelect: deleteSelection });
    return items;
  }

  function drawingMenuItems(): MenuItem[] {
    const drawings = view.selectedDrawings;
    const count = drawings.length;
    const items: MenuItem[] = [];
    if (count > 1) {
      items.push({ label: `Group ${count} drawings`, disabled: !drawingOps.canGroup(drawings), onSelect: groupSelectedDrawings });
    }
    if (drawingOps.isAnyGrouped(drawings)) items.push({ label: 'Ungroup', onSelect: ungroupSelectedDrawings });
    items.push({ label: 'Duplicate', onSelect: clipboard.duplicateSelection });
    items.push({ label: 'Copy', onSelect: clipboard.copy });
    items.push({ label: 'Cut', onSelect: clipboard.cut });
    items.push({ separator: true });
    items.push({ label: count > 1 ? `Delete ${count} drawings` : 'Delete drawing', danger: true, onSelect: deleteSelection });
    return items;
  }

  function hasCopyableSelection(): boolean {
    return view.selection.size > 0 || view.selectedRegions.size > 0 || view.selectedDrawings.length > 0;
  }

  function groupSelectedDrawings(): void {
    drawingOps.groupDrawings(view.selectedDrawings);
    view.holdWholeGroups();
  }

  function ungroupSelectedDrawings(): void {
    drawingOps.ungroupDrawings(view.selectedDrawings);
  }

  // Runs a keyboard command (editor-commands.ts). False when it had nothing to act on and left
  // the key to the browser — Ctrl+C with nothing copyable copies page text as usual.
  function runCommand(command: EditorCommand): boolean {
    switch (command) {
      case 'undo':
        undo();
        return true;
      case 'redo':
        redo();
        return true;
      case 'select-all':
        view.selectAll();
        return true;
      case 'copy':
        if (!hasCopyableSelection()) return false;
        clipboard.copy();
        return true;
      case 'cut':
        if (!hasCopyableSelection()) return false;
        clipboard.cut();
        return true;
      case 'paste':
        clipboard.paste();
        return true;
      case 'duplicate':
        clipboard.duplicateSelection();
        return true;
      case 'group':
        if (view.selectedDrawings.length === 0) return false;
        groupSelectedDrawings();
        return true;
      case 'ungroup':
        if (view.selectedDrawings.length === 0) return false;
        ungroupSelectedDrawings();
        return true;
      case 'delete':
        deleteSelection();
        return true;
      case 'fit':
        view.fitToContent();
        return true;
      case 'zoom-in':
        view.stepZoom(1);
        return true;
      case 'zoom-out':
        view.stepZoom(-1);
        return true;
      case 'escape':
        escape();
        return true;
    }
  }

  // Escape abandons a gesture under way first. Otherwise it closes what is floating over the
  // canvas, and then steps back out of a dive or, with none to leave, drops the selection.
  function escape(): void {
    if (view.cancelGesture()) return;
    editors.closeAll();
    if (shell.closePopups()) return;
    const trailLength = navigation.trail.length;
    if (trailLength > 0) void navigateBackTo(trailLength - 1);
    else view.clearSelection();
  }

  function canvasMenuItems(world: Point): MenuItem[] {
    const creation = view.creationTargetAt(world);
    return [
      {
        label: 'Add node here',
        onSelect: () => createNodeAndEdit(centeredDefaultRect(creation.point), creation.frameHost),
      },
      { label: 'Paste', disabled: !clipboard.hasContent(), onSelect: () => clipboard.paste(world) },
      { separator: true },
      { label: 'Fit to content', onSelect: () => view.fitToContent() },
      { label: 'Reset zoom', onSelect: () => view.setZoom(1) },
    ];
  }

  // Returns null once the flow exists and is open, otherwise why it could not be created — the
  // sidebar shows that beneath its name box.
  function createFlowFile(path: string): string | null {
    const existing = findExistingFile(workspaceFiles, path);
    if (existing) return `${existing} already exists — pick another name.`;
    const graphName = path.split('/').pop()!.replace(/\.flow$/, '');
    const text = `---\nname: ${graphName}\n---\n`;
    registerCreatedFlowFile(path, text);
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

  function resetSessionState(): void {
    editors.closeAll();
    view.clearSelection();
    expansions.reset();
    layers.reset();
    navigation.trail.length = 0;
    session.reset();
    workspaceFiles = [];
    openFlow = null;
  }

  // `preferredPath` is the flow to open when the workspace has it — the one a reload was showing —
  // ahead of the manifest's choice.
  async function switchWorkspace(next: Workspace, { preferredPath = null }: { preferredPath?: string | null } = {}): Promise<void> {
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
    await shell.applyWorkspaceDisplay();
    shell.fileListChanged();
    shell.workspaceChanged();

    const startupPath =
      preferredPath && workspaceFiles.includes(preferredPath) ? preferredPath : uiState.startupFlow(workspaceFiles);
    if (startupPath) {
      await openFile(startupPath);
    } else {
      showEmptyWorkspace();
    }
  }

  function showEmptyWorkspace(): void {
    shell.workspaceEmpty();
    view.setModel(FlowDoc.buildModel(parseFlow('---\nname: empty\n---\n'), null));
  }

  return {
    view,
    session,
    expansions,
    layerSync,
    uiState,
    clipboard,
    drawingOps,
    contextOps,
    openFlow: () => openFlow,
    workspace: () => workspace,
    workspaceFiles: () => workspaceFiles,
    trail: (): readonly TrailEntry[] => navigation.trail,
    switchWorkspace,
    openFlowFromSidebar,
    createFlowFile,
    deleteFlowFile,
    duplicateFlowFile,
    renameFlowFile,
    mutate,
    renameGraph,
    undo,
    redo,
    ownerOf,
    applyToDoc,
    applyEdit,
    applyLayerEdit,
    applyEdgeStyleEdit,
    findNode,
    findEdgeWhere,
    renameNodeAction,
    applyExpandEditAction,
    rippleInnerRefsAcrossWorkspace,
    descriptionOf,
    applyDescriptionEdit,
    referencesOf,
    applyReferencesEdit,
    ensureExpandTarget,
    ensureInnerDocument,
    innerOptions,
    deleteNodesAction,
    deleteSelection,
    openExpand,
    navigateBackTo,
    toggleInlineExpansion,
    menuItemsFor,
    hasCopyableSelection,
    groupSelectedDrawings,
    ungroupSelectedDrawings,
    runCommand,
  };
}
