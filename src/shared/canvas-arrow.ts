// A free arrow on a graph's canvas layer: a drawing of kind `arrow`, filed under a graph scope like
// a stroke, running straight from its first point to its second in the scope's own units. It joins
// nothing — an arrow between two nodes that means something is an edge in the .flow — so moving a
// node never moves it. It is drawn with the line and heads an edge can have.

import {
  isArrowhead,
  isLineStyle,
  type Arrowhead,
  type EdgeEnd,
  type LineStyle,
} from './canvas-edge-style.js';
import { isLayerColor, type Drawing } from './canvas-layer.js';
import { roundCoordinate, isFiniteNumber, type DrawingPoint } from './drawing-geometry.js';

export const ARROW_KIND = 'arrow';

// The same names as a stroke's widths, drawn as wide (STROKE_LINE_WIDTHS); declared here because
// canvas-drawings.ts imports this module.
export const ARROW_WIDTHS = ['thin', 'medium', 'thick'] as const;
export type ArrowWidth = (typeof ARROW_WIDTHS)[number];

export const DEFAULT_ARROW_WIDTH: ArrowWidth = 'medium';
export const DEFAULT_ARROW_LINE: LineStyle = 'solid';
export const DEFAULT_ARROW_START_HEAD: Arrowhead = 'none';
export const DEFAULT_ARROW_END_HEAD: Arrowhead = 'arrow';
// An edge turned into an arrow keeps the weight it was drawn with: an edge's line is a thin stroke's.
export const EDGE_ARROW_WIDTH: ArrowWidth = 'thin';

// How far past its end a head can reach, in the scope's own units: the longest head an edge is
// drawn with (client/canvas/arrowheads.ts), which a test holds to this.
export const ARROWHEAD_REACH = 14;

export interface ArrowDrawing {
  kind: typeof ARROW_KIND;
  id: string;
  graph: string | null;
  // A colour slot or `#rrggbb`; null draws in the theme's ink.
  color: string | null;
  width: ArrowWidth;
  line: LineStyle;
  startHead: Arrowhead;
  endHead: Arrowhead;
  // Where it starts, then where it points.
  points: [DrawingPoint, DrawingPoint];
}

export function isArrowWidth(value: unknown): value is ArrowWidth {
  return (ARROW_WIDTHS as readonly unknown[]).includes(value);
}

// Null for anything that is not a drawable arrow. A bad colour, width, line or head only costs the
// arrow that styling; without exactly two points there is nothing to draw.
export function arrowDrawingOf(drawing: Drawing): ArrowDrawing | null {
  if (drawing.kind !== ARROW_KIND || typeof drawing.id !== 'string' || drawing.id === '') return null;
  if (drawing.graph !== undefined && typeof drawing.graph !== 'string') return null;
  const points = arrowPointsOf(drawing.points);
  if (!points) return null;
  return {
    kind: ARROW_KIND,
    id: drawing.id,
    graph: drawing.graph ?? null,
    color: isLayerColor(drawing.color) ? drawing.color : null,
    width: isArrowWidth(drawing.width) ? drawing.width : DEFAULT_ARROW_WIDTH,
    line: isLineStyle(drawing.line) ? drawing.line : DEFAULT_ARROW_LINE,
    startHead: isArrowhead(drawing.startHead) ? drawing.startHead : DEFAULT_ARROW_START_HEAD,
    endHead: isArrowhead(drawing.endHead) ? drawing.endHead : DEFAULT_ARROW_END_HEAD,
    points,
  };
}

export function arrowPointsOf(raw: unknown): [DrawingPoint, DrawingPoint] | null {
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every(isCoordinatePair)) return null;
  const [start, end] = raw as [number, number][];
  return [{ x: start[0], y: start[1] }, { x: end[0], y: end[1] }];
}

function isCoordinatePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
}

// Defaults are never written, as a stroke's default width is not.
export function arrowDrawingRecord(arrow: ArrowDrawing): Drawing {
  const drawing: Drawing = { id: arrow.id, kind: ARROW_KIND };
  if (arrow.graph != null) drawing.graph = arrow.graph;
  if (arrow.color != null) drawing.color = arrow.color;
  if (arrow.width !== DEFAULT_ARROW_WIDTH) drawing.width = arrow.width;
  if (arrow.line !== DEFAULT_ARROW_LINE) drawing.line = arrow.line;
  if (arrow.startHead !== DEFAULT_ARROW_START_HEAD) drawing.startHead = arrow.startHead;
  if (arrow.endHead !== DEFAULT_ARROW_END_HEAD) drawing.endHead = arrow.endHead;
  drawing.points = storedArrowPoints(arrow.points);
  return drawing;
}

export function storedArrowPoints(points: readonly DrawingPoint[]): [number, number][] {
  return points.map((point) => [roundCoordinate(point.x), roundCoordinate(point.y)]);
}

export function arrowEndIndex(end: EdgeEnd): 0 | 1 {
  return end === 'start' ? 0 : 1;
}

// The arrow with one end moved to `point`, the other where it was.
export function withArrowEnd(points: readonly [DrawingPoint, DrawingPoint], end: EdgeEnd, point: DrawingPoint): [DrawingPoint, DrawingPoint] {
  return end === 'start' ? [point, points[1]] : [points[0], point];
}
