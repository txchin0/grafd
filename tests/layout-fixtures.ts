// Shared by the layout tests: reading a .flow the way the linter does and placing it, and random
// graphs to lay out.

import fc from 'fast-check';
import { placeNodes, type LayoutScope } from '../src/shared/auto-layout.js';
import type { Rect } from '../src/shared/flow-format.js';
import { layoutScopeOfScanned } from '../src/shared/flow-lint-semantics.js';
import { rootScope, scanFlow } from '../src/shared/flow-scan.js';
import type { LayeredGraph } from '../src/shared/layered-layout.js';

export function scopeFrom(text: string): LayoutScope {
  return layoutScopeOfScanned(rootScope(scanFlow(text))!);
}

export function rectsByName(text: string): Map<string, Rect> {
  const scope = scopeFrom(text);
  const rects = placeNodes(scope);
  return new Map(scope.nodes.map((node, index) => [node.name, rects[index]]));
}

export function overlaps(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.w && second.x < first.x + first.w
    && first.y < second.y + second.h && second.y < first.y + first.h;
}

const WORDS = ['load', 'the', 'session', 'validate', 'payment', 'retry', 'user', 'checkout', 'token', 'refresh'];

export const arbitraryGraph: fc.Arbitrary<LayeredGraph> = fc
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
