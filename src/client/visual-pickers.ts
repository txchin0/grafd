// The canvas-layer controls in the node, edge and region editors and the draw tool's pen: rows of
// shape and text size buttons, colour swatches, line styles, arrowheads, fill patterns and stroke widths. Each is a one-click choice that takes effect
// immediately, like a checkbox, and is refilled whenever its owner is.

import {
  LAYER_COLOR_SLOTS,
  NODE_SHAPES,
  NODE_TEXT_SIZES,
  isLayerColorSlot,
  type NodeShape,
  type NodeTextSize,
} from '../shared/canvas-layer.js';
import { ARROWHEADS, LINE_STYLES, type Arrowhead, type LineStyle } from '../shared/canvas-edge-style.js';
import { REGION_FILL_PATTERNS, type RegionFillPattern } from '../shared/canvas-region-style.js';
import type { Rect } from '../shared/flow-format.js';
import { STROKE_LINE_WIDTHS, STROKE_WIDTHS, type StrokeWidth } from '../shared/canvas-drawings.js';
import { arrowheadIsFilled, arrowheadOutline, arrowheadPathData } from './canvas/arrowheads.js';
import { outlinePathData, shapeOutline } from './canvas/node-shapes.js';
import { NODE_TEXT_SCALES } from './canvas/node-metrics.js';
import { layerColorSlotToken } from './theme.js';

