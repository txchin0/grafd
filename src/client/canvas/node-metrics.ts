// How a node's text is laid out: where the title and description wrap inside its rect, and
// the band the title occupies. Measurement only — nothing here paints.
//
// The inline title editor overlays the band computed here while the painter fills the same
// band with text, so the two must agree exactly or the overlay drifts off the ink. Keeping
// the font strings and the wrapping in one place is what stops them from diverging.

import type { FlowNode, Rect } from '../../shared/flow-format.js';

export const HAND_FONT = '"Segoe Print", "Comic Sans MS", cursive';

export const NODE_TEXT_SIDE_PADDING = 13;
export const TITLE_FONT_PX = 15;
export const TITLE_LINE_HEIGHT = 20;
export const DESCRIPTION_LINE_HEIGHT = 16;
// Both text runs are drawn on a middle baseline, so the first description line sits a little
// tighter under the title than the block-height gap suggests.
export const DESCRIPTION_FIRST_LINE_NUDGE = 4;
export const FRAME_TITLE_FONT_PX = 13;
export const FRAME_TITLE_LINE_HEIGHT = 18;
export const FRAME_TITLE_LEFT = 12;
export const FRAME_TITLE_MIDDLE_Y = 16;
// Keeps the frame's title clear of the expand/collapse badges in the header strip.
export const FRAME_TITLE_RIGHT_INSET = 64;
export const REGION_LABEL_RIGHT_INSET = 16;

const TITLE_MAX_LINES = 2;
const DESCRIPTION_FONT_PX = 12.5;
const DESCRIPTION_MAX_LINES = 4;
const TITLE_DESCRIPTION_GAP = 6;
const FRAME_TITLE_HIT_PADDING = 6;

export const TITLE_FONT = `600 ${TITLE_FONT_PX}px ${HAND_FONT}`;
export const DESCRIPTION_FONT = `${DESCRIPTION_FONT_PX}px ${HAND_FONT}`;
export const FRAME_TITLE_FONT = `600 ${FRAME_TITLE_FONT_PX}px ${HAND_FONT}`;

export interface NodeTextLayout {
  titleLines: string[];
  descriptionLines: string[];
  maxWidth: number;
  firstLineMiddleY: number;
}

// Measures against `ctx`'s current font, so callers set the font for the run being wrapped.
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '…');
  }
  return lines;
}

// Leaves ctx.font set to the description font.
export function layOutNodeText(
  ctx: CanvasRenderingContext2D,
  node: FlowNode,
  rect: Rect,
  description: string | null,
): NodeTextLayout {
  const maxWidth = rect.w - 2 * NODE_TEXT_SIDE_PADDING;

  ctx.font = TITLE_FONT;
  const titleLines = wrapText(ctx, node.name, maxWidth, TITLE_MAX_LINES);
  ctx.font = DESCRIPTION_FONT;
  const descriptionLineBudget = Math.max(
    0,
    Math.floor((rect.h - TITLE_LINE_HEIGHT - titleLines.length * TITLE_LINE_HEIGHT) / DESCRIPTION_LINE_HEIGHT),
  );
  const descriptionLines = description
    ? wrapText(ctx, description, maxWidth, Math.min(DESCRIPTION_MAX_LINES, descriptionLineBudget))
    : [];

  const blockHeight = titleLines.length * TITLE_LINE_HEIGHT
    + (descriptionLines.length ? TITLE_DESCRIPTION_GAP + descriptionLines.length * DESCRIPTION_LINE_HEIGHT : 0);

  return {
    titleLines,
    descriptionLines,
    maxWidth,
    firstLineMiddleY: rect.y + rect.h / 2 - blockHeight / 2 + TITLE_LINE_HEIGHT / 2,
  };
}

export function titleBandOf(rect: Rect, layout: NodeTextLayout): Rect {
  return {
    x: rect.x + NODE_TEXT_SIDE_PADDING,
    y: layout.firstLineMiddleY - TITLE_LINE_HEIGHT / 2,
    w: layout.maxWidth,
    h: Math.max(1, layout.titleLines.length) * TITLE_LINE_HEIGHT,
  };
}

export function frameTitleBand(ctx: CanvasRenderingContext2D, node: FlowNode, frame: Rect): Rect {
  return headerLabelBand(ctx, node.name, frame, FRAME_TITLE_RIGHT_INSET);
}

// A region's name sits where a frame's title does, but a region carries no badges (R47), so its
// label may run closer to the right edge. Both go through here so the band a hit test measures is
// the band the painter fills.
export function regionLabelBand(ctx: CanvasRenderingContext2D, name: string, region: Rect): Rect {
  return headerLabelBand(ctx, name, region, REGION_LABEL_RIGHT_INSET);
}

function headerLabelBand(ctx: CanvasRenderingContext2D, text: string, rect: Rect, rightInset: number): Rect {
  ctx.font = FRAME_TITLE_FONT;
  const available = rect.w - rightInset;
  const width = Math.min(available, ctx.measureText(text).width) + 2 * FRAME_TITLE_HIT_PADDING;
  return {
    x: rect.x + FRAME_TITLE_LEFT - FRAME_TITLE_HIT_PADDING,
    y: rect.y + FRAME_TITLE_MIDDLE_Y - FRAME_TITLE_LINE_HEIGHT / 2,
    w: width,
    h: FRAME_TITLE_LINE_HEIGHT,
  };
}
