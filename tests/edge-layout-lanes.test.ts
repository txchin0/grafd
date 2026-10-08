// Parallel edges between one pair of nodes have to be told apart at a glance, which means they
// need distinct anchors on the border and not just distinct curves in the middle. These tests
// measure every laid-out edge across the line between its two nodes, so a lane that collapses
// onto its neighbour fails here rather than in a screenshot.

import { describe, expect, it } from 'vitest';
import { edgePathBounds, layOutModelEdges, type EdgeGeometryMap } from '../src/client/canvas/edge-layout.js';
import { edgeEnd, edgeStart, type EdgeGeometry } from '../src/client/canvas/edge-path.js';
import { assignMissingIds, buildModel, edgeIdentityOf, type EdgeIdentity, type ModelEdge } from '../src/client/flow-doc.js';
import { distanceToEdgePath, edgePathMidpoint } from '../src/client/canvas/edge-path.js';
import type { EdgeBend } from '../src/shared/canvas-edge-style.js';
import { rectCenter, unitVectorBetween, type Point } from '../src/client/geometry.js';
import { parseFlow, type Rect } from '../src/shared/flow-format.js';
import { parseCanvasLayer } from '../src/shared/canvas-layer.js';
import { dressModel } from '../src/client/model-visuals.js';

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

describe('edges meeting shaped nodes', () => {
  function layOutWithLayer(flowText: string, layerText: string) {
    const doc = parseFlow(flowText);
    assignMissingIds(doc);
    const model = dressModel(buildModel(doc, null), parseCanvasLayer(layerText));
    const geometry: EdgeGeometryMap = new Map();
    layOutModelEdges(model, geometry);
    return { model, geometry };
  }

  it('ends an edge on a diamond outline rather than on its bounding box', () => {
    const flow = [
      '---', 'name: Shapes', '---', '',
      'A', '  id: a-1', '  pos: 0, 300, 200, 88', '  -> B', '',
      'B', '  id: b-1', '  pos: 800, 0, 200, 88', '',
    ].join('\n');
    const plain = layOutWithLayer(flow, '{}');
    const shaped = layOutWithLayer(flow, JSON.stringify({ nodes: { 'b-1': { shape: 'diamond' } } }));
    const plainEnd = edgeEnd(plain.geometry.get(plain.model.edges[0])!);
    const shapedEnd = edgeEnd(shaped.geometry.get(shaped.model.edges[0])!);

    // On the rectangle the edge stops on its left border; on the diamond it runs on into the
    // lower-left facet, |dx|/100 + |dy|/44 = 1 about B's centre.
    expect(plainEnd.x).toBeCloseTo(800, 6);
    expect(Math.abs(shapedEnd.x - 900) / 100 + Math.abs(shapedEnd.y - 44) / 44).toBeCloseTo(1, 6);
    expect(shapedEnd.x).toBeGreaterThan(plainEnd.x);
  });

  it('starts and ends a self-loop on an ellipse outline', () => {
    const flow = ['---', 'name: Loop', '---', '', 'A', '  id: a-1', '  pos: 0, 0, 200, 100', '  -> A', ''].join('\n');
    const { model, geometry } = layOutWithLayer(flow, JSON.stringify({ nodes: { 'a-1': { shape: 'ellipse' } } }));
    const loop = geometry.get(model.edges[0])!;
    for (const point of [edgeStart(loop), edgeEnd(loop)]) {
      expect(((point.x - 100) / 100) ** 2 + ((point.y - 50) / 50) ** 2).toBeCloseTo(1, 6);
    }
  });
});

