// How free text is laid out in its box: its lines — its own, or its words wrapped to the box's
// width — and the size they are drawn at. The stored size is drawn as given unless the box cannot
// hold it, as when the box was measured in another canvas font; then it shrinks to fit rather than
// spill. The box itself is measured here whenever the words or the wrap width change.
//
// The painter inks the layout computed here and the inline text editor overlays it, so both go
// through this one place or the overlay drifts off the ink.

import { TEXT_KIND, TEXT_LINE_HEIGHT_RATIO, textLinesOf, type TextDrawing } from '../../shared/canvas-text.js';
import { transformedDrawing, type CanvasDrawing } from '../../shared/canvas-drawings.js';
import { isStretch, type DrawingTransform } from '../../shared/drawing-geometry.js';
import type { Rect } from '../../shared/flow-format.js';
import type { Point } from '../geometry.js';
import { handFontAt } from './node-metrics.js';

// The width one line takes at a font size, in the same units as the size.
export type LineMeasurer = (line: string, fontPx: number) => number;

export interface TextLayout {
  fontPx: number;
  lines: string[];
  lineHeight: number;
}

type LaidOutFields = Pick<TextDrawing, 'text' | 'box' | 'size' | 'wrap'>;

export function textFontAt(fontPx: number): string {
  return handFontAt(fontPx);
}

export function canvasLineMeasurer(ctx: CanvasRenderingContext2D): LineMeasurer {
  return (line, fontPx) => {
    ctx.font = textFontAt(fontPx);
    return ctx.measureText(line).width;
  };
}

// Text width is proportional to font size, so one measurement at the stored size says how far to
// shrink when the box is too small for it.
export function textLayout(text: LaidOutFields, measureLine: LineMeasurer): TextLayout {
  const lines = linesOf(text.text, text.wrap ? text.box.w : null, text.size, measureLine);
  const widest = widestLineWidth(lines, text.size, measureLine);
  const naturalHeight = lines.length * text.size * TEXT_LINE_HEIGHT_RATIO;
  const widthFit = widest > text.box.w ? text.box.w / widest : 1;
  const heightFit = naturalHeight > text.box.h ? text.box.h / naturalHeight : 1;
  const fontPx = text.size * Math.min(widthFit, heightFit);
  return { fontPx, lines, lineHeight: fontPx * TEXT_LINE_HEIGHT_RATIO };
}

// The box that holds `text` at `fontPx` with its top-left corner at `topLeft`: as wide as its
// widest line, or — given a wrap width — that wide. Never narrower than one em, so even a run of
// spaces has a box to see and grab, and a wrapped text always fits a letter on a line.
export function textBoxFor(text: string, topLeft: Point, fontPx: number, measureLine: LineMeasurer, wrapWidth: number | null = null): Rect {
  const width = wrapWidth == null ? null : Math.max(fontPx, wrapWidth);
  const lines = linesOf(text, width, fontPx, measureLine);
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: width ?? Math.max(fontPx, widestLineWidth(lines, fontPx, measureLine)),
    h: lines.length * fontPx * TEXT_LINE_HEIGHT_RATIO,
  };
}

// The text with its box measured again where it starts: after its words change, or after a
// stretch gave it a new width to wrap to.
export function relaidOutText<Text extends LaidOutFields>(text: Text, measureLine: LineMeasurer): Text {
  const box = textBoxFor(text.text, text.box, text.size, measureLine, text.wrap ? text.box.w : null);
  return { ...text, box };
}

// A drawing as a gesture carrying it shows it, before anything is written: moved, scaled or
// stretched, with a stretched text laid out again for the width it is being given — as the write
// will. A text moved or scaled evenly keeps the lines it has.
export function drawingAsCarried(drawing: CanvasDrawing, transform: DrawingTransform, measureLine: LineMeasurer): CanvasDrawing {
  const carried = transformedDrawing(drawing, transform);
  return carried.kind === TEXT_KIND && isStretch(transform) ? relaidOutText(carried, measureLine) : carried;
}

// The middle of each line, where the painter puts its baseline.
export function lineMiddleY(box: Rect, layout: TextLayout, lineIndex: number): number {
  return box.y + (lineIndex + 0.5) * layout.lineHeight;
}

function linesOf(text: string, wrapWidth: number | null, fontPx: number, measureLine: LineMeasurer): string[] {
  const paragraphs = textLinesOf(text);
  if (wrapWidth == null) return paragraphs;
  return paragraphs.flatMap((paragraph) => wrappedParagraph(paragraph, wrapWidth, fontPx, measureLine));
}

// Greedy: as many words on a line as fit. A word wider than the whole width is broken where it
// overruns, as the textarea the text is typed into breaks it.
function wrappedParagraph(paragraph: string, width: number, fontPx: number, measureLine: LineMeasurer): string[] {
  const fits = (line: string) => measureLine(line, fontPx) <= width;
  const lines: string[] = [];
  let current = '';
  for (const word of paragraph.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    current = '';
    for (const piece of brokenToWidth(word, fits)) {
      if (current !== '') lines.push(current);
      current = piece;
    }
  }
  lines.push(current);
  return lines;
}

// A word as pieces that each fit, longest first; a lone character too wide for the width is
// still a piece of its own.
function brokenToWidth(word: string, fits: (line: string) => boolean): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const character of word) {
    if (piece !== '' && !fits(piece + character)) {
      pieces.push(piece);
      piece = '';
    }
    piece += character;
  }
  pieces.push(piece);
  return pieces;
}

function widestLineWidth(lines: readonly string[], fontPx: number, measureLine: LineMeasurer): number {
  return lines.reduce((widest, line) => Math.max(widest, measureLine(line, fontPx)), 0);
}
