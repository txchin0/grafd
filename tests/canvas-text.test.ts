import { describe, expect, it } from 'vitest';
import {
  addTextDrawing,
  drawingAnchorPoints,
  drawingsInScope,
  drawingsToCopy,
  pasteDrawings,
  setDrawingColor,
  setTextDrawing,
  transformDrawings,
} from '../src/shared/canvas-drawings.js';
import { textDrawingOf, type TextDrawing } from '../src/shared/canvas-text.js';
import { emptyCanvasLayer, parseCanvasLayer, serializeCanvasLayer } from '../src/shared/canvas-layer.js';
import { groupDrawings } from '../src/shared/canvas-groups.js';
import { drawingAsCarried, relaidOutText, textBoxFor, textLayout, type LineMeasurer } from '../src/client/canvas/text-drawing-layout.js';

// Every character half an em wide: enough to tell a wide line from a narrow one.
const HALF_EM_PER_CHARACTER = 0.5;
const measureLine: LineMeasurer = (line, fontPx) => line.length * fontPx * HALF_EM_PER_CHARACTER;

function text(id: string, overrides: Partial<TextDrawing> = {}): TextDrawing {
  return { kind: 'text', id, graph: null, color: null, text: 'Hello', box: { x: 10, y: 20, w: 50, h: 25 }, size: 20, wrap: false, ...overrides };
}

describe('text storage', () => {
  it('writes a text on one line, defaults left out and its layout rounded, and reads it back', () => {
    const layer = emptyCanvasLayer();
    addTextDrawing(layer, text('t1', { graph: 'Steps', color: 'blue', text: 'Two\nlines', box: { x: 1.04, y: 2, w: 3.333, h: 4 }, size: 1.66, wrap: true }));
    addTextDrawing(layer, text('t2'));
    const written = serializeCanvasLayer(layer)!;
    expect(written.split('\n').filter((line) => line.includes('"kind":"text"'))).toHaveLength(2);
    const reread = parseCanvasLayer(written);
    expect(reread.drawings[0]).toEqual({ id: 't1', kind: 'text', graph: 'Steps', color: 'blue', text: 'Two\nlines', box: [1, 2, 3.3, 4], size: 1.66, wrap: true });
    expect(reread.drawings[1]).toEqual({ id: 't2', kind: 'text', text: 'Hello', box: [10, 20, 50, 25], size: 20 });
  });

  it('reads only text it can draw, defaulting a bad colour, and sizes a text written without one by its box', () => {
    const good = { id: 't', kind: 'text', text: 'Hi\nthere', box: [0, 0, 10, 50] };
    expect(textDrawingOf(good)).toMatchObject({ size: 20, wrap: false });
    expect(textDrawingOf({ ...good, size: 12, wrap: true })).toMatchObject({ size: 12, wrap: true });
    expect(textDrawingOf({ ...good, color: 'mauve' })).toMatchObject({ id: 't', color: null });
    expect(textDrawingOf({ ...good, text: ' \n ' })).toBeNull();
    expect(textDrawingOf({ ...good, text: 3 })).toBeNull();
    expect(textDrawingOf({ ...good, box: [0, 0, 0, 10] })).toBeNull();
    expect(textDrawingOf({ ...good, box: [0, 0, 10] })).toBeNull();
    expect(textDrawingOf({ ...good, graph: 4 })).toBeNull();
  });

  it('files text by scope alongside strokes, oldest first', () => {
    const layer = emptyCanvasLayer();
    addTextDrawing(layer, text('body'));
    addTextDrawing(layer, text('inner', { graph: 'Steps' }));
    expect(drawingsInScope(layer, null).map((drawing) => drawing.id)).toEqual(['body']);
    expect(drawingsInScope(layer, 'Steps').map((drawing) => drawing.id)).toEqual(['inner']);
  });
});

