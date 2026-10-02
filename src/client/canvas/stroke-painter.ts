// How a freehand stroke is inked. Shared by the scene painter, which draws committed strokes,
// and the view's gesture overlay, which draws the one in progress — the ink under the pen is the
// ink that gets committed. Strokes skip rough.js on purpose: a hand-drawn line is already rough,
// and re-jittering hundreds of points makes it wobble.

import { midpointOf, type Point } from '../geometry.js';
import { canvasPalette, resolveLayerColor } from '../theme.js';

// A stroke without a colour of its own takes the theme's ink, so it reads in every theme.
export function strokeInkColor(layerColor: string | null): string {
  return layerColor ? resolveLayerColor(layerColor) : canvasPalette.ink;
}

export function inkStroke(ctx: CanvasRenderingContext2D, points: readonly Point[], color: string, lineWidth: number): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (points.length === 1) inkDot(ctx, points[0], lineWidth);
  else inkSmoothedPath(ctx, points);
  ctx.restore();
}

function inkDot(ctx: CanvasRenderingContext2D, point: Point, lineWidth: number): void {
  ctx.beginPath();
  ctx.arc(point.x, point.y, lineWidth / 2, 0, Math.PI * 2);
  ctx.fill();
}

// Curves through the midpoints of consecutive segments, each bending around the point between
// them: the pen's corners round off without the line leaving the hand's path.
function inkSmoothedPath(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length - 1; index += 1) {
    const midpoint = midpointOf(points[index], points[index + 1]);
    ctx.quadraticCurveTo(points[index].x, points[index].y, midpoint.x, midpoint.y);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}
