// Parallel edges between one pair of nodes have to be told apart at a glance, which means they
// need distinct anchors on the border and not just distinct curves in the middle. These tests
// measure every laid-out edge across the line between its two nodes, so a lane that collapses
// onto its neighbour fails here rather than in a screenshot.

import { describe, expect, it } from 'vitest';
import { layOutModelEdges, type EdgeGeometryMap } from '../src/client/canvas/edge-layout.js';
import { edgeEnd, edgeStart, type EdgeGeometry } from '../src/client/canvas/edge-path.js';
import { assignMissingIds, buildModel, type ModelEdge } from '../src/client/flow-doc.js';
import { distanceToEdgePath } from '../src/client/canvas/edge-path.js';
import { rectCenter, unitVectorBetween, type Point } from '../src/client/geometry.js';
import { parseFlow, type Rect } from '../src/shared/flow-format.js';

const NODE_SIZE = '200, 88';

function flowBetween(edgesFromA: string[], edgesFromB: string[]): string {
  return [
    '---',
    'name: Lanes',
    '---',
    '',
    'A',
    '  id: a-1',
    `  pos: 0, 0, ${NODE_SIZE}`,
    ...edgesFromA,
    '',
    'B',
    '  id: b-1',
    `  pos: 800, 0, ${NODE_SIZE}`,
    ...edgesFromB,
    '',
  ].join('\n');
}

function layOut(flowText: string): { edges: ModelEdge[]; geometry: EdgeGeometryMap; rects: Rect[] } {
  const doc = parseFlow(flowText);
  assignMissingIds(doc);
  const model = buildModel(doc, null);
  const geometry: EdgeGeometryMap = new Map();
  layOutModelEdges(model, geometry);
  return {
    edges: model.edges,
    geometry,
    rects: model.nodes.map((node) => node.pos!),
  };
}

// Signed distance across the line joining the two node centres: positive on one side, negative
// on the other. Comparing these is how "on opposite sides" and "in order" become assertions.
function offsetAcrossPairAxis(point: Point, rects: Rect[]): number {
  const from = rectCenter(rects[0]);
  const axis = unitVectorBetween(from, rectCenter(rects[1]));
  return axis.x * (point.y - from.y) - axis.y * (point.x - from.x);
}

function offsetsOf(geometry: EdgeGeometry, rects: Rect[]): { start: number; mid: number; end: number } {
  return {
    start: offsetAcrossPairAxis(edgeStart(geometry), rects),
    mid: offsetAcrossPairAxis(geometry.through[1], rects),
    end: offsetAcrossPairAxis(edgeEnd(geometry), rects),
  };
}

function laidOutOffsets(flowText: string) {
  const { edges, geometry, rects } = layOut(flowText);
  return edges.map((edge) => offsetsOf(geometry.get(edge)!, rects));
}

describe('edges pointing both ways between one pair', () => {
  const RECIPROCAL = flowBetween(['  -> B'], ['  -> A']);

  it('separates them where they meet the borders, not only in the middle', () => {
    const [forward, backward] = laidOutOffsets(RECIPROCAL);
    // The forward edge's start and the backward edge's end share a border; so do the other two.
    expect(Math.abs(forward.start - backward.end)).toBeGreaterThan(10);
    expect(Math.abs(forward.end - backward.start)).toBeGreaterThan(10);
  });

  it('puts them on opposite sides of the line between the nodes', () => {
    const [forward, backward] = laidOutOffsets(RECIPROCAL);
    expect(Math.sign(forward.mid)).toBe(-Math.sign(backward.mid));
    expect(Math.sign(forward.start)).toBe(-Math.sign(backward.start));
  });

  it('bows each one away from the middle, so the pair opens into a lens', () => {
    const [forward, backward] = laidOutOffsets(RECIPROCAL);
    expect(Math.abs(forward.mid)).toBeGreaterThan(Math.abs(forward.start));
    expect(Math.abs(backward.mid)).toBeGreaterThan(Math.abs(backward.start));
  });

  it('leaves a single reverse edge on the axis, so the lane is a property of the bundle', () => {
    const [onlyBackward] = laidOutOffsets(flowBetween([], ['  -> A']));
    expect(onlyBackward.start).toBeCloseTo(0, 6);
    expect(onlyBackward.mid).toBeCloseTo(0, 6);
  });
});