describe('text edits', () => {
  it('scales its size with its box when scaled evenly', () => {
    const layer = emptyCanvasLayer();
    addTextDrawing(layer, text('t'));
    transformDrawings(layer, new Map([['t', { scaleX: 2, scaleY: 2, x: -10, y: 5 }]]));
    expect(layer.drawings[0]).toMatchObject({ box: [10, 45, 100, 50], size: 40 });
    expect(layer.drawings[0].wrap).toBeUndefined();
  });

  it('takes a sideways stretch as a width to wrap to, keeping its size', () => {
    const layer = emptyCanvasLayer();
    addTextDrawing(layer, text('t'));
    transformDrawings(layer, new Map([['t', { scaleX: 0.5, scaleY: 1, x: 5, y: 0 }]]));
    expect(layer.drawings[0]).toMatchObject({ box: [10, 20, 25, 25], size: 20, wrap: true });
  });

  it('rewrites its words and layout, keeping every other field', () => {
    const layer = emptyCanvasLayer();
    addTextDrawing(layer, text('t', { color: 'red', wrap: true }));
    setTextDrawing(layer, { id: 't', text: 'New', box: { x: 1, y: 2, w: 3, h: 4 }, size: 5, wrap: false });
    expect(layer.drawings[0]).toEqual({ id: 't', kind: 'text', color: 'red', text: 'New', box: [1, 2, 3, 4], size: 5 });
  });

  it('recolours, copies and pastes a text with the stroke it is grouped with', () => {
    const layer = emptyCanvasLayer();
    addTextDrawing(layer, text('t'));
    layer.drawings = [...layer.drawings, { id: 's', kind: 'stroke', points: [[0, 0], [10, 0]] }];
    groupDrawings(layer, new Set(['t', 's']));
    setDrawingColor(layer, new Set(['t']), 'red');
    expect(layer.drawings[0].color).toBe('red');

    const pastedIds = pasteDrawings(layer, drawingsToCopy(layer, new Set(['t', 's'])), 'Steps', { x: 100, y: 0 });
    const pastedText = layer.drawings.find((drawing) => drawing.id === pastedIds[0])!;
    expect(pastedText).toMatchObject({ kind: 'text', graph: 'Steps', box: [110, 20, 50, 25], size: 20 });
    expect(layer.groups).toHaveLength(2);
  });

  it('anchors a paste on a text\'s box corners', () => {
    expect(drawingAnchorPoints({ id: 't', kind: 'text', text: 'x', box: [5, 6, 10, 20] })).toEqual([{ x: 5, y: 6 }, { x: 15, y: 26 }]);
  });
});

describe('text layout', () => {
  it('sizes a box to the widest line at the font size, one line height per line', () => {
    expect(textBoxFor('ab\nabcd', { x: 1, y: 2 }, 20, measureLine)).toEqual({ x: 1, y: 2, w: 40, h: 50 });
  });

  it('never makes a box narrower than one em', () => {
    expect(textBoxFor(' ', { x: 0, y: 0 }, 20, measureLine).w).toBe(20);
    expect(textBoxFor('abc', { x: 0, y: 0 }, 20, measureLine, 4).w).toBe(20);
  });

  it('wraps words to a width, breaking a word too long for it, and keeps that width', () => {
    // At 20 a character is 10 wide: a 60-wide line holds six.
    const box = textBoxFor('ab cd ef\nabcdefghij', { x: 0, y: 0 }, 20, measureLine, 60);
    expect(box).toEqual({ x: 0, y: 0, w: 60, h: 4 * 25 });
    expect(textLayout({ text: 'ab cd ef\nabcdefghij', box, size: 20, wrap: true }, measureLine).lines).toEqual(['ab cd', 'ef', 'abcdef', 'ghij']);
  });

  it('draws at its size, shrinking only when its box is too small for it', () => {
    const box = textBoxFor('ab\nabcd', { x: 0, y: 0 }, 20, measureLine);
    expect(textLayout({ text: 'ab\nabcd', box, size: 20, wrap: false }, measureLine)).toEqual({ fontPx: 20, lines: ['ab', 'abcd'], lineHeight: 25 });
    expect(textLayout({ text: 'abcd', box: { x: 0, y: 0, w: 20, h: 25 }, size: 20, wrap: false }, measureLine).fontPx).toBe(10);
  });

  it('measures a wrapped text again where it starts, at its size', () => {
    const narrowed = relaidOutText(text('t', { text: 'ab cd', box: { x: 3, y: 4, w: 30, h: 25 }, wrap: true }), measureLine);
    expect(narrowed.box).toEqual({ x: 3, y: 4, w: 30, h: 50 });
  });

  it('shows a text being stretched sideways re-wrapped for its new width', () => {
    const shown = drawingAsCarried(text('t', { text: 'ab cd' , box: { x: 0, y: 0, w: 50, h: 25 } }), { scaleX: 0.6, scaleY: 1, x: 0, y: 0 }, measureLine);
    expect(shown).toMatchObject({ wrap: true, size: 20, box: { x: 0, y: 0, w: 30, h: 50 } });
  });
});
