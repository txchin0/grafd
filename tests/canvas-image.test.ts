import { describe, expect, it } from 'vitest';
import {
  addImageDrawing,
  addStroke,
  drawingAnchorPoints,
  drawingBounds,
  drawingsForExtractedDocument,
  drawingsInScope,
  drawingsToCopy,
  pasteDrawings,
  setDrawingColor,
  transformDrawings,
  transformedDrawing,
} from '../src/shared/canvas-drawings.js';
import { imageDrawingOf, isImageSource, type ImageDrawing } from '../src/shared/canvas-image.js';
import { emptyCanvasLayer, parseCanvasLayer, serializeCanvasLayer } from '../src/shared/canvas-layer.js';
import { groupDrawings } from '../src/shared/canvas-groups.js';
import { fittedImageSize, pastedImageBox } from '../src/client/pasted-image.js';

const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function image(id: string, overrides: Partial<ImageDrawing> = {}): ImageDrawing {
  return { kind: 'image', id, graph: null, src: ONE_PIXEL_PNG, box: { x: 10, y: 20, w: 40, h: 30 }, ...overrides };
}

function boxOf(layer: ReturnType<typeof emptyCanvasLayer>, id: string) {
  return layer.drawings.find((drawing) => drawing.id === id)?.box;
}

describe('image storage', () => {
  it('writes an image on one line, its source last and its box rounded, and reads it back', () => {
    const layer = emptyCanvasLayer();
    addImageDrawing(layer, image('i1', { graph: 'Steps', box: { x: 1.04, y: 2, w: 3.333, h: 4 } }));
    const written = serializeCanvasLayer(layer)!;
    const line = written.split('\n').find((candidate) => candidate.includes('"kind":"image"'))!;
    expect(line.indexOf('"src"')).toBeGreaterThan(line.indexOf('"box"'));
    expect(parseCanvasLayer(written).drawings[0]).toEqual({ id: 'i1', kind: 'image', graph: 'Steps', box: [1, 2, 3.3, 4], src: ONE_PIXEL_PNG });
    expect(drawingsInScope(parseCanvasLayer(written), 'Steps')).toEqual([image('i1', { graph: 'Steps', box: { x: 1, y: 2, w: 3.3, h: 4 } })]);
  });

  it('accepts only inline raster sources', () => {
    expect(isImageSource(ONE_PIXEL_PNG)).toBe(true);
    expect(isImageSource('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    expect(isImageSource('data:image/webp;base64,UklGRg==')).toBe(true);
    expect(isImageSource('https://example.com/picture.png')).toBe(false);
    expect(isImageSource('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isImageSource('data:image/png,not-base64')).toBe(false);
    expect(isImageSource('data:image/png;base64,abc<script>')).toBe(false);
  });

  it('reads only an image it can draw', () => {
    const good = { id: 'i', kind: 'image', src: ONE_PIXEL_PNG, box: [0, 0, 10, 10] };
    expect(imageDrawingOf(good)).toMatchObject({ id: 'i', graph: null });
    expect(imageDrawingOf({ ...good, src: 'http://x/y.png' })).toBeNull();
    expect(imageDrawingOf({ ...good, box: [0, 0, 0, 10] })).toBeNull();
    expect(imageDrawingOf({ ...good, id: '' })).toBeNull();
    expect(imageDrawingOf({ ...good, graph: 4 })).toBeNull();
  });
});

describe('image edits', () => {
  it('moves and resizes by its box, and is bounded by it', () => {
    const layer = emptyCanvasLayer();
    addImageDrawing(layer, image('i'));
    transformDrawings(layer, new Map([['i', { scaleX: 2, scaleY: 2, x: 5, y: -10 }]]));
    expect(boxOf(layer, 'i')).toEqual([25, 30, 80, 60]);
    const [shown] = drawingsInScope(layer, null);
    expect(drawingBounds(shown)).toEqual({ x: 25, y: 30, w: 80, h: 60 });
    expect(transformedDrawing(shown, { scaleX: 1, scaleY: 1, x: 1, y: 1 })).toEqual(image('i', { box: { x: 26, y: 31, w: 80, h: 60 } }));
  });

  it('has no colour for a swatch to change, while a stroke beside it is recoloured', () => {
    const layer = emptyCanvasLayer();
    addImageDrawing(layer, image('i'));
    addStroke(layer, { kind: 'stroke', id: 's', graph: null, color: null, width: 'medium', points: [{ x: 0, y: 0 }] });
    setDrawingColor(layer, new Set(['i', 's']), 'red');
    expect(layer.drawings.map((drawing) => drawing.color)).toEqual([undefined, 'red']);
  });

  it('pastes shifted, filed under the target scope and grouped as it was copied', () => {
    const layer = emptyCanvasLayer();
    addImageDrawing(layer, image('i'));
    addStroke(layer, { kind: 'stroke', id: 's', graph: null, color: null, width: 'medium', points: [{ x: 0, y: 0 }] });
    groupDrawings(layer, new Set(['i', 's']));
    const copied = drawingsToCopy(layer, new Set(['i', 's']));
    expect(drawingAnchorPoints(copied.drawings[0])).toEqual([{ x: 10, y: 20 }, { x: 50, y: 50 }]);
    const [imageCopy, strokeCopy] = pasteDrawings(layer, copied, 'Steps', { x: 100, y: 0 });
    expect(boxOf(layer, imageCopy)).toEqual([110, 20, 40, 30]);
    expect(layer.drawings.find((drawing) => drawing.id === imageCopy)).toMatchObject({ graph: 'Steps', src: ONE_PIXEL_PNG });
    expect(layer.groups.at(-1)?.members).toEqual([{ kind: 'drawing', id: imageCopy }, { kind: 'drawing', id: strokeCopy }]);
  });

  it('goes with its graph block when the block is extracted to a file of its own', () => {
    const layer = emptyCanvasLayer();
    addImageDrawing(layer, image('i', { graph: 'Steps' }));
    const [carried] = drawingsForExtractedDocument(layer, 'Steps', new Set()).drawings;
    expect(carried).toMatchObject({ kind: 'image', src: ONE_PIXEL_PNG, box: [10, 20, 40, 30] });
    expect(carried.graph).toBeUndefined();
  });
});

describe('a pasted image', () => {
  it('is stored no larger than its longest side allows, in proportion', () => {
    expect(fittedImageSize({ width: 3200, height: 1000 }, 1600)).toEqual({ width: 1600, height: 500 });
    expect(fittedImageSize({ width: 300, height: 4000 }, 1600)).toEqual({ width: 120, height: 1600 });
    expect(fittedImageSize({ width: 800, height: 600 }, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('lands centred, pixel for pixel on screen, unless that would overflow the viewport', () => {
    const viewport = { width: 1000, height: 800 };
    expect(pastedImageBox({ width: 200, height: 100 }, { x: 0, y: 0 }, 2, viewport)).toEqual({ x: -50, y: -25, w: 100, h: 50 });
    expect(pastedImageBox({ width: 1600, height: 400 }, { x: 0, y: 0 }, 1, viewport)).toEqual({ x: -400, y: -100, w: 800, h: 200 });
  });

  it('keeps its own size on a canvas not laid out yet, rather than shrinking to nothing', () => {
    expect(pastedImageBox({ width: 200, height: 100 }, { x: 0, y: 0 }, 1, { width: 0, height: 0 })).toEqual({ x: -100, y: -50, w: 200, h: 100 });
  });
});
