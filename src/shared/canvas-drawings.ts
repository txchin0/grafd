// Free drawings on a graph's canvas layer. Each drawing is filed under the graph scope it was
// drawn in — `graph` names the `graph:` block, and is absent for the file body — and its geometry
// is in that scope's own `pos` coordinates, so it is drawn wherever the scope is: dived into, or
// unfolded inside a frame. `followIdentityChanges` (canvas-layer.ts) keeps `graph` in step with
// block renames and removals.
//
// This editor draws two kinds: a freehand stroke (its geometry is `points`) and free text (its
// geometry is a `box`, canvas-text.ts). Drawings of other kinds, and fields this editor does not
// know, are kept verbatim and simply not drawn.

import { isLayerColor, type CanvasLayer, type Drawing } from './canvas-layer.js';
import { groupsForCopies, pruneGroups, type Group } from './canvas-groups.js';
import {
  isTextSize,
  storedTextLayout,
  textBoxOf,
  textDrawingOf,
  textDrawingRecord,
  type TextDrawing,
} from './canvas-text.js';
import {
  applyDrawingTransform,
  isFiniteNumber,
  isStretch,
  roundCoordinate,
  transformedRect,
  translationBy,
  type DrawingPoint,
  type DrawingTransform,
} from './drawing-geometry.js';
import { newUuid, type Rect } from './flow-format.js';

export const STROKE_KIND = 'stroke';
export const STROKE_WIDTHS = ['thin', 'medium', 'thick'] as const;
export type StrokeWidth = (typeof STROKE_WIDTHS)[number];
export const DEFAULT_STROKE_WIDTH: StrokeWidth = 'medium';

// In the scope's own units, so a stroke inside a scaled-down frame thins with everything else.
export const STROKE_LINE_WIDTHS: Record<StrokeWidth, number> = { thin: 1.5, medium: 3, thick: 6 };

export interface Stroke {
  kind: typeof STROKE_KIND;
  id: string;
  graph: string | null;
  // A colour slot or `#rrggbb`; null draws in the theme's ink.
  color: string | null;
  width: StrokeWidth;
  points: DrawingPoint[];
}

// Every drawing this editor can draw, read from the layer.
export type CanvasDrawing = Stroke | TextDrawing;

export function isStrokeWidth(value: unknown): value is StrokeWidth {
  return (STROKE_WIDTHS as readonly unknown[]).includes(value);
}

export function drawingOf(drawing: Drawing): CanvasDrawing | null {
  return strokeOf(drawing) ?? textDrawingOf(drawing);
}

// Null for anything that is not a drawable stroke. A bad colour or width only costs the stroke
// its styling, as a bad shape costs a node its; bad points or a bad `graph` leave nothing to draw.
export function strokeOf(drawing: Drawing): Stroke | null {
  if (drawing.kind !== STROKE_KIND || typeof drawing.id !== 'string' || drawing.id === '') return null;
  if (drawing.graph !== undefined && typeof drawing.graph !== 'string') return null;
  const points = strokePointsOf(drawing.points);
  if (!points) return null;
  return {
    kind: STROKE_KIND,
    id: drawing.id,
    graph: drawing.graph ?? null,
    color: isLayerColor(drawing.color) ? drawing.color : null,
    width: isStrokeWidth(drawing.width) ? drawing.width : DEFAULT_STROKE_WIDTH,
    points,
  };
}

export function strokePointsOf(raw: unknown): DrawingPoint[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const points: DrawingPoint[] = [];
  for (const pair of raw) {
    if (!isCoordinatePair(pair)) return null;
    points.push({ x: pair[0], y: pair[1] });
  }
  return points;
}

function isCoordinatePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
}

export function drawingsInScope(layer: CanvasLayer | null, scope: string | null): CanvasDrawing[] {
  if (!layer) return [];
  return layer.drawings
    .map(drawingOf)
    .filter((drawing): drawing is CanvasDrawing => drawing != null && drawing.graph === scope);
}

