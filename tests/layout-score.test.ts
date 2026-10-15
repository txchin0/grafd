// The layout score: what each finding catches, that the fix it gives removes it, and that a graph
// the layered layout drew is free of everything that layout promises to avoid.

import fc from 'fast-check';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { scoreDocumentText } from '../src/shared/document-score.js';
import type { Rect } from '../src/shared/flow-format.js';
import { layOutLayeredDrawing } from '../src/shared/layered-layout.js';
import { bendThroughPoint } from '../src/shared/canvas-edge-style.js';
import { scoreGraph, type Finding, type FindingKind, type ScoredGraph } from '../src/shared/layout-score.js';
import { rectCenter } from '../src/shared/rect-math.js';
import { canvasLayerPathOf, parseCanvasLayer } from '../src/shared/canvas-layer.js';
import { runFlowScore } from '../src/tools/flow-score.js';
import { arbitraryGraph } from './layout-fixtures.js';

function node(name: string, x: number, y: number, w = 200, h = 88): ScoredGraph['nodes'][number] {
  return { name, rect: { x, y, w, h }, description: null, shape: 'rectangle' };
}

function edge(from: number, to: number, label: string | null = null): ScoredGraph['edges'][number] {
  return { from, to, kind: 'flow', label, bend: null };
}

function findingsOf(graph: ScoredGraph, kind: FindingKind): Finding[] {
  return scoreGraph(graph).findings.filter((finding) => finding.kind === kind);
}

// The graph with a finding's move or resize applied.
function withFixApplied(graph: ScoredGraph, finding: Finding): ScoredGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((scored) => {
      const { move, resize } = finding;
      if (move?.node === scored.name) return { ...scored, rect: { ...scored.rect, x: scored.rect.x + move.dx, y: scored.rect.y + move.dy } };
      if (resize?.node === scored.name) return { ...scored, rect: { ...scored.rect, w: resize.w, h: resize.h } };
      return scored;
    }),
  };
}

// Applies the first finding of a kind and checks that kind of finding is gone.
function expectFixToClear(graph: ScoredGraph, kind: FindingKind): void {
  const [finding] = findingsOf(graph, kind);
  expect(finding).toBeDefined();
  expect(findingsOf(withFixApplied(graph, finding), kind)).toEqual([]);
}

describe('a clean graph', () => {
  it('scores 100 with nothing to fix', () => {
    const graph: ScoredGraph = { nodes: [node('A', 0, 0), node('B', 296, 0)], edges: [edge(0, 1)], regions: [] };
    expect(scoreGraph(graph)).toMatchObject({ score: 100, findings: [] });
  });
});

