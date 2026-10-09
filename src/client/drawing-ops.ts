// What the canvas's drawing gestures write. A stroke or a text is stored in the canvas layer of
// the file that owns the graph it was made in, filed under that graph's scope — one made inside an
// unfolded frame belongs to the subgraph the frame shows, whichever file that lives in.
//
// Every operation is one undoable action, or joins the action already open: a stroke dragged or
// deleted together with nodes lands in the same undo step, and strokes selected in several files
// at once are still edited in one.

import { canvasLayerPathOf, type CanvasLayer } from '../shared/canvas-layer.js';
import {
  STROKE_KIND,
  addStroke,
  addTextDrawing,
  drawingsToCopy,
  pasteDrawings as pasteDrawingsInto,
  removeDrawings,
  setDrawingColor,
  setTextDrawing,
  transformDrawings,
  type CarriedDrawings,
  type Stroke,
} from '../shared/canvas-drawings.js';
import { isStretch, translationBy, type DrawingTransform } from '../shared/drawing-geometry.js';
import { TEXT_KIND, textDrawingOf, type TextDrawing } from '../shared/canvas-text.js';
import { groupDrawings as groupDrawingsIn, ungroupDrawings as ungroupDrawingsIn } from '../shared/canvas-groups.js';
import { newUuid, type FlowNode } from '../shared/flow-format.js';
import type { DrawStyle } from './canvas/canvas-view.js';
import {
  distinctDrawingMoves,
  drawingWritesOf,
  type DrawingMove,
  type DrawingSelection,
  type StoredDrawing,
} from './canvas/drawing-selection.js';
import type { DocumentOwner } from './canvas/expansion.js';
import type { CanvasLayerSync } from './canvas-layer-sync.js';
import type { EditSession } from './edit-session.js';
import type { FlowModel } from './flow-doc.js';
import type { Point } from './geometry.js';
import { relaidOutText, textBoxFor, type LineMeasurer } from './canvas/text-drawing-layout.js';

export interface CreationTarget {
  owner: DocumentOwner;
  scope: string | null;
}

// A text about to be written, its point and size in the coordinate space of the graph under
// `frameHost`.
export interface NewText {
  text: string;
  topLeft: Point;
  frameHost: FlowNode | null;
  color: string | null;
  fontPx: number;
}

// Strokes copied out of one graph, ready to be pasted into any.
export interface CopiedDrawings {
  owner: DocumentOwner;
  scope: string | null;
  carried: CarriedDrawings;
}

type LayerEdit = (layer: CanvasLayer) => void;

export interface DrawingOpsOptions {
  session(): EditSession;
  layerSync: CanvasLayerSync;
  // The graph something drawn under `frameHost` belongs to; null when the frame on screen no
  // longer describes anything writable.
  creationTargetFor(frameHost: FlowNode | null): CreationTarget | null;
  // Writes the target's `graph:` block into its document when an `expand` names a block that
  // does not exist yet, so a stroke drawn there is never filed under a scope nothing owns.
  ensureScope(target: CreationTarget): void;
  documentOwnerAt(path: string): DocumentOwner | null;
  rerenderAfterEditTo(owner: DocumentOwner): void;
  notify(text: string): void;
  // Text is measured where it is painted, so the box written is the box the painter fills.
  measureLine(): LineMeasurer;
}

export interface DrawingOps {
  createStroke(points: Point[], frameHost: FlowNode | null, style: DrawStyle): void;
  // Where the new text is stored, or null when nothing could be written.
  createText(newText: NewText): StoredDrawing | null;
  // Rewrites a text in place: its top-left corner, size and wrap width stay, and its box fits the
  // new words.
  setText(selection: DrawingSelection, text: string): void;
  moveDrawings(moves: readonly DrawingMove[]): void;
  // Every stroke stretched by the same transform: a lone stroke, or a group as one.
  resizeDrawings(selections: readonly DrawingSelection[], transform: DrawingTransform): void;
  deleteDrawings(selections: readonly DrawingSelection[]): void;
  recolorDrawings(selections: readonly DrawingSelection[], color: string | null): void;
  // Whether the strokes can form one group: at least two, all drawn in the same graph.
  canGroup(selections: readonly DrawingSelection[]): boolean;
  groupDrawings(selections: readonly DrawingSelection[]): void;
  isAnyGrouped(selections: readonly DrawingSelection[]): boolean;
  ungroupDrawings(selections: readonly DrawingSelection[]): void;
  // One entry per graph the selected strokes are drawn in, with the groups among them.
  copyDrawings(selections: readonly DrawingSelection[]): CopiedDrawings[];
  // Copies into the target graph, shifted by `offset`; returns where the copies are stored.
  pasteDrawings(target: CreationTarget, carried: CarriedDrawings, offset: Point): StoredDrawing[];
}

