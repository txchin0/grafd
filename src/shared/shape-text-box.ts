// How much of a node's rectangle its shape leaves for text: the box its title and description are
// laid out in so none of them spill past a pointed or curved outline, and the proportions those
// outlines are drawn with. Shared because text has to fit the shape wherever a node is sized — by
// the painter (client/canvas/node-shapes.ts), the layout, the score and the role styling alike.

import type { NodeShape } from './canvas-layer.js';
import type { Rect } from './flow-format.js';

// How far a hexagon's points and a parallelogram's slant reach in, as a fraction of the width,
// capped by the height so a wide, short node keeps a recognisable shape.
const HEXAGON_POINT_FRACTION = 0.18;
const PARALLELOGRAM_SLANT_FRACTION = 0.16;
// The height of a cylinder's elliptical top, as a fraction of the node height.
const CYLINDER_CAP_FRACTION = 0.22;
const CYLINDER_MAX_CAP = 18;
// The largest centred box that stays inside each curved or pointed outline.
const ELLIPSE_TEXT_FRACTION = Math.SQRT1_2;
const DIAMOND_TEXT_WIDTH_FRACTION = 0.6;
const DIAMOND_TEXT_HEIGHT_FRACTION = 0.4;

export function hexagonPointDepth(rect: Rect): number {
  return Math.min(rect.w * HEXAGON_POINT_FRACTION, rect.h / 2);
}

export function parallelogramSlant(rect: Rect): number {
  return Math.min(rect.w * PARALLELOGRAM_SLANT_FRACTION, rect.h / 2);
}

export function cylinderCapHeight(rect: Rect): number {
  return Math.min(rect.h * CYLINDER_CAP_FRACTION, CYLINDER_MAX_CAP);
}

// The centred box a node's title, description and trait marks are laid out in.
export function shapeTextBox(shape: NodeShape, rect: Rect): Rect {
  switch (shape) {
    case 'ellipse':
      return centredBox(rect, rect.w * ELLIPSE_TEXT_FRACTION, rect.h * ELLIPSE_TEXT_FRACTION);
    case 'diamond':
      return centredBox(rect, rect.w * DIAMOND_TEXT_WIDTH_FRACTION, rect.h * DIAMOND_TEXT_HEIGHT_FRACTION);
    case 'hexagon':
      return centredBox(rect, rect.w - 2 * hexagonPointDepth(rect), rect.h);
    case 'parallelogram':
      return centredBox(rect, rect.w - 2 * parallelogramSlant(rect), rect.h);
    case 'cylinder': {
      const cap = cylinderCapHeight(rect);
      return { x: rect.x, y: rect.y + cap, w: rect.w, h: rect.h - cap };
    }
    case 'rounded':
    case 'rectangle':
      return rect;
  }
}

// Whether a point lies inside the outline a node is drawn with, rather than merely inside its
// rectangle: what an edge passing a diamond's empty corner has to be judged by. A cylinder and a
// rounded rectangle are taken as their rectangle; their corners give away a few pixels at most.
export function shapeContainsPoint(shape: NodeShape, rect: Rect, point: { x: number; y: number }): boolean {
  const insideRect = point.x > rect.x && point.x < rect.x + rect.w && point.y > rect.y && point.y < rect.y + rect.h;
  if (!insideRect) return false;
  const fromCentreX = Math.abs(point.x - (rect.x + rect.w / 2)) / (rect.w / 2);
  const fromCentreY = Math.abs(point.y - (rect.y + rect.h / 2)) / (rect.h / 2);
  switch (shape) {
    case 'ellipse':
      return fromCentreX ** 2 + fromCentreY ** 2 < 1;
    case 'diamond':
      return fromCentreX + fromCentreY < 1;
    case 'hexagon': {
      const pointShare = hexagonPointDepth(rect) / (rect.w / 2);
      return fromCentreX < 1 - pointShare * fromCentreY;
    }
    case 'parallelogram': {
      const slant = parallelogramSlant(rect);
      const shift = slant * ((rect.y + rect.h - point.y) / rect.h);
      return point.x > rect.x + shift && point.x < rect.x + rect.w - slant + shift;
    }
    case 'cylinder':
    case 'rounded':
    case 'rectangle':
      return true;
  }
}

function centredBox(rect: Rect, width: number, height: number): Rect {
  return { x: rect.x + (rect.w - width) / 2, y: rect.y + (rect.h - height) / 2, w: width, h: height };
}
