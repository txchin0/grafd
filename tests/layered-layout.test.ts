import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/client/flow-doc.js';
import { countCrossingPairs } from '../src/shared/edge-crossings.js';
import { parseFlow, type Rect } from '../src/shared/flow-format.js';
import { closestOrderedPlacement } from '../src/shared/layered-coordinates.js';
import { layOutLayered, layOutLayeredDrawing, RANK_GAP, rankGapFor, type LayeredGraph } from '../src/shared/layered-layout.js';
import { estimateEdgeLabelWidth, estimateNodeSize, NODE_WIDTH_STEPS } from '../src/shared/node-size-estimate.js';
import { CANVAS_SNAP, rectCenter, rectContainsRect, regionRectFrom, type Point } from '../src/shared/rect-math.js';
import { arbitraryGraph, overlaps, rectsByName } from './layout-fixtures.js';

const ORIGIN = { x: 80, y: 80 };

// Close enough to the curve the canvas draws through an edge's two ends and its bend to tell
// whether it clears a node: a quadratic passing through the bend halfway along.
function curveThrough(from: Point, bend: Point, to: Point): Point[] {
  const control = { x: 2 * bend.x - (from.x + to.x) / 2, y: 2 * bend.y - (from.y + to.y) / 2 };
  return Array.from({ length: 99 }, (_, step) => {
    const t = (step + 1) / 100;
    return {
      x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t * t * to.x,
      y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t * t * to.y,
    };
  });
}

function rectContainsPoint(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x > rect.x && point.x < rect.x + rect.w && point.y > rect.y && point.y < rect.y + rect.h;
}

function crossingsOf(graph: LayeredGraph, rects: Rect[]): number {
  return countCrossingPairs(graph.edges.map((edge) => ({
    from: rectCenter(rects[edge.from]),
    to: rectCenter(rects[edge.to]),
  })));
}

describe('layOutLayered on any graph', () => {
  it('places every node without overlap, on the snap lattice, the same way every time', () => {
    fc.assert(fc.property(arbitraryGraph, (graph) => {
      const rects = layOutLayered(graph, 'LR', ORIGIN);
      expect(rects).toHaveLength(graph.nodes.length);
      expect(layOutLayered(graph, 'LR', ORIGIN)).toEqual(rects);
      for (const rect of rects) {
        expect(rect.x % CANVAS_SNAP).toBe(0);
        expect(rect.y % CANVAS_SNAP).toBe(0);
      }
      rects.forEach((first, index) => {
        for (const second of rects.slice(index + 1)) expect(overlaps(first, second)).toBe(false);
      });
    }));
  });

  it('starts the drawing at the origin', () => {
    fc.assert(fc.property(arbitraryGraph, (graph) => {
      const rects = layOutLayered(graph, 'TB', ORIGIN);
      expect(Math.min(...rects.map((rect) => rect.x))).toBe(ORIGIN.x);
      expect(Math.min(...rects.map((rect) => rect.y))).toBe(ORIGIN.y);
    }));
  });

  it('never stands a node inside a region it is not a member of', () => {
    fc.assert(fc.property(arbitraryGraph, (graph) => {
      const rects = layOutLayered(graph, 'LR', ORIGIN);
      for (const members of graph.regions) {
        const region = regionRectFrom(null, members.map((member) => rects[member]));
        if (!region) continue;
        rects.forEach((rect, node) => {
          if (!members.includes(node)) expect(rectContainsRect(region, rect)).toBe(false);
        });
      }
    }));
  });

  it('runs every edge of an acyclic flow forward', () => {
    const acyclic = arbitraryGraph.map((graph) => ({
      ...graph,
      edges: graph.edges
        .filter((edge) => edge.from !== edge.to)
        .map((edge) => ({ from: Math.min(edge.from, edge.to), to: Math.max(edge.from, edge.to), kind: 'flow' as const, label: edge.label })),
    }));
    fc.assert(fc.property(acyclic, (graph) => {
      const rects = layOutLayered(graph, 'LR', ORIGIN);
      for (const edge of graph.edges) expect(rects[edge.to].x).toBeGreaterThan(rects[edge.from].x);
    }));
  });

  it('gives every node of a rank the same length along the flow', () => {
    fc.assert(fc.property(arbitraryGraph, (graph) => {
      const rects = layOutLayered(graph, 'LR', ORIGIN);
      const widthsByColumn = new Map<number, Set<number>>();
      for (const rect of rects) widthsByColumn.set(rect.x, (widthsByColumn.get(rect.x) ?? new Set()).add(rect.w));
      for (const widths of widthsByColumn.values()) expect(widths.size).toBe(1);
    }));
  });
});

