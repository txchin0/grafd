import type { View, ViewportSize } from './camera-transition.js';

// The background grid doubles as the depth gauge of a dive. At the top level it is the plain dot
// lattice; each level further down resolves the gaps between neighbouring dots one step finer —
// a new order of dots along the grid lines, halving their spacing — until the last step joins
// them into lines. Depth is continuous, so a dive can resolve the grid while the camera moves.
//
// The lattice itself never moves or changes spacing with depth: it stays where snapping lands.
//
// The grid is painted every frame, twice during a dive, and must stay smooth on slow machines, so
// its cost may not grow with the number of dots on screen, nor with how fast the camera or the
// depth is changing. Each kind of dot is one small tile, drawn once and filled across the screen
// as a repeating pattern; depth only sets how strongly each kind is filled, so it never redraws a
// tile. Tile sizes come in fixed steps and the pattern's transform stretches a tile to the exact
// spacing, so a zoom reuses a few cached tiles instead of drawing a new one every frame. Placing the
// pattern by transform rather than snapping it to whole pixels lets it glide with the camera.
//
// Measured on a dive benchmark at 4x CPU throttling: redrawing tiles every frame of a dive cost
// four times the frames the old per-dot grid did.

const GRID_SPACING = 32;
const MAJOR_DOT_SIZE = 1.5;
// The lattice fades out as its screen spacing shrinks from the first to the second; below that it
// reads as noise. A fade rather than a cut-off, so a grid growing in during a dive never pops.
const MAJOR_SPACING_FULLY_SHOWN = 14;
const MAJOR_SPACING_HIDDEN = 9;
// A finer order fades out as its own spacing shrinks from twice this to this.
const MIN_RESOLVED_SPACING = 3.5;
// Past this many device pixels a tile costs more memory than the few cells on screen cost to draw
// directly, so the cells are drawn directly.
const MAX_TILE_SIZE = 512;
// A tile stretched to at most half a step either way keeps its dots within 4.5% of their size.
const TILE_SIZE_STEPS_PER_DOUBLING = 8;
// Enough for every kind of dot at every size step a dive passes through, in both grids it paints.
const CACHED_TILE_COUNT = 48;

interface ResolvedOrder {
  divisions: number;
  dotSize: number;
  opacity: number;
}

const RESOLVED_ORDERS: readonly ResolvedOrder[] = [
  { divisions: 2, dotSize: 1.2, opacity: 0.85 },
  { divisions: 4, dotSize: 1, opacity: 0.75 },
  { divisions: 8, dotSize: 0.8, opacity: 0.65 },
];
// The step after the last order of dots, where the dots along each line give way to the line.
const JOINED_LINES_DEPTH = RESOLVED_ORDERS.length + 1;
const JOINED_LINE_WIDTH = 1;
const JOINED_LINE_OPACITY = 0.8;

export interface GridPaint {
  view: View;
  viewport: ViewportSize;
  pixelRatio: number;
  // Levels below the top of the dive trail; fractional mid-dive.
  depth: number;
  color: string;
  opacity: number;
}

export type TileCanvas = HTMLCanvasElement | OffscreenCanvas;
type TileContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type PaintContext = CanvasRenderingContext2D | TileContext;

// One kind of mark the grid repeats in every cell.
type GridLayer =
  | { kind: 'joined-lines' }
  | { kind: 'dots'; name: string; dotSize: number; divisions: number; positions: 'lattice-point' | 'odd-steps' };

const MAJOR_DOTS: GridLayer = { kind: 'dots', name: 'major', dotSize: MAJOR_DOT_SIZE, divisions: 1, positions: 'lattice-point' };
const JOINED_LINES: GridLayer = { kind: 'joined-lines' };
const ORDER_LAYERS: readonly GridLayer[] = RESOLVED_ORDERS.map((order) => ({
  kind: 'dots',
  name: `order-${order.divisions}`,
  dotSize: order.dotSize,
  divisions: order.divisions,
  positions: 'odd-steps',
}));

interface VisibleLayer {
  layer: GridLayer;
  opacity: number;
}

interface GridTile {
  key: string;
  canvas: TileCanvas;
  pattern: CanvasPattern | null;
}

export class GridPainter {
  // Most recently used first.
  private readonly tiles: GridTile[] = [];