export interface ChoiceRow<Choice> {
  fill(current: Choice): void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ICON_SIZE = { w: 24, h: 16 };
const ICON_INSET = 1.5;
// Edge icons are drawn in a larger box shown at icon size, so an arrowhead keeps the proportions
// it has on the canvas, where its size is fixed in canvas units.
const EDGE_ICON_BOX = { w: 36, h: 24 };
const EDGE_ICON_INSET = 4;
const EDGE_ICON_STROKE_WIDTH = 2;

// The dash each line style's icon shows; the canvas's own dashes are too fine at icon size.
const LINE_STYLE_ICON_DASHES: Record<LineStyle, string | null> = {
  solid: null,
  dashed: '6 4',
  dotted: '0 4.5',
};

const LINE_STYLE_LABELS: Record<LineStyle, string> = {
  solid: 'Solid line',
  dashed: 'Dashed line',
  dotted: 'Dotted line',
};

const ARROWHEAD_LABELS: Record<Arrowhead, string> = {
  none: 'No head',
  arrow: 'Arrow',
  triangle: 'Triangle',
  diamond: 'Diamond',
  dot: 'Dot',
  bar: 'Bar',
};

export type EdgeEnd = 'start' | 'end';

const STROKE_WIDTH_LABELS: Record<StrokeWidth, string> = {
  thin: 'Thin stroke',
  medium: 'Medium stroke',
  thick: 'Thick stroke',
};

const FILL_PATTERN_LABELS: Record<RegionFillPattern, string> = {
  hachure: 'Hatched',
  'cross-hatch': 'Cross-hatched',
  dots: 'Dotted',
  solid: 'Solid',
  none: 'No background',
};

// The pattern icons sit inside a dashed outline, the way a region is drawn.
const FILL_ICON_OUTLINE_DASH = '3 2';
const FILL_ICON_LINE_GAP = 4.5;
const FILL_ICON_DOT_GAP = 4;
const FILL_ICON_DOT_RADIUS = 0.8;
const FILL_ICON_SOLID_OPACITY = '0.35';

const SHAPE_LABELS: Record<NodeShape, string> = {
  rectangle: 'Rectangle',
  rounded: 'Rounded rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
  hexagon: 'Hexagon',
  parallelogram: 'Parallelogram',
  cylinder: 'Cylinder',
};

const TEXT_SIZE_LABELS: Record<NodeTextSize, string> = {
  small: 'Small text',
  medium: 'Medium text',
  large: 'Large text',
  'x-large': 'Extra-large text',
};

// The letter each text size icon shows, at the medium size; each icon scales it like the canvas
// scales the node's text. It sits on a shared baseline so the sizes read as a row of steps.
const TEXT_SIZE_ICON_LETTER = 'A';
const TEXT_SIZE_ICON_MEDIUM_PX = 10;
const TEXT_SIZE_ICON_BASELINE_INSET = 2;

export function createTextSizePicker(container: HTMLElement, pick: (textSize: NodeTextSize) => void): ChoiceRow<NodeTextSize> {
  return createIconChoiceRow(container, NODE_TEXT_SIZES, (textSize) => TEXT_SIZE_LABELS[textSize], textSizeIcon, pick);
}

export function createShapePicker(container: HTMLElement, pick: (shape: NodeShape) => void): ChoiceRow<NodeShape> {
  return createIconChoiceRow(container, NODE_SHAPES, (shape) => SHAPE_LABELS[shape], shapeIcon, pick);
}

// Swatches show the slot through its theme token, so they always match what the canvas draws.
// A hex colour written into the layer by hand has no swatch of its own; while an edge carries
// one it is shown as an extra, chosen swatch so the editor never misreports the edge as default.
export function createColorSwatches(
  container: HTMLElement,
  pick: (color: string | null) => void,
  defaultLabel = 'Default colour',
): ChoiceRow<string | null> {
  const defaultSwatch = choiceButton(defaultLabel, () => pick(null));
  defaultSwatch.classList.add('swatch', 'swatch-default');
  const slotSwatches = LAYER_COLOR_SLOTS.map((slot) => {
    const swatch = choiceButton(slot, () => pick(slot));
    swatch.classList.add('swatch');
    swatch.dataset.choice = slot;
    swatch.style.setProperty('--swatch-color', `var(${layerColorSlotToken(slot)})`);
    return swatch;
  });
  const customSwatch = choiceButton('Custom colour', () => {});
  customSwatch.classList.add('swatch');
  customSwatch.hidden = true;
  container.replaceChildren(defaultSwatch, ...slotSwatches, customSwatch);
  return {
    fill(current) {
      markChosen(defaultSwatch, current == null);
      for (const swatch of slotSwatches) markChosen(swatch, swatch.dataset.choice === current);
      const isCustom = current != null && !isLayerColorSlot(current);
      customSwatch.hidden = !isCustom;
      customSwatch.title = isCustom ? current : '';
      if (isCustom) customSwatch.style.setProperty('--swatch-color', current);
      markChosen(customSwatch, isCustom);
    },
  };
}

export function createStrokeWidthPicker(container: HTMLElement, pick: (width: StrokeWidth) => void): ChoiceRow<StrokeWidth> {
  return createIconChoiceRow(container, STROKE_WIDTHS, (width) => STROKE_WIDTH_LABELS[width], strokeWidthIcon, pick);
}

export function createLineStylePicker(container: HTMLElement, pick: (line: LineStyle) => void): ChoiceRow<LineStyle> {
  return createIconChoiceRow(container, LINE_STYLES, (line) => LINE_STYLE_LABELS[line], lineStyleIcon, pick);
}

export function createArrowheadPicker(
  container: HTMLElement,
  end: EdgeEnd,
  pick: (head: Arrowhead) => void,
): ChoiceRow<Arrowhead> {
  return createIconChoiceRow(
    container,
    ARROWHEADS,
    (head) => `${ARROWHEAD_LABELS[head]} at the ${end}`,
    (head) => arrowheadIcon(head, end),
    pick,
  );
}

export function createFillPatternPicker(container: HTMLElement, pick: (pattern: RegionFillPattern) => void): ChoiceRow<RegionFillPattern> {
  return createIconChoiceRow(container, REGION_FILL_PATTERNS, (pattern) => FILL_PATTERN_LABELS[pattern], fillPatternIcon, pick);
}

function createIconChoiceRow<Choice extends string>(
  container: HTMLElement,
  choices: readonly Choice[],
  labelOf: (choice: Choice) => string,
  iconOf: (choice: Choice) => SVGSVGElement,
  pick: (choice: Choice) => void,
): ChoiceRow<Choice> {
  const buttons = choices.map((choice) => {
    const button = choiceButton(labelOf(choice), () => pick(choice));
    button.dataset.choice = choice;
    button.append(iconOf(choice));
    return button;
  });
  container.replaceChildren(...buttons);
  return {
    fill(current) {
      for (const button of buttons) markChosen(button, button.dataset.choice === current);
    },
  };
}

function choiceButton(label: string, onChoose: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'choice';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onChoose);
  return button;
}

