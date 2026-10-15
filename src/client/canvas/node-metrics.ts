// How a node's text is laid out: where the title and description wrap inside its rect, and
// the band the title occupies. Measurement only — nothing here paints.
//
// The inline title editor overlays the band computed here while the painter fills the same
// band with text, so the two must agree exactly or the overlay drifts off the ink. Keeping
// the font strings and the wrapping in one place is what stops them from diverging.

import type { NodeTextSize } from '../../shared/canvas-layer.js';
import type { FlowNode, Rect } from '../../shared/flow-format.js';
import {
  DESCRIPTION_FONT_PX,
  DESCRIPTION_LINE_HEIGHT,
  DESCRIPTION_MAX_LINES,
  NODE_TEXT_SIDE_PADDING,
  TITLE_DESCRIPTION_GAP,
  TITLE_FONT_PX,
  TITLE_LINE_HEIGHT,
  TITLE_MAX_LINES,
  wrapTextLines,
} from '../../shared/node-text-metrics.js';
import { handFontFamily } from '../canvas-font.js';

// The medium text size (node-text-metrics.ts) is scaled as a whole for every other size.
// Both text runs are drawn on a middle baseline, so the first description line sits a little
// tighter under the title than the block-height gap suggests.
const DESCRIPTION_FIRST_LINE_NUDGE = 4;

export const NODE_TEXT_SCALES: Record<NodeTextSize, number> = {
  small: 0.8,
  medium: 1,
  large: 1.3,
  'x-large': 1.7,
};

export const FRAME_TITLE_FONT_PX = 13;
export const FRAME_TITLE_LINE_HEIGHT = 18;
export const FRAME_TITLE_LEFT = 12;
export const FRAME_TITLE_MIDDLE_Y = 16;
// Keeps the frame's title clear of the expand/collapse badges in the header strip.
export const FRAME_TITLE_RIGHT_INSET = 64;
export const REGION_LABEL_RIGHT_INSET = 16;

const FRAME_TITLE_HIT_PADDING = 6;

// A node's text metrics at one text size.
export interface NodeTypography {
  titleFontPx: number;
  titleLineHeight: number;
  descriptionFontPx: number;
  descriptionLineHeight: number;
  titleDescriptionGap: number;
  descriptionFirstLineNudge: number;
}

export function nodeTypography(size: NodeTextSize): NodeTypography {
  const scale = NODE_TEXT_SCALES[size];
  return {
    titleFontPx: TITLE_FONT_PX * scale,
    titleLineHeight: TITLE_LINE_HEIGHT * scale,
    descriptionFontPx: DESCRIPTION_FONT_PX * scale,
    descriptionLineHeight: DESCRIPTION_LINE_HEIGHT * scale,
    titleDescriptionGap: TITLE_DESCRIPTION_GAP * scale,
    descriptionFirstLineNudge: DESCRIPTION_FIRST_LINE_NUDGE * scale,
  };
}

export function titleFont(typography: NodeTypography): string {
  return handFontAt(typography.titleFontPx, 600);
}

export function descriptionFont(typography: NodeTypography): string {
  return handFontAt(typography.descriptionFontPx);
}

export function frameTitleFont(): string {
  return `600 ${FRAME_TITLE_FONT_PX}px ${handFontFamily()}`;
}

export function handFontAt(sizePx: number, weight?: number | string): string {
  const size = `${sizePx}px ${handFontFamily()}`;
  return weight == null ? size : `${weight} ${size}`;
}

export interface NodeTextLayout {
  typography: NodeTypography;
  titleLines: string[];
  descriptionLines: string[];
  maxWidth: number;
  firstLineMiddleY: number;
}

// Measures against `ctx`'s current font, so callers set the font for the run being wrapped.
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  return wrapTextLines(text, maxWidth, maxLines, (run) => ctx.measureText(run).width);
}

// Leaves ctx.font set to the description font.
export function layOutNodeText(
  ctx: CanvasRenderingContext2D,
  node: FlowNode,
  rect: Rect,
  description: string | null,
  typography: NodeTypography,
): NodeTextLayout {
  const { titleLineHeight, descriptionLineHeight } = typography;
  const maxWidth = rect.w - 2 * NODE_TEXT_SIDE_PADDING;

  ctx.font = titleFont(typography);
  const titleLines = wrapText(ctx, node.name, maxWidth, TITLE_MAX_LINES);
  ctx.font = descriptionFont(typography);
  const descriptionLineBudget = Math.max(
    0,
    Math.floor((rect.h - titleLineHeight - titleLines.length * titleLineHeight) / descriptionLineHeight),
  );
  const descriptionLines = description
    ? wrapText(ctx, description, maxWidth, Math.min(DESCRIPTION_MAX_LINES, descriptionLineBudget))
    : [];

  const blockHeight = titleLines.length * titleLineHeight
    + (descriptionLines.length ? typography.titleDescriptionGap + descriptionLines.length * descriptionLineHeight : 0);

  return {
    typography,
    titleLines,
    descriptionLines,
    maxWidth,
    firstLineMiddleY: rect.y + rect.h / 2 - blockHeight / 2 + titleLineHeight / 2,
  };
}

export function titleBandOf(rect: Rect, layout: NodeTextLayout): Rect {
  return {
    x: rect.x + NODE_TEXT_SIDE_PADDING,
    y: layout.firstLineMiddleY - layout.typography.titleLineHeight / 2,
    w: layout.maxWidth,
    h: Math.max(1, layout.titleLines.length) * layout.typography.titleLineHeight,
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
  ctx.font = frameTitleFont();
  const available = rect.w - rightInset;
  const width = Math.min(available, ctx.measureText(text).width) + 2 * FRAME_TITLE_HIT_PADDING;
  return {
    x: rect.x + FRAME_TITLE_LEFT - FRAME_TITLE_HIT_PADDING,
    y: rect.y + FRAME_TITLE_MIDDLE_Y - FRAME_TITLE_LINE_HEIGHT / 2,
    w: width,
    h: FRAME_TITLE_LINE_HEIGHT,
  };
}
