import type { CanvasView, TitlePlacement } from './canvas/canvas-view.js';
import { handFontAt } from './canvas/node-metrics.js';

// Deeply nested or zoomed-out titles are drawn far too small to type into, so the overlay stops
// shrinking well before the canvas text does.
const MIN_FONT_PX = 11;
const MIN_WIDTH_PX = 90;
const LINE_BOX_RATIO = 1.6;

interface InlineTitleBox {
  left: number;
  top: number;
  width: number;
  height: number;
  font: string;
  textAlign: 'center' | 'left';
  color: string;
}

function inlineTitleBox(view: CanvasView, placement: TitlePlacement): InlineTitleBox {
  const band = view.worldRectToScreen(placement.rect);
  const fontPx = Math.max(MIN_FONT_PX, placement.fontPx * placement.screenScale);
  const width = Math.max(band.w, MIN_WIDTH_PX);
  const height = Math.max(band.h, fontPx * LINE_BOX_RATIO);
  const left = placement.align === 'center'
    ? band.x + band.w / 2 - width / 2
    : band.x;
  return {
    left: Math.round(left),
    top: Math.round(band.y + band.h / 2 - height / 2),
    width: Math.round(width),
    height: Math.round(height),
    font: handFontAt(fontPx, 600),
    textAlign: placement.align,
    color: placement.color,
  };
}

function applyTypography(input: HTMLInputElement, box: InlineTitleBox): void {
  input.style.width = `${box.width}px`;
  input.style.height = `${box.height}px`;
  input.style.font = box.font;
  input.style.textAlign = box.textAlign;
  input.style.color = box.color;
}

// The overlay's positioned element and the input whose typography tracks the canvas ink: the node
// title editor positions the input itself, the region name editor positions its panel instead and
// styles the input inside it. Both apply the same box, so they share the positioning core.
function positionInlineTitle(
  positioned: HTMLElement,
  input: HTMLInputElement,
  view: CanvasView,
  placement: TitlePlacement,
): void {
  const box = inlineTitleBox(view, placement);
  positioned.style.left = `${box.left}px`;
  positioned.style.top = `${box.top}px`;
  applyTypography(input, box);
}

export function positionInlineTitleInput(
  input: HTMLInputElement,
  view: CanvasView,
  placement: TitlePlacement,
): void {
  positionInlineTitle(input, input, view, placement);
}

export function positionInlineTitlePanel(
  panel: HTMLElement,
  input: HTMLInputElement,
  view: CanvasView,
  placement: TitlePlacement,
): void {
  positionInlineTitle(panel, input, view, placement);
}
