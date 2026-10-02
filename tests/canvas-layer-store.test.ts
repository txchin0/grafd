import { describe, expect, it } from 'vitest';
import { CanvasLayerStore } from '../src/client/canvas-layer-store.js';
import { canvasLayerIsUnreadable, companionLayerOf, emptyCanvasLayer, setNodeShape } from '../src/shared/canvas-layer.js';

function storeReading(read: (path: string) => Promise<string | null>): CanvasLayerStore {
  return new CanvasLayerStore({ readFile: read, onLoaded: () => {} });
}

describe('CanvasLayerStore', () => {
  it('loads a missing layer as an empty, editable one', async () => {
    const store = storeReading(() => Promise.resolve(null));
    expect(await store.ensure('a.flow')).toEqual(emptyCanvasLayer());
    expect(store.layerFor('a.flow')).not.toBeNull();
  });

  it('offers no layer to edit when the file is not a layer, so nothing overwrites it', async () => {
    const store = storeReading(() => Promise.resolve('{ "nodes": { , }'));
    expect(await store.ensure('a.flow')).toBeNull();
    expect(store.layerFor('a.flow')).toBeNull();
    expect(store.isLoaded('a.flow')).toBe(true);
  });

  it('offers no layer to edit when the read fails, rather than mistaking it for no file', async () => {
    const store = storeReading(() => Promise.reject(new Error('offline')));
    expect(await store.ensure('a.flow')).toBeNull();
    expect(store.layerFor('a.flow')).toBeNull();
  });

  it('becomes editable again once a readable layer is adopted', async () => {
    const store = storeReading(() => Promise.resolve('not json'));
    await store.ensure('a.flow');
    const repaired = emptyCanvasLayer();
    setNodeShape(repaired, 'n1', 'diamond');
    store.adopt('a.flow', repaired);
    expect(store.layerFor('a.flow')).toBe(repaired);
  });

  it('turns unreadable when a watcher push is not a layer', async () => {
    const store = storeReading(() => Promise.resolve(null));
    await store.ensure('a.flow');
    store.adoptUnreadable('a.flow');
    expect(store.layerFor('a.flow')).toBeNull();
    expect(store.isLoaded('a.flow')).toBe(true);
  });
});

describe('canvasLayerIsUnreadable', () => {
  it('separates text that is not a layer from no file at all', () => {
    expect(canvasLayerIsUnreadable(null)).toBe(false);
    expect(canvasLayerIsUnreadable('')).toBe(false);
    expect(canvasLayerIsUnreadable('{"format":"grafd-canvas/1"}')).toBe(false);
    expect(canvasLayerIsUnreadable('{"nodes": {},}')).toBe(true);
    expect(canvasLayerIsUnreadable('[]')).toBe(true);
  });
});

describe('companionLayerOf', () => {
  it('gives a .flow its layer and everything else none', () => {
    expect(companionLayerOf('dir/a.flow')).toBe('dir/a.flow.canvas.json');
    expect(companionLayerOf('dir/a.flow.canvas.json')).toBeNull();
    expect(companionLayerOf('grafd.manifest.json')).toBeNull();
  });
});
