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
import { DEFAULT_NODE_SHAPE, type NodeShape } from './canvas-layer.js';
import { shapeTextBox } from './shape-text-box.js';

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
const SHAPED_WIDTH_STEPS = [160, 200, 240, 280, 320, 360, 400] as const;
const MAX_NODE_HEIGHT = 320;
const COMFORTABLE_DESCRIPTION_LINES = 3;
// The painter keeps a title line's height of the node clear of text (node-metrics.ts
// layOutNodeText); this is the air added on top of that so text never touches the outline.
const VERTICAL_BREATHING_ROOM = 16;
const HEIGHT_STEP = 8;

interface TextLines {
  title: number;
  description: number;
}

// The smallest width step, and the smallest height on the snap lattice at it, whose text box — the
// part of the rectangle the shape leaves for text — holds the text comfortably; failing that, at
// all; failing that, the widest. A node is never shorter than the default.
export function estimateNodeSize(title: string, description: string | null, shape: NodeShape = DEFAULT_NODE_SHAPE): NodeSize {
  const widths = widthStepsFor(shape);
  for (const fits of [fitsComfortably, fitsAtAll]) {
    for (const width of widths) {
      const height = smallestHeightFitting(width, title, description, shape, fits);
      if (height !== null) return { w: width, h: height };
    }
  }
  const widest = widths[widths.length - 1];
  return { w: widest, h: smallestHeightFitting(widest, title, description, shape, () => true) ?? MAX_NODE_HEIGHT };
}

// Whether a node of this size and shape cuts its text short: a title past the lines a node shows,
// or more of its description than it has room for, by the painter's own budget (node-metrics.ts
// layOutNodeText) in the shape's text box. A description too long for any node is cut regardless,
// so only what a bigger node would show counts.
export function textCutOff(title: string, description: string | null, size: NodeSize, shape: NodeShape = DEFAULT_NODE_SHAPE): boolean {
  const box = shapeTextBox(shape, { x: 0, y: 0, w: size.w, h: size.h });
  const lines = linesAt(box.w, title, description);
  if (lines.title > TITLE_MAX_LINES) return true;
  const descriptionBudget = Math.floor((box.h - (lines.title + 1) * TITLE_LINE_HEIGHT) / DESCRIPTION_LINE_HEIGHT);
  return Math.min(lines.description, DESCRIPTION_MAX_LINES) > descriptionBudget;
}

// A shape that gives text its whole width keeps to the usual steps; one that narrows it — a
// diamond keeps barely more than half — can grow wider before its text has to wrap.
function widthStepsFor(shape: NodeShape): readonly number[] {
  const textBoxWidth = shapeTextBox(shape, { x: 0, y: 0, w: NODE_WIDTH_STEPS[0], h: DEFAULT_NODE_SIZE.h }).w;
  return textBoxWidth === NODE_WIDTH_STEPS[0] ? NODE_WIDTH_STEPS : SHAPED_WIDTH_STEPS;
}

function smallestHeightFitting(
  width: number,
  title: string,
  description: string | null,
  shape: NodeShape,
  fits: (lines: TextLines) => boolean,
): number | null {
  for (let height = DEFAULT_NODE_SIZE.h; height <= MAX_NODE_HEIGHT; height += HEIGHT_STEP) {
    const box = shapeTextBox(shape, { x: 0, y: 0, w: width, h: height });
    const lines = linesAt(box.w, title, description);
    if (fits(lines) && box.h >= textBlockHeight(lines)) return height;
  }
  return null;
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

// The height a text box needs for these lines, with room to breathe.
function textBlockHeight(lines: TextLines): number {
  const titleLines = Math.min(lines.title, TITLE_MAX_LINES);
  const descriptionLines = Math.min(lines.description, DESCRIPTION_MAX_LINES);
  const descriptionBlock = descriptionLines > 0
    ? TITLE_DESCRIPTION_GAP + descriptionLines * DESCRIPTION_LINE_HEIGHT
    : 0;
  return (titleLines + 1) * TITLE_LINE_HEIGHT + descriptionBlock + VERTICAL_BREATHING_ROOM;
}
