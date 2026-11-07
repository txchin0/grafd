// An edge's look lives in its layer entry, and only what differs from how the edge would be drawn
// anyway is written — which for the line depends on the edge's kind.

import { describe, expect, it } from 'vitest';
import {
  anchorDirectionOf,
  angleToward,
  defaultEdgeStyle,
  edgeStyleOf,
  readEdgeAngle,
  readEdgeBend,
  setEdgeStyle,
  snapAnchorAngle,
} from '../src/shared/canvas-edge-style.js';
import { emptyCanvasLayer, parseCanvasLayer, serializeCanvasLayer, type CanvasLayer } from '../src/shared/canvas-layer.js';

const KEY = 'a-1 -> #b-1';
const FLOW_EDGE = 'flow';
const ERROR_EDGE = 'error';

function layerWith(entry: Record<string, unknown>): CanvasLayer {
  const layer = emptyCanvasLayer();
  layer.edges[KEY] = entry;
  return layer;
}

describe('reading an edge style', () => {
  it('reads every default for an edge with no entry', () => {
    expect(edgeStyleOf(emptyCanvasLayer(), KEY, FLOW_EDGE)).toEqual({
      color: null,
      line: 'solid',
      startHead: 'none',
      endHead: 'arrow',
      bend: null,
      startAngle: null,
      endAngle: null,
    });
  });

  it('reads an error edge that says nothing about its line as dashed', () => {
    expect(edgeStyleOf(emptyCanvasLayer(), KEY, ERROR_EDGE)).toEqual(defaultEdgeStyle(ERROR_EDGE));
    expect(edgeStyleOf(layerWith({ line: 'wavy' }), KEY, ERROR_EDGE).line).toBe('dashed');
  });

  it('reads an invalid value as the default', () => {
    const style = edgeStyleOf(layerWith({ color: 'mauve-ish', line: 'wavy', startHead: 'flag', endHead: 3, bend: [0.5] }), KEY, FLOW_EDGE);
    expect(style.color).toBeNull();
    expect(style.line).toBe('solid');
    expect(style.startHead).toBe('none');
    expect(style.endHead).toBe('arrow');
    expect(style.bend).toBeNull();
  });

  it('clamps a hand-written bend that runs past either end of the chord', () => {
    expect(readEdgeBend([1.8, 0.2])).toEqual({ along: 1, across: 0.2 });
    expect(readEdgeBend([-0.4, -0.2])).toEqual({ along: 0, across: -0.2 });
  });

  it('reads nothing at all when there is no layer', () => {
    expect(edgeStyleOf(null, KEY, FLOW_EDGE).endHead).toBe('arrow');
  });
});

