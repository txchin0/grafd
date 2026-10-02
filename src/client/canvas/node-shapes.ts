// The geometry of a node's shape inside its rectangle: the outline the painter draws, where a
// ray from inside leaves that outline (so edges and ports sit on the shape rather than on its
// bounding box), and the box its text has to fit in. Pure — the rectangle stays the node's
// layout and hit area; the shape only changes how it is drawn and where edges meet it.

import type { NodeShape } from '../../shared/canvas-layer.js';
import type { Rect } from '../../shared/flow-format.js';
import { offsetAlong, rectBorderPointFrom, rectCenter, unitVectorBetween, type Point } from '../geometry.js';

const ROUNDED_CORNER_RADIUS = 16;
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

export type ShapeOutline =
  | { kind: 'rect'; rect: Rect; radius: number }
  | { kind: 'ellipse'; center: Point; width: number; height: number }
  | { kind: 'polygon'; points: Point[] }
  | { kind: 'cylinder'; rect: Rect; capHeight: number };

export function shapeOutline(shape: NodeShape, rect: Rect): ShapeOutline {
  switch (shape) {
    case 'rounded':
      return { kind: 'rect', rect, radius: Math.min(ROUNDED_CORNER_RADIUS, rect.w / 3, rect.h / 3) };
    case 'ellipse':
      return { kind: 'ellipse', center: rectCenter(rect), width: rect.w, height: rect.h };
    case 'diamond':
    case 'hexagon':
    case 'parallelogram':
      return { kind: 'polygon', points: polygonPoints(shape, rect) };
    case 'cylinder':
      return { kind: 'cylinder', rect, capHeight: cylinderCapHeight(rect) };
    case 'rectangle':
      return { kind: 'rect', rect, radius: 0 };
  }
}

function polygonPoints(shape: 'diamond' | 'hexagon' | 'parallelogram', rect: Rect): Point[] {
  const { x, y, w, h } = rect;
  const right = x + w;
  const bottom = y + h;
  const middle = y + h / 2;
  if (shape === 'diamond') {
    return [{ x: x + w / 2, y }, { x: right, y: middle }, { x: x + w / 2, y: bottom }, { x, y: middle }];
  }
  if (shape === 'hexagon') {
    const point = hexagonPointDepth(rect);
    return [
      { x: x + point, y },
      { x: right - point, y },
      { x: right, y: middle },
      { x: right - point, y: bottom },
      { x: x + point, y: bottom },
      { x, y: middle },
    ];
  }
  const slant = parallelogramSlant(rect);
  return [{ x: x + slant, y }, { x: right, y }, { x: right - slant, y: bottom }, { x, y: bottom }];
}

function hexagonPointDepth(rect: Rect): number {
  return Math.min(rect.w * HEXAGON_POINT_FRACTION, rect.h / 2);
}

function parallelogramSlant(rect: Rect): number {
  return Math.min(rect.w * PARALLELOGRAM_SLANT_FRACTION, rect.h / 2);
}

function cylinderCapHeight(rect: Rect): number {
  return Math.min(rect.h * CYLINDER_CAP_FRACTION, CYLINDER_MAX_CAP);
}

// Where a ray cast from `origin` (inside the shape) along `direction` leaves the outline. The
// rounded rectangle and the cylinder are close enough to their rectangle that edges meeting the
// rectangle read as touching them.
// Where the outline is crossed on the way from the rectangle's centre toward `toward`.
export function shapeBorderPointToward(shape: NodeShape, rect: Rect, toward: Point): Point {
  const center = rectCenter(rect);
  return shapeBorderPointFrom(shape, rect, center, unitVectorBetween(center, toward));
}

export function shapeBorderPointFrom(shape: NodeShape, rect: Rect, origin: Point, direction: Point): Point {
  if (direction.x === 0 && direction.y === 0) return origin;
  const outline = shapeOutline(shape, rect);
  if (outline.kind === 'ellipse') return ellipseExit(outline, origin, direction) ?? rectBorderPointFrom(rect, origin, direction);
  if (outline.kind === 'polygon') return polygonExit(outline.points, origin, direction) ?? rectBorderPointFrom(rect, origin, direction);
  return rectBorderPointFrom(rect, origin, direction);
}

