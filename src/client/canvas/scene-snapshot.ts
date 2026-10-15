// A whole graph drawn onto a canvas of its own, framed to its content — with no view, camera or
// page behind it. This is what `grafd render` draws: the same scene painter the editor paints
// with, so a rendered graph looks as it does on screen, framed as Export image frames it.

import rough from 'roughjs';
import type { Rect } from '../../shared/flow-format.js';
import { boundsOfRects, padRect } from '../../shared/rect-math.js';
import { displayRects, type FlowModel } from '../flow-doc.js';
import { NO_HIDDEN_TITLES, SNAPSHOT_PADDING } from './canvas-view.js';
import { edgePathBounds } from './edge-layout.js';
import type { ExpansionLayer } from './expansion.js';
import { ScenePainter } from './scene-painter.js';

// The canvas a snapshot is drawn on: the page's own, or one a server-side canvas library made.
export interface SnapshotCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): unknown;
}

export interface SceneSnapshotRequest {
  canvas: SnapshotCanvas;
  model: FlowModel;
  // The world rect to draw, as `snapshotFrameOf` frames it.
  frame: Rect;
  // Canvas pixels per world unit.
  scale: number;
  background: string;
  roughness: number;
  expansions: ExpansionLayer;
  images(src: string): CanvasImageSource | null;
}

// The world rect a snapshot shows: the model's content, edges included — a bend can carry an edge
// well outside its nodes — with the room Export image leaves around it. Null for an empty graph.
export function snapshotFrameOf(model: FlowModel): Rect | null {
  const bounds = boundsOfRects([...displayRects(model), ...edgePathBounds(model)]);
  return bounds && padRect(bounds, SNAPSHOT_PADDING);
}

export function paintSceneSnapshot(request: SceneSnapshotRequest): void {
  const { canvas, frame, scale } = request;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = request.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -frame.x * scale, -frame.y * scale);
  new ScenePainter({
    ctx,
    rough: rough.canvas(canvas as unknown as HTMLCanvasElement),
    baseRoughness: request.roughness,
    selectedEdges: [],
    hiddenTitles: NO_HIDDEN_TITLES,
    edgeGeometry: new Map(),
    expansions: request.expansions,
    images: request.images,
  }).drawScene(request.model);
}