export function createDrawingOps(options: DrawingOpsOptions): DrawingOps {
  const { layerSync } = options;

  function inOneAction(body: () => void): void {
    options.session().runAction(body);
  }

  function createStroke(points: Point[], frameHost: FlowNode | null, style: DrawStyle): void {
    const target = options.creationTargetFor(frameHost);
    if (points.length === 0 || !target) return;
    const stroke: Stroke = { kind: STROKE_KIND, id: newUuid(), graph: target.scope, color: style.color, width: style.width, points };
    reportWrite(target.owner, writeIntoScope(target, (layer) => addStroke(layer, stroke)));
  }

  function createText({ text, topLeft, frameHost, color, fontPx }: NewText): StoredDrawing | null {
    const target = options.creationTargetFor(frameHost);
    if (!target) return null;
    const box = textBoxFor(text, topLeft, fontPx, options.measureLine());
    const drawing: TextDrawing = { kind: TEXT_KIND, id: newUuid(), graph: target.scope, color, text, box, size: fontPx, wrap: false };
    const written = writeIntoScope(target, (layer) => addTextDrawing(layer, drawing));
    reportWrite(target.owner, written);
    return written ? { path: target.owner.path, scope: target.scope, id: drawing.id } : null;
  }

  function setText(selection: DrawingSelection, text: string): void {
    const current = selection.model.visuals?.drawings().find((drawing) => drawing.id === selection.id);
    if (current?.kind !== TEXT_KIND) return;
    const rewritten = relaidOutText({ ...current, text }, options.measureLine());
    writeEachFile([selection], (layer) => setTextDrawing(layer, rewritten));
  }

  // A stretch that gave text a width to wrap to leaves its height to the wrapped lines, which
  // only a measurement can count. Text scaled evenly keeps the lines it had.
  function relayOutStretchedTexts(layer: CanvasLayer, ids: ReadonlySet<string>, measure: LineMeasurer): void {
    for (const drawing of layer.drawings) {
      const text = typeof drawing.id === 'string' && ids.has(drawing.id) ? textDrawingOf(drawing) : null;
      if (text) setTextDrawing(layer, relaidOutText(text, measure));
    }
  }

  // Checked before the block is created, so drawings that cannot be stored leave no trace.
  function writeIntoScope(target: CreationTarget, edit: LayerEdit): boolean {
    return options.session().runAction(() => {
      if (!layerSync.drawingsAreEditable(target.owner)) return false;
      options.ensureScope(target);
      return layerSync.editDrawings(target.owner, edit);
    });
  }

  function moveDrawings(moves: readonly DrawingMove[]): void {
    const transformsByPath = new Map<string, { model: FlowModel; transforms: Map<string, DrawingTransform> }>();
    for (const move of distinctDrawingMoves(moves)) {
      const path = move.model.sourcePath;
      if (path == null) continue;
      const entry = transformsByPath.get(path) ?? { model: move.model, transforms: new Map<string, DrawingTransform>() };
      entry.transforms.set(move.id, translationBy(move.offset));
      transformsByPath.set(path, entry);
    }
    inOneAction(() => {
      for (const { model, transforms } of transformsByPath.values()) {
        writeToOwnerOf(model, (layer) => transformDrawings(layer, transforms));
      }
    });
  }

  function resizeDrawings(selections: readonly DrawingSelection[], transform: DrawingTransform): void {
    const measure = options.measureLine();
    writeEachFile(selections, (layer, ids) => {
      transformDrawings(layer, new Map([...ids].map((id) => [id, transform])));
      if (isStretch(transform)) relayOutStretchedTexts(layer, ids, measure);
    });
  }

  function deleteDrawings(selections: readonly DrawingSelection[]): void {
    writeEachFile(selections, (layer, ids) => removeDrawings(layer, ids));
  }

  function recolorDrawings(selections: readonly DrawingSelection[], color: string | null): void {
    writeEachFile(selections, (layer, ids) => setDrawingColor(layer, ids, color));
  }

  // A group holds strokes of one graph only: strokes of different scopes live in different
  // coordinates, and moving them together would mean something different in each.
  function canGroup(selections: readonly DrawingSelection[]): boolean {
    const writes = drawingWritesOf(selections);
    const scopes = new Set(selections.map((selection) => selection.model.sourceScope));
    return writes.length === 1 && writes[0].ids.size >= 2 && scopes.size === 1;
  }

  function groupDrawings(selections: readonly DrawingSelection[]): void {
    if (!canGroup(selections)) return;
    const [{ model, ids }] = drawingWritesOf(selections);
    inOneAction(() => writeToOwnerOf(model, (layer) => groupDrawingsIn(layer, ids)));
  }

  function isAnyGrouped(selections: readonly DrawingSelection[]): boolean {
    return selections.some((selection) => (selection.model.visuals?.drawingGroupOf(selection.id).length ?? 1) > 1);
  }

  function ungroupDrawings(selections: readonly DrawingSelection[]): void {
    writeEachFile(selections, (layer, ids) => ungroupDrawingsIn(layer, ids));
  }

  // Strokes are copied from the file they are stored in, so a stroke shown in two frames is
  // copied once — per graph, since the model each was selected in names the graph it is filed
  // under and so the coordinates its points are in.
  function copyDrawings(selections: readonly DrawingSelection[]): CopiedDrawings[] {
    return selectionsByScope(selections).flatMap((sameScope) => drawingWritesOf(sameScope)).flatMap(({ model, ids }) => {
      const owner = liveOwnerOf(model);
      const content = owner ? layerSync.drawingContentOf(owner) : null;
      return owner && content ? [{ owner, scope: model.sourceScope, carried: drawingsToCopy(content, ids) }] : [];
    });
  }

  function selectionsByScope(selections: readonly DrawingSelection[]): DrawingSelection[][] {
    const byScope = new Map<string | null, DrawingSelection[]>();
    for (const selection of selections) {
      const scope = selection.model.sourceScope;
      byScope.set(scope, [...(byScope.get(scope) ?? []), selection]);
    }
    return [...byScope.values()];
  }

  function pasteDrawings(target: CreationTarget, carried: CarriedDrawings, offset: Point): StoredDrawing[] {
    if (carried.drawings.length === 0) return [];
    let pastedIds: string[] = [];
    const written = writeIntoScope(target, (layer) => {
      pastedIds = pasteDrawingsInto(layer, carried, target.scope, offset);
    });
    reportWrite(target.owner, written);
    return written ? pastedIds.map((id) => ({ path: target.owner.path, scope: target.scope, id })) : [];
  }

  function writeEachFile(
    selections: readonly DrawingSelection[],
    edit: (layer: CanvasLayer, ids: ReadonlySet<string>) => void,
  ): void {
    inOneAction(() => {
      for (const { model, ids } of drawingWritesOf(selections)) writeToOwnerOf(model, (layer) => edit(layer, ids));
    });
  }

  // The live document at the model's path rather than the model's own document, which a
  // re-parse may already have replaced.
  function liveOwnerOf(model: FlowModel): DocumentOwner | null {
    return model.sourcePath != null ? options.documentOwnerAt(model.sourcePath) : null;
  }

  function writeToOwnerOf(model: FlowModel, edit: LayerEdit): void {
    const owner = liveOwnerOf(model);
    if (owner) reportWrite(owner, layerSync.editDrawings(owner, edit));
  }

  // The layer refuses drawing edits while it cannot be read, or holds a drawing list it cannot
  // write, and the user just watched the stroke appear or move — so the refusal is said out loud
  // rather than undone in silence.
  function reportWrite(owner: DocumentOwner, written: boolean): void {
    if (!written) {
      const layerName = canvasLayerPathOf(owner.path).split('/').pop();
      options.notify(`Drawing not saved: ${layerName} cannot be edited until it is fixed`);
    }
    options.rerenderAfterEditTo(owner);
  }

  return {
    createStroke,
    createText,
    setText,
    moveDrawings,
    resizeDrawings,
    deleteDrawings,
    recolorDrawings,
    canGroup,
    groupDrawings,
    isAnyGrouped,
    ungroupDrawings,
    copyDrawings,
    pasteDrawings,
  };
}
