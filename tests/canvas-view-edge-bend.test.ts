// Bending an edge by dragging its middle: what a press on the grip writes, when it writes nothing,
// and that the bend reaches everything drawn from the edge's geometry — the edit popup's anchor
// and an exported image.

import { beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import type { CanvasActions } from '../src/client/canvas/canvas-view.js';
import { assignMissingIds, buildModel, isSameEdge, type ModelEdge } from '../src/client/flow-doc.js';
import type { Point } from '../src/client/geometry.js';
import { dressModel } from '../src/client/model-visuals.js';
import { parseCanvasLayer } from '../src/shared/canvas-layer.js';
import type { EdgeBend } from '../src/shared/canvas-edge-style.js';
import { parseFlow } from '../src/shared/flow-format.js';
import { createCanvasMock, createExpansionLayer, stubCanvasGlobals } from './canvas-mock.js';

// Two nodes 800 units apart, centre to centre, so a point 200 units off the middle of the chord
// is a bend of a quarter of it.
function pairFlow(edgeLine: string): string {
  return [
    '---', 'name: Pair', '---', '',
    'A', '  id: a-1', '  pos: 0, 0, 200, 88', `  ${edgeLine}`, '',
    'B', '  id: b-1', '  pos: 800, 0, 200, 88', '',
  ].join('\n');
}

const PLAIN_EDGE = pairFlow('-> B');
const CHORD_MIDDLE = { x: 500, y: 44 };
const QUARTER_BELOW = { x: 500, y: 244 };
const LABELLED_EDGE = pairFlow('-> B : "a label long enough to grab off-centre"');
const SELF_LOOP_FLOW = ['---', 'name: Loop', '---', '', 'A', '  id: a-1', '  pos: 0, 0, 200, 88', '  -> A : "again"', ''].join('\n');

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
});

