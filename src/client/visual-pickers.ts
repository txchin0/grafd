// The canvas-layer controls in the node and edge editors and the draw tool's pen: rows of shape
// buttons, colour swatches, line styles, arrowheads and stroke widths. Each is a one-click choice that takes effect
// immediately, like a checkbox, and is refilled whenever its owner is.

import {
  LAYER_COLOR_SLOTS,
  NODE_SHAPES,
  isLayerColorSlot,
  type NodeShape,
} from '../shared/canvas-layer.js';
import { ARROWHEADS, LINE_STYLES, type Arrowhead, type LineStyle } from '../shared/canvas-edge-style.js';
import { STROKE_LINE_WIDTHS, STROKE_WIDTHS, type StrokeWidth } from '../shared/canvas-drawings.js';
import { arrowheadIsFilled, arrowheadOutline, arrowheadPathData } from './canvas/arrowheads.js';
import { outlinePathData, shapeOutline } from './canvas/node-shapes.js';
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

const SHAPE_LABELS: Record<NodeShape, string> = {
  rectangle: 'Rectangle',
  rounded: 'Rounded rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
  hexagon: 'Hexagon',
  parallelogram: 'Parallelogram',
  cylinder: 'Cylinder',
};

export function createShapePicker(container: HTMLElement, pick: (shape: NodeShape) => void): ChoiceRow<NodeShape> {
  return createIconChoiceRow(container, NODE_SHAPES, (shape) => SHAPE_LABELS[shape], shapeIcon, pick);
}

// Swatches show the slot through its theme token, so they always match what the canvas draws.
// A hex colour written into the layer by hand has no swatch of its own; while an edge carries
// one it is shown as an extra, chosen swatch so the editor never misreports the edge as default.
export function createColorSwatches(container: HTMLElement, pick: (color: string | null) => void): ChoiceRow<string | null> {
  const defaultSwatch = choiceButton('Default colour', () => pick(null));
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
