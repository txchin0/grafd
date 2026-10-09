// How free text is inked: left-aligned lines from the top of its box, laid out by
// text-drawing-layout.ts. Like strokes it skips rough.js — hand-drawn type is already rough.

import type { TextDrawing } from '../../shared/canvas-text.js';
import { canvasLineMeasurer, lineMiddleY, textFontAt, textLayout } from './text-drawing-layout.js';

export function inkText(ctx: CanvasRenderingContext2D, text: TextDrawing, color: string): void {
  const layout = textLayout(text, canvasLineMeasurer(ctx));
  ctx.save();
  ctx.font = textFontAt(layout.fontPx);
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  layout.lines.forEach((line, index) => ctx.fillText(line, text.box.x, lineMiddleY(text.box, layout, index)));
  ctx.restore();
}