describe('each finding, and the fix it gives', () => {
  it('catches nodes on top of each other and moves one off', () => {
    expectFixToClear({ nodes: [node('A', 0, 0), node('B', 120, 40)], edges: [], regions: [] }, 'overlap');
  });

  it('catches nodes too close to read apart and moves one away', () => {
    expectFixToClear({ nodes: [node('A', 0, 0), node('B', 210, 0)], edges: [], regions: [] }, 'crowded');
  });

  it('catches an edge drawn through a node and moves the node out of its way', () => {
    const graph: ScoredGraph = { nodes: [node('A', 0, 0), node('B', 300, 0), node('C', 600, 0)], edges: [edge(0, 2)], regions: [] };
    const [finding] = findingsOf(graph, 'edge-through-node');
    expect(finding.message).toContain('"B"');
    expectFixToClear(graph, 'edge-through-node');
  });

  it('leaves an edge alone when its bend takes it round the node', () => {
    const graph: ScoredGraph = { nodes: [node('A', 0, 0), node('B', 300, 0), node('C', 600, 0)], edges: [edge(0, 2)], regions: [] };
    const bend = bendThroughPoint({ x: 400, y: -120 }, rectCenter(graph.nodes[0].rect), rectCenter(graph.nodes[2].rect));
    expect(findingsOf({ ...graph, edges: [{ ...edge(0, 2), bend }] }, 'edge-through-node')).toEqual([]);
  });

  it('catches a node standing in a region it is not a member of and moves it out', () => {
    const graph: ScoredGraph = {
      nodes: [node('Member', 0, 0), node('Outsider', 100, 300)],
      edges: [],
      regions: [{ name: 'Cart', members: [0], area: { x: -40, y: -40, w: 600, h: 500 } }],
    };
    expectFixToClear(graph, 'outsider-in-region');
  });

  it('catches regions overlapping with no member in common', () => {
    const graph: ScoredGraph = {
      nodes: [node('A', 0, 0), node('B', 240, 0)],
      edges: [],
      regions: [{ name: 'One', members: [0], area: { x: 0, y: 0, w: 400, h: 200 } }, { name: 'Two', members: [1], area: null }],
    };
    expect(findingsOf(graph, 'regions-overlap')).toHaveLength(1);
  });

  it('catches two edges crossing, but not two edges between the same nodes', () => {
    const crossing: ScoredGraph = {
      nodes: [node('A', 0, 0), node('B', 0, 300), node('C', 600, 0), node('D', 600, 300)],
      edges: [edge(0, 3), edge(1, 2)],
      regions: [],
    };
    expect(findingsOf(crossing, 'crossing')).toHaveLength(1);
    const fannedApart: ScoredGraph = { nodes: [node('A', 0, 0), node('B', 600, 0)], edges: [edge(0, 1), edge(1, 0)], regions: [] };
    expect(findingsOf(fannedApart, 'crossing')).toEqual([]);
  });

  it('catches a label with no room between its nodes, once, and makes room for it', () => {
    const graph: ScoredGraph = {
      nodes: [node('A', 0, 0), node('B', 240, 0)],
      edges: [edge(0, 1, 'the user fills the form and taps login')],
      regions: [],
    };
    expect(findingsOf(graph, 'label-collision')).toHaveLength(1);
    expectFixToClear(graph, 'label-collision');
  });

  it('catches two labels lying side by side and moves one edge far enough to part them', () => {
    // Top to bottom, one node forking to two below: both labels sit halfway down, next to each other.
    const graph: ScoredGraph = {
      nodes: [node('A', 0, 0), node('B', 0, 240), node('C', 256, 240)],
      edges: [edge(0, 1, 'payment received from the bank'), edge(0, 2, 'cancelled or expired unpaid')],
      regions: [],
    };
    expect(findingsOf(graph, 'label-collision')).toHaveLength(1);
    expectFixToClear(graph, 'label-collision');
  });

  it('catches text a node is too small to show and gives the size that shows it', () => {
    const graph: ScoredGraph = {
      nodes: [{ name: 'Reconcile the ledger against every bank statement', rect: { x: 0, y: 0, w: 120, h: 64 }, description: null, shape: 'rectangle' }],
      edges: [],
      regions: [],
    };
    expectFixToClear(graph, 'text-cut-off');
  });

  it('catches ends that nearly line up and lines them up', () => {
    const graph: ScoredGraph = { nodes: [node('A', 0, 0), node('B', 296, 10)], edges: [edge(0, 1)], regions: [] };
    expectFixToClear(graph, 'near-miss');
  });

  it('leaves alone ends half a snap step apart, which the lattice cannot line up', () => {
    const graph: ScoredGraph = { nodes: [node('A', 0, 0, 200, 88), node('B', 296, 0, 200, 96)], edges: [edge(0, 1)], regions: [] };
    expect(findingsOf(graph, 'near-miss')).toEqual([]);
  });

  it('costs more for what hides things than for what is only untidy', () => {
    const overlapping = scoreGraph({ nodes: [node('A', 0, 0), node('B', 100, 0)], edges: [], regions: [] });
    const nearlyLevel = scoreGraph({ nodes: [node('A', 0, 0), node('B', 296, 10)], edges: [edge(0, 1)], regions: [] });
    expect(overlapping.score).toBeLessThan(nearlyLevel.score);
  });
});

