// The two gestures a free arrow has: one being drawn with the arrow tool, and one end of a selected
// arrow being dragged.
//
// An arrow being drawn belongs to the graph the press landed in — the innermost unfolded frame
// under it, or the top-level graph — and both its ends are kept in that graph's coordinates, as a
// stroke's points are. A press on a node remembers the node: let go on another node it can reach,
// the drag is an edge in the .flow rather than an arrow (the view decides which, as a port drag's
// release is decided).

import type { EdgeEnd } from '../../shared/canvas-edge-style.js';
import type { FlowNode } from '../../shared/flow-format.js';
import type { Point } from '../geometry.js';
import type { DrawingSelection } from './drawing-selection.js';
import { inverseTransformPoint, type FrameTarget, type FrameTransform } from './expansion.js';

export interface ArrowGesture {
  type: 'arrow';
  frameHost: FlowNode | null;
  transform: FrameTransform;
  start: Point;
  end: Point;
  // The node the press landed on, which an edge would start from.
  fromNode: FlowNode | null;
  // The node a release here would join `fromNode` to, lit up while the pointer is over it.
  edgeTarget: FlowNode | null;
  startScreen: Point;
  moved: boolean;
}

const TOP_LEVEL_TRANSFORM: FrameTransform = { scale: 1, tx: 0, ty: 0 };

export function beginArrowGesture(frame: FrameTarget | null, fromNode: FlowNode | null, world: Point, screen: Point): ArrowGesture {
  const transform = frame?.transform ?? TOP_LEVEL_TRANSFORM;
  const start = inverseTransformPoint(world, transform);
  return { type: 'arrow', frameHost: frame?.host ?? null, transform, start, end: start, fromNode, edgeTarget: null, startScreen: screen, moved: false };
}

export function extendArrowGesture(gesture: ArrowGesture, world: Point): void {
  gesture.end = inverseTransformPoint(world, gesture.transform);
}

export interface ArrowEndGesture {
  type: 'arrow-end';
  drawing: DrawingSelection;
  end: EdgeEnd;
  // The arrow's model's transform to the world, so the dragged end stays under the pointer.
  transform: FrameTransform;
  point: Point;
  startScreen: Point;
  moved: boolean;
}

export function beginArrowEnd(drawing: DrawingSelection, end: EdgeEnd, transform: FrameTransform, world: Point, screen: Point): ArrowEndGesture {
  return { type: 'arrow-end', drawing, end, transform, point: inverseTransformPoint(world, transform), startScreen: screen, moved: false };
}

export function extendArrowEnd(gesture: ArrowEndGesture, world: Point): void {
  gesture.point = inverseTransformPoint(world, gesture.transform);
}