function stubActions(): CanvasActions {
  return {
    createNode: vi.fn(),
    createStroke: vi.fn(),
    resizeDrawings: vi.fn(),
    quickCreateNode: vi.fn(),
    nodeClicked: vi.fn(),
    canvasClicked: vi.fn(),
    moveCommitted: vi.fn(),
    completeEdge: vi.fn(),
    editEdge: vi.fn(),
    bendEdge: vi.fn(),
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

// The identity camera makes screen and world coordinates the same, so gesture points are world points.
function openedCanvas(flowText: string, layerEdges: Record<string, unknown> = {}) {
  const doc = parseFlow(flowText);
  assignMissingIds(doc);
  const layer = parseCanvasLayer(JSON.stringify({ edges: layerEdges }));
  const buildDressedModel = () => {
    const built = dressModel(buildModel(doc, null), layer);
    built.sourceDoc = doc;
    built.sourcePath = 'pair.flow';
    return built;
  };
  const model = buildDressedModel();
  const actions = stubActions();
  const canvas = createCanvasMock();
  const view = new CanvasView(canvas, actions, createExpansionLayer());
  view.setModel(model);
  // Geometry is a by-product of drawing, so the scene has to be rendered before it can be hit.
  (view as unknown as { render(): void }).render();
  return { view, canvas, actions, edge: model.edges[0], buildDressedModel };
}

function listenerFor(canvas: HTMLCanvasElement, type: string) {
  const calls = (canvas.addEventListener as unknown as { mock: { calls: [string, (event: unknown) => void][] } }).mock.calls;
  return calls.find(([name]) => name === type)![1];
}

function dragThrough(canvas: HTMLCanvasElement, points: Point[]): void {
  const [first, ...rest] = points;
  listenerFor(canvas, 'pointerdown')({ button: 0, pointerId: 1, clientX: first.x, clientY: first.y, shiftKey: false, detail: 1 });
  for (const point of rest) listenerFor(canvas, 'pointermove')({ pointerId: 1, clientX: point.x, clientY: point.y });
  const last = points[points.length - 1];
  listenerFor(canvas, 'pointerup')({ pointerId: 1, clientX: last.x, clientY: last.y, detail: 1 });
}

function labelCenterOf(view: InstanceType<typeof CanvasView>, edge: ModelEdge): Point {
  const label = view.edgeGeometryOf(edge)!.labelRect!;
  return { x: label.x + label.w / 2, y: label.y + label.h / 2 };
}

function bendsWritten(actions: CanvasActions): [ModelEdge, EdgeBend | null][] {
  return (actions.bendEdge as unknown as Mock).mock.calls as [ModelEdge, EdgeBend | null][];
}

describe('dragging an edge from its middle', () => {
  it('writes the bend that puts the edge under the pointer', () => {
    const { canvas, actions, edge } = openedCanvas(PLAIN_EDGE);
    dragThrough(canvas, [CHORD_MIDDLE, QUARTER_BELOW]);
    const [[bentEdge, bend]] = bendsWritten(actions);
    expect(bentEdge).toBe(edge);
    expect(bend!.along).toBeCloseTo(0.5, 6);
    expect(bend!.across).toBeCloseTo(0.25, 6);
  });

  it('straightens the edge when it is dragged back onto its chord', () => {
    const { canvas, actions } = openedCanvas(PLAIN_EDGE);
    dragThrough(canvas, [CHORD_MIDDLE, QUARTER_BELOW, { x: 520, y: 47 }]);
    expect(bendsWritten(actions)).toEqual([[expect.anything(), null]]);
  });

  it('writes nothing for a click that never drags', () => {
    const { canvas, actions, view, edge } = openedCanvas(PLAIN_EDGE);
    dragThrough(canvas, [CHORD_MIDDLE]);
    expect(bendsWritten(actions)).toEqual([]);
    expect(view.selectedEdge).toBe(edge);
  });

  it('only selects an edge pressed away from its middle', () => {
    const { canvas, actions, view, edge } = openedCanvas(PLAIN_EDGE);
    dragThrough(canvas, [{ x: 300, y: 44 }, { x: 300, y: 244 }]);
    expect(bendsWritten(actions)).toEqual([]);
    expect(view.selectedEdge).toBe(edge);
  });

  it('keeps the offset a label was grabbed at, rather than jumping its centre under the pointer', () => {
    const { canvas, actions, view, edge } = openedCanvas(LABELLED_EDGE);
    const characterWidth = 7;
    (canvas.getContext('2d') as unknown as { measureText: Mock }).measureText
      .mockImplementation((text: string) => ({ width: text.length * characterWidth }));
    (view as unknown as { render(): void }).render();
    const label = view.edgeGeometryOf(edge)!.labelRect!;
    expect(label.w).toBeGreaterThan(200);
    const nearLeftEnd = { x: label.x + 4, y: label.y + label.h / 2 };
    dragThrough(canvas, [nearLeftEnd, { x: nearLeftEnd.x, y: nearLeftEnd.y + 200 }]);
    const [[, bend]] = bendsWritten(actions);
    const center = labelCenterOf(view, edge);
    expect(bend!.along).toBeCloseTo((center.x - 100) / 800, 6);
  });

  it('follows the pointer when the press closes an editor whose commit rebuilds the model', () => {
    const { view, canvas, actions, edge, buildDressedModel } = openedCanvas(PLAIN_EDGE);
    (actions.canvasClicked as Mock).mockImplementation(() => view.setModel(buildDressedModel()));
    listenerFor(canvas, 'pointerdown')({ button: 0, pointerId: 1, clientX: CHORD_MIDDLE.x, clientY: CHORD_MIDDLE.y, shiftKey: false, detail: 1 });
    listenerFor(canvas, 'pointermove')({ pointerId: 1, clientX: QUARTER_BELOW.x, clientY: QUARTER_BELOW.y });
    (view as unknown as { render(): void }).render();

    const rebuiltEdge = view.selectedEdge!;
    expect(rebuiltEdge).not.toBe(edge);
    expect(isSameEdge(rebuiltEdge, edge)).toBe(true);
    const grip = view.edgeGeometryOf(rebuiltEdge)!.grip;
    expect(grip.x).toBeCloseTo(QUARTER_BELOW.x, 6);
    expect(grip.y).toBeCloseTo(QUARTER_BELOW.y, 6);
  });

  it('never bends a self-loop, even from its label', () => {
    const { canvas, actions, view, edge } = openedCanvas(SELF_LOOP_FLOW);
    const label = view.edgeGeometryOf(edge)!.labelRect!;
    const labelCenter = { x: label.x + label.w / 2, y: label.y + label.h / 2 };
    dragThrough(canvas, [labelCenter, { x: labelCenter.x + 150, y: labelCenter.y + 150 }]);
    expect(bendsWritten(actions)).toEqual([]);
  });
});

describe('a bent edge', () => {
  it('anchors its edit popup on the bend point, where its label is', () => {
    const { view, edge } = openedCanvas(PLAIN_EDGE, { 'a-1 -> #b-1': { bend: [0.5, 0.25] } });
    const anchor = view.edgeAnchor(edge);
    expect(anchor.x).toBeCloseTo(QUARTER_BELOW.x, 6);
    expect(anchor.y).toBeCloseTo(QUARTER_BELOW.y, 6);
  });

  it('is framed whole by zoom-to-fit and exports, however far it bulges past the nodes', () => {
    const { view } = openedCanvas(PLAIN_EDGE, { 'a-1 -> #b-1': { bend: [0.5, 1] } });
    const bendPointY = 44 + 800;
    const bounds = view.snapshotBounds(0);
    expect(bounds.y + bounds.h).toBeGreaterThanOrEqual(bendPointY - 1);
  });

  it('exports with its bend, its dotted line and a head at each end', () => {
    const { view } = openedCanvas(PLAIN_EDGE, {
      'a-1 -> #b-1': { bend: [0.5, 0.25], line: 'dotted', startHead: 'dot', endHead: 'triangle' },
    });
    view.baseRoughness = 0;
    const snapshotCanvas = createCanvasMock(400, 300);
    const context = snapshotCanvas.getContext('2d') as unknown as Record<string, Mock> & { lineCap: string };
    const dashesSet: { dash: number[]; lineCap: string }[] = [];
    context.setLineDash.mockImplementation((dash: number[]) => dashesSet.push({ dash, lineCap: context.lineCap }));

    view.renderSnapshot({ canvas: snapshotCanvas, viewport: { width: 400, height: 300 }, pixelRatio: 1, background: null, grid: false });

    const dottedStrokes = dashesSet.filter(({ dash }) => dash.length === 2 && dash[0] === 0);
    expect(dottedStrokes.length).toBeGreaterThan(0);
    expect(dottedStrokes.every(({ lineCap }) => lineCap === 'round')).toBe(true);
    // Each head clears the dash it would otherwise inherit from its line.
    expect(dashesSet.filter(({ dash }) => dash.length === 0).length).toBeGreaterThanOrEqual(2);
    expect(context.arc).toHaveBeenCalled();
    expect(context.closePath).toHaveBeenCalled();

    const curveEnds = context.bezierCurveTo.mock.calls.map((call) => ({ x: call[4] as number, y: call[5] as number }));
    expect(curveEnds.some((end) => Math.hypot(end.x - QUARTER_BELOW.x, end.y - QUARTER_BELOW.y) < 1e-6)).toBe(true);
  });
});
