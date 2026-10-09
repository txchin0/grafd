import { describe, expect, it } from 'vitest';
import { addStroke, addTextDrawing } from '../src/shared/canvas-drawings.js';
import { applyDrawingTransform } from '../src/shared/drawing-geometry.js';
import { emptyCanvasLayer } from '../src/shared/canvas-layer.js';
import { parseFlow, type FlowNode } from '../src/shared/flow-format.js';
import { buildModel, displayRects, type FlowModel } from '../src/client/flow-doc.js';
import { distanceToPolyline, simplifyPolyline } from '../src/client/geometry.js';
import { dressModel } from '../src/client/model-visuals.js';
import { hitDrawingAt, drawingsInsideRect, type DrawingSurface } from '../src/client/canvas/drawing-hit-test.js';
import { applyCombinedMove, combinedMoveDelta, type CombinedMoveSnapshot } from '../src/client/canvas/region-gestures.js';
import { beginStrokeGesture, extendStrokeGesture, finishedStrokePoints, resizedDrawingTransform } from '../src/client/canvas/stroke-gesture.js';
import type { FrameTarget } from '../src/client/canvas/expansion.js';

const IDENTITY = { scale: 1, tx: 0, ty: 0 };

function modelWithStrokes(...strokes: { id: string; points: { x: number; y: number }[] }[]): FlowModel {
  const layer = emptyCanvasLayer();
  for (const { id, points } of strokes) addStroke(layer, { kind: 'stroke', id, graph: null, color: null, width: 'medium', points });
  const model = buildModel(parseFlow('---\nname: demo\n---\n'), null);
  model.sourcePath = 'a.flow';
  return dressModel(model, layer);
}