function markChosen(button: HTMLButtonElement, chosen: boolean): void {
  button.classList.toggle('chosen', chosen);
  button.setAttribute('aria-pressed', String(chosen));
}

function strokeWidthIcon(width: StrokeWidth): SVGSVGElement {
  const svg = iconSvg();
  const middle = ICON_SIZE.h / 2;
  const line = document.createElementNS(SVG_NAMESPACE, 'path');
  line.setAttribute('d', `M ${ICON_INSET * 2} ${middle} L ${ICON_SIZE.w - ICON_INSET * 2} ${middle}`);
  line.setAttribute('stroke-width', String(STROKE_LINE_WIDTHS[width]));
  line.setAttribute('stroke-linecap', 'round');
  svg.append(line);
  return svg;
}

function lineStyleIcon(line: LineStyle): SVGSVGElement {
  const svg = edgeIconSvg();
  const dash = LINE_STYLE_ICON_DASHES[line];
  const stroke = edgeIconLine(EDGE_ICON_INSET, EDGE_ICON_BOX.w - EDGE_ICON_INSET);
  stroke.setAttribute('stroke-linecap', 'round');
  if (dash) stroke.setAttribute('stroke-dasharray', dash);
  svg.append(stroke);
  return svg;
}

// The line runs short of the head's end of the box, so even the longest head fits beside it.
function arrowheadIcon(head: Arrowhead, end: EdgeEnd): SVGSVGElement {
  const svg = edgeIconSvg();
  const middle = EDGE_ICON_BOX.h / 2;
  const left = { x: EDGE_ICON_INSET, y: middle };
  const right = { x: EDGE_ICON_BOX.w - EDGE_ICON_INSET, y: middle };
  const [tail, tip] = end === 'end' ? [left, right] : [right, left];
  svg.append(edgeIconLine(left.x, right.x));
  const outline = arrowheadOutline(head, tail, tip);
  if (!outline) return svg;
  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', arrowheadPathData(outline));
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  if (arrowheadIsFilled(outline)) path.classList.add('filled');
  svg.append(path);
  return svg;
}

function edgeIconSvg(): SVGSVGElement {
  const svg = iconSvg(EDGE_ICON_BOX);
  // Inline, because the choice buttons' stylesheet sets a width meant for the smaller icon box.
  svg.style.strokeWidth = String(EDGE_ICON_STROKE_WIDTH);
  return svg;
}

function edgeIconLine(fromX: number, toX: number): SVGPathElement {
  const middle = EDGE_ICON_BOX.h / 2;
  const line = document.createElementNS(SVG_NAMESPACE, 'path');
  line.setAttribute('d', `M ${fromX} ${middle} L ${toX} ${middle}`);
  return line;
}

