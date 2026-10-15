// The size the layout gives a node it places, from the text the node has to show. The layout runs
// in the linter and on the command line as well as in the editor, and all three must place a node
// identically, so its text is estimated from a fixed width per character rather than measured with
// a canvas only the editor has. Widths come in steps, which keeps an estimate a few pixels off from
// ever changing a size.

import {
  DESCRIPTION_LINE_HEIGHT,
  DESCRIPTION_MAX_LINES,
  EDGE_LABEL_PADDING_X,
  NODE_TEXT_SIDE_PADDING,
  TITLE_DESCRIPTION_GAP,
  TITLE_LINE_HEIGHT,
  TITLE_MAX_LINES,
  wrapTextLines,
} from './node-text-metrics.js';

export const DEFAULT_NODE_SIZE = { w: 200, h: 88 };

export interface NodeSize {
  w: number;
  h: number;
}

// Measured on both canvas faces (Segoe Print and Playpen Sans) over typical node titles and
// descriptions, then rounded up: a title the estimate expects on one line must not wrap.
const TITLE_CHARACTER_WIDTH = 8.5;
const DESCRIPTION_CHARACTER_WIDTH = 7;
const EDGE_LABEL_CHARACTER_WIDTH = 7;

export const NODE_WIDTH_STEPS = [160, 200, 240, 280] as const;
const COMFORTABLE_DESCRIPTION_LINES = 3;
// The painter keeps a title line's height of the node clear of text (node-metrics.ts
// layOutNodeText); this is the air added on top of that so text never touches the outline.
const VERTICAL_BREATHING_ROOM = 16;
const HEIGHT_STEP = 8;

interface TextLines {
  title: number;
  description: number;
}

export function estimateNodeSize(title: string, description: string | null): NodeSize {
  const width = NODE_WIDTH_STEPS.find((step) => fitsComfortably(linesAt(step, title, description)))
    ?? NODE_WIDTH_STEPS.find((step) => fitsAtAll(linesAt(step, title, description)))
    ?? NODE_WIDTH_STEPS[NODE_WIDTH_STEPS.length - 1];
  return { w: width, h: heightFor(linesAt(width, title, description)) };
}

// The width of the pill an edge's label is drawn in.
export function estimateEdgeLabelWidth(text: string): number {
  return text.length * EDGE_LABEL_CHARACTER_WIDTH + 2 * EDGE_LABEL_PADDING_X;
}

function fitsComfortably(lines: TextLines): boolean {
  return lines.title === 1 && lines.description <= COMFORTABLE_DESCRIPTION_LINES;
}

function fitsAtAll(lines: TextLines): boolean {
  return lines.title <= TITLE_MAX_LINES && lines.description <= DESCRIPTION_MAX_LINES;
}

function linesAt(width: number, title: string, description: string | null): TextLines {
  const textWidth = width - 2 * NODE_TEXT_SIDE_PADDING;
  return {
    title: wrappedLineCount(title, textWidth, TITLE_CHARACTER_WIDTH),
    description: description ? wrappedLineCount(description, textWidth, DESCRIPTION_CHARACTER_WIDTH) : 0,
  };
}

function wrappedLineCount(text: string, textWidth: number, characterWidth: number): number {
  return wrapTextLines(text, textWidth, Infinity, (run) => run.length * characterWidth).length;
}

function heightFor(lines: TextLines): number {
  const titleLines = Math.min(lines.title, TITLE_MAX_LINES);
  const descriptionLines = Math.min(lines.description, DESCRIPTION_MAX_LINES);
  const descriptionBlock = descriptionLines > 0
    ? TITLE_DESCRIPTION_GAP + descriptionLines * DESCRIPTION_LINE_HEIGHT
    : 0;
  const textBlock = (titleLines + 1) * TITLE_LINE_HEIGHT + descriptionBlock + VERTICAL_BREATHING_ROOM;
  return Math.max(DEFAULT_NODE_SIZE.h, Math.ceil(textBlock / HEIGHT_STEP) * HEIGHT_STEP);
}
