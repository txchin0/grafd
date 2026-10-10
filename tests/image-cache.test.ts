import { describe, expect, it, vi } from 'vitest';
import { createImageCache, type ImageDecoder } from '../src/client/canvas/image-cache.js';

interface PendingDecode {
  src: string;
  resolve(image: CanvasImageSource): void;
  reject(error: Error): void;
}

function controlledDecoder(): { decode: ImageDecoder; pending: PendingDecode[] } {
  const pending: PendingDecode[] = [];
  const decode: ImageDecoder = (src) => new Promise((resolve, reject) => pending.push({ src, resolve, reject }));
  return { decode, pending };
}

function pixelsFor(src: string): CanvasImageSource {
  return { src } as unknown as CanvasImageSource;
}

async function afterThisPaint(): Promise<void> {
  await Promise.resolve();
}

describe('the image cache', () => {
  it('decodes a source once, however often it is asked for, and asks for a paint when it lands', async () => {
    const { decode, pending } = controlledDecoder();
    const onDecoded = vi.fn();
    const cache = createImageCache({ decode, onDecoded });
    expect(cache.imageFor('a')).toBeNull();
    expect(cache.imageFor('a')).toBeNull();
    expect(pending).toHaveLength(1);
    pending[0].resolve(pixelsFor('a'));
    expect(await cache.whenSettled()).toBe(true);
    expect(onDecoded).toHaveBeenCalledTimes(1);
    expect(cache.imageFor('a')).toEqual(pixelsFor('a'));
    expect(await cache.whenSettled()).toBe(false);
  });

  it('remembers a source that cannot be decoded rather than trying it again', async () => {
    const { decode, pending } = controlledDecoder();
    const cache = createImageCache({ decode, onDecoded: () => {} });
    cache.imageFor('broken');
    pending[0].reject(new Error('not an image'));
    await cache.whenSettled();
    expect(cache.imageFor('broken')).toBeNull();
    expect(pending).toHaveLength(1);
  });

  it('lets go of the least recently drawn pixels once past its capacity', async () => {
    const { decode, pending } = controlledDecoder();
    const cache = createImageCache({ decode, onDecoded: () => {}, capacity: 2 });
    for (const src of ['a', 'b']) cache.imageFor(src);
    for (const decoding of pending) decoding.resolve(pixelsFor(decoding.src));
    await cache.whenSettled();
    await afterThisPaint();
    cache.imageFor('a');
    await afterThisPaint();
    cache.imageFor('c');
    await afterThisPaint();
    expect(cache.imageFor('a')).toEqual(pixelsFor('a'));
    expect(cache.imageFor('b')).toBeNull();
    expect(pending.map((decoding) => decoding.src)).toEqual(['a', 'b', 'c', 'b']);
  });

  it('keeps everything one paint draws, even past its capacity', async () => {
    const { decode, pending } = controlledDecoder();
    const cache = createImageCache({ decode, onDecoded: () => {}, capacity: 1 });
    for (const src of ['a', 'b', 'c']) cache.imageFor(src);
    for (const decoding of pending) decoding.resolve(pixelsFor(decoding.src));
    await cache.whenSettled();
    expect(['a', 'b', 'c'].map((src) => cache.imageFor(src))).toEqual(['a', 'b', 'c'].map(pixelsFor));
    expect(pending).toHaveLength(3);
  });
});
