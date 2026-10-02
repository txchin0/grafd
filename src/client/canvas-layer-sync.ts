// Keeps each canvas layer in step with the .flow it decorates. Layer entries are keyed by node
// ids and edge keys, and edits to the graph change those keys — a relabel, a retarget, an inner
// rename ripple, an extraction that lifts edges onto a host. Rather than every mutation site
// re-keying the layer itself, each flow commit compares the document's identities with those it
// had at its previous commit and moves (or drops) the entries that changed. Mutations edit node
// and edge objects in place, so object identity is what links an entry to its new key.
//
// Copies are new objects with fresh ids, so nothing links them to their sources: the copy
// sites capture their sources' visuals and put them on the copies explicitly.
//
// Drawings are filed by graph scope rather than by node, so they follow the same commits: a
// `graph:` block renamed or removed takes its drawings with it.

import {
  applyCapturedVisuals,
  canvasLayerIsUnreadable,
  canvasLayerPathOf,
  capturedVisualsAreEmpty,
  captureVisuals,
  documentIdentities,
  drawingListsAreEditable,
  edgeColorOf,
  emptyCanvasLayer,
  flowPathOfCanvasLayer,
  followIdentityChanges,
  nodeShapeOf,
  parseCanvasLayer,
  serializeCanvasLayer,
  setEdgeColor,
  setNodeShape,
  type CanvasLayer,
  type CapturedVisuals,
  type DocumentIdentities,
  type NodeShape,
} from '../shared/canvas-layer.js';
import type { CarriedDrawings } from '../shared/canvas-drawings.js';
import type { FlowDocument, FlowNode } from '../shared/flow-format.js';
import type { DocumentOwner } from './canvas/expansion.js';
import type { CanvasLayerStore } from './canvas-layer-store.js';
import type { EditSession, FlowCommitObserver } from './edit-session.js';
import type { ModelEdge } from './flow-doc.js';
import { edgeLayerKey } from './model-visuals.js';

export interface CanvasLayerSync {
  // Handed to the edit session as its FlowCommitObserver.
  readonly observer: FlowCommitObserver;
  shapeOf(owner: DocumentOwner, node: FlowNode): NodeShape;
  edgeColorOf(owner: DocumentOwner, edge: ModelEdge): string | null;
  // Standalone visual edits, each one undoable action that writes only the layer. False when
  // there was no layer to edit (still loading, or unreadable) or nothing to key the edit by.
  setShape(owner: DocumentOwner, node: FlowNode, shape: NodeShape): boolean;
  setEdgeColor(owner: DocumentOwner, edge: ModelEdge, color: string | null): boolean;
  // Drawing edits, each its own undoable action — or part of the one already open, so a stroke
  // moved or deleted with nodes lands in the same undo step. False when there was no layer.
  // A drawing edit, its own undoable action or part of the one already open, so a stroke moved
  // or deleted with nodes lands in the same undo step. False, with nothing written, when there
  // was no layer or it cannot take drawing edits (see drawingListsAreEditable).
  editDrawings(owner: DocumentOwner, edit: (layer: CanvasLayer) => void): boolean;
  drawingsAreEditable(owner: DocumentOwner): boolean;
  // The drawings and groups an extraction copies from, or null when the layer is not readable.
  drawingContentOf(owner: DocumentOwner): CarriedDrawings | null;
  // A layer file changed on disk. Returns whether a loaded layer was replaced, so the canvas
  // needs redrawing.
  adoptWatchedLayer(layerPath: string, text: string | null): boolean;
  // Positional visuals of nodes about to be copied; null when there is nothing to carry.
  captureVisuals(owner: DocumentOwner, sources: FlowNode[]): CapturedVisuals | null;
  // Called inside the mutation that made `copies`, so the flow commit that follows carries the
  // layer write in the same undo step.
  applyCapturedVisuals(owner: DocumentOwner, copies: FlowNode[], captured: CapturedVisuals | null): void;
  // The layer text for a document this editor is about to create from copies of `sources`
  // (paired by position, null where a source has no copy) and the drawings it takes along, or
  // null when it has no visuals.
  layerTextForNewDocument(
    doc: FlowDocument,
    copies: (FlowNode | null)[],
    captured: CapturedVisuals | null,
    carried: CarriedDrawings,
  ): string | null;
}

