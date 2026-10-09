// A region's look lives in its layer entry, filed under the provider's name, and only what differs
// from the theme's region look is written.

import { describe, expect, it } from 'vitest';
import {
  defaultRegionStyle,
  regionFillColorOf,
  regionStyleOf,
  setRegionStyle,
} from '../src/shared/canvas-region-style.js';
import { emptyCanvasLayer, parseCanvasLayer, serializeCanvasLayer } from '../src/shared/canvas-layer.js';

const REGION = 'Auth';

describe('reading a region style', () => {
  it('reads every default for a region with no entry, or with no layer', () => {
    expect(regionStyleOf(emptyCanvasLayer(), REGION)).toEqual({ color: null, fillColor: null, fill: 'hachure' });
    expect(regionStyleOf(null, REGION)).toEqual(defaultRegionStyle());
  });

  it('reads an invalid value as the default', () => {
    const layer = emptyCanvasLayer();
    layer.regions[REGION] = { color: 'mauve-ish', fillColor: 7, fill: 'plaid' };
    expect(regionStyleOf(layer, REGION)).toEqual(defaultRegionStyle());
  });

  it('fills in the region colour until a background colour of its own is chosen', () => {
    expect(regionFillColorOf({ color: 'blue', fillColor: null, fill: 'hachure' })).toBe('blue');
    expect(regionFillColorOf({ color: 'blue', fillColor: 'gray', fill: 'solid' })).toBe('gray');
    expect(regionFillColorOf(defaultRegionStyle())).toBeNull();
  });
});

describe('writing a region style', () => {
  it('round-trips through the layer file, a hand-written hex colour included', () => {
    const layer = emptyCanvasLayer();
    setRegionStyle(layer, REGION, { color: '#12ab9f', fillColor: 'yellow', fill: 'cross-hatch' });
    const reread = parseCanvasLayer(serializeCanvasLayer(layer));
    expect(regionStyleOf(reread, REGION)).toEqual({ color: '#12ab9f', fillColor: 'yellow', fill: 'cross-hatch' });
  });

  it('never writes a default, and removes the entry when its last field is reset', () => {
    const layer = emptyCanvasLayer();
    setRegionStyle(layer, REGION, { color: 'red', fill: 'hachure' });
    expect(layer.regions[REGION]).toEqual({ color: 'red' });
    setRegionStyle(layer, REGION, { fill: 'none' });
    setRegionStyle(layer, REGION, { color: null, fill: 'hachure' });
    expect(layer.regions).toEqual({});
    expect(serializeCanvasLayer(layer)).toBeNull();
  });

  it('leaves a field the patch does not mention untouched, along with unknown fields', () => {
    const layer = emptyCanvasLayer();
    layer.regions[REGION] = { color: 'green', glow: true };
    setRegionStyle(layer, REGION, { fill: 'dots' });
    expect(layer.regions[REGION]).toEqual({ color: 'green', glow: true, fill: 'dots' });
  });
});
