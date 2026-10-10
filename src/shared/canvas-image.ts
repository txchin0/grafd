// A picture on a graph's canvas layer: a drawing of kind `image`, filed under a graph scope like a
// stroke or a text, drawn into its `box` in the scope's own units. Its pixels travel inside the
// layer as a base64 `data:` URL, so an image moves, copies, undoes and exports with its graph
// through the same text-only reads and writes every other drawing uses — no backend stores a
// separate binary file.
//
// Only inline raster sources are accepted: a remote URL would make the editor fetch from wherever
// a layer points and taint every export, and an SVG can carry markup of its own.

import type { Drawing } from './canvas-layer.js';
import { drawingBoxOf, storedDrawingBox } from './drawing-geometry.js';
import type { Rect } from './flow-format.js';

export const IMAGE_KIND = 'image';

const IMAGE_SOURCE_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export interface ImageDrawing {
  kind: typeof IMAGE_KIND;
  id: string;
  graph: string | null;
  // A `data:image/…;base64,` URL.
  src: string;
  box: Rect;
}

// Null for anything that is not a drawable image: without a usable source or box there is
// nothing to draw.
export function imageDrawingOf(drawing: Drawing): ImageDrawing | null {
  if (drawing.kind !== IMAGE_KIND || typeof drawing.id !== 'string' || drawing.id === '') return null;
  if (drawing.graph !== undefined && typeof drawing.graph !== 'string') return null;
  if (!isImageSource(drawing.src)) return null;
  const box = drawingBoxOf(drawing.box);
  if (!box) return null;
  return { kind: IMAGE_KIND, id: drawing.id, graph: drawing.graph ?? null, src: drawing.src, box };
}

export function isImageSource(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_SOURCE_PATTERN.test(value);
}

// The source is written last: it is by far the longest field, and every other field stays
// readable at the start of the drawing's line.
export function imageDrawingRecord(image: ImageDrawing): Drawing {
  const drawing: Drawing = { id: image.id, kind: IMAGE_KIND };
  if (image.graph != null) drawing.graph = image.graph;
  drawing.box = storedDrawingBox(image.box);
  drawing.src = image.src;
  return drawing;
}