export function createCanvasLayerSync(session: () => EditSession, layers: CanvasLayerStore): CanvasLayerSync {
  // The identities each document held at its last commit (or when it began being tracked).
  // Keyed by the document object: a re-parse is a new object with a fresh baseline.
  const baselines = new WeakMap<FlowDocument, DocumentIdentities>();

  const observer: FlowCommitObserver = {
    tracked(_path, doc) {
      if (!baselines.has(doc)) baselines.set(doc, documentIdentities(doc));
    },
    committing(path, doc, undoable) {
      const before = baselines.get(doc);
      const after = documentIdentities(doc);
      baselines.set(doc, after);
      const layer = layers.layerFor(path);
      if (!before || !layer) return;
      session().trackLayerWithBaseline(path, layer);
      followIdentityChanges(layer, before, after);
      // Committed whether or not this commit re-keyed anything: copies made inside the same
      // mutation put their visuals on the layer already, and this is the write that carries them.
      const layerPath = canvasLayerPathOf(path);
      if (undoable) session().commit(layerPath);
      else session().commitWithoutUndo(layerPath);
    },
  };

  function editLayer(flowPath: string, mutation: (layer: CanvasLayer) => void): boolean {
    const layer = layers.layerFor(flowPath);
    if (!layer) return false;
    session().runAction(() => {
      session().trackLayerWithBaseline(flowPath, layer);
      mutation(layer);
      session().commit(canvasLayerPathOf(flowPath));
    });
    return true;
  }

  function setShape(owner: DocumentOwner, node: FlowNode, shape: NodeShape): boolean {
    const nodeId = node.id;
    return nodeId != null && editLayer(owner.path, (layer) => setNodeShape(layer, nodeId, shape));
  }

  function setEdgeColorOf(owner: DocumentOwner, edge: ModelEdge, color: string | null): boolean {
    const key = edgeLayerKey(owner.doc, edge);
    return key != null && editLayer(owner.path, (layer) => setEdgeColor(layer, key, color));
  }

  function drawingsAreEditable(owner: DocumentOwner): boolean {
    const layer = layers.layerFor(owner.path);
    return layer != null && drawingListsAreEditable(layer);
  }

  function editDrawings(owner: DocumentOwner, edit: (layer: CanvasLayer) => void): boolean {
    return drawingsAreEditable(owner) && editLayer(owner.path, edit);
  }

  // A layer only matters once its .flow has been loaded; until then the next load reads the
  // file fresh. Like a document push, a tracked layer goes through the session, which cancels
  // any layer commit still pending against it. Text that is not a layer is never adopted as an
  // empty one: the session stops tracking it, so no edit overwrites the file before it is fixed.
  function adoptWatchedLayer(layerPath: string, text: string | null): boolean {
    const flowPath = flowPathOfCanvasLayer(layerPath);
    if (!layers.isLoaded(flowPath)) return false;
    if (canvasLayerIsUnreadable(text)) {
      session().forget(layerPath);
      layers.adoptUnreadable(flowPath);
    } else if (session().isTracking(layerPath)) {
      if (session().committedTextAt(layerPath) === text) return false;
      session().adoptLayerText(flowPath, text);
    } else {
      layers.adopt(flowPath, parseCanvasLayer(text));
    }
    return true;
  }

  function captureVisualsOf(owner: DocumentOwner, sources: FlowNode[]): CapturedVisuals | null {
    const layer = layers.layerFor(owner.path);
    if (!layer) return null;
    const captured = captureVisuals(layer, documentIdentities(owner.doc), sources);
    return capturedVisualsAreEmpty(captured) ? null : captured;
  }

  function applyCapturedVisualsTo(owner: DocumentOwner, copies: FlowNode[], captured: CapturedVisuals | null): void {
    if (!captured) return;
    const layer = layers.layerFor(owner.path);
    if (!layer) return;
    session().trackLayerWithBaseline(owner.path, layer);
    applyCapturedVisuals(layer, documentIdentities(owner.doc), copies, captured);
  }

  function layerTextForNewDocument(
    doc: FlowDocument,
    copies: (FlowNode | null)[],
    captured: CapturedVisuals | null,
    carried: CarriedDrawings,
  ): string | null {
    const layer = emptyCanvasLayer();
    layer.drawings = carried.drawings;
    layer.groups = carried.groups;
    if (captured) {
      const pairedCopies = copies.filter((copy): copy is FlowNode => copy != null);
      const pairedCaptured = captured.filter((_, index) => copies[index] != null);
      applyCapturedVisuals(layer, documentIdentities(doc), pairedCopies, pairedCaptured);
    }
    return serializeCanvasLayer(layer);
  }

  return {
    observer,
    shapeOf: (owner, node) => nodeShapeOf(layers.layerFor(owner.path), node.id),
    edgeColorOf: (owner, edge) => edgeColorOf(layers.layerFor(owner.path), edgeLayerKey(owner.doc, edge)),
    setShape,
    setEdgeColor: setEdgeColorOf,
    editDrawings,
    drawingsAreEditable,
    drawingContentOf: (owner) => {
      const layer = layers.layerFor(owner.path);
      return layer ? { drawings: layer.drawings, groups: layer.groups } : null;
    },
    adoptWatchedLayer,
    captureVisuals: captureVisualsOf,
    applyCapturedVisuals: applyCapturedVisualsTo,
    layerTextForNewDocument,
  };
}
