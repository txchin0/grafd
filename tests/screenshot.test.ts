import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { buildModel } from '../src/client/flow-doc.js';
import {
  MAX_SNAPSHOT_SIDE,
  exceedsSnapshotLimits,
  pixelSizeForRatio,
  pixelSizeForWidth,
  previewLayoutFor,
} from '../src/client/screenshot.js';
import { VIEWPORT, createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

const DASHBOARD_FLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../flows/dashboard.flow'),
  'utf8',
);

describe('snapshot pixel sizing', () => {
  const logical = { width: 800, height: 500 };

  it('scales both sides by the pixel ratio', () => {
    expect(pixelSizeForRatio(logical, 3)).toEqual({ width: 2400, height: 1500, pixelRatio: 3 });
  });

  it('derives the pixel ratio from a requested width and keeps the aspect ratio', () => {
    const size = pixelSizeForWidth(logical, 1920);
    expect(size.width).toBe(1920);
    expect(size.height).toBe(1200);
    expect(size.width / size.height).toBeCloseTo(logical.width / logical.height, 6);
  });

  it('rounds to whole pixels and never collapses to zero', () => {
    const size = pixelSizeForRatio({ width: 3, height: 0.2 }, 0.4);
    expect(size).toEqual({ width: 1, height: 1, pixelRatio: 0.4 });
  });

  it('rejects sizes past the side and area caps but allows what fits', () => {
    expect(exceedsSnapshotLimits(pixelSizeForRatio(logical, 4))).toBe(false);
    expect(exceedsSnapshotLimits(pixelSizeForWidth(logical, MAX_SNAPSHOT_SIDE + 1))).toBe(true);
    expect(exceedsSnapshotLimits({ width: 8000, height: 8000, pixelRatio: 1 })).toBe(true);
  });
});

describe('preview layout', () => {
  const wide = { width: 1600, height: 500 };

  it('fits the CSS size inside the preview box on its limiting axis', () => {
    const { css } = previewLayoutFor(wide, 1);
    expect(css.width).toBe(560);
    expect(css.height).toBe(175);
  });

  it('supersamples the backing store past the CSS size on a 1x display', () => {
    const { css, device } = previewLayoutFor(wide, 1);
    expect(device.width).toBe(css.width * 3);
    expect(device.height / device.width).toBeCloseTo(css.height / css.width, 3);
  });

  it('follows the display pixel ratio when it exceeds the minimum', () => {
    expect(previewLayoutFor(wide, 4).device.width).toBe(560 * 4);
    expect(previewLayoutFor(wide, 2).device.width).toBe(560 * 3);
  });

  it('never upscales a graph smaller than the preview box', () => {
    const { css } = previewLayoutFor({ width: 200, height: 120 }, 2);
    expect(css).toEqual({ width: 200, height: 120, pixelRatio: 1 });
  });
});

describe('CanvasView.renderSnapshot', () => {
  let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

  beforeAll(async () => {
    stubCanvasGlobals();
    ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
    vi.spyOn(CanvasView.prototype, 'requestRender').mockImplementation(() => {});
  });

  function viewWithDashboard() {
    const doc = parseFlow(DASHBOARD_FLOW);
    const model = buildModel(doc, null);
    model.sourceDoc = doc;
    model.sourcePath = 'dashboard.flow';
    const view = new CanvasView(
      createCanvasMock(),
      {} as unknown as ConstructorParameters<typeof CanvasView>[1],
      createExpansionLayer(),
    );
    view.setModel(model);
    return view;
  }

  it('frames the padded content bounds at 1:1 and paints the background', () => {
    const view = viewWithDashboard();
    const bounds = view.snapshotBounds();
    const target = createCanvasMock(bounds.w * 2, bounds.h * 2);
    const ctx = target.getContext('2d')!;

    view.renderSnapshot({
      canvas: target,
      viewport: { width: bounds.w, height: bounds.h },
      pixelRatio: 2,
      background: '#17191d',
      grid: false,
    });

    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, target.width, target.height);
    // Viewport equal to the bounds means zoom-to-fit lands on scale 1: the world transform
    // is the pixel ratio alone, offset by the bounds origin.
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, -bounds.x * 2, -bounds.y * 2);
  });

  it('restores the live render target and camera afterwards', () => {
    const view = viewWithDashboard();
    view.setViewNow({ x: 17, y: 42, scale: 0.75 });
    const bounds = view.snapshotBounds();

    view.renderSnapshot({
      canvas: createCanvasMock(bounds.w, bounds.h),
      viewport: { width: bounds.w, height: bounds.h },
      pixelRatio: 1,
      background: null,
      grid: true,
    });

    expect(view.view).toEqual({ x: 17, y: 42, scale: 0.75 });
    // The live view still renders against its own canvas, not the snapshot's.
    view.fitToContent();
    expect(view.view.scale).toBeLessThanOrEqual(1.4);
    expect(view.view.x).not.toBe(17);
  });
});
