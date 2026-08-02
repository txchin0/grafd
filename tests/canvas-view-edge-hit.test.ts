// Clicking an edge has to hit the curve that was actually drawn, not the chord between its
// endpoints. The oracle test at the bottom is the one that keeps the two from drifting apart.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import rough from 'roughjs';
import type { CanvasActions } from '../src/client/canvas/canvas-view.js';
import {
  createEdgeGeometry,
  distanceToEdgePath,
  edgePathMidpoint,
  flattenEdgePath,
} from '../src/client/canvas/edge-path.js';
import { parseFlow } from '../src/shared/flow-format.js';
import { assignMissingIds, buildModel } from '../src/client/flow-doc.js';
import type { Point } from '../src/client/geometry.js';
import { createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

// A reciprocal pair, so both edges take an outward lane and bow; far enough apart that the bow
// reaches its 34px cap, which is how an edge escapes the chord.
const BOWED_FLOW = `---
name: Bowed
---

Start
  id: start-1
  pos: 0, 0, 200, 88
  -> End

End
  id: end-1
  pos: 800, 0, 200, 88
  -> Start
`;

function bowedEdge(bow: number) {
  return createEdgeGeometry([{ x: 0, y: 0 }, { x: 200, y: bow }, { x: 400, y: 0 }]);
}

describe('edge path distance', () => {
  it('measures zero at the bow apex the spline is drawn through', () => {
    expect(distanceToEdgePath({ x: 200, y: 34 }, bowedEdge(34).path)).toBeCloseTo(0, 6);
  });

  it('measures the full bow height at the chord midpoint', () => {
    expect(distanceToEdgePath({ x: 200, y: 0 }, bowedEdge(34).path)).toBeCloseTo(34, 1);
  });

  it('still reaches the endpoints the curve is anchored to', () => {
    const geometry = bowedEdge(34);
    expect(distanceToEdgePath({ x: 0, y: 0 }, geometry.path)).toBeCloseTo(0, 6);
    expect(distanceToEdgePath({ x: 400, y: 0 }, geometry.path)).toBeCloseTo(0, 6);
  });

  it('follows a self-loop out past the node it leaves and returns to', () => {
    const apex = { x: 242, y: -40 };
    const selfLoop = createEdgeGeometry([{ x: 170, y: 0 }, apex, { x: 200, y: 24 }]);
    expect(distanceToEdgePath(apex, selfLoop.path)).toBeCloseTo(0, 6);
  });

  it('degenerates to the straight line when the edge has no bow', () => {
    const straight = bowedEdge(0);
    expect(distanceToEdgePath({ x: 200, y: 0 }, straight.path)).toBeCloseTo(0, 6);
    expect(distanceToEdgePath({ x: 200, y: 12 }, straight.path)).toBeCloseTo(12, 6);
  });
});

describe('arbitrary waypoint counts', () => {
  it('passes through every waypoint of a multi-bend route', () => {
    const waypoints = [
      { x: 0, y: 0 },
      { x: 100, y: 80 },
      { x: 200, y: -60 },
      { x: 300, y: 40 },
      { x: 400, y: 0 },
    ];
    const path = flattenEdgePath(waypoints);
    for (const waypoint of waypoints) {
      expect(distanceToEdgePath(waypoint, path)).toBeCloseTo(0, 6);
    }
  });

  it('anchors labels by arc length, so a lopsided route does not push them to one end', () => {
    // Both bends are on the same side, so the chord midpoint is nowhere near the drawn middle.
    const path = flattenEdgePath([
      { x: 0, y: 0 },
      { x: 40, y: 200 },
      { x: 360, y: 200 },
      { x: 400, y: 0 },
    ]);
    const midpoint = edgePathMidpoint(path);
    expect(distanceToEdgePath(midpoint, path)).toBeCloseTo(0, 6);
    expect(midpoint.x).toBeGreaterThan(150);
    expect(midpoint.x).toBeLessThan(250);
  });

  it('handles a two-point path with no waypoints at all', () => {
    const path = flattenEdgePath([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(distanceToEdgePath({ x: 50, y: 0 }, path)).toBeCloseTo(0, 6);
    expect(edgePathMidpoint(path).x).toBeCloseTo(50, 6);
  });
});

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
});

function stubActions(): CanvasActions {
  return {
    createNode: vi.fn(),
    quickCreateNode: vi.fn(),
    nodeClicked: vi.fn(),
    canvasClicked: vi.fn(),
    moveCommitted: vi.fn(),
    completeEdge: vi.fn(),
    editEdge: vi.fn(),
    editNodeTitle: vi.fn(),
    editRegionTitle: vi.fn(),
    openExpand: vi.fn(),
    toggleExpand: vi.fn(),
    materializeGhost: vi.fn(),
    contextMenu: vi.fn(),
    regionMoved: vi.fn(),
    regionResized: vi.fn(),
    deleteRegion: vi.fn(),
    createRegion: vi.fn(),
    regionClicked: vi.fn(),
  };
}

// The identity camera makes screen and world coordinates the same, so gesture points can be
// written directly in world space.
function bowedCanvas() {
  const doc = parseFlow(BOWED_FLOW);
  assignMissingIds(doc);
  const model = buildModel(doc, null);
  model.sourceDoc = doc;
  model.sourcePath = 'bowed.flow';

  const actions = stubActions();
  const canvas = createCanvasMock();
  const view = new CanvasView(canvas, actions, createExpansionLayer());
  view.setModel(model);
  // Geometry is a by-product of drawing, so the scene has to be rendered before it can be hit.
  (view as unknown as { render(): void }).render();

  return { canvas, actions, geometry: view.edgeGeometryOf(model.edges[0])! };
}

function doubleClickOnCanvas(canvas: HTMLCanvasElement, point: Point): void {
  const calls = (canvas.addEventListener as unknown as {
    mock: { calls: [string, (event: unknown) => void][] };
  }).mock.calls;
  const listener = calls.find(([name]) => name === 'dblclick')![1];
  listener({ button: 0, clientX: point.x, clientY: point.y, shiftKey: false, detail: 2 });
}

describe('double-clicking a bowed edge', () => {
  it('opens the editor from the apex, which sits well off the chord', () => {
    const { canvas, actions, geometry } = bowedCanvas();
    const apex = geometry.through[1];
    const chordMidY = (geometry.through[0].y + geometry.through[2].y) / 2;
    expect(Math.abs(apex.y - chordMidY)).toBeGreaterThan(30);

    doubleClickOnCanvas(canvas, apex);
    expect(actions.editEdge).toHaveBeenCalledTimes(1);
  });

  it('leaves empty canvas beyond the curve alone', () => {
    const { canvas, actions, geometry } = bowedCanvas();
    const apex = geometry.through[1];
    doubleClickOnCanvas(canvas, { x: apex.x, y: apex.y + 60 });
    expect(actions.editEdge).not.toHaveBeenCalled();
  });
});

// Samples the path rough.js would actually stroke, by reading back the drawable's own curve ops
// with roughness turned off so no jitter is applied.
function pointsAlongRoughCurve(through: [number, number][]): Point[] {
  const drawable = rough.generator().curve(through, {
    roughness: 0,
    curveTightness: 0,
    disableMultiStroke: true,
  });
  const samples: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };
  for (const { op, data } of drawable.sets[0].ops) {
    if (op === 'move') {
      cursor = { x: data[0], y: data[1] };
      samples.push(cursor);
      continue;
    }
    if (op !== 'bcurveTo') throw new Error(`unexpected curve op: ${op}`);
    const controlA = { x: data[0], y: data[1] };
    const controlB = { x: data[2], y: data[3] };
    const end = { x: data[4], y: data[5] };
    for (let step = 1; step <= 20; step += 1) {
      const t = step / 20;
      const inverse = 1 - t;
      samples.push({
        x: cursor.x * inverse ** 3 + controlA.x * 3 * inverse ** 2 * t + controlB.x * 3 * inverse * t ** 2 + end.x * t ** 3,
        y: cursor.y * inverse ** 3 + controlA.y * 3 * inverse ** 2 * t + controlB.y * 3 * inverse * t ** 2 + end.y * t ** 3,
      });
    }
    cursor = end;
  }
  return samples;
}