describe('bent edges', () => {
  const PAIR = flowBetween(['  -> B', '  -> B'], []);
  const FIRST_KEY = 'a-1 -> #b-1';
  const SECOND_KEY = 'a-1 -> #b-1 : #2';
  // Half way along, and a quarter of the 800-unit chord to one side: 200 units off the axis.
  const BEND = { along: 0.5, across: 0.25 };

  function layOutBent(flowText: string, edges: Record<string, unknown>, overrides?: Map<EdgeIdentity, EdgeBend | null>) {
    const doc = parseFlow(flowText);
    assignMissingIds(doc);
    const model = dressModel(buildModel(doc, null), parseCanvasLayer(JSON.stringify({ edges })));
    const geometry: EdgeGeometryMap = new Map();
    layOutModelEdges(model, geometry, overrides);
    return { model, geometry, rects: model.nodes.map((node) => node.pos!) };
  }

  it('runs through its bend point, leaving each node on the border that faces it', () => {
    const { model, geometry, rects } = layOutBent(PAIR, { [FIRST_KEY]: { bend: [BEND.along, BEND.across] } });
    const bent = geometry.get(model.edges[0])!;
    const bendPoint = { x: 500, y: 44 + 200 };
    expect(bent.grip.x).toBeCloseTo(bendPoint.x, 6);
    expect(bent.grip.y).toBeCloseTo(bendPoint.y, 6);
    expect(distanceToEdgePath(bendPoint, bent.path)).toBeCloseTo(0, 6);
    // The bend is below both nodes, so the edge leaves A downward and meets B from below.
    expect(edgeStart(bent).y).toBeCloseTo(rects[0].y + rects[0].h, 6);
    expect(edgeEnd(bent).y).toBeCloseTo(rects[1].y + rects[1].h, 6);
  });

  it('leaves its bundle, so the one edge left runs straight down the middle', () => {
    const { model, geometry, rects } = layOutBent(PAIR, { [FIRST_KEY]: { bend: [BEND.along, BEND.across] } });
    const remaining = offsetsOf(geometry.get(model.edges[1])!, rects);
    expect(remaining.start).toBeCloseTo(0, 6);
    expect(remaining.mid).toBeCloseTo(0, 6);
    expect(remaining.end).toBeCloseTo(0, 6);
  });

  it('lays an edge whose drag override is null out exactly as an unbent one, back in its lane', () => {
    const plain = layOutBent(PAIR, {});
    const bentInLayer = layOutBent(PAIR, { [SECOND_KEY]: { bend: [BEND.along, BEND.across] } });
    const overrides = new Map<EdgeIdentity, EdgeBend | null>([[edgeIdentityOf(bentInLayer.model.edges[1]), null]]);
    const relaidOut: EdgeGeometryMap = new Map();
    layOutModelEdges(bentInLayer.model, relaidOut, overrides);
    plain.model.edges.forEach((edge, index) => {
      expect(relaidOut.get(bentInLayer.model.edges[index])!.through).toEqual(plain.geometry.get(edge)!.through);
    });
  });

  it('still applies a drag override after the model is rebuilt mid-drag', () => {
    const doc = parseFlow(PAIR);
    assignMissingIds(doc);
    const layer = parseCanvasLayer(JSON.stringify({ edges: {} }));
    const pressedOn = dressModel(buildModel(doc, null), layer);
    const rebuilt = dressModel(buildModel(doc, null), layer);
    expect(rebuilt.edges[0]).not.toBe(pressedOn.edges[0]);
    const overrides = new Map([[edgeIdentityOf(pressedOn.edges[0]), BEND]]);
    const geometry: EdgeGeometryMap = new Map();
    layOutModelEdges(rebuilt, geometry, overrides);
    expect(geometry.get(rebuilt.edges[0])!.grip.y).toBeCloseTo(44 + 200, 6);
  });

  it('measures a bent edge where it runs, far outside the nodes it joins', () => {
    const { model } = layOutBent(PAIR, { [FIRST_KEY]: { bend: [BEND.along, BEND.across] } });
    const lowestEdge = Math.max(...edgePathBounds(model).map((rect) => rect.y + rect.h));
    expect(lowestEdge).toBeGreaterThanOrEqual(44 + 200 - 1);
  });

  it('never bends a self-loop, so the loops nested around it keep their places', () => {
    const loops = ['---', 'name: Loops', '---', '', 'A', '  id: a-1', '  pos: 0, 0, 200, 100', '  -> A', '  -> A', ''].join('\n');
    const plain = layOutBent(loops, {});
    const withBend = layOutBent(loops, { 'a-1 -> #a-1': { bend: [0.5, 0.4] } });
    withBend.model.edges.forEach((edge, index) => {
      const geometry = withBend.geometry.get(edge)!;
      expect(geometry.through).toEqual(plain.geometry.get(plain.model.edges[index])!.through);
      expect(geometry.chord).toBeNull();
    });
  });

  it('grips an unbent edge half way along the curve it draws', () => {
    const { model, geometry } = layOutBent(flowBetween(['  -> B'], ['  -> A']), {});
    const laned = geometry.get(model.edges[0])!;
    expect(laned.grip).toEqual(edgePathMidpoint(laned.path));
    expect(laned.chord).not.toBeNull();
  });
});
