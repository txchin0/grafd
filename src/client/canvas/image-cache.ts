// Decoded pixels for the images on the canvas. Painting is synchronous and decoding is not, so a
// painter asks for an image and gets it only once it has been decoded; the first ask starts the
// decode, and its landing asks for another paint. Keyed by source, so every copy of an image —
// pasted twice, or shown in two frames — shares one decode.

export type ImageDecoder = (src: string) => Promise<CanvasImageSource>;

export interface ImageCacheOptions {
  decode: ImageDecoder;
  // An image finished decoding, so whatever painted its placeholder should paint again.
  onDecoded(): void;
  // Decoded pixels kept for the most recently drawn sources; older ones are decoded again if
  // they come back into view. A decoded picture holds its full bitmap, unlike its source. A paint
  // that draws more than this many keeps them all until it is over: evicting one it drew would
  // only have the next paint decode it again, endlessly.
  capacity?: number;
}

export interface ImageCache {
  // The decoded pixels, or null while they are decoding or when they cannot be decoded.
  imageFor(src: string): CanvasImageSource | null;
  // Resolves once no decode is in flight — what an export waits on before drawing for good — to
  // whether there was any to wait for.
  whenSettled(): Promise<boolean>;
}

const DEFAULT_CAPACITY = 64;

type CacheEntry =
  | { state: 'decoding'; done: Promise<void> }
  | { state: 'decoded'; image: CanvasImageSource }
  | { state: 'failed' };

export function createImageCache({ decode, onDecoded, capacity = DEFAULT_CAPACITY }: ImageCacheOptions): ImageCache {
  // A Map iterates in insertion order, so re-inserting on every hit keeps the least recently
  // drawn source first in line for eviction.
  const entries = new Map<string, CacheEntry>();
  // Painting is synchronous, so everything asked for before the current task ends was asked for
  // by the same paint.
  const askedThisPaint = new Set<string>();

  function imageFor(src: string): CanvasImageSource | null {
    noteAskedThisPaint(src);
    const entry = entries.get(src);
    if (!entry) {
      startDecoding(src);
      return null;
    }
    entries.delete(src);
    entries.set(src, entry);
    return entry.state === 'decoded' ? entry.image : null;
  }

  function startDecoding(src: string): void {
    const done = decode(src).then(
      (image) => settle(src, { state: 'decoded', image }),
      () => settle(src, { state: 'failed' }),
    );
    entries.set(src, { state: 'decoding', done });
    evictBeyondCapacity();
  }

  // An entry evicted while it decoded is not brought back: nothing has asked for it since.
  function settle(src: string, entry: CacheEntry): void {
    if (entries.get(src)?.state !== 'decoding') return;
    entries.set(src, entry);
    onDecoded();
  }

  function noteAskedThisPaint(src: string): void {
    if (askedThisPaint.size === 0) queueMicrotask(() => askedThisPaint.clear());
    askedThisPaint.add(src);
  }

  function evictBeyondCapacity(): void {
    for (const src of entries.keys()) {
      if (entries.size <= capacity) return;
      if (!askedThisPaint.has(src)) entries.delete(src);
    }
  }

  async function whenSettled(): Promise<boolean> {
    const decoding = [...entries.values()].flatMap((entry) => (entry.state === 'decoding' ? [entry.done] : []));
    await Promise.all(decoding);
    return decoding.length > 0;
  }

  return { imageFor, whenSettled };
}

export const decodeImageInBrowser: ImageDecoder = async (src) => {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
};
