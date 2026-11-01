// A free arrow in the canvas layer: what it reads as, what is written of it, and how the edits
// every drawing goes through — a move, a resize, a paste, an end dragged — carry its two points.

import { describe, expect, it } from 'vitest';
import { arrowDrawingOf, arrowDrawingRecord, type ArrowDrawing } from '../src/shared/canvas-arrow.js';
import {
  addArrowDrawing,
  drawingBounds,
  drawingOf,
  pasteDrawings,
  setArrowEnd,
  transformDrawings,
} from '../src/shared/canvas-drawings.js';
import { emptyCanvasLayer, parseCanvasLayer, serializeCanvasLayer } from '../src/shared/canvas-layer.js';

const ARROW: ArrowDrawing = {
  kind: 'arrow',
  id: 'pointer',
  graph: null,
  color: null,
  width: 'medium',
  line: 'solid',
  startHead: 'none',
  endHead: 'arrow',
  points: [{ x: 10, y: 20 }, { x: 110, y: 70 }],
};

function layerWithArrow(arrow: ArrowDrawing = ARROW) {
  const layer = emptyCanvasLayer();
  addArrowDrawing(layer, arrow);
  return layer;
}

describe('a free arrow in the layer', () => {
  it('writes only its points when every style is the default', () => {
    expect(arrowDrawingRecord(ARROW)).toEqual({ id: 'pointer', kind: 'arrow', points: [[10, 20], [110, 70]] });
  });

  it('round-trips its graph, colour, width, line and heads', () => {
    const styled: ArrowDrawing = { ...ARROW, graph: 'Steps', color: 'red', width: 'thin', line: 'dotted', startHead: 'dot', endHead: 'triangle' };
    const reread = parseCanvasLayer(serializeCanvasLayer(layerWithArrow(styled)));
    expect(drawingOf(reread.drawings[0])).toEqual(styled);
  });

  it('reads a bad style as the default, and anything but two points as nothing to draw', () => {
    expect(arrowDrawingOf({ id: 'a', kind: 'arrow', width: 'huge', line: 'wavy', endHead: 'spear', points: [[0, 0], [1, 1]] }))
      .toMatchObject({ width: 'medium', line: 'solid', endHead: 'arrow' });
    expect(arrowDrawingOf({ id: 'a', kind: 'arrow', points: [[0, 0]] })).toBeNull();
    expect(arrowDrawingOf({ id: 'a', kind: 'arrow', points: [[0, 0], [1, 'one']] })).toBeNull();
  });

  it('reaches as far as a head can past either end', () => {
    const bounds = drawingBounds(ARROW);
    expect(bounds.x).toBeLessThan(10 - 1.5);
    expect(bounds.x + bounds.w).toBeGreaterThan(110 + 1.5);
  });
});

describe('editing a free arrow', () => {
  it('carries both points through a move or a resize', () => {
    const layer = layerWithArrow();
    transformDrawings(layer, new Map([['pointer', { scaleX: 2, scaleY: 1, x: 5, y: -10 }]]));
    expect(layer.drawings[0].points).toEqual([[25, 10], [225, 60]]);
  });

  it('moves one end and keeps every other field', () => {
    const layer = layerWithArrow({ ...ARROW, color: 'blue' });
    setArrowEnd(layer, 'pointer', 'start', { x: -3.04, y: 4 });
    expect(layer.drawings[0]).toEqual({ id: 'pointer', kind: 'arrow', color: 'blue', points: [[-3, 4], [110, 70]] });
  });

  it('pastes a copy shifted into another graph', () => {
    const source = layerWithArrow();
    const target = emptyCanvasLayer();
    pasteDrawings(target, { drawings: source.drawings, groups: [] }, 'Steps', { x: 100, y: 0 });
    expect(drawingOf(target.drawings[0])).toMatchObject({ graph: 'Steps', points: [{ x: 110, y: 20 }, { x: 210, y: 70 }] });
  });
});
