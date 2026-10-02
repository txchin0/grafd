// Which strokes are selected, and what that selection writes. A stroke has two identities:
//
// - Where it is drawn: the model it was painted in plus its id. A local `graph:` block expanded
//   by two hosts shows the same stroke in both frames, and each copy is selected, outlined and
//   dragged where it appears.
// - Where it is stored: its file plus its id. Every write goes through this one, so a stroke
//   picked up in two frames at once is moved, recoloured or deleted once.

import type { FlowModel } from '../flow-doc.js';
import type { Point } from '../geometry.js';

export interface DrawingSelection {
  model: FlowModel;
  id: string;
}

// A stroke by where it is stored and filed, for selecting one no model has laid out yet — a copy
// just pasted.
export interface StoredDrawing {
  path: string;
  scope: string | null;
  id: string;
}

export interface DrawingMove extends DrawingSelection {
  offset: Point;
}

// The drawings of one file that a write touches.
export interface DrawingWrite {
  model: FlowModel;
  ids: Set<string>;
}

// Keys a stroke by where it is stored, which every on-screen copy of it shares.
export function storedDrawingKey(model: FlowModel, id: string): string {
  return `${model.sourcePath ?? ''}\n${id}`;
}

export function sameDrawingSelection(a: DrawingSelection, b: DrawingSelection): boolean {
  return a.model === b.model && a.id === b.id;
}

export function drawingWritesOf(selections: readonly DrawingSelection[]): DrawingWrite[] {
  const writesByPath = new Map<string | null, DrawingWrite>();
  for (const selection of selections) {
    const path = selection.model.sourcePath;
    const write = writesByPath.get(path) ?? { model: selection.model, ids: new Set<string>() };
    write.ids.add(selection.id);
    writesByPath.set(path, write);
  }
  return [...writesByPath.values()];
}

// One move per stored stroke: the first copy listed decides the offset.
export function distinctDrawingMoves(moves: readonly DrawingMove[]): DrawingMove[] {
  const seen = new Set<string>();
  return moves.filter((move) => {
    const key = storedDrawingKey(move.model, move.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