describe('the flattened path agrees with what rough.js draws', () => {
  // Whatever drawEdge hands to rough.curve is the real definition of where the edge is. Capturing
  // it here means a future change to the renderer fails this test instead of silently moving the
  // ink away from the clickable region.
  function capturePointsDrawnFor(flowText: string): [number, number][] {
    const curveSpy = vi.spyOn(rough.canvas(createCanvasMock()).constructor.prototype, 'curve');
    try {
      const doc = parseFlow(flowText);
      assignMissingIds(doc);
      const model = buildModel(doc, null);
      model.sourceDoc = doc;
      const view = new CanvasView(createCanvasMock(), stubActions(), createExpansionLayer());
      view.setModel(model);
      (view as unknown as { render(): void }).render();
      expect(curveSpy).toHaveBeenCalled();
      return curveSpy.mock.calls[0][0] as [number, number][];
    } finally {
      curveSpy.mockRestore();
    }
  }

  it('keeps every point rough.js strokes within a pixel of the hit-tested polyline', () => {
    const drawnPoints = capturePointsDrawnFor(BOWED_FLOW);
    const flattened = flattenEdgePath(drawnPoints.map(([x, y]) => ({ x, y })));
    for (const sample of pointsAlongRoughCurve(drawnPoints)) {
      expect(distanceToEdgePath(sample, flattened)).toBeLessThan(1);
    }
  });

  it('holds for arbitrary waypoint counts, not just the three-point bow', () => {
    const waypoints: [number, number][] = [[0, 0], [100, 80], [200, -60], [300, 40], [400, 0]];
    const flattened = flattenEdgePath(waypoints.map(([x, y]) => ({ x, y })));
    for (const sample of pointsAlongRoughCurve(waypoints)) {
      expect(distanceToEdgePath(sample, flattened)).toBeLessThan(1);
    }
  });
});
