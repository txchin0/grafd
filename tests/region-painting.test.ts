// A region is painted from its canvas-layer entry: its colour on the outline, the label and the
// fill, a background colour of its own on the fill alone, and no fill at all when it has none.
// rough.js strokes hachure lines in the fill colour, so the colours each stroke and fill were laid
// down in show which paint went where.

import { beforeAll, describe, expect, it, type Mock } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel } from '../src/client/flow-doc.js';
import { dressModel } from '../src/client/model-visuals.js';
import { canvasPalette } from '../src/client/theme.js';
import { emptyCanvasLayer } from '../src/shared/canvas-layer.js';
import { setRegionStyle, type RegionStylePatch } from '../src/shared/canvas-region-style.js';
import { createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

const REGION_ONLY_FLOW = `---
name: Region
---

context: Auth
  pos: 40, 40, 400, 240
  nodes:
`;

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
});

interface PaintedColours {
  strokes: Set<string>;
  fills: Set<string>;
  labels: Set<string>;
}

function paintRegion(patch: RegionStylePatch): PaintedColours {
  const canvas = createCanvasMock();
  const context = canvas.getContext('2d') as unknown as Record<string, Mock> & { strokeStyle: string; fillStyle: string };
  const painted: PaintedColours = { strokes: new Set(), fills: new Set(), labels: new Set() };
  context.stroke.mockImplementation(() => painted.strokes.add(context.strokeStyle));
  context.fill.mockImplementation(() => painted.fills.add(context.fillStyle));
  context.fillText.mockImplementation((text: string) => {
    if (text === 'Auth') painted.labels.add(context.fillStyle);
  });
  const layer = emptyCanvasLayer();
  setRegionStyle(layer, 'Auth', patch);
  const view = new CanvasView(canvas, {} as unknown as ConstructorParameters<typeof CanvasView>[1], createExpansionLayer());
  view.setModel(dressModel(buildModel(parseFlow(REGION_ONLY_FLOW), null), layer));
  view.requestRender();
  return painted;
}

describe('painting a region', () => {
  it("draws the theme's region look when the region has no style", () => {
    const painted = paintRegion({});
    expect(painted.strokes).toContain(canvasPalette.regionStroke);
    expect(painted.strokes).toContain(canvasPalette.regionFill);
    expect(painted.labels).toEqual(new Set([canvasPalette.regionStroke]));
  });

  it('tints outline, label and hatching alike with the region colour', () => {
    const painted = paintRegion({ color: 'red' });
    expect(painted.strokes).toContain(canvasPalette.slots.red);
    expect(painted.strokes).not.toContain(canvasPalette.regionStroke);
    expect(painted.strokes).not.toContain(canvasPalette.regionFill);
    expect(painted.labels).toEqual(new Set([canvasPalette.slots.red]));
  });

  it('fills in the background colour while the outline keeps the region colour', () => {
    const painted = paintRegion({ color: 'red', fillColor: 'blue', fill: 'solid' });
    expect(painted.fills).toContain(canvasPalette.slots.blue);
    expect(painted.strokes).toContain(canvasPalette.slots.red);
    expect(painted.strokes).not.toContain(canvasPalette.slots.blue);
  });

  it('lays down no fill at all for a region without a background', () => {
    const painted = paintRegion({ color: 'red', fillColor: 'blue', fill: 'none' });
    expect(painted.strokes).not.toContain(canvasPalette.slots.blue);
    expect(painted.fills).not.toContain(canvasPalette.slots.blue);
    expect(painted.strokes).toContain(canvasPalette.slots.red);
  });
});