  constructor(private readonly createTileCanvas: () => TileCanvas) {}

  paint(ctx: CanvasRenderingContext2D, paint: GridPaint): void {
    const spacing = GRID_SPACING * paint.view.scale;
    const opacity = paint.opacity * legibilityOfLattice(spacing);
    if (opacity <= 0) return;
    const layers = visibleLayers(paint.depth, spacing);
    const tileSize = steppedTileSize(spacing * paint.pixelRatio);
    ctx.save();
    ctx.globalAlpha *= opacity;
    if (tileSize > MAX_TILE_SIZE) paintCellsDirectly(ctx, paint, spacing, layers);
    else this.fillWithTiles(ctx, paint, spacing, tileSize, layers);
    ctx.restore();
  }

  private fillWithTiles(
    ctx: CanvasRenderingContext2D,
    paint: GridPaint,
    spacing: number,
    tileSize: number,
    layers: readonly VisibleLayer[],
  ): void {
    // Pattern space is a tile's pixels, with a lattice point at the tile's centre.
    const tilePixel = spacing / tileSize;
    const centre = tileSize / 2;
    const placement = {
      a: tilePixel,
      b: 0,
      c: 0,
      d: tilePixel,
      e: paint.view.x - centre * tilePixel,
      f: paint.view.y - centre * tilePixel,
    };
    const baseAlpha = ctx.globalAlpha;
    for (const { layer, opacity } of layers) {
      const pattern = this.tileFor(ctx, layer, tileSize, paint).pattern;
      if (!pattern) continue;
      pattern.setTransform(placement);
      ctx.globalAlpha = baseAlpha * opacity;
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, paint.viewport.width, paint.viewport.height);
    }
    ctx.globalAlpha = baseAlpha;
  }

  private tileFor(ctx: CanvasRenderingContext2D, layer: GridLayer, tileSize: number, paint: GridPaint): GridTile {
    const key = `${tileSize}|${paint.pixelRatio}|${layerName(layer)}|${paint.color}`;
    const cached = this.tiles.find((tile) => tile.key === key);
    if (cached) {
      this.markRecentlyUsed(cached);
      return cached;
    }
    const tile = this.recycledTile();
    tile.key = key;
    tile.canvas.width = tileSize;
    tile.canvas.height = tileSize;
    const tileContext = tile.canvas.getContext('2d') as TileContext | null;
    if (!tileContext) {
      tile.pattern = null;
      return tile;
    }
    tileContext.fillStyle = paint.color;
    // The cells left of and above the tile's own lattice point reach into it, so drawing both rows
    // and columns of cells wraps the marks that straddle the tile's edges.
    const firstLatticePoint = tileSize / 2 - tileSize;
    paintCells(tileContext, [{ layer, opacity: 1 }], {
      spacing: tileSize,
      unitsPerPixel: paint.pixelRatio,
      firstX: firstLatticePoint,
      firstY: firstLatticePoint,
      columns: 2,
      rows: 2,
    });
    tile.pattern = ctx.createPattern(tile.canvas, 'repeat');
    return tile;
  }

  private recycledTile(): GridTile {
    if (this.tiles.length < CACHED_TILE_COUNT) {
      const tile: GridTile = { key: '', canvas: this.createTileCanvas(), pattern: null };
      this.tiles.unshift(tile);
      return tile;
    }
    const leastRecent = this.tiles[this.tiles.length - 1];
    this.markRecentlyUsed(leastRecent);
    return leastRecent;
  }

  private markRecentlyUsed(tile: GridTile): void {
    const index = this.tiles.indexOf(tile);
    if (index === 0) return;
    this.tiles.splice(index, 1);
    this.tiles.unshift(tile);
  }
}

function paintCellsDirectly(
  ctx: CanvasRenderingContext2D,
  paint: GridPaint,
  spacing: number,
  layers: readonly VisibleLayer[],
): void {
  const firstX = positiveModulo(paint.view.x, spacing) - spacing;
  const firstY = positiveModulo(paint.view.y, spacing) - spacing;
  ctx.fillStyle = paint.color;
  paintCells(ctx, layers, {
    spacing,
    unitsPerPixel: 1,
    firstX,
    firstY,
    columns: Math.ceil((paint.viewport.width - firstX) / spacing) + 1,
    rows: Math.ceil((paint.viewport.height - firstY) / spacing) + 1,
  });
}