describe('writing an edge style', () => {
  it('round-trips through the layer file', () => {
    const layer = emptyCanvasLayer();
    setEdgeStyle(layer, KEY, { line: 'dotted', startHead: 'dot', endHead: 'triangle', bend: { along: 0.5, across: 0.25 }, endAngle: 180 }, FLOW_EDGE);
    const reread = parseCanvasLayer(serializeCanvasLayer(layer));
    expect(edgeStyleOf(reread, KEY, FLOW_EDGE)).toEqual({
      color: null,
      line: 'dotted',
      startHead: 'dot',
      endHead: 'triangle',
      bend: { along: 0.5, across: 0.25 },
      startAngle: null,
      endAngle: 180,
    });
  });

  it('never writes a default head', () => {
    const layer = emptyCanvasLayer();
    setEdgeStyle(layer, KEY, { startHead: 'none', endHead: 'arrow' }, FLOW_EDGE);
    expect(layer.edges[KEY]).toBeUndefined();
  });

  it('writes a dashed line on a flow edge, whose default is solid', () => {
    const layer = emptyCanvasLayer();
    setEdgeStyle(layer, KEY, { line: 'dashed' }, FLOW_EDGE);
    expect(layer.edges[KEY]).toEqual({ line: 'dashed' });
  });

  it('removes the line from an error edge set back to dashed, its own default', () => {
    const layer = emptyCanvasLayer();
    setEdgeStyle(layer, KEY, { line: 'solid' }, ERROR_EDGE);
    expect(layer.edges[KEY]).toEqual({ line: 'solid' });
    setEdgeStyle(layer, KEY, { line: 'dashed' }, ERROR_EDGE);
    expect(layer.edges[KEY]).toBeUndefined();
  });

  it('rounds a bend to a thousandth of the chord, so a drag writes a quiet diff', () => {
    const layer = emptyCanvasLayer();
    setEdgeStyle(layer, KEY, { bend: { along: 0.123456, across: -0.98765 } }, FLOW_EDGE);
    expect(layer.edges[KEY].bend).toEqual([0.123, -0.988]);
  });

  it('removes the entry when its last field is cleared', () => {
    const layer = layerWith({ bend: [0.5, 0.2] });
    setEdgeStyle(layer, KEY, { bend: null }, FLOW_EDGE);
    expect(layer.edges[KEY]).toBeUndefined();
  });

  it('keeps the entry\'s other fields, known or not', () => {
    const layer = layerWith({ color: 'red', fromANewerEditor: true });
    setEdgeStyle(layer, KEY, { endHead: 'diamond' }, FLOW_EDGE);
    expect(layer.edges[KEY]).toEqual({ color: 'red', fromANewerEditor: true, endHead: 'diamond' });
  });

  it('writes and clears a colour, which has no default to compare against', () => {
    const layer = emptyCanvasLayer();
    setEdgeStyle(layer, KEY, { color: '#12ab9f' }, FLOW_EDGE);
    expect(edgeStyleOf(layer, KEY, FLOW_EDGE).color).toBe('#12ab9f');
    setEdgeStyle(layer, KEY, { color: null }, FLOW_EDGE);
    expect(layer.edges[KEY]).toBeUndefined();
  });

  it('leaves fields the patch does not name untouched', () => {
    const layer = layerWith({ line: 'dotted', bend: [0.5, 0.2] });
    setEdgeStyle(layer, KEY, { color: 'blue' }, FLOW_EDGE);
    expect(layer.edges[KEY]).toEqual({ line: 'dotted', bend: [0.5, 0.2], color: 'blue' });
  });
});

describe('pinned ends', () => {
  it('writes an angle as whole degrees within one turn, and frees the end on null', () => {
    const layer = emptyCanvasLayer();
    setEdgeStyle(layer, KEY, { startAngle: -90.4, endAngle: 450 }, FLOW_EDGE);
    expect(layer.edges[KEY]).toEqual({ startAngle: 270, endAngle: 90 });
    setEdgeStyle(layer, KEY, { startAngle: null, endAngle: null }, FLOW_EDGE);
    expect(layer.edges[KEY]).toBeUndefined();
  });

  it('reads anything but a finite number as a free end', () => {
    const style = edgeStyleOf(layerWith({ startAngle: 'bottom', endAngle: 720.5 }), KEY, FLOW_EDGE);
    expect(style.startAngle).toBeNull();
    expect(style.endAngle).toBeCloseTo(0.5, 6);
    expect(readEdgeAngle(Number.NaN)).toBeNull();
  });

  it('measures angles clockwise from the top', () => {
    const center = { x: 0, y: 0 };
    expect(angleToward(center, { x: 0, y: -5 })).toBeCloseTo(0, 6);
    expect(angleToward(center, { x: 5, y: 0 })).toBeCloseTo(90, 6);
    expect(angleToward(center, { x: 0, y: 5 })).toBeCloseTo(180, 6);
    expect(angleToward(center, { x: -5, y: 0 })).toBeCloseTo(270, 6);
    expect(angleToward(center, center)).toBeNull();
    const bottom = anchorDirectionOf(180);
    expect(bottom.x).toBeCloseTo(0, 6);
    expect(bottom.y).toBeCloseTo(1, 6);
  });

  it('snaps near a side or a diagonal, and keeps whole degrees elsewhere', () => {
    expect(snapAnchorAngle(176.2)).toBe(180);
    expect(snapAnchorAngle(357)).toBe(0);
    expect(snapAnchorAngle(48.6)).toBe(45);
    expect(snapAnchorAngle(120.4)).toBe(120);
  });
});
