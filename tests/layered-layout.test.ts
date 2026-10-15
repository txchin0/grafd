import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/client/flow-doc.js';
import { placeNodes, type LayoutScope } from '../src/shared/auto-layout.js';
import { countCrossingPairs } from '../src/shared/edge-crossings.js';
import { parseFlow, type Rect } from '../src/shared/flow-format.js';
import { closestOrderedPlacement } from '../src/shared/layered-coordinates.js';
import { layOutLayered, type LayeredGraph } from '../src/shared/layered-layout.js';
import { layoutScopeOfScanned } from '../src/shared/flow-lint-semantics.js';
import { rootScope, scanFlow } from '../src/shared/flow-scan.js';
import { estimateNodeSize, NODE_WIDTH_STEPS } from '../src/shared/node-size-estimate.js';
import { CANVAS_SNAP, rectCenter, rectContainsRect, regionRectFrom } from '../src/shared/rect-math.js';

const ORIGIN = { x: 80, y: 80 };

function scopeFrom(text: string): LayoutScope {
  return layoutScopeOfScanned(rootScope(scanFlow(text))!);
}

function rectsByName(text: string): Map<string, Rect> {
  const scope = scopeFrom(text);
  const rects = placeNodes(scope);
  return new Map(scope.nodes.map((node, index) => [node.name, rects[index]]));
}

function overlaps(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.w && second.x < first.x + first.w
    && first.y < second.y + second.h && second.y < first.y + first.h;
}

function crossingsOf(graph: LayeredGraph, rects: Rect[]): number {
  return countCrossingPairs(graph.edges.map((edge) => ({
    from: rectCenter(rects[edge.from]),
    to: rectCenter(rects[edge.to]),
  })));
}

const WORDS = ['load', 'the', 'session', 'validate', 'payment', 'retry', 'user', 'checkout', 'token', 'refresh'];

const arbitraryGraph: fc.Arbitrary<LayeredGraph> = fc
  .integer({ min: 1, max: 14 })
  .chain((nodeCount) => fc.record({
    nodes: fc.array(
      fc.record({
        title: fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 6 }).map((words) => words.join(' ')),
        description: fc.option(fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 30 }).map((words) => words.join(' '))),
        entrypoint: fc.boolean(),
      }),
      { minLength: nodeCount, maxLength: nodeCount },
    ),
    edges: fc.array(
      fc.record({
        from: fc.integer({ min: 0, max: nodeCount - 1 }),
        to: fc.integer({ min: 0, max: nodeCount - 1 }),
        kind: fc.constantFrom('flow' as const, 'flow' as const, 'error' as const),
      }),
      { maxLength: nodeCount * 2 },
    ),
    // Each node in at most one of three regions, or none.
    membership: fc.array(fc.integer({ min: -1, max: 2 }), { minLength: nodeCount, maxLength: nodeCount }),
  }))
  .map(({ nodes, edges, membership }) => ({
    nodes,
    edges,
    regions: [0, 1, 2].map((region) => [...membership.keys()].filter((node) => membership[node] === region)),
  }));

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
        .map((edge) => ({ from: Math.min(edge.from, edge.to), to: Math.max(edge.from, edge.to), kind: 'flow' as const })),
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
      edges: [{ from: 0, to: 3, kind: 'flow' }, { from: 1, to: 2, kind: 'flow' }],
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
      edges: [{ from: 0, to: 1, kind: 'flow' }],
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
    expect(rects.get('B')!.y).toBeGreaterThan(400 + 88);
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