describe('the room between ranks', () => {
  it('is the usual gap where no label needs more', () => {
    const rects = rectsByName('A\n  -> B\n\nB\n');
    expect(rects.get('B')!.x - (rects.get('A')!.x + rects.get('A')!.w)).toBe(RANK_GAP);
  });

  it('widens to fit the label of an edge between them', () => {
    const label = 'the user fills the form and taps the login button';
    const rects = rectsByName(`A\n  -> B : "${label}"\n\nB\n`);
    const gap = rects.get('B')!.x - (rects.get('A')!.x + rects.get('A')!.w);
    expect(gap).toBeGreaterThanOrEqual(estimateEdgeLabelWidth(label));
    expect(gap).toBe(rankGapFor([label], 'LR'));
  });

  it('keeps to the usual gap top to bottom, where a label lies across the flow', () => {
    expect(rankGapFor(['the user fills the form and taps the login button'], 'TB')).toBe(RANK_GAP);
  });
});

describe('where a long edge bends', () => {
  // A→D spans three ranks, and the straight line between them runs through B and C on the spine.
  const SKIPPING: LayeredGraph = {
    nodes: ['A', 'B', 'C', 'D'].map((title) => ({ title, description: null, entrypoint: false })),
    edges: [
      { from: 0, to: 1, kind: 'flow', label: null },
      { from: 1, to: 2, kind: 'flow', label: null },
      { from: 2, to: 3, kind: 'flow', label: null },
      { from: 0, to: 3, kind: 'flow', label: null },
    ],
    regions: [],
  };

  it('bends a long edge off the nodes it would cross, and leaves short edges straight', () => {
    const { rects, bendPoints } = layOutLayeredDrawing(SKIPPING, 'LR', ORIGIN);
    expect(bendPoints.slice(0, 3)).toEqual([null, null, null]);
    const bend = bendPoints[3]!;
    expect(bend).not.toBeNull();
    expect(bend.y).not.toBe(rectCenter(rects[0]).y);
    for (const rect of rects) expect(rectContainsPoint(rect, bend)).toBe(false);
  });

  it('bends it clear of the nodes it skips', () => {
    const { rects, bendPoints } = layOutLayeredDrawing(SKIPPING, 'LR', ORIGIN);
    const curve = curveThrough(rectCenter(rects[0]), bendPoints[3]!, rectCenter(rects[3]));
    for (const skipped of [rects[1], rects[2]]) {
      expect(curve.some((point) => rectContainsPoint(skipped, point))).toBe(false);
    }
  });

  it('runs an edge between two bands straight across the gap between them', () => {
    const acrossBands: LayeredGraph = { ...SKIPPING, regions: [[3]] };
    expect(layOutLayeredDrawing(acrossBands, 'LR', ORIGIN).bendPoints[3]).toBeNull();
  });

  it('never bends through a node, on any graph', () => {
    fc.assert(fc.property(arbitraryGraph, (graph) => {
      const { rects, bendPoints } = layOutLayeredDrawing(graph, 'LR', ORIGIN);
      expect(bendPoints).toHaveLength(graph.edges.length);
      for (const point of bendPoints) {
        if (point) for (const rect of rects) expect(rectContainsPoint(rect, point)).toBe(false);
      }
    }));
  });
});

