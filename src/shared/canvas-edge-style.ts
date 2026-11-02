// How an edge is drawn: its colour, the line it is drawn with, the heads at either end, the
// bend a user dragged into it, and the angle either end is pinned to. This module owns an edge's canvas-layer entry; canvas-layer.ts only
// keys it, re-keys it with the edge and copies it with the edge.
//
// A default is never written: an entry holds only what differs from how the edge would be drawn
// anyway. An error edge is drawn dashed by default, so what counts as a default depends on the
// edge's kind, which is why both reads and writes are told it.

import { isLayerColor, setEntryField, type CanvasLayer, type LayerColorSlot } from './canvas-layer.js';
import type { Point } from './rect-math.js';

export type EdgeKind = 'flow' | 'error';

export const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

export const ARROWHEADS = ['none', 'arrow', 'triangle', 'diamond', 'dot', 'bar'] as const;
export type Arrowhead = (typeof ARROWHEADS)[number];

// Where a bent edge passes, relative to the chord between its endpoints' centres:
// `fromCenter + along · d + across · perpendicular(d)` with `d = toCenter − fromCenter`. Both are
// fractions of the chord, so a bend keeps its shape however the two nodes are moved.
export interface EdgeBend {
  along: number;
  across: number;
}

// `along` past either end would fold the edge back on itself.
const MIN_BEND_ALONG = 0;
const MAX_BEND_ALONG = 1;
// Stored to a thousandth of the chord: finer than any screen shows, and it keeps diffs quiet.
const BEND_PRECISION = 1000;

// Where a pinned end meets its node: the angle, in degrees, of the ray from the node's centre that
// it leaves along — clockwise from straight up, so 90 is the right side and 180 the bottom. A
// geometric angle rather than a fraction of the outline, so the end stays on the side it was put
// on however the node is resized.
const FULL_TURN_DEGREES = 360;
// Pinned ends snap to the sides and the corners' diagonals when dragged this near them.
const ANCHOR_SNAP_STEP_DEGREES = 45;
const ANCHOR_SNAP_DEGREES = 6;

export type EdgeEnd = 'start' | 'end';

// The colour slot that marks an edge as leading into an error, wherever one has to be written —
// the theme's own error colour has no slot, so a layer cannot name it.
export const ERROR_EDGE_COLOR: LayerColorSlot = 'red';

export interface EdgeStyle {
  // Null draws the edge kind's own colour, which the theme decides.
  color: string | null;
  line: LineStyle;
  startHead: Arrowhead;
  endHead: Arrowhead;
  bend: EdgeBend | null;
  // Null leaves the end where the edge's route puts it.
  startAngle: number | null;
  endAngle: number | null;
}

// A field set to null returns it to its default; a field left out is untouched.
export type EdgeStylePatch = { [Field in keyof EdgeStyle]?: EdgeStyle[Field] | null };

const EDGE_STYLE_FIELDS = ['color', 'line', 'startHead', 'endHead', 'bend', 'startAngle', 'endAngle'] as const satisfies readonly (keyof EdgeStyle)[];

export function defaultEdgeStyle(kind: EdgeKind): EdgeStyle {
  return {
    color: null,
    line: kind === 'error' ? 'dashed' : 'solid',
    startHead: 'none',
    endHead: 'arrow',
    bend: null,
    startAngle: null,
    endAngle: null,
  };
}

export function angleFieldOf(end: EdgeEnd): 'startAngle' | 'endAngle' {
  return end === 'start' ? 'startAngle' : 'endAngle';
}

export function isLineStyle(value: unknown): value is LineStyle {
  return (LINE_STYLES as readonly unknown[]).includes(value);
}

export function isArrowhead(value: unknown): value is Arrowhead {
  return (ARROWHEADS as readonly unknown[]).includes(value);
}

// What an edge's label pill shows: its own label, or for an error edge without one, what it is.
export function shownEdgeLabel(label: string | null, kind: EdgeKind): string | null {
  return label ?? (kind === 'error' ? 'on error' : null);
}

export function clampBendAlong(along: number): number {
  return Math.min(MAX_BEND_ALONG, Math.max(MIN_BEND_ALONG, along));
}

// The two directions of the arithmetic a stored bend means — where a bend puts the edge's middle,
// and which bend passes through a point — kept together so nothing else has to know the chord
// convention above. Null for a chord of no length (two nodes stacked on one centre), which has
// nothing to measure against. `along` is trusted as given in the one, and clamped in the other, so
// past either end of the chord a bend tracks the end rather than folding the edge back on itself.
export function bendPointOn(bend: EdgeBend, fromCenter: Point, toCenter: Point): Point | null {
  const chord = chordBetween(fromCenter, toCenter);
  if (!chord) return null;
  return {
    x: fromCenter.x + bend.along * chord.vector.x + bend.across * chord.across.x,
    y: fromCenter.y + bend.along * chord.vector.y + bend.across * chord.across.y,
  };
}

