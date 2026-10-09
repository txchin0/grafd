// Free text on a graph's canvas layer: a drawing of kind `text`, filed under a graph scope like a
// stroke. It is written at a font `size` in its box, both in the scope's own units. The box is
// stored rather than measured, so bounds, hit-testing and moves never measure text: the editor
// re-measures it only when the words or the wrap width change.
//
// A text either sizes its box to its lines, or — once given a width (`wrap`) — wraps its words to
// that width and grows downward. Scaling a text evenly scales its size with its box; stretching it
// sideways gives it a width to wrap to and keeps its size.

import { isLayerColor, type Drawing } from './canvas-layer.js';
import { isFiniteNumber, roundCoordinate } from './drawing-geometry.js';
import type { Rect } from './flow-format.js';

export const TEXT_KIND = 'text';
// In the scope's own units, as stroke widths are, so text written inside a scaled-down frame
// shrinks with everything else in it.
export const DEFAULT_TEXT_FONT_SIZE = 20;
// A line's height as a multiple of the font size.
export const TEXT_LINE_HEIGHT_RATIO = 1.25;
// A size multiplies into the height of every line, so it is stored finer than a coordinate: to a
// hundredth, which keeps even a text shrunk to almost nothing in proportion with its box.
const SIZE_PRECISION = 100;

export interface TextDrawing {
  kind: typeof TEXT_KIND;
  id: string;
  graph: string | null;
  // A colour slot or `#rrggbb`; null draws in the theme's ink.
  color: string | null;
  text: string;
  box: Rect;
  size: number;
  // Wraps its words to the box's width; otherwise its lines are its own and the box fits them.
  wrap: boolean;
}

// Null for anything that is not drawable text. A bad colour only costs the text its colour; an
// empty text or a bad box leaves nothing to draw. A text written without a size — as the first
// editor wrote them — is as large as its box holds its lines.
export function textDrawingOf(drawing: Drawing): TextDrawing | null {
  if (drawing.kind !== TEXT_KIND || typeof drawing.id !== 'string' || drawing.id === '') return null;
  if (drawing.graph !== undefined && typeof drawing.graph !== 'string') return null;
  if (!isDrawableText(drawing.text)) return null;
  const box = textBoxOf(drawing.box);
  if (!box) return null;
  return {
    kind: TEXT_KIND,
    id: drawing.id,
    graph: drawing.graph ?? null,
    color: isLayerColor(drawing.color) ? drawing.color : null,
    text: drawing.text,
    box,
    size: isTextSize(drawing.size) ? drawing.size : box.h / (textLinesOf(drawing.text).length * TEXT_LINE_HEIGHT_RATIO),
    wrap: drawing.wrap === true,
  };
}

export function isDrawableText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function isTextSize(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

// `[x, y, w, h]` with a positive width and height.
export function textBoxOf(raw: unknown): Rect | null {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(isFiniteNumber)) return null;
  const [x, y, w, h] = raw as number[];
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

export function storedTextBox(box: Rect): [number, number, number, number] {
  return [roundCoordinate(box.x), roundCoordinate(box.y), roundCoordinate(box.w), roundCoordinate(box.h)];
}

// What a text's layout is stored as. `wrap` is written only when set, as other defaults are not.
export function storedTextLayout(text: Pick<TextDrawing, 'box' | 'size' | 'wrap'>): Record<string, unknown> {
  const stored: Record<string, unknown> = { box: storedTextBox(text.box), size: Math.round(text.size * SIZE_PRECISION) / SIZE_PRECISION };
  if (text.wrap) stored.wrap = true;
  return stored;
}

export function textDrawingRecord(text: TextDrawing): Drawing {
  const drawing: Drawing = { id: text.id, kind: TEXT_KIND };
  if (text.graph != null) drawing.graph = text.graph;
  if (text.color != null) drawing.color = text.color;
  drawing.text = text.text;
  return { ...drawing, ...storedTextLayout(text) };
}

export function textLinesOf(text: string): string[] {
  return text.split('\n');
}