describe('a graph the layered layout drew', () => {
  const PROMISED: FindingKind[] = ['overlap', 'crowded', 'outsider-in-region', 'regions-overlap', 'text-cut-off'];

  it('has none of what the layout promises to avoid', () => {
    fc.assert(fc.property(arbitraryGraph, (graph) => {
      const { rects, bendPoints } = layOutLayeredDrawing(graph, 'LR', { x: 0, y: 0 });
      const scored: ScoredGraph = {
        nodes: graph.nodes.map((laidOut, index) => ({ name: `n${index}`, rect: rects[index], description: laidOut.description, shape: laidOut.shape ?? ('rectangle' as const) })),
        edges: graph.edges.map((laidOut, index) => {
          const point = bendPoints[index];
          const bend = point ? bendThroughPoint(point, rectCenter(rects[laidOut.from]), rectCenter(rects[laidOut.to])) : null;
          return { ...laidOut, bend };
        }),
        regions: graph.regions.map((members, index) => ({ name: `r${index}`, members, area: null })),
      };
      const counts = scoreGraph(scored).counts;
      for (const kind of PROMISED) expect(counts[kind]).toBe(0);
    }));
  });
});

// A→C straight runs through B; the layer bends it round B.
const SKIPPING_FLOW = `---
name: Skipping
---

A
  id: a-1
  pos: 0, 0, 200, 88
  -> B
  -> C

B
  id: b-1
  pos: 300, 0, 200, 88
  -> C

C
  id: c-1
  pos: 600, 0, 200, 88
`;

describe('scoring a file', () => {
  it('draws edges as the canvas layer bends them', () => {
    const [straight] = scoreDocumentText(SKIPPING_FLOW, null);
    expect(straight.current.counts['edge-through-node']).toBe(1);

    const bend = bendThroughPoint({ x: 400, y: -120 }, { x: 100, y: 44 }, { x: 700, y: 44 });
    const layer = parseCanvasLayer(JSON.stringify({ format: 'grafd-canvas/1', edges: { 'a-1 -> #c-1': { bend: [bend!.along, bend!.across] } } }));
    const [bent] = scoreDocumentText(SKIPPING_FLOW, layer);
    expect(bent.current.counts['edge-through-node']).toBe(0);
  });

  it('says what arranging would score', () => {
    const [scored] = scoreDocumentText(SKIPPING_FLOW, null);
    expect(scored.arranged).toBeGreaterThan(scored.current.score);
  });

  it('scores each graph block on its own', () => {
    const text = `${SKIPPING_FLOW}\ngraph: Inner\n  X\n    -> Y\n\n  Y\n`;
    expect(scoreDocumentText(text, null).map((scored) => scored.scope)).toEqual([null, 'Inner']);
  });
});

describe('grafd score', () => {
  async function workspaceWith(text: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'grafd-score-'));
    await writeFile(path.join(root, 'main.flow'), text);
    return root;
  }

  it('fails a graph scoring below --min, and passes it otherwise', async () => {
    const root = await workspaceWith(SKIPPING_FLOW);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runFlowScore([root, '--min=100'])).toBe(1);
      expect(await runFlowScore([root, '--min=50'])).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it('reports the findings and their moves as JSON', async () => {
    const root = await workspaceWith(SKIPPING_FLOW);
    const output: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((text: string) => output.push(text));
    try {
      await runFlowScore([root, '--format=json']);
    } finally {
      log.mockRestore();
    }
    const [file] = JSON.parse(output.join('\n')).files;
    const [graph] = file.graphs;
    expect(graph.findings[0]).toMatchObject({ kind: 'edge-through-node', move: { node: 'B' } });
    expect(graph.arranged).toBeGreaterThan(graph.score);
  });

  it('refuses an option it does not know', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runFlowScore(['--sideways'])).toBe(2);
    } finally {
      log.mockRestore();
    }
  });

  it('reads the canvas layer beside each file', async () => {
    const root = await workspaceWith(SKIPPING_FLOW);
    const bend = bendThroughPoint({ x: 400, y: -120 }, { x: 100, y: 44 }, { x: 700, y: 44 })!;
    const layer = { format: 'grafd-canvas/1', edges: { 'a-1 -> #c-1': { bend: [bend.along, bend.across] } } };
    await writeFile(path.join(root, canvasLayerPathOf('main.flow')), JSON.stringify(layer));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runFlowScore([root, '--min=100'])).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});
