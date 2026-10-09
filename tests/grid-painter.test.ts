import { describe, expect, it, type Mock } from 'vitest';
import { GridPainter, type GridPaint } from '../src/client/canvas/grid-painter.js';
import { createCanvasMock, createContextMock } from './canvas-mock.js';

const MAJOR_DOT_SIZE = 1.5;
const HALFWAY_DOT_SIZE = 1.2;
const EIGHTH_DOT_SIZE = 0.8;
const SPACING_AT_UNIT_SCALE = 32;
// A spacing whose tile would be past the largest the grid makes, so it draws cells directly.
const SPACING_PAST_LARGEST_TILE = 600;

interface Fill {
  x: number;
  y: number;
  width: number;
  height: number;
  alpha: number;
  style: unknown;
}

// A context that remembers what each fillRect drew with, and whose save/restore really restores
// the alpha, so the painter's bookkeeping can be checked.
function recordingContext() {
  const ctx = createContextMock();
  const fills: Fill[] = [];
  const savedAlphas: number[] = [];
  ctx.fillRect.mockImplementation((x: number, y: number, width: number, height: number) => {
    fills.push({ x, y, width, height, alpha: ctx.globalAlpha, style: ctx.fillStyle });
  });
  ctx.save.mockImplementation(() => savedAlphas.push(ctx.globalAlpha));
  ctx.restore.mockImplementation(() => { ctx.globalAlpha = savedAlphas.pop() ?? 1; });
  return { ctx, fills };
}

function createPainter() {
  const tiles: ReturnType<typeof recordingContext>[] = [];
  const tileCanvases: HTMLCanvasElement[] = [];
  const painter = new GridPainter(() => {
    const tile = recordingContext();
    tiles.push(tile);
    const canvas = createCanvasMock(0, 0);
    (canvas.getContext as Mock).mockReturnValue(tile.ctx);
    tileCanvases.push(canvas);
    return canvas;
  });
  const screen = recordingContext();
  const paint = (overrides: Partial<GridPaint> = {}) => {
    painter.paint(screen.ctx as unknown as CanvasRenderingContext2D, {
      view: { x: 0, y: 0, scale: 1 },
      viewport: { width: 320, height: 192 },
      pixelRatio: 1,
      depth: 0,
      color: 'rgba(0, 0, 0, 0.1)',
      opacity: 1,
      ...overrides,
    });
  };
  // Every fill drawn into any tile.
  const tileFills = () => tiles.flatMap((tile) => tile.fills);
  const dotsOfSize = (size: number) => tileFills().filter((fill) => Math.abs(fill.width - size) < 0.05 && Math.abs(fill.height - size) < 0.05);
  return { paint, screen, dotsOfSize, tileFills, tileCanvases };
}

