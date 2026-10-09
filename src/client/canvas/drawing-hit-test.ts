// What a press or a marquee lands on among the drawings on screen. Drawings live in every model
// the canvas shows — the top-level graph and each unfolded frame — each in its own coordinates,
// so every test runs per surface in that surface's units. Pure: the view hands in the surfaces.

import { STROKE_KIND, STROKE_LINE_WIDTHS, drawingBounds, type CanvasDrawing } from '../../shared/canvas-drawings.js';
import type { Rect } from '../../shared/flow-format.js';
import { padRect, rectContainsRect } from '../../shared/rect-math.js';
import type { FlowModel } from '../flow-doc.js';
import { distanceToPolyline, rectContains, type Point } from '../geometry.js';
import type { DrawingSelection } from './drawing-selection.js';
import { inverseTransformPoint, transformRect, type FrameTransform } from './expansion.js';

// One model's drawings as they sit on the canvas: the transform from its units to world units,
// and — inside an unfolded frame — the world area the frame clips its content to.
export interface DrawingSurface {
  model: FlowModel;
  transform: FrameTransform;
  clip: Rect | null;
}

// `slop` is the extra reach in world units around a drawing's ink, so a thin line can still be
// picked up. Surfaces are listed outermost first; the innermost one under the point, and the
// most recently drawn drawing within it, wins.
export function hitDrawingAt(surfaces: readonly DrawingSurface[], world: Point, slop: number): DrawingSelection | null {
  for (let index = surfaces.length - 1; index >= 0; index -= 1) {
    const surface = surfaces[index];
    if (surface.clip && !rectContains(surface.clip, world)) continue;
    const local = inverseTransformPoint(world, surface.transform);
    const localSlop = slop / surface.transform.scale;
    const drawings = surface.model.visuals?.drawings() ?? [];
    for (let drawingIndex = drawings.length - 1; drawingIndex >= 0; drawingIndex -= 1) {
      const drawing = drawings[drawingIndex];
      if (drawingIsWithin(drawing, local, localSlop)) return { model: surface.model, id: drawing.id };
    }
  }
  return null;
}

// A stroke is picked up along its ink; a text anywhere in its box, which is where a reader looks.
function drawingIsWithin(drawing: CanvasDrawing, point: Point, slop: number): boolean {
  if (drawing.kind === STROKE_KIND) {
    return distanceToPolyline(point, drawing.points) <= STROKE_LINE_WIDTHS[drawing.width] / 2 + slop;
  }
  return rectContains(padRect(drawing.box, slop), point);
}

// Every drawing whose whole ink lies inside `worldRect`, as a marquee selects nodes.
export function drawingsInsideRect(surfaces: readonly DrawingSurface[], worldRect: Rect): DrawingSelection[] {
  return surfaces.flatMap((surface) =>
    (surface.model.visuals?.drawings() ?? [])
      .filter((drawing) => rectContainsRect(worldRect, worldBoundsOf(drawing, surface)))
      .map((drawing) => ({ model: surface.model, id: drawing.id })),
  );
}

export function worldBoundsOf(drawing: CanvasDrawing, surface: DrawingSurface): Rect {
  return transformRect(drawingBounds(drawing), surface.transform);
}