// The default width is never written, as the default node shape is not.
export function strokeDrawing(stroke: Stroke): Drawing {
  const drawing: Drawing = { id: stroke.id, kind: STROKE_KIND };
  if (stroke.graph != null) drawing.graph = stroke.graph;
  if (stroke.color != null) drawing.color = stroke.color;
  if (stroke.width !== DEFAULT_STROKE_WIDTH) drawing.width = stroke.width;
  drawing.points = stroke.points.map(storedCoordinatePair);
  return drawing;
}

function storedCoordinatePair(point: DrawingPoint): [number, number] {
  return [roundCoordinate(point.x), roundCoordinate(point.y)];
}

// Where a drawing's ink reaches: what selection outlines, marquees and frames measure.
export function drawingBounds(drawing: CanvasDrawing): Rect {
  return drawing.kind === STROKE_KIND ? strokeBounds(drawing) : drawing.box;
}

// The box a resize stretches: a stroke's points (its line width is style and stays), a text's box.
export function drawingGeometryBox(drawing: CanvasDrawing): Rect {
  return drawing.kind === STROKE_KIND ? strokePointBounds(drawing) : drawing.box;
}

export function transformedDrawing<Shown extends CanvasDrawing>(drawing: Shown, transform: DrawingTransform): Shown {
  if (drawing.kind === STROKE_KIND) {
    return { ...drawing, points: drawing.points.map((point) => applyDrawingTransform(point, transform)) };
  }
  return { ...drawing, ...transformedTextLayout(drawing, transform) };
}

// A text scaled evenly scales its size with its box. Stretched sideways, it keeps its size and
// takes the stretched width as the width it wraps to — its height then follows from the wrapped
// lines, which only a measurement can say, so the editor lays it out again afterwards.
function transformedTextLayout(text: Pick<TextDrawing, 'box' | 'size' | 'wrap'>, transform: DrawingTransform): Pick<TextDrawing, 'box' | 'size' | 'wrap'> {
  return {
    box: transformedRect(text.box, transform),
    size: text.size * transform.scaleY,
    wrap: text.wrap || isStretch(transform),
  };
}

// Where the ink reaches: the points' bounds grown by half the line on every side.
export function strokeBounds(stroke: Stroke): Rect {
  const points = strokePointBounds(stroke);
  const halfLine = STROKE_LINE_WIDTHS[stroke.width] / 2;
  return { x: points.x - halfLine, y: points.y - halfLine, w: points.w + 2 * halfLine, h: points.h + 2 * halfLine };
}

// The box the points themselves span. Folded rather than spread into Math.min, which runs out of
// stack on a long enough hand-written stroke.
export function strokePointBounds(stroke: Pick<Stroke, 'points'>): Rect {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { x, y } of stroke.points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// The points a stored drawing's geometry passes through, whatever its kind — what a paste
// anchors on. Empty for a drawing with no geometry this editor reads.
export function drawingAnchorPoints(drawing: Drawing): DrawingPoint[] {
  const points = strokePointsOf(drawing.points);
  if (points) return points;
  const box = textBoxOf(drawing.box);
  return box ? [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y + box.h }] : [];
}

export function addStroke(layer: CanvasLayer, stroke: Stroke): void {
  layer.drawings = [...layer.drawings, strokeDrawing(stroke)];
}

export function addTextDrawing(layer: CanvasLayer, text: TextDrawing): void {
  layer.drawings = [...layer.drawings, textDrawingRecord(text)];
}

export function removeDrawings(layer: CanvasLayer, ids: ReadonlySet<string>): void {
  layer.drawings = layer.drawings.filter((drawing) => !hasIdIn(drawing, ids));
  pruneGroups(layer);
}

export function transformDrawings(layer: CanvasLayer, transforms: ReadonlyMap<string, DrawingTransform>): void {
  layer.drawings = layer.drawings.map((drawing) => {
    const transform = typeof drawing.id === 'string' ? transforms.get(drawing.id) : undefined;
    return transform ? withTransformedGeometry(drawing, transform) : drawing;
  });
}

