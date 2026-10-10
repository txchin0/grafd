// An image pasted from the system clipboard, made ready to be stored in a canvas layer. Its pixels
// travel inside the layer as text, and the whole layer is rewritten on every edit to it, so a
// paste is scaled down to a bounded size and encoded in whichever format holds it in fewer bytes:
// PNG for flat screenshots and diagrams, WebP for photographs. Both keep transparency.

import type { Rect } from '../shared/flow-format.js';
import type { Point } from './geometry.js';

export const MAX_PASTED_IMAGE_SIDE = 1600;
const WEBP_QUALITY = 0.9;
// A pasted image larger than this share of the viewport is shrunk to fit it, so all of it is in
// view the moment it lands.
const LARGEST_SHARE_OF_VIEWPORT = 0.8;

export interface PixelSize {
  width: number;
  height: number;
}

export interface PreparedImage extends PixelSize {
  // A `data:image/…;base64,` URL.
  src: string;
}

export function imageFileOf(clipboard: DataTransfer | null): File | null {
  for (const item of clipboard?.items ?? []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

export async function preparePastedImage(file: Blob): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = fittedImageSize({ width: bitmap.width, height: bitmap.height }, MAX_PASTED_IMAGE_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, size.width, size.height);
    return { ...size, src: smallerOf(canvas.toDataURL('image/png'), canvas.toDataURL('image/webp', WEBP_QUALITY)) };
  } finally {
    bitmap.close();
  }
}

// A browser that cannot encode WebP hands back PNG for it, which the comparison then simply ties.
function smallerOf(first: string, second: string): string {
  return second.length < first.length ? second : first;
}

// The size an image is stored at: as it is, or scaled down evenly so its longest side fits.
export function fittedImageSize(size: PixelSize, longestSide: number): PixelSize {
  const scale = Math.min(1, longestSide / Math.max(size.width, size.height));
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

// Where a pasted image lands, in the coordinates of the graph it is pasted into: centred on the
// paste point, shown pixel for pixel on screen at the current zoom unless that would overflow the
// viewport. `screenPixelsPerUnit` is how many screen pixels one unit of that graph spans.
export function pastedImageBox(image: PixelSize, center: Point, screenPixelsPerUnit: number, viewport: PixelSize): Rect {
  const screenSize = fittedWithin(image, {
    width: viewport.width * LARGEST_SHARE_OF_VIEWPORT,
    height: viewport.height * LARGEST_SHARE_OF_VIEWPORT,
  });
  const w = screenSize.width / screenPixelsPerUnit;
  const h = screenSize.height / screenPixelsPerUnit;
  return { x: center.x - w / 2, y: center.y - h / 2, w, h };
}

// A canvas laid out at no size at all — hidden, or not yet laid out — has no room to fit to, and
// shrinking to it would leave a box too small to draw or select.
function fittedWithin(size: PixelSize, bounds: PixelSize): PixelSize {
  if (bounds.width <= 0 || bounds.height <= 0) return size;
  const scale = Math.min(1, bounds.width / size.width, bounds.height / size.height);
  return { width: size.width * scale, height: size.height * scale };
}