function iconSvg(viewBox: { w: number; h: number } = ICON_SIZE): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewBox.w} ${viewBox.h}`);
  svg.setAttribute('width', String(ICON_SIZE.w));
  svg.setAttribute('height', String(ICON_SIZE.h));
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

function shapeIcon(shape: NodeShape): SVGSVGElement {
  const svg = iconSvg();
  const iconRect = { x: ICON_INSET, y: ICON_INSET, w: ICON_SIZE.w - 2 * ICON_INSET, h: ICON_SIZE.h - 2 * ICON_INSET };
  for (const data of outlinePathData(shapeOutline(shape, iconRect))) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', data);
    svg.append(path);
  }
  return svg;
}

function textSizeIcon(textSize: NodeTextSize): SVGSVGElement {
  const svg = iconSvg();
  const letter = document.createElementNS(SVG_NAMESPACE, 'text');
  letter.setAttribute('x', String(ICON_SIZE.w / 2));
  letter.setAttribute('y', String(ICON_SIZE.h - TEXT_SIZE_ICON_BASELINE_INSET));
  letter.setAttribute('text-anchor', 'middle');
  letter.setAttribute('font-size', String(TEXT_SIZE_ICON_MEDIUM_PX * NODE_TEXT_SCALES[textSize]));
  letter.textContent = TEXT_SIZE_ICON_LETTER;
  svg.append(letter);
  return svg;
}

function fillPatternIcon(pattern: RegionFillPattern): SVGSVGElement {
  const svg = iconSvg();
  const box = { x: ICON_INSET, y: ICON_INSET, w: ICON_SIZE.w - 2 * ICON_INSET, h: ICON_SIZE.h - 2 * ICON_INSET };
  const outline = svgRect(box);
  outline.setAttribute('stroke-dasharray', FILL_ICON_OUTLINE_DASH);
  svg.append(...fillPatternMarks(pattern, box), outline);
  return svg;
}

function fillPatternMarks(pattern: RegionFillPattern, box: Rect): SVGElement[] {
  switch (pattern) {
    case 'hachure':
      return [diagonalLinesPath(box, 1)];
    case 'cross-hatch':
      return [diagonalLinesPath(box, 1), diagonalLinesPath(box, -1)];
    case 'dots':
      return dotGrid(box);
    case 'solid':
      return [solidBox(box)];
    case 'none':
      return [];
  }
}

// Parallel lines y = slope·x + offset, one every gap of offset, each clipped to the box.
function diagonalLinesPath(box: Rect, slope: 1 | -1): SVGPathElement {
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const offsetsAtCorners = [box.x, right].flatMap((x) => [box.y, bottom].map((y) => y - slope * x));
  const firstOffset = Math.min(...offsetsAtCorners);
  const lastOffset = Math.max(...offsetsAtCorners);
  const segments: string[] = [];
  for (let offset = firstOffset + FILL_ICON_LINE_GAP; offset < lastOffset; offset += FILL_ICON_LINE_GAP) {
    const xAtTop = (box.y - offset) / slope;
    const xAtBottom = (bottom - offset) / slope;
    const fromX = Math.max(box.x, Math.min(xAtTop, xAtBottom));
    const toX = Math.min(right, Math.max(xAtTop, xAtBottom));
    if (toX > fromX) segments.push(`M ${fromX} ${slope * fromX + offset} L ${toX} ${slope * toX + offset}`);
  }
  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', segments.join(' '));
  return path;
}

function dotGrid(box: Rect): SVGCircleElement[] {
  const dots: SVGCircleElement[] = [];
  for (let y = box.y + FILL_ICON_DOT_GAP / 2; y < box.y + box.h; y += FILL_ICON_DOT_GAP) {
    for (let x = box.x + FILL_ICON_DOT_GAP / 2; x < box.x + box.w; x += FILL_ICON_DOT_GAP) {
      const dot = document.createElementNS(SVG_NAMESPACE, 'circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      dot.setAttribute('r', String(FILL_ICON_DOT_RADIUS));
      dot.classList.add('filled');
      dots.push(dot);
    }
  }
  return dots;
}

function solidBox(box: Rect): SVGRectElement {
  const fill = svgRect(box);
  fill.setAttribute('fill-opacity', FILL_ICON_SOLID_OPACITY);
  fill.setAttribute('stroke', 'none');
  fill.classList.add('filled');
  return fill;
}

function svgRect(box: Rect): SVGRectElement {
  const rect = document.createElementNS(SVG_NAMESPACE, 'rect');
  rect.setAttribute('x', String(box.x));
  rect.setAttribute('y', String(box.y));
  rect.setAttribute('width', String(box.w));
  rect.setAttribute('height', String(box.h));
  return rect;
}
