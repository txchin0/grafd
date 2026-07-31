// Where a press lands on a context region: its border band or name label, never the
// interior. A region encloses nodes it does not own, so the interior must fall through to
// the marquee (R27). Topmost first — the region drawn last wins where frames overlap.

import type { Rect } from '../../shared/flow-format.js';
import type { FlowModel, ModelContext } from '../flow-doc.js';
import { regionRectOf } from '../flow-doc.js';
import { pointNearRectBorder, rectContains, type Point } from '../geometry.js';
import { hitResizeCorner, HANDLE_HIT_RADIUS_PX, type ResizeCorner } from './resize-handles.js';

// Wide enough to catch with a mouse, narrow enough that the interior still belongs to the marquee.
export const REGION_BORDER_BAND_PX = 7;

export type RegionLabelBand = (name: string, region: Rect) => Rect;

export function hitRegionAt(
  model: FlowModel,
  world: Point,
  viewScale: number,
  labelBand: RegionLabelBand,
): ModelContext | null {
  const band = REGION_BORDER_BAND_PX / viewScale;
  for (let index = model.contexts.length - 1; index >= 0; index -= 1) {
    const context = model.contexts[index];
    const rect = regionRectOf(model, context);
    if (!rect) continue;
    if (pointNearRectBorder(rect, world, band)) return context;
    if (rectContains(labelBand(context.block.name, rect), world)) return context;
  }
  return null;
}

export function hitRegionHandleAt(
  selected: ModelContext,
  model: FlowModel,
  world: Point,
  viewScale: number,
): { context: ModelContext; corner: ResizeCorner } | null {
  const rect = regionRectOf(model, selected);
  if (!rect) return null;
  const corner = hitResizeCorner(rect, world, HANDLE_HIT_RADIUS_PX / viewScale);
  return corner ? { context: selected, corner } : null;
}