export function bendThroughPoint(point: Point, fromCenter: Point, toCenter: Point): EdgeBend | null {
  const chord = chordBetween(fromCenter, toCenter);
  if (!chord) return null;
  const offset = { x: point.x - fromCenter.x, y: point.y - fromCenter.y };
  return {
    along: clampBendAlong((offset.x * chord.vector.x + offset.y * chord.vector.y) / chord.squaredLength),
    across: (offset.x * chord.across.x + offset.y * chord.across.y) / chord.squaredLength,
  };
}

function chordBetween(fromCenter: Point, toCenter: Point): { vector: Point; across: Point; squaredLength: number } | null {
  const vector = { x: toCenter.x - fromCenter.x, y: toCenter.y - fromCenter.y };
  const squaredLength = vector.x * vector.x + vector.y * vector.y;
  if (squaredLength === 0) return null;
  return { vector, across: { x: -vector.y, y: vector.x }, squaredLength };
}

// The unit vector a pinned end leaves its node's centre along.
export function anchorDirectionOf(angle: number): Point {
  const radians = (angle * Math.PI) / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

// The angle of the ray from `center` through `point`; null when they coincide.
export function angleToward(center: Point, point: Point): number | null {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  if (dx === 0 && dy === 0) return null;
  return normalizedAngle((Math.atan2(dx, -dy) * 180) / Math.PI);
}

// Near a side or a diagonal the angle lands exactly on it; elsewhere it is kept to a whole degree.
export function snapAnchorAngle(angle: number): number {
  const nearestStep = Math.round(angle / ANCHOR_SNAP_STEP_DEGREES) * ANCHOR_SNAP_STEP_DEGREES;
  const snapped = Math.abs(angle - nearestStep) <= ANCHOR_SNAP_DEGREES ? nearestStep : Math.round(angle);
  return normalizedAngle(snapped);
}

function normalizedAngle(angle: number): number {
  return ((angle % FULL_TURN_DEGREES) + FULL_TURN_DEGREES) % FULL_TURN_DEGREES;
}

// An angle is any finite number of degrees, read into one turn; anything else leaves the end free.
export function readEdgeAngle(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? normalizedAngle(raw) : null;
}

// A bend is written as `[along, across]`; anything else reads as no bend.
export function readEdgeBend(raw: unknown): EdgeBend | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [along, across] = raw;
  if (!Number.isFinite(along) || !Number.isFinite(across)) return null;
  return { along: clampBendAlong(along), across };
}

// Every field resolved: what the entry says where it says something valid, the kind's default
// everywhere else.
export function edgeStyleOf(layer: CanvasLayer | null, edgeKey: string | null, kind: EdgeKind): EdgeStyle {
  const defaults = defaultEdgeStyle(kind);
  const entry = layer && edgeKey != null ? layer.edges[edgeKey] : undefined;
  if (!entry) return defaults;
  return {
    color: isLayerColor(entry.color) ? entry.color : defaults.color,
    line: isLineStyle(entry.line) ? entry.line : defaults.line,
    startHead: isArrowhead(entry.startHead) ? entry.startHead : defaults.startHead,
    endHead: isArrowhead(entry.endHead) ? entry.endHead : defaults.endHead,
    bend: readEdgeBend(entry.bend),
    startAngle: readEdgeAngle(entry.startAngle),
    endAngle: readEdgeAngle(entry.endAngle),
  };
}

export function setEdgeStyle(layer: CanvasLayer, edgeKey: string, patch: EdgeStylePatch, kind: EdgeKind): void {
  const defaults = defaultEdgeStyle(kind);
  for (const field of EDGE_STYLE_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const isDefault = value === null || value === defaults[field];
    setEntryField(layer.edges, edgeKey, field, isDefault ? null : storedFieldValue(value));
  }
}

// A bend is the one field held as an object; it is written as a rounded pair. An angle is written
// to a whole degree, within one turn.
function storedFieldValue(value: NonNullable<EdgeStyle[keyof EdgeStyle]>): unknown {
  if (typeof value === 'object') return storedBend(value);
  if (typeof value === 'number') return normalizedAngle(Math.round(value));
  return value;
}

function storedBend(bend: EdgeBend): [number, number] {
  return [roundForStorage(bend.along), roundForStorage(bend.across)];
}

function roundForStorage(value: number): number {
  return Math.round(value * BEND_PRECISION) / BEND_PRECISION;
}