// What shows at `depth` when the lattice is `screenSpacing` screen pixels apart, and how strongly.
function visibleLayers(depth: number, screenSpacing: number): VisibleLayer[] {
  const linesEmerged = emergenceAt(depth, JOINED_LINES_DEPTH);
  const layers: VisibleLayer[] = [];
  if (linesEmerged > 0) layers.push({ layer: JOINED_LINES, opacity: linesEmerged * JOINED_LINE_OPACITY });
  RESOLVED_ORDERS.forEach((order, index) => {
    const emerged = emergenceAt(depth, index + 1) * (1 - linesEmerged) * legibilityOfOrder(order, screenSpacing);
    if (emerged > 0) layers.push({ layer: ORDER_LAYERS[index], opacity: emerged * order.opacity });
  });
  layers.push({ layer: MAJOR_DOTS, opacity: 1 });
  return layers;
}

function steppedTileSize(deviceSpacing: number): number {
  const step = Math.round(Math.log2(deviceSpacing) * TILE_SIZE_STEPS_PER_DOUBLING);
  return Math.round(2 ** (step / TILE_SIZE_STEPS_PER_DOUBLING));
}

function layerName(layer: GridLayer): string {
  return layer.kind === 'joined-lines' ? 'joined-lines' : layer.name;
}

// How far the step reached at `stepDepth` has appeared: nothing a whole level before it, fully at it.
function emergenceAt(depth: number, stepDepth: number): number {
  return clampUnit(depth - (stepDepth - 1));
}

function legibilityOfLattice(spacing: number): number {
  return clampUnit((spacing - MAJOR_SPACING_HIDDEN) / (MAJOR_SPACING_FULLY_SHOWN - MAJOR_SPACING_HIDDEN));
}

function legibilityOfOrder(order: ResolvedOrder, majorSpacing: number): number {
  const orderSpacing = majorSpacing / order.divisions;
  return clampUnit((orderSpacing - MIN_RESOLVED_SPACING) / MIN_RESOLVED_SPACING);
}

// A run of cells on some surface: where the first lattice point sits, how far apart they are, and
// how many surface units make one screen (CSS) pixel, which mark sizes are given in.
interface CellSpan {
  spacing: number;
  unitsPerPixel: number;
  firstX: number;
  firstY: number;
  columns: number;
  rows: number;
}

// Each cell draws what lies on its lattice point and along the grid lines running right of and
// below it, so neighbouring cells never paint the same mark twice.
function paintCells(ctx: PaintContext, layers: readonly VisibleLayer[], span: CellSpan): void {
  const baseAlpha = ctx.globalAlpha;
  for (const { layer, opacity } of layers) {
    ctx.globalAlpha = baseAlpha * opacity;
    for (let column = 0; column < span.columns; column++) {
      for (let row = 0; row < span.rows; row++) {
        const x = span.firstX + column * span.spacing;
        const y = span.firstY + row * span.spacing;
        if (layer.kind === 'joined-lines') paintLineSegments(ctx, span, x, y);
        else paintDots(ctx, span, layer, x, y);
      }
    }
  }
  ctx.globalAlpha = baseAlpha;
}

function paintLineSegments(ctx: PaintContext, span: CellSpan, x: number, y: number): void {
  const width = JOINED_LINE_WIDTH * span.unitsPerPixel;
  ctx.fillRect(x, y - width / 2, span.spacing, width);
  ctx.fillRect(x - width / 2, y, width, span.spacing);
}

function paintDots(
  ctx: PaintContext,
  span: CellSpan,
  layer: Extract<GridLayer, { kind: 'dots' }>,
  x: number,
  y: number,
): void {
  const size = layer.dotSize * span.unitsPerPixel;
  const half = size / 2;
  if (layer.positions === 'lattice-point') {
    ctx.fillRect(x - half, y - half, size, size);
    return;
  }
  // An order adds its dots at odd multiples of its step; the even ones belong to coarser orders.
  const step = span.spacing / layer.divisions;
  for (let multiple = 1; multiple < layer.divisions; multiple += 2) {
    const along = multiple * step;
    ctx.fillRect(x + along - half, y - half, size, size);
    ctx.fillRect(x - half, y + along - half, size, size);
  }
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}
