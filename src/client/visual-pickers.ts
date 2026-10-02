// The canvas-layer controls in the node and edge editors: a row of shape buttons and a row of
// colour swatches. Each is a one-click choice that writes immediately, like a checkbox, and is
// refilled from the layer whenever the editor is.

import {
  EDGE_COLOR_SLOTS,
  NODE_SHAPES,
  isEdgeColorSlot,
  type NodeShape,
} from '../shared/canvas-layer.js';
import { outlinePathData, shapeOutline } from './canvas/node-shapes.js';
import { edgeColorSlotToken } from './theme.js';

export interface ChoiceRow<Choice> {
  fill(current: Choice): void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ICON_SIZE = { w: 24, h: 16 };
const ICON_INSET = 1.5;

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
  const slotSwatches = EDGE_COLOR_SLOTS.map((slot) => {
    const swatch = choiceButton(slot, () => pick(slot));
    swatch.classList.add('swatch');
    swatch.dataset.choice = slot;
    swatch.style.setProperty('--swatch-color', `var(${edgeColorSlotToken(slot)})`);
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
      const isCustom = current != null && !isEdgeColorSlot(current);
      customSwatch.hidden = !isCustom;
      customSwatch.title = isCustom ? current : '';
      if (isCustom) customSwatch.style.setProperty('--swatch-color', current);
      markChosen(customSwatch, isCustom);
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

function shapeIcon(shape: NodeShape): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', `0 0 ${ICON_SIZE.w} ${ICON_SIZE.h}`);
  svg.setAttribute('width', String(ICON_SIZE.w));
  svg.setAttribute('height', String(ICON_SIZE.h));
  svg.setAttribute('aria-hidden', 'true');
  const iconRect = { x: ICON_INSET, y: ICON_INSET, w: ICON_SIZE.w - 2 * ICON_INSET, h: ICON_SIZE.h - 2 * ICON_INSET };
  for (const data of outlinePathData(shapeOutline(shape, iconRect))) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', data);
    svg.append(path);
  }
  return svg;
}
