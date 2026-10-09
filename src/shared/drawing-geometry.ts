// How a drawing's geometry is carried by a move or a resize, and how its coordinates are stored.
// Every kind of drawing goes through here, so a stroke and a text grouped together move and
// stretch alike.

import type { Rect } from './flow-format.js';

// Stored to a tenth of a unit: finer than any screen shows, and it keeps a drawing's line short.
const COORDINATE_PRECISION = 10;

export interface DrawingPoint {
  x: number;
  y: number;
}

// Each axis scaled, then shifted — `x' = x · scaleX + x`. Style (a stroke's line width) is not
// geometry, so a resized drawing keeps its own.
export interface DrawingTransform {
  scaleX: number;
  scaleY: number;
  x: number;
  y: number;
}

export const IDENTITY_TRANSFORM: DrawingTransform = { scaleX: 1, scaleY: 1, x: 0, y: 0 };

export function translationBy(offset: DrawingPoint): DrawingTransform {
  return { scaleX: 1, scaleY: 1, x: offset.x, y: offset.y };
}

export function isIdentityTransform(transform: DrawingTransform): boolean {
  return transform.scaleX === 1 && transform.scaleY === 1 && transform.x === 0 && transform.y === 0;
}

// Whether the transform changes a drawing's proportions rather than only its scale and place.
export function isStretch(transform: DrawingTransform): boolean {
  return transform.scaleX !== transform.scaleY;
}

export function applyDrawingTransform(point: DrawingPoint, transform: DrawingTransform): DrawingPoint {
  return { x: point.x * transform.scaleX + transform.x, y: point.y * transform.scaleY + transform.y };
}

// Scales are never negative — a resize floors them — so the corners stay in order.
export function transformedRect(rect: Rect, transform: DrawingTransform): Rect {
  const topLeft = applyDrawingTransform(rect, transform);
  return { x: topLeft.x, y: topLeft.y, w: rect.w * transform.scaleX, h: rect.h * transform.scaleY };
}

export function roundCoordinate(value: number): number {
  return Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
