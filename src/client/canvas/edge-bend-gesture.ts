// A bend drag: where a press grabs an edge's bend, and the bend each pointer move gives it. Pure —
// the view converts the pointer into the edge's model coordinates and holds the gesture; this
// decides what the gesture means.

import type { EdgeBend } from '../../shared/canvas-edge-style.js';
import { edgeIdentityOf, type ModelEdge } from '../flow-doc.js';
import { distanceBetween, rectContains, type Point } from '../geometry.js';
import { bendThrough, canBendAlong, distanceFromChord } from './edge-bend.js';
import type { EdgeBendOverrides } from './edge-layout.js';
import type { EdgeChord, EdgeGeometry } from './edge-path.js';

// Screen pixels: how near an unlabelled edge's grip a press must land to bend the edge, and how
// near the chord a dragged bend straightens instead.
const GRIP_HIT_RADIUS_PX = 9;
const STRAIGHTEN_SNAP_PX = 8;

export interface EdgeBendGesture {
  type: 'edge-bend';
  edge: ModelEdge;
  // Measured once, at the press: nothing a bend drag does moves the edge's nodes.
  chord: EdgeChord;
  // From the press to the grip, in the edge's model coordinates. A label grabbed near one end
  // keeps that offset, rather than jumping its centre under the pointer.
  grabOffset: Point;
  startScreen: Point;
  moved: boolean;
  // Null while the edge is dragged back onto its chord, which straightens it.
  bend: EdgeBend | null;
}

// Where a press grabs an edge's bend: its label, or the grip at the middle of an unlabelled edge.
// A self-loop has no chord to bend against, so neither part of it is a grip. `local` is in the
// coordinates of the model drawing the edge, and `screenScale` is the scale that model is drawn at.
export function gripContains(geometry: EdgeGeometry, local: Point, screenScale: number): boolean {
  if (!geometry.chord || !canBendAlong(geometry.chord)) return false;
  if (geometry.labelRect) return rectContains(geometry.labelRect, local);
  return distanceBetween(local, geometry.grip) * screenScale <= GRIP_HIT_RADIUS_PX;
}

export function beginEdgeBend(edge: ModelEdge, geometry: EdgeGeometry, local: Point, screen: Point): EdgeBendGesture | null {
  if (!geometry.chord) return null;
  return {
    type: 'edge-bend',
    edge,
    chord: geometry.chord,
    grabOffset: { x: geometry.grip.x - local.x, y: geometry.grip.y - local.y },
    startScreen: screen,
    moved: false,
    bend: null,
  };
}

// Whether the move changed what the gesture would write: until the pointer has travelled past the
// drag threshold, the press is still a click.
export function extendEdgeBend(
  gesture: EdgeBendGesture,
  local: Point,
  screenScale: number,
  screen: Point,
  dragThresholdPx: number,
): boolean {
  if (!gesture.moved && distanceBetween(screen, gesture.startScreen) < dragThresholdPx) return false;
  gesture.moved = true;
  const grip = { x: local.x + gesture.grabOffset.x, y: local.y + gesture.grabOffset.y };
  const isOnChord = distanceFromChord(grip, gesture.chord) * screenScale < STRAIGHTEN_SNAP_PX;
  gesture.bend = isOnChord ? null : bendThrough(grip, gesture.chord);
  return true;
}

// The bend to paint before anything is written, once the press has become a drag.
export function bendOverridesOf(gesture: EdgeBendGesture): EdgeBendOverrides | null {
  return gesture.moved ? new Map([[edgeIdentityOf(gesture.edge), gesture.bend]]) : null;
}