describe('GridPainter', () => {
  it('fills the canvas once per kind of mark, however many dots are on screen', () => {
    const { paint, screen } = createPainter();
    paint({ depth: 3, viewport: { width: 1920, height: 1080 } });
    const kindsOfMark = 4;
    expect(screen.fills).toHaveLength(kindsOfMark);
    for (const fill of screen.fills) {
      expect(fill).toEqual(expect.objectContaining({ x: 0, y: 0, width: 1920, height: 1080 }));
      expect(typeof fill.style).toBe('object');
    }
  });

  it('draws only the plain lattice at the top of the trail', () => {
    const { paint, dotsOfSize, tileFills } = createPainter();
    paint({ depth: 0 });
    expect(dotsOfSize(MAJOR_DOT_SIZE).length).toBeGreaterThan(0);
    expect(tileFills().every((fill) => Math.abs(fill.width - MAJOR_DOT_SIZE) < 0.05)).toBe(true);
  });

  it('fills in the halfway points one level down', () => {
    const { paint, dotsOfSize } = createPainter();
    paint({ depth: 1 });
    expect(dotsOfSize(HALFWAY_DOT_SIZE).length).toBeGreaterThan(0);
    expect(dotsOfSize(EIGHTH_DOT_SIZE)).toHaveLength(0);
  });

  it('wraps a dot that straddles the tile edge onto both sides of it', () => {
    const { paint, dotsOfSize } = createPainter();
    paint({ depth: 1 });
    const halfway = dotsOfSize(HALFWAY_DOT_SIZE);
    const half = HALFWAY_DOT_SIZE / 2;
    expect(halfway.some((dot) => Math.abs(dot.x + half) < 1e-9)).toBe(true);
    expect(halfway.some((dot) => Math.abs(dot.x + half - SPACING_AT_UNIT_SCALE) < 1e-9)).toBe(true);
  });

  it('joins the dots into lines at the deepest step, dropping the dots along them', () => {
    const { paint, dotsOfSize, tileFills } = createPainter();
    paint({ depth: 4 });
    expect(tileFills().some((fill) => fill.width === SPACING_AT_UNIT_SCALE)).toBe(true);
    expect(dotsOfSize(HALFWAY_DOT_SIZE)).toHaveLength(0);
    expect(dotsOfSize(MAJOR_DOT_SIZE).length).toBeGreaterThan(0);
  });

  it('is partway resolved mid-dive', () => {
    const { paint, screen, dotsOfSize } = createPainter();
    paint({ depth: 0.5 });
    expect(dotsOfSize(HALFWAY_DOT_SIZE).length).toBeGreaterThan(0);
    const [halfwayFill, majorFill] = screen.fills;
    expect(halfwayFill.alpha).toBeGreaterThan(0);
    expect(halfwayFill.alpha).toBeLessThan(0.5);
    expect(majorFill.alpha).toBe(1);
  });

  it('leaves out orders too fine to read at the current zoom', () => {
    const { paint, dotsOfSize } = createPainter();
    paint({ depth: 3, view: { x: 0, y: 0, scale: 0.4 } });
    expect(dotsOfSize(HALFWAY_DOT_SIZE).length).toBeGreaterThan(0);
    expect(dotsOfSize(EIGHTH_DOT_SIZE)).toHaveLength(0);
  });

  it('places the tile so its lattice point lands on the camera\'s lattice, one spacing per tile', () => {
    const { paint, screen, tileCanvases } = createPainter();
    paint({ view: { x: 7, y: 3, scale: 1.3 } });
    const pattern = screen.ctx.createPattern.mock.results[0].value as { setTransform: Mock };
    const transform = pattern.setTransform.mock.lastCall![0];
    const spacing = SPACING_AT_UNIT_SCALE * 1.3;
    const tileSize = tileCanvases[0].width;
    expect(Math.abs(tileSize - spacing) / spacing).toBeLessThan(0.05);
    expect(transform.a * tileSize).toBeCloseTo(spacing);
    expect(transform.e + transform.a * (tileSize / 2)).toBeCloseTo(7);
    expect(transform.f + transform.d * (tileSize / 2)).toBeCloseTo(3);
  });

  it('keeps its tiles while the camera pans or zooms within a size step', () => {
    const { paint, screen } = createPainter();
    paint({ depth: 2, view: { x: 0, y: 0, scale: 1 } });
    const tilesDrawn = screen.ctx.createPattern.mock.calls.length;
    paint({ depth: 2, view: { x: 40, y: -12, scale: 1 } });
    paint({ depth: 2, view: { x: 40, y: -12, scale: 1.01 } });
    expect(screen.ctx.createPattern).toHaveBeenCalledTimes(tilesDrawn);
  });

  it('never redraws a tile because the depth moved, only to show a kind of mark it had not', () => {
    const { paint, screen } = createPainter();
    paint({ depth: 2.5 });
    const tilesDrawn = screen.ctx.createPattern.mock.calls.length;
    for (const depth of [2.6, 2.75, 2.99, 2.2]) paint({ depth });
    expect(screen.ctx.createPattern).toHaveBeenCalledTimes(tilesDrawn);
  });

  it('keeps the tiles of both grids a dive paints, the grid left and the grid entered', () => {
    const { paint, screen } = createPainter();
    paint({ depth: 1, view: { x: 0, y: 0, scale: 3 } });
    paint({ depth: 1, view: { x: 0, y: 0, scale: 0.8 } });
    const tilesDrawn = screen.ctx.createPattern.mock.calls.length;
    for (let frame = 0; frame < 3; frame++) {
      paint({ depth: 1, view: { x: 0, y: 0, scale: 3 } });
      paint({ depth: 1, view: { x: 0, y: 0, scale: 0.8 } });
    }
    expect(screen.ctx.createPattern).toHaveBeenCalledTimes(tilesDrawn);
  });

  it('draws a few huge cells straight onto the canvas rather than through a tile', () => {
    const { paint, screen } = createPainter();
    paint({ depth: 1, view: { x: 0, y: 0, scale: SPACING_PAST_LARGEST_TILE / SPACING_AT_UNIT_SCALE } });
    expect(screen.ctx.createPattern).not.toHaveBeenCalled();
    expect(screen.fills.some((fill) => fill.width === MAJOR_DOT_SIZE)).toBe(true);
    expect(screen.fills.some((fill) => fill.width === HALFWAY_DOT_SIZE)).toBe(true);
  });

  it('fades the lattice out as it shrinks towards noise rather than cutting it off', () => {
    const fading = createPainter();
    fading.paint({ view: { x: 0, y: 0, scale: 11 / SPACING_AT_UNIT_SCALE } });
    expect(fading.screen.fills[0].alpha).toBeGreaterThan(0);
    expect(fading.screen.fills[0].alpha).toBeLessThan(1);
    const gone = createPainter();
    gone.paint({ view: { x: 0, y: 0, scale: 8 / SPACING_AT_UNIT_SCALE } });
    expect(gone.screen.fills).toHaveLength(0);
  });

  it('draws nothing once fully faded out', () => {
    const { paint, screen } = createPainter();
    paint({ depth: 2, opacity: 0 });
    expect(screen.fills).toHaveLength(0);
  });

  it('leaves the context as it found it', () => {
    const { paint, screen } = createPainter();
    paint({ depth: 2.5, opacity: 0.4 });
    expect(screen.ctx.globalAlpha).toBe(1);
    expect(screen.ctx.save).toHaveBeenCalledTimes(screen.ctx.restore.mock.calls.length);
  });
});