describe('the shape of a layered layout', () => {
  it('draws a chain as one straight row', () => {
    const rects = rectsByName('A\n  -> B\n\nB\n  -> C\n\nC\n');
    const [a, b, c] = ['A', 'B', 'C'].map((name) => rects.get(name)!);
    expect(new Set([a.y, b.y, c.y]).size).toBe(1);
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
  });

  it('centres a fork between its branches and their join', () => {
    const rects = rectsByName('Start\n  -> Left\n  -> Right\n\nLeft\n  -> End\n\nRight\n  -> End\n\nEnd\n');
    const middleOf = (name: string): number => rectCenter(rects.get(name)!).y;
    expect(middleOf('Start')).toBe(middleOf('End'));
    expect(middleOf('Start') - middleOf('Left')).toBe(middleOf('Right') - middleOf('Start'));
  });

  it('keeps the longest path straight past a side branch', () => {
    const rects = rectsByName('A\n  -> B\n  -> Side\n\nB\n  -> C\n\nC\n  -> D\n\nD\n\nSide\n');
    const rows = new Set(['A', 'B', 'C', 'D'].map((name) => rects.get(name)!.y));
    expect(rows.size).toBe(1);
  });

  it('keeps a retry loop flowing forward and runs only the loop back', () => {
    const rects = rectsByName([
      'Show Form\n  entrypoint: true\n  -> Submit',
      'Submit\n  -> Done : "ok"\n  -> Show Error : "failed"',
      'Show Error\n  -> Show Form : "retry"',
      'Done',
    ].join('\n\n'));
    const columnOf = (name: string): number => rects.get(name)!.x;
    expect(columnOf('Show Form')).toBeLessThan(columnOf('Submit'));
    expect(columnOf('Submit')).toBeLessThan(columnOf('Show Error'));
    expect(columnOf('Submit')).toBeLessThan(columnOf('Done'));
  });

  it('places an error handler after the node that fails into it', () => {
    const rects = rectsByName('Charge Card\n  on_error: -> Refund\n  -> Receipt\n\nReceipt\n\nRefund\n');
    expect(rects.get('Refund')!.x).toBeGreaterThan(rects.get('Charge Card')!.x);
  });

  it('orders a rank so edges the file order would cross do not', () => {
    const graph: LayeredGraph = {
      nodes: ['A', 'B', 'C', 'D'].map((title) => ({ title, description: null, entrypoint: false })),
      edges: [{ from: 0, to: 3, kind: 'flow', label: null }, { from: 1, to: 2, kind: 'flow', label: null }],
      regions: [],
    };
    expect(crossingsOf(graph, layOutLayered(graph, 'LR', ORIGIN))).toBe(0);
  });

  it('keeps overlapping regions chained A, A+B, B apart from each other\'s non-members', () => {
    const text = [
      'context: A\n  nodes:\n    - One\n    - Two',
      'context: B\n  nodes:\n    - Two\n    - Three',
      'Zero\n  -> One\n  -> Two\n  -> Three',
      'One',
      'Two',
      'Three',
    ].join('\n\n');
    const rects = rectsByName(text);
    const regionOf = (members: string[]): Rect => regionRectFrom(null, members.map((name) => rects.get(name)!))!;
    for (const [members, outsiders] of [[['One', 'Two'], ['Zero', 'Three']], [['Two', 'Three'], ['Zero', 'One']]]) {
      for (const outsider of outsiders) expect(rectContainsRect(regionOf(members), rects.get(outsider)!)).toBe(false);
    }
  });

  it('lays out top to bottom when asked', () => {
    const graph: LayeredGraph = {
      nodes: ['A', 'B'].map((title) => ({ title, description: null, entrypoint: false })),
      edges: [{ from: 0, to: 1, kind: 'flow', label: null }],
      regions: [],
    };
    const [a, b] = layOutLayered(graph, 'TB', ORIGIN);
    expect(a.x).toBe(b.x);
    expect(b.y).toBeGreaterThan(a.y + a.h);
  });
});

describe('placeNodes', () => {
  it('lays out a graph with no positions as a layered drawing', () => {
    const rects = rectsByName('A\n  -> B\n\nB\n');
    expect(rects.get('A')!.y).toBe(rects.get('B')!.y);
  });

  it('keeps every authored position', () => {
    const rects = rectsByName('A\n  pos: 400, 400, 200, 88\n  -> B\n\nB\n');
    expect(rects.get('A')).toEqual({ x: 400, y: 400, w: 200, h: 88 });
  });

  it('places nodes where the canvas does, read from the file the way the linter reads it', () => {
    const text = [
      '---\nname: Checkout\n---',
      'context: Payment\n  nodes:\n    - Charge Card\n    - Refund',
      'Cart\n  entrypoint: true\n  description: "Items the user picked, with their quantities"\n  -> Charge Card : "pay"',
      'Charge Card\n  on_error: -> Refund\n  -> Receipt',
      'Receipt\n  -> Cart : "shop again"',
      'Refund',
      'Lost\n  -> Nowhere',
    ].join('\n\n');
    const model = buildModel(parseFlow(text), null);
    const linterRects = rectsByName(text);
    for (const node of model.nodes) expect(node.pos).toEqual(linterRects.get(node.name));
  });
});

describe('estimateNodeSize', () => {
  it('gives a short title the narrowest width and the default height', () => {
    expect(estimateNodeSize('Start', null)).toEqual({ w: NODE_WIDTH_STEPS[0], h: 88 });
  });

  it('widens a node until its title fits on one line', () => {
    expect(estimateNodeSize('Validate shopping cart contents', null).w).toBeGreaterThan(NODE_WIDTH_STEPS[0]);
  });

  it('grows a node taller for its description', () => {
    const description = 'Reads the session token from secure storage and refreshes it when it is about to expire';
    expect(estimateNodeSize('Check Session', description).h).toBeGreaterThan(88);
  });
});

describe('closestOrderedPlacement', () => {
  it('places items where they want to be when they are far enough apart', () => {
    expect(closestOrderedPlacement([0, 100], [1, 1], [50])).toEqual([0, 100]);
  });

  it('spreads items that want the same spot evenly around it', () => {
    expect(closestOrderedPlacement([0, 0], [1, 1], [50])).toEqual([-25, 25]);
  });

  it('lets the heavier item stay closer to where it wants to be', () => {
    const [heavy, light] = closestOrderedPlacement([0, 0], [3, 1], [40]);
    expect(Math.abs(heavy)).toBeLessThan(Math.abs(light));
    expect(light - heavy).toBe(40);
  });
});
