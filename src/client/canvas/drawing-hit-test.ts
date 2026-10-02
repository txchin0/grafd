// What a press or a marquee lands on among the strokes on screen. Strokes live in every model
// the canvas shows — the top-level graph and each unfolded frame — each in its own coordinates,
// so every test runs per surface in that surface's units. Pure: the view hands in the surfaces.

import { STROKE_LINE_WIDTHS, strokeBounds, type Stroke } from '../../shared/canvas-drawings.js';
import type { Rect } from '../../shared/flow-format.js';
import { rectContainsRect } from '../../shared/rect-math.js';
import type { FlowModel } from '../flow-doc.js';
import { distanceToPolyline, rectContains, type Point } from '../geometry.js';
import type { DrawingSelection } from './drawing-selection.js';
import { inverseTransformPoint, transformRect, type FrameTransform } from './expansion.js';

// One model's strokes as they sit on the canvas: the transform from its units to world units,
// and — inside an unfolded frame — the world area the frame clips its content to.
export interface StrokeSurface {
  model: FlowModel;
  transform: FrameTransform;
  clip: Rect | null;
}

// `slop` is the extra reach in world units around a stroke's ink, so a thin line can still be
// picked up. Surfaces are listed outermost first; the innermost one under the point, and the
// most recently drawn stroke within it, wins.
export function hitStrokeAt(surfaces: readonly StrokeSurface[], world: Point, slop: number): DrawingSelection | null {
  for (let index = surfaces.length - 1; index >= 0; index -= 1) {
    const surface = surfaces[index];
    if (surface.clip && !rectContains(surface.clip, world)) continue;
    const local = inverseTransformPoint(world, surface.transform);
    const localSlop = slop / surface.transform.scale;
    const strokes = surface.model.visuals?.strokes() ?? [];
    for (let strokeIndex = strokes.length - 1; strokeIndex >= 0; strokeIndex -= 1) {
      const stroke = strokes[strokeIndex];
      if (strokeIsWithin(stroke, local, localSlop)) return { model: surface.model, id: stroke.id };
    }
  }
  return null;
}

function strokeIsWithin(stroke: Stroke, point: Point, slop: number): boolean {
  return distanceToPolyline(point, stroke.points) <= STROKE_LINE_WIDTHS[stroke.width] / 2 + slop;
}

// Every stroke whose whole ink lies inside `worldRect`, as a marquee selects nodes.
export function strokesInsideRect(surfaces: readonly StrokeSurface[], worldRect: Rect): DrawingSelection[] {
  return surfaces.flatMap((surface) =>
    (surface.model.visuals?.strokes() ?? [])
      .filter((stroke) => rectContainsRect(worldRect, worldBoundsOf(stroke, surface)))
      .map((stroke) => ({ model: surface.model, id: stroke.id })),
  );
}

export function worldBoundsOf(stroke: Stroke, surface: StrokeSurface): Rect {
  return transformRect(strokeBounds(stroke), surface.transform);
}