describe('polylines', () => {
  it('drops points that lie on the line their neighbours draw, and keeps the ends', () => {
    const points = [{ x: 0, y: 0 }, { x: 5, y: 0.1 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(simplifyPolyline(points, 0.5)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(simplifyPolyline([{ x: 1, y: 1 }], 0.5)).toEqual([{ x: 1, y: 1 }]);
  });

  it('measures a lone point as a dot', () => {
    expect(distanceToPolyline({ x: 3, y: 4 }, [{ x: 0, y: 0 }])).toBe(5);
    expect(distanceToPolyline({ x: 5, y: 2 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(2);
  });
});

function modelWithText(id: string, box: { x: number; y: number; w: number; h: number }): FlowModel {
  const layer = emptyCanvasLayer();
  addTextDrawing(layer, { kind: 'text', id, graph: null, color: null, text: 'Note', box, size: 20, wrap: false });
  const model = buildModel(parseFlow('---\nname: demo\n---\n'), null);
  model.sourcePath = 'a.flow';
  return dressModel(model, layer);
}

describe('hitting text', () => {
  const box = { x: 100, y: 100, w: 60, h: 25 };

  it('hits anywhere in its box, grown by the slop', () => {
    const surfaces: DrawingSurface[] = [{ model: modelWithText('t', box), transform: IDENTITY, clip: null }];
    expect(hitDrawingAt(surfaces, { x: 130, y: 112 }, 2)?.id).toBe('t');
    expect(hitDrawingAt(surfaces, { x: 161, y: 126 }, 2)?.id).toBe('t');
    expect(hitDrawingAt(surfaces, { x: 163, y: 112 }, 2)).toBeNull();
  });

  it('is picked up by a marquee that encloses its whole box, and counts as content', () => {
    const model = modelWithText('t', box);
    const surfaces: DrawingSurface[] = [{ model, transform: IDENTITY, clip: null }];
    expect(drawingsInsideRect(surfaces, { x: 90, y: 90, w: 80, h: 40 }).map((hit) => hit.id)).toEqual(['t']);
    expect(drawingsInsideRect(surfaces, { x: 90, y: 90, w: 60, h: 40 })).toEqual([]);
    expect(displayRects(model)).toContainEqual(box);
  });
});

describe('hitting strokes', () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];

  it('hits within half the line plus the slop, and misses beyond it', () => {
    const surfaces: DrawingSurface[] = [{ model: modelWithStrokes({ id: 's', points: line }), transform: IDENTITY, clip: null }];
    expect(hitDrawingAt(surfaces, { x: 50, y: 6 }, 5)?.id).toBe('s');
    expect(hitDrawingAt(surfaces, { x: 50, y: 7 }, 5)).toBeNull();
  });

  it('measures a framed stroke in its frame\'s units, inside the frame only', () => {
    const frame = { model: modelWithStrokes({ id: 'inner', points: line }), transform: { scale: 0.5, tx: 200, ty: 100 }, clip: { x: 190, y: 90, w: 80, h: 30 } };
    const surfaces: DrawingSurface[] = [{ model: modelWithStrokes(), transform: IDENTITY, clip: null }, frame];
    expect(hitDrawingAt(surfaces, { x: 225, y: 101 }, 2)).toEqual({ model: frame.model, id: 'inner' });
    expect(hitDrawingAt(surfaces, { x: 225, y: 104 }, 2)).toBeNull();
    frame.clip = { x: 0, y: 0, w: 10, h: 10 };
    expect(hitDrawingAt(surfaces, { x: 225, y: 101 }, 2)).toBeNull();
  });

  it('prefers the innermost surface, and the stroke drawn last', () => {
    const top = modelWithStrokes({ id: 'under', points: line }, { id: 'over', points: line });
    const framed = modelWithStrokes({ id: 'framed', points: line });
    const surfaces: DrawingSurface[] = [
      { model: top, transform: IDENTITY, clip: null },
      { model: framed, transform: IDENTITY, clip: { x: -10, y: -10, w: 20, h: 20 } },
    ];
    expect(hitDrawingAt(surfaces, { x: 0, y: 0 }, 2)?.id).toBe('framed');
    expect(hitDrawingAt(surfaces, { x: 50, y: 0 }, 2)?.id).toBe('over');
  });

  it('selects in a marquee only the strokes it wholly encloses', () => {
    const model = modelWithStrokes({ id: 'inside', points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] }, { id: 'grazed', points: line });
    const surfaces: DrawingSurface[] = [{ model, transform: IDENTITY, clip: null }];
    expect(drawingsInsideRect(surfaces, { x: 0, y: 0, w: 50, h: 50 }).map((hit) => hit.id)).toEqual(['inside']);
  });
});

describe('the pen', () => {
  const frame = { host: {} as FlowNode, model: modelWithStrokes(), transform: { scale: 0.5, tx: 100, ty: 0 }, interior: { x: 0, y: 0, w: 1, h: 1 } } as FrameTarget;

  it('keeps points in the coordinates of the graph it landed in', () => {
    const gesture = beginStrokeGesture(frame, { x: 110, y: 10 }, { x: 0, y: 0 });
    expect(gesture.frameHost).toBe(frame.host);
    expect(gesture.points).toEqual([{ x: 20, y: 20 }]);
  });

  it('ignores samples too close together to show, and thins the result to the screen', () => {
    const gesture = beginStrokeGesture(null, { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(extendStrokeGesture(gesture, { x: 1, y: 0 }, { x: 1, y: 0 })).toBe(false);
    for (let x = 2; x <= 20; x += 2) extendStrokeGesture(gesture, { x, y: 0 }, { x, y: 0 });
    expect(gesture.points.length).toBeGreaterThan(2);
    expect(finishedStrokePoints(gesture, 1)).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }]);
  });
});

describe('the distance a combined move carries everything', () => {
  const doc = parseFlow('---\nname: demo\n---\n\nA\n  pos: 3, 3, 100, 60\n');
  const node = doc.items.flatMap((item) => (item.kind === 'node' ? [item.node] : []))[0];
  const snap8 = (value: number) => Math.round(value / 8) * 8;

  function snapshot(scale: number): CombinedMoveSnapshot {
    return {
      startPositions: new Map([[node, { x: 3, y: 3 }]]),
      scales: new Map([[node, scale]]),
      movingRegions: [],
      startRects: new Map(),
      startWorld: { x: 0, y: 0 },
      moved: false,
    };
  }

  it('follows the snapped distance a node actually travelled, in world units', () => {
    const gesture = snapshot(0.5);
    node.pos = { x: 3, y: 3, w: 100, h: 60 };
    // 10 world units at scale 0.5 is 20 local, snapped from 23 to 24: 21 local, 10.5 world.
    expect(applyCombinedMove(gesture, { x: 10, y: 0 }, snap8, { node })).toEqual({ x: 10.5, y: -1.5 });
  });

  it('follows the pointer exactly when only strokes move', () => {
    const empty: CombinedMoveSnapshot = { ...snapshot(1), startPositions: new Map(), scales: new Map() };
    expect(combinedMoveDelta(empty, { x: 7, y: -3 }, snap8, null)).toEqual({ x: 7, y: -3 });
  });
});

describe('strokes as content', () => {
  it('count toward a model\'s measured content, line width included', () => {
    const model = modelWithStrokes({ id: 's', points: [{ x: -500, y: 0 }, { x: -400, y: 0 }] });
    expect(displayRects(model)).toContainEqual({ x: -501.5, y: -1.5, w: 103, h: 3 });
  });
});

describe('resizing a stroke by a corner', () => {
  const box = { x: 10, y: 20, w: 100, h: 50 };
  const rounded = ({ x, y }: { x: number; y: number }) => ({ x: Math.round(x * 1e6) / 1e6, y: Math.round(y * 1e6) / 1e6 });
  const corners = (transform: ReturnType<typeof resizedDrawingTransform>) => [
    rounded(applyDrawingTransform({ x: box.x, y: box.y }, transform)),
    rounded(applyDrawingTransform({ x: box.x + box.w, y: box.y + box.h }, transform)),
  ];

  it('stretches toward the dragged corner while the opposite one stays put', () => {
    expect(corners(resizedDrawingTransform(box, 'se', { x: 100, y: -25 }, { keepAspect: false }))).toEqual([{ x: 10, y: 20 }, { x: 210, y: 45 }]);
    expect(corners(resizedDrawingTransform(box, 'nw', { x: 50, y: 10 }, { keepAspect: false }))).toEqual([{ x: 60, y: 30 }, { x: 110, y: 70 }]);
  });

  it('never folds a stroke over onto itself', () => {
    const [topLeft, bottomRight] = corners(resizedDrawingTransform(box, 'se', { x: -500, y: -500 }, { keepAspect: false }));
    expect(bottomRight.x - topLeft.x).toBe(4);
    expect(bottomRight.y - topLeft.y).toBe(4);
  });

  it('keeps the proportions when asked, following the axis dragged further for its size', () => {
    expect(corners(resizedDrawingTransform(box, 'se', { x: 100, y: 5 }, { keepAspect: true }))).toEqual([{ x: 10, y: 20 }, { x: 210, y: 120 }]);
    expect(corners(resizedDrawingTransform(box, 'nw', { x: 0, y: 25 }, { keepAspect: true }))).toEqual([{ x: 60, y: 45 }, { x: 110, y: 70 }]);
  });

  it('stops shrinking a kept proportion when the shorter side reaches the floor', () => {
    const [topLeft, bottomRight] = corners(resizedDrawingTransform(box, 'se', { x: -500, y: 0 }, { keepAspect: true }));
    expect(bottomRight.x - topLeft.x).toBe(8);
    expect(bottomRight.y - topLeft.y).toBe(4);
  });

  it('moves only the side a side handle drags, leaving the other axis alone', () => {
    expect(corners(resizedDrawingTransform(box, 'e', { x: 40, y: 99 }, { keepAspect: false }))).toEqual([{ x: 10, y: 20 }, { x: 150, y: 70 }]);
    expect(corners(resizedDrawingTransform(box, 'n', { x: 99, y: -30 }, { keepAspect: false }))).toEqual([{ x: 10, y: -10 }, { x: 110, y: 70 }]);
  });

  it('scales evenly from a side when asked, growing the other axis from its near side', () => {
    expect(corners(resizedDrawingTransform(box, 's', { x: 0, y: 50 }, { keepAspect: true }))).toEqual([{ x: 10, y: 20 }, { x: 210, y: 120 }]);
    expect(corners(resizedDrawingTransform(box, 'n', { x: 0, y: 25 }, { keepAspect: true }))).toEqual([{ x: 10, y: 45 }, { x: 60, y: 70 }]);
  });

  it('leaves a straight line alone across itself', () => {
    const flat = { x: 0, y: 5, w: 40, h: 0 };
    expect(resizedDrawingTransform(flat, 'se', { x: 40, y: 30 }, { keepAspect: false })).toMatchObject({ scaleX: 2, scaleY: 1, y: 0 });
  });
});