// The stored drawing with whichever geometry it has carried by the transform. A drawing whose
// geometry this editor cannot read is left exactly as it is.
function withTransformedGeometry(drawing: Drawing, transform: DrawingTransform): Drawing {
  const points = strokePointsOf(drawing.points);
  if (points) return { ...drawing, points: points.map((point) => storedCoordinatePair(applyDrawingTransform(point, transform))) };
  const text = textDrawingOf(drawing);
  if (text) return { ...drawing, ...storedTextLayout(transformedTextLayout(text, transform)) };
  return drawing;
}

export function setDrawingColor(layer: CanvasLayer, ids: ReadonlySet<string>, color: string | null): void {
  layer.drawings = layer.drawings.map((drawing) => {
    if (!hasIdIn(drawing, ids)) return drawing;
    const recolored = { ...drawing };
    if (color == null) delete recolored.color;
    else recolored.color = color;
    return recolored;
  });
}

// Rewrites a text's words and layout in place, keeping every other field it was read with.
export function setTextDrawing(layer: CanvasLayer, text: Pick<TextDrawing, 'id' | 'text' | 'box' | 'size' | 'wrap'>): void {
  layer.drawings = layer.drawings.map((drawing) => {
    if (drawing.id !== text.id) return drawing;
    const rewritten: Drawing = { ...drawing, text: text.text, ...storedTextLayout(text) };
    if (!text.wrap) delete rewritten.wrap;
    return rewritten;
  });
}

function hasIdIn(drawing: Drawing, ids: ReadonlySet<string>): boolean {
  return typeof drawing.id === 'string' && ids.has(drawing.id);
}

export interface CarriedDrawings {
  drawings: Drawing[];
  groups: Group[];
}

// The drawings a `graph:` block extracted into its own file takes along, with the groups they
// formed: those drawn in the block itself become the new file's body drawings, and those in
// blocks that move with it keep their block. Every copy gets a fresh id — the parent keeps its
// own drawings when it keeps the block.
export function drawingsForExtractedDocument(
  layer: Pick<CanvasLayer, 'drawings' | 'groups'>,
  blockName: string,
  carriedBlockNames: ReadonlySet<string>,
): CarriedDrawings {
  const copyIds = new Map<string, string>();
  const drawings = layer.drawings.flatMap((drawing) => {
    const carried = drawing.graph === blockName
      ? withoutGraph(drawing)
      : typeof drawing.graph === 'string' && carriedBlockNames.has(drawing.graph) ? drawing : null;
    if (!carried) return [];
    const copyId = newUuid();
    if (typeof drawing.id === 'string') copyIds.set(drawing.id, copyId);
    return [{ ...carried, id: copyId }];
  });
  return { drawings, groups: groupsForCopies(layer.groups, copyIds) };
}

// The drawings with these ids and the groups they form among themselves, detached from the
// layer so later edits to the originals never reach a copy.
export function drawingsToCopy(layer: Pick<CanvasLayer, 'drawings' | 'groups'>, ids: ReadonlySet<string>): CarriedDrawings {
  const drawings = layer.drawings.filter((drawing) => hasIdIn(drawing, ids)).map((drawing) => structuredClone(drawing));
  const sameIds = new Map([...ids].map((id) => [id, id]));
  return { drawings, groups: groupsForCopies(layer.groups, sameIds) };
}

// Places copies of carried drawings in `scope`, shifted by `offset`, each under a fresh id and
// with fresh groups. Returns the copies' ids.
export function pasteDrawings(layer: CanvasLayer, carried: CarriedDrawings, scope: string | null, offset: DrawingPoint): string[] {
  const copyIds = new Map<string, string>();
  const pastedIds: string[] = [];
  const shift = translationBy(offset);
  const copies = carried.drawings.map((drawing) => {
    const id = newUuid();
    const copy: Drawing = { ...withTransformedGeometry(withoutGraph(drawing), shift), id };
    if (scope != null) copy.graph = scope;
    if (typeof drawing.id === 'string') copyIds.set(drawing.id, id);
    pastedIds.push(id);
    return copy;
  });
  layer.drawings = [...layer.drawings, ...copies];
  layer.groups = [...layer.groups, ...groupsForCopies(carried.groups, copyIds)];
  return pastedIds;
}

function withoutGraph(drawing: Drawing): Drawing {
  const copy = { ...drawing };
  delete copy.graph;
  return copy;
}
