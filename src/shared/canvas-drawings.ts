// Free drawings on a graph's canvas layer. Each drawing is filed under the graph scope it was
// drawn in — `graph` names the `graph:` block, and is absent for the file body — and its points
// are in that scope's own `pos` coordinates, so it is drawn wherever the scope is: dived into, or
// unfolded inside a frame. `followIdentityChanges` (canvas-layer.ts) keeps `graph` in step with
// block renames and removals.
//
// The only kind this editor draws is a freehand stroke. Drawings of other kinds, and fields this
// editor does not know, are kept verbatim and simply not drawn.

import { isLayerColor, type CanvasLayer, type Drawing } from './canvas-layer.js';
import { groupsForCopies, pruneGroups, type Group } from './canvas-groups.js';
import { newUuid, type Rect } from './flow-format.js';

export const STROKE_KIND = 'stroke';
export const STROKE_WIDTHS = ['thin', 'medium', 'thick'] as const;
export type StrokeWidth = (typeof STROKE_WIDTHS)[number];
export const DEFAULT_STROKE_WIDTH: StrokeWidth = 'medium';

// In the scope's own units, so a stroke inside a scaled-down frame thins with everything else.
export const STROKE_LINE_WIDTHS: Record<StrokeWidth, number> = { thin: 1.5, medium: 3, thick: 6 };

// Stored to a tenth of a unit: finer than any screen shows, and it keeps a stroke's line short.
const COORDINATE_PRECISION = 10;

export interface StrokePoint {
  x: number;
  y: number;
}

// How a stroke's points are carried by a move or a resize: each axis scaled, then shifted —
// `x' = x · scaleX + x`. Line width is style, not geometry, so a resized stroke keeps its own.
export interface StrokeTransform {
  scaleX: number;
  scaleY: number;
  x: number;
  y: number;
}

export function translationBy(offset: StrokePoint): StrokeTransform {
  return { scaleX: 1, scaleY: 1, x: offset.x, y: offset.y };
}

export function applyStrokeTransform(point: StrokePoint, transform: StrokeTransform): StrokePoint {
  return { x: point.x * transform.scaleX + transform.x, y: point.y * transform.scaleY + transform.y };
}

export function transformedStroke(stroke: Stroke, transform: StrokeTransform): Stroke {
  return { ...stroke, points: stroke.points.map((point) => applyStrokeTransform(point, transform)) };
}

export interface Stroke {
  id: string;
  graph: string | null;
  // A colour slot or `#rrggbb`; null draws in the theme's ink.
  color: string | null;
  width: StrokeWidth;
  points: StrokePoint[];
}

export function isStrokeWidth(value: unknown): value is StrokeWidth {
  return (STROKE_WIDTHS as readonly unknown[]).includes(value);
}

// Null for anything that is not a drawable stroke. A bad colour or width only costs the stroke
// its styling, as a bad shape costs a node its; bad points or a bad `graph` leave nothing to draw.
export function strokeOf(drawing: Drawing): Stroke | null {
  if (drawing.kind !== STROKE_KIND || typeof drawing.id !== 'string' || drawing.id === '') return null;
  if (drawing.graph !== undefined && typeof drawing.graph !== 'string') return null;
  const points = strokePointsOf(drawing.points);
  if (!points) return null;
  return {
    id: drawing.id,
    graph: drawing.graph ?? null,
    color: isLayerColor(drawing.color) ? drawing.color : null,
    width: isStrokeWidth(drawing.width) ? drawing.width : DEFAULT_STROKE_WIDTH,
    points,
  };
}

export function strokePointsOf(raw: unknown): StrokePoint[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const points: StrokePoint[] = [];
  for (const pair of raw) {
    if (!isCoordinatePair(pair)) return null;
    points.push({ x: pair[0], y: pair[1] });
  }
  return points;
}

function isCoordinatePair(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate));
}

export function strokesInScope(layer: CanvasLayer | null, scope: string | null): Stroke[] {
  if (!layer) return [];
  return layer.drawings
    .map(strokeOf)
    .filter((stroke): stroke is Stroke => stroke != null && stroke.graph === scope);
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

function storedCoordinatePair(point: StrokePoint): [number, number] {
  return [roundCoordinate(point.x), roundCoordinate(point.y)];
}

function roundCoordinate(value: number): number {
  return Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
}

// Where the ink reaches: the points' bounds grown by half the line on every side.
export function strokeBounds(stroke: Stroke): Rect {
  const points = strokePointBounds(stroke);
  const halfLine = STROKE_LINE_WIDTHS[stroke.width] / 2;
  return { x: points.x - halfLine, y: points.y - halfLine, w: points.w + 2 * halfLine, h: points.h + 2 * halfLine };
}

// The box the points themselves span — what a resize stretches. Folded rather than spread into
// Math.min, which runs out of stack on a long enough hand-written stroke.
export function strokePointBounds(stroke: Stroke): Rect {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { x, y } of stroke.points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function addStroke(layer: CanvasLayer, stroke: Stroke): void {
  layer.drawings = [...layer.drawings, strokeDrawing(stroke)];
}

export function removeDrawings(layer: CanvasLayer, ids: ReadonlySet<string>): void {
  layer.drawings = layer.drawings.filter((drawing) => !hasIdIn(drawing, ids));
  pruneGroups(layer);
}

export function transformDrawings(layer: CanvasLayer, transforms: ReadonlyMap<string, StrokeTransform>): void {
  layer.drawings = layer.drawings.map((drawing) => {
    const transform = typeof drawing.id === 'string' ? transforms.get(drawing.id) : undefined;
    const points = transform ? strokePointsOf(drawing.points) : null;
    if (!transform || !points) return drawing;
    return { ...drawing, points: points.map((point) => storedCoordinatePair(applyStrokeTransform(point, transform))) };
  });
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
export function pasteDrawings(layer: CanvasLayer, carried: CarriedDrawings, scope: string | null, offset: StrokePoint): string[] {
  const copyIds = new Map<string, string>();
  const pastedIds: string[] = [];
  const shift = translationBy(offset);
  const copies = carried.drawings.map((drawing) => {
    const id = newUuid();
    const copy: Drawing = { ...withoutGraph(drawing), id };
    if (scope != null) copy.graph = scope;
    const points = strokePointsOf(drawing.points);
    if (points) copy.points = points.map((point) => storedCoordinatePair(applyStrokeTransform(point, shift)));
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
