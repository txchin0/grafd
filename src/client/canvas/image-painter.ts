// How an image is drawn: its pixels stretched into its box, or — until they are decoded, or when
// they cannot be — a faint outline of the box, so the image is still seen to be there and where a
// press would pick it up.

import type { Rect } from '../../shared/flow-format.js';
import { canvasPalette } from '../theme.js';

const PLACEHOLDER_ALPHA = 0.35;
const PLACEHOLDER_DASH = [6, 4];
const PLACEHOLDER_LINE_WIDTH = 1;

export function inkImage(ctx: CanvasRenderingContext2D, image: CanvasImageSource | null, box: Rect): void {
  if (image) ctx.drawImage(image, box.x, box.y, box.w, box.h);
  else inkPlaceholder(ctx, box);
}

function inkPlaceholder(ctx: CanvasRenderingContext2D, box: Rect): void {
  ctx.save();
  ctx.globalAlpha *= PLACEHOLDER_ALPHA;
  ctx.strokeStyle = canvasPalette.ink;
  ctx.lineWidth = PLACEHOLDER_LINE_WIDTH;
  ctx.setLineDash(PLACEHOLDER_DASH);
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.restore();
}