function ellipseExit(
  ellipse: { center: Point; width: number; height: number },
  origin: Point,
  direction: Point,
): Point | null {
  const radiusX = ellipse.width / 2;
  const radiusY = ellipse.height / 2;
  if (radiusX <= 0 || radiusY <= 0) return null;
  // Solve |(origin + t·direction − center) / radii| = 1 for the larger root.
  const px = (origin.x - ellipse.center.x) / radiusX;
  const py = (origin.y - ellipse.center.y) / radiusY;
  const dx = direction.x / radiusX;
  const dy = direction.y / radiusY;
  const a = dx * dx + dy * dy;
  const b = 2 * (px * dx + py * dy);
  const c = px * px + py * py - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const distance = (-b + Math.sqrt(discriminant)) / (2 * a);
  return distance < 0 ? null : offsetAlong(origin, direction, distance);
}

// The nearest crossing ahead of the origin. From inside a convex outline there is exactly one;
// an origin pushed just outside (a far lane on a narrow point) still lands on the outline.
function polygonExit(points: Point[], origin: Point, direction: Point): Point | null {
  let nearest = Infinity;
  points.forEach((start, index) => {
    const end = points[(index + 1) % points.length];
    const distance = rayHitsSegment(origin, direction, start, end);
    if (distance != null && distance < nearest) nearest = distance;
  });
  return Number.isFinite(nearest) ? offsetAlong(origin, direction, nearest) : null;
}

function rayHitsSegment(origin: Point, direction: Point, start: Point, end: Point): number | null {
  const edgeX = end.x - start.x;
  const edgeY = end.y - start.y;
  const denominator = direction.x * edgeY - direction.y * edgeX;
  if (Math.abs(denominator) < 1e-9) return null;
  const toStartX = start.x - origin.x;
  const toStartY = start.y - origin.y;
  const alongRay = (toStartX * edgeY - toStartY * edgeX) / denominator;
  const alongEdge = (toStartX * direction.y - toStartY * direction.x) / denominator;
  if (alongRay < 0 || alongEdge < 0 || alongEdge > 1) return null;
  return alongRay;
}

// The centred box a node's title, description and trait marks are laid out in, so none of
// them spill past a pointed or curved outline.
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

function centredBox(rect: Rect, width: number, height: number): Rect {
  return { x: rect.x + (rect.w - width) / 2, y: rect.y + (rect.h - height) / 2, w: width, h: height };
}

// The outline as SVG path data, one entry per stroke, back to front. The painter hands the
// curved outlines to rough.js this way, and the shape picker draws its icons from the same data,
// so a preview never disagrees with the canvas.
export function outlinePathData(outline: ShapeOutline): string[] {
  switch (outline.kind) {
    case 'rect':
      return [roundedRectPath(outline.rect, outline.radius)];
    case 'ellipse':
      return [ellipsePath(outline.center, outline.width / 2, outline.height / 2)];
    case 'polygon':
      return [polygonPath(outline.points)];
    case 'cylinder':
      return cylinderPaths(outline.rect, outline.capHeight);
  }
}

function roundedRectPath(rect: Rect, radius: number): string {
  const { x, y, w, h } = rect;
  const right = x + w;
  const bottom = y + h;
  if (radius <= 0) return `M ${x} ${y} H ${right} V ${bottom} H ${x} Z`;
  return `M ${x + radius} ${y} H ${right - radius} A ${radius} ${radius} 0 0 1 ${right} ${y + radius} `
    + `V ${bottom - radius} A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom} `
    + `H ${x + radius} A ${radius} ${radius} 0 0 1 ${x} ${bottom - radius} `
    + `V ${y + radius} A ${radius} ${radius} 0 0 1 ${x + radius} ${y} Z`;
}

function ellipsePath(center: Point, radiusX: number, radiusY: number): string {
  const left = center.x - radiusX;
  const right = center.x + radiusX;
  return `M ${left} ${center.y} A ${radiusX} ${radiusY} 0 1 0 ${right} ${center.y} `
    + `A ${radiusX} ${radiusY} 0 1 0 ${left} ${center.y} Z`;
}

function polygonPath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ') + ' Z';
}

// The body runs from the middle of the lid round the front of the base; the lid is then drawn
// whole over it, which is what shows its front rim.
function cylinderPaths(rect: Rect, capHeight: number): string[] {
  const { x, y, w, h } = rect;
  const radiusX = w / 2;
  const radiusY = capHeight / 2;
  const lid = y + radiusY;
  const base = y + h - radiusY;
  const body = `M ${x} ${lid} L ${x} ${base} A ${radiusX} ${radiusY} 0 0 0 ${x + w} ${base} `
    + `L ${x + w} ${lid} A ${radiusX} ${radiusY} 0 0 0 ${x} ${lid} Z`;
  return [body, ellipsePath({ x: x + radiusX, y: lid }, radiusX, radiusY)];
}