describe('lane ordering', () => {
  function midOffsetsAscending(offsets: { mid: number }[]): number[] {
    return offsets.map((offset) => offset.mid).sort((a, b) => a - b);
  }

  it.each([
    ['two', flowBetween(['  -> B'], ['  -> A'])],
    ['three', flowBetween(['  -> B', '  -> B : "retry"'], ['  -> A'])],
    ['four', flowBetween(['  -> B', '  -> B : "retry"'], ['  -> A', '  -> A : "back"'])],
  ])('keeps every lane of a bundle of %s distinct and in order', (_size, flowText) => {
    const offsets = laidOutOffsets(flowText);
    const mids = midOffsetsAscending(offsets);
    const starts = offsets.map((offset) => offset.start).sort((a, b) => a - b);
    for (let index = 1; index < mids.length; index += 1) {
      expect(mids[index]).toBeGreaterThan(mids[index - 1]);
      expect(starts[index]).toBeGreaterThan(starts[index - 1]);
    }
  });

  it('leaves the middle lane of an odd bundle straight, with its neighbours arcing either way', () => {
    const offsets = laidOutOffsets(flowBetween(['  -> B', '  -> B : "retry"'], ['  -> A']));
    const [middle, ...outer] = [...offsets].sort((a, b) => Math.abs(a.mid) - Math.abs(b.mid));
    expect(middle.mid).toBeCloseTo(middle.start, 6);
    expect(Math.sign(outer[0].mid)).toBe(-Math.sign(outer[1].mid));
  });
});

describe('a lone edge', () => {
  it('runs straight between its nodes', () => {
    const { edges, geometry, rects } = layOut(flowBetween(['  -> B'], []));
    const path = geometry.get(edges[0])!;
    expect(offsetsOf(path, rects)).toEqual({ start: 0, mid: 0, end: 0 });
    expect(distanceToEdgePath(path.through[1], path.path)).toBeCloseTo(0, 6);
  });
});

describe('lanes on small nodes', () => {
  const CRAMPED = [
    '---',
    'name: Cramped',
    '---',
    '',
    'A',
    '  id: a-1',
    '  pos: 0, 0, 40, 20',
    '  -> B',
    '  -> B : "retry"',
    '',
    'B',
    '  id: b-1',
    '  pos: 300, 0, 40, 20',
    '  -> A',
    '  -> A : "back"',
    '',
  ].join('\n');

  it('tightens the spacing so every anchor stays on its border', () => {
    const { edges, geometry, rects } = layOut(CRAMPED);
    for (const edge of edges) {
      const path = geometry.get(edge)!;
      for (const anchor of [edgeStart(path), edgeEnd(path)]) {
        const rect = rects.find((candidate) => Math.abs(anchor.x - candidate.x) < 1
          || Math.abs(anchor.x - (candidate.x + candidate.w)) < 1)!;
        expect(rect).toBeDefined();
        expect(anchor.y).toBeGreaterThanOrEqual(rect.y);
        expect(anchor.y).toBeLessThanOrEqual(rect.y + rect.h);
      }
    }
  });

  it('still gives each of them a distinct lane', () => {
    const mids = laidOutOffsets(CRAMPED).map((offset) => offset.mid);
    expect(new Set(mids.map((mid) => mid.toFixed(6))).size).toBe(mids.length);
  });
});

describe('repeated self-loops', () => {
  it('nest instead of stacking on one another', () => {
    const { edges, geometry } = layOut([
      '---',
      'name: Loops',
      '---',
      '',
      'A',
      '  id: a-1',
      '  pos: 0, 0, 200, 88',
      '  -> A',
      '  -> A : "again"',
      '',
    ].join('\n'));
    const [inner, outer] = edges.map((edge) => geometry.get(edge)!.through[1]);
    expect(outer.x).toBeGreaterThan(inner.x);
    expect(outer.y).toBeLessThan(inner.y);
  });
});
