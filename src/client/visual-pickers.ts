// The canvas-layer controls in the node and edge editors and the draw tool's pen: rows of shape
// buttons, colour swatches and stroke widths. Each is a one-click choice that takes effect
// immediately, like a checkbox, and is refilled whenever its owner is.

import {
  LAYER_COLOR_SLOTS,
  NODE_SHAPES,
  isLayerColorSlot,
  type NodeShape,
} from '../shared/canvas-layer.js';
import { STROKE_LINE_WIDTHS, STROKE_WIDTHS, type StrokeWidth } from '../shared/canvas-drawings.js';
import { outlinePathData, shapeOutline } from './canvas/node-shapes.js';
import { layerColorSlotToken } from './theme.js';

export interface ChoiceRow<Choice> {
  fill(current: Choice): void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ICON_SIZE = { w: 24, h: 16 };
const ICON_INSET = 1.5;

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
  const buttons = NODE_SHAPES.map((shape) => {
    const button = choiceButton(SHAPE_LABELS[shape], () => pick(shape));
    button.dataset.choice = shape;
    button.append(shapeIcon(shape));
    return button;
  });
  container.replaceChildren(...buttons);
  return {
    fill(current) {
      for (const button of buttons) markChosen(button, button.dataset.choice === current);
    },
  };
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
  const buttons = STROKE_WIDTHS.map((width) => {
    const button = choiceButton(STROKE_WIDTH_LABELS[width], () => pick(width));
    button.dataset.choice = width;
    button.append(strokeWidthIcon(width));
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

function iconSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', `0 0 ${ICON_SIZE.w} ${ICON_SIZE.h}`);
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
