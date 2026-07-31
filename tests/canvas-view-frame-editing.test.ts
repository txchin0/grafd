// Pointer gestures aimed at an unfolded frame: the graph a drawn rectangle belongs to, and
// where an edge dropped on empty canvas puts the node it creates.

import { beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { parseFlow, type FlowNode, type Rect } from '../src/shared/flow-format.js';
import { allNodes, assignMissingIds, buildModel } from '../src/client/flow-doc.js';
import type { Point } from '../src/client/geometry.js';
import { ExpansionLayer, transformPoint, transformRect, type FrameTarget } from '../src/client/canvas/expansion.js';
import { BADGE_HIT_RADIUS, nodeBadges } from '../src/client/canvas/node-badges.js';
import type { CanvasActions, EdgeDrop } from '../src/client/canvas/canvas-view.js';
import { createCanvasMock, stubCanvasGlobals } from './canvas-mock.js';

// A subgraph far larger than the frame that shows it, so its contents render scaled down and
// frame-local coordinates differ from world ones in size as well as offset.
const FRAMED_FLOW = `---
name: Frames
---

Host
  id: host-1
  pos: 400, 300, 200, 88

Sibling
  id: sibling-1
  pos: 1600, 300, 200, 88

graph: Sub
  Inner A
    id: inner-a
    pos: 0, 0, 200, 88
  Inner B
    id: inner-b
    pos: 1200, 700, 200, 88
`;

// An edge at the top level and another inside the subgraph, so one render has to compute
// geometry for two models.
const EDGED_FRAME_FLOW = `---
name: Edged
---

Host
  id: host-1
  pos: 400, 300, 200, 88
  -> Sibling

Sibling
  id: sibling-1
  pos: 1600, 300, 200, 88

graph: Sub
  Inner A
    id: inner-a
    pos: 0, 0, 200, 88
    -> Inner B
  Inner B
    id: inner-b
    pos: 1200, 700, 200, 88
`;

const NESTED_FLOW = `---
name: Nested
---

Host
  id: host-1
  pos: 400, 300, 200, 88

graph: Sub
  Middle
    id: middle-1
    pos: 0, 0, 200, 88
    expand: Deep
  Filler
    id: filler-1
    pos: 900, 600, 200, 88

graph: Deep
  Leaf
    id: leaf-1
    pos: 0, 0, 200, 88
`;

let CanvasView: typeof import('../src/client/canvas/canvas-view.js').CanvasView;

beforeAll(async () => {
  stubCanvasGlobals();
  ({ CanvasView } = await import('../src/client/canvas/canvas-view.js'));
  vi.spyOn(CanvasView.prototype, 'requestRender').mockImplementation(() => {});
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
    openExpand: vi.fn(),
    toggleExpand: vi.fn(),
    materializeGhost: vi.fn(),
    contextMenu: vi.fn(),
    regionMoved: vi.fn(),
    regionResized: vi.fn(),
    deleteRegion: vi.fn(),
  };
}

function openedCanvas(flowText: string, openNames: string[]) {
  const doc = parseFlow(flowText);
  assignMissingIds(doc);
  const model = buildModel(doc, null);
  model.sourceDoc = doc;
  model.sourcePath = 'frames.flow';

  const layer = new ExpansionLayer({ onNeedsRender: () => {}, readExternalFile: async () => null });
  const actions = stubActions();
  const canvas = createCanvasMock();
  const view = new CanvasView(canvas, actions, layer);

  const nodeNamed = (name: string) => allNodes(doc).find((node) => node.name === name)!;
  // `expand` is set here rather than in the source text so the host keeps a plain rect until
  // the frame is opened, matching how the editor unfolds one.
  for (const name of openNames) {
    const node = nodeNamed(name);
    node.props.push({ key: 'expand', value: name === 'Host' ? 'Sub' : 'Deep' });
  }
  layer.restoreOpen(openNames.map((name) => nodeNamed(name).id!));
  view.setModel(model);
  view.refreshDisplayGeometry();

  return { view, layer, actions, canvas, nodeNamed };
}

function listenerFor(canvas: HTMLCanvasElement, type: string) {
  const calls = (canvas.addEventListener as unknown as { mock: { calls: [string, (event: unknown) => void][] } }).mock.calls;
  return calls.find(([name]) => name === type)![1];
}

// The identity camera makes screen and world coordinates the same, so gesture points can be
// written directly in world space.
function dragOnCanvas(canvas: HTMLCanvasElement, from: Point, to: Point): void {
  listenerFor(canvas, 'pointerdown')({ button: 0, pointerId: 1, clientX: from.x, clientY: from.y, shiftKey: false, detail: 1 });
  listenerFor(canvas, 'pointermove')({ pointerId: 1, clientX: to.x, clientY: to.y });
  listenerFor(canvas, 'pointerup')({ pointerId: 1, clientX: to.x, clientY: to.y, detail: 1 });
}

function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// A region inside the frame that no node occupies, so a gesture there means "empty canvas".
function emptyRegionIn(frame: FrameTarget, occupied: Rect[], extent = { w: 1, h: 1 }): Rect {
  const steps = 12;
  for (let column = 0; column < steps; column += 1) {
    for (let row = 0; row < steps; row += 1) {
      const candidate = {
        x: frame.interior.x + (frame.interior.w * column) / steps,
        y: frame.interior.y + (frame.interior.h * row) / steps,
        ...extent,
      };
      const fitsInside = contains(frame.interior, { x: candidate.x + candidate.w, y: candidate.y + candidate.h });
      if (fitsInside && !occupied.some((rect) => overlaps(rect, candidate))) return candidate;
    }
  }
  throw new Error('no empty region inside the frame');
}

function emptySpotIn(frame: FrameTarget, occupied: Rect[]): Point {
  return emptyRegionIn(frame, occupied);
}

// The single classification the view hands to completeEdge for a released port-drag.
function dropOf(actions: CanvasActions) {
  const calls = (actions.completeEdge as unknown as { mock: { calls: [FlowNode, EdgeDrop][] } }).mock.calls;
  expect(calls.length).toBe(1);
  return calls[0][1];
}

function sourceOf(actions: CanvasActions): FlowNode {
  const calls = (actions.completeEdge as unknown as { mock: { calls: [FlowNode, EdgeDrop][] } }).mock.calls;
  return calls[0][0];
}

function portOf(view: InstanceType<typeof CanvasView>, node: FlowNode): Point {
  const rect = view.rect(node);
  return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
}

describe('drawing a node rectangle inside an unfolded frame', () => {
  it('creates it in the frame’s subgraph, in that subgraph’s coordinates', () => {
    const { view, layer, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    view.setTool('node');
    const host = nodeNamed('Host');
    const frame = layer.frameFor(host)!;
    expect(frame.transform.scale).toBeLessThan(1);

    const drawn = emptyRegionIn(
      frame,
      [view.rect(nodeNamed('Inner A')), view.rect(nodeNamed('Inner B'))],
      { w: 120, h: 70 },
    );
    const start = { x: drawn.x, y: drawn.y };
    dragOnCanvas(canvas, start, { x: drawn.x + drawn.w, y: drawn.y + drawn.h });

    expect(actions.createNode).toHaveBeenCalledTimes(1);
    const [rect, frameHost] = (actions.createNode as unknown as { mock: { calls: [Rect, FlowNode | null][] } }).mock.calls[0];
    expect(frameHost).toBe(host);

    const backInWorld = transformRect(rect, frame.transform);
    expect(backInWorld.x).toBeCloseTo(start.x, -1);
    expect(backInWorld.y).toBeCloseTo(start.y, -1);
    expect(backInWorld.w).toBeCloseTo(120, -1);
    expect(backInWorld.h).toBeCloseTo(70, -1);
    // The authored rect is the drawn one read in subgraph units, so it is larger than what
    // was drawn by exactly the frame's scale.
    expect(rect.w).toBeGreaterThan(120);
  });

  it('creates nothing when the rectangle leaves the frame it started in', () => {
    const { view, layer, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    view.setTool('node');
    const frame = layer.frameFor(nodeNamed('Host'))!;

    const start = emptySpotIn(frame, [view.rect(nodeNamed('Inner A')), view.rect(nodeNamed('Inner B'))]);
    dragOnCanvas(canvas, start, { x: frame.interior.x + frame.interior.w + 400, y: frame.interior.y - 300 });

    expect(actions.createNode).not.toHaveBeenCalled();
  });

  it('creates nothing when the rectangle starts outside and ends inside a frame', () => {
    const { view, layer, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    view.setTool('node');
    const frame = layer.frameFor(nodeNamed('Host'))!;

    dragOnCanvas(canvas, { x: frame.interior.x - 300, y: frame.interior.y - 200 }, rectCenter(frame.interior));

    expect(actions.createNode).not.toHaveBeenCalled();
  });

  it('still creates top-level nodes in world coordinates', () => {
    const { view, actions, canvas } = openedCanvas(FRAMED_FLOW, ['Host']);
    view.setTool('node');

    dragOnCanvas(canvas, { x: 2400, y: 1400 }, { x: 2560, y: 1500 });

    const [rect, frameHost] = (actions.createNode as unknown as { mock: { calls: [Rect, FlowNode | null][] } }).mock.calls[0];
    expect(frameHost).toBeNull();
    expect(rect).toMatchObject({ x: 2400, y: 1400, w: 160, h: 104 });
  });
});

describe('dragging an edge from inside a frame onto empty canvas', () => {
  it('creates a sibling in the same subgraph when released inside the frame', () => {
    const { view, layer, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    const host = nodeNamed('Host');
    const innerA = nodeNamed('Inner A');
    const frame = layer.frameFor(host)!;
    view.select(innerA);

    const target = emptySpotIn(frame, [view.rect(innerA), view.rect(nodeNamed('Inner B'))]);
    dragOnCanvas(canvas, portOf(view, innerA), target);

    const drop = dropOf(actions);
    expect(drop).toMatchObject({ kind: 'empty-inner', host });
    const point = (drop as Extract<EdgeDrop, { kind: 'empty-inner' }>).point;
    expect(transformRect({ ...point, w: 0, h: 0 }, frame.transform).x).toBeCloseTo(target.x, 6);
  });

  it('creates an inner-source edge one level up when released in the graph that owns the frame', () => {
    const { view, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    const innerA = nodeNamed('Inner A');
    view.select(innerA);

    dragOnCanvas(canvas, portOf(view, innerA), { x: 2600, y: 1800 });

    expect(dropOf(actions)).toEqual({
      kind: 'empty-outer',
      host: nodeNamed('Host'),
      innerName: 'Inner A',
      point: { x: 2600, y: 1800 },
    });
  });

  it('resolves one level up from a nested frame into its parent frame', () => {
    const { view, layer, actions, canvas, nodeNamed } = openedCanvas(NESTED_FLOW, ['Host', 'Middle']);
    const leaf = nodeNamed('Leaf');
    const outerFrame = layer.frameFor(nodeNamed('Host'))!;
    const innerFrame = layer.frameFor(nodeNamed('Middle'))!;
    view.select(leaf);

    const target = emptySpotIn(outerFrame, [innerFrame.interior, view.rect(nodeNamed('Middle')), view.rect(nodeNamed('Filler'))]);
    dragOnCanvas(canvas, portOf(view, leaf), target);

    expect(dropOf(actions)).toMatchObject({
      kind: 'empty-outer',
      host: nodeNamed('Middle'),
      innerName: 'Leaf',
    });
  });

  it('creates nothing when released more than one level out', () => {
    const { view, actions, canvas, nodeNamed } = openedCanvas(NESTED_FLOW, ['Host', 'Middle']);
    const leaf = nodeNamed('Leaf');
    view.select(leaf);

    dragOnCanvas(canvas, portOf(view, leaf), { x: 2600, y: 1800 });

    expect(dropOf(actions)).toEqual({ kind: 'rejected' });
  });

  it('creates nothing when released on a node the edge cannot reach', () => {
    const { view, layer, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    const host = nodeNamed('Host');
    const innerA = nodeNamed('Inner A');
    const frame = layer.frameFor(host)!;
    view.select(innerA);

    // The frame's header strip belongs to the host, not to the subgraph drawn below it —
    // and an edge from inside the frame cannot land on the frame's own host.
    const header = { x: frame.interior.x + 20, y: (view.rect(host).y + frame.interior.y) / 2 };
    dragOnCanvas(canvas, portOf(view, innerA), header);

    expect(dropOf(actions)).toEqual({ kind: 'rejected' });
  });

  // A drag that never entered a frame is plain empty canvas: the node is created where it
  // landed, in world coordinates, with no host to route it through.
  it('treats a top-level release as plain empty canvas', () => {
    const { view, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    const sibling = nodeNamed('Sibling');
    view.select(sibling);

    dragOnCanvas(canvas, portOf(view, sibling), { x: 2600, y: 1800 });

    expect(dropOf(actions)).toEqual({ kind: 'empty', point: { x: 2600, y: 1800 } });
  });
});

// Drawing a frame recurses into another geometry pass for its subgraph. That pass has to add
// to what the outer one computed rather than replace it, or every top-level edge would lose
// its geometry — and with it its hit region — the moment any frame was unfolded.
describe('edge geometry across nested models', () => {
  function renderedFrame() {
    const opened = openedCanvas(EDGED_FRAME_FLOW, ['Host']);
    (opened.view as unknown as { render(): void }).render();
    const subModel = opened.view.model.display!.expansions.get(opened.nodeNamed('Host'))!.subModel;
    return { ...opened, topEdge: opened.view.model.edges[0], innerEdge: subModel.edges[0] };
  }

  it('keeps geometry for every model one render walks', () => {
    const { view, topEdge, innerEdge } = renderedFrame();

    expect(view.edgeGeometryOf(innerEdge)).not.toBeNull();
    expect(view.edgeGeometryOf(topEdge)).not.toBeNull();
  });

  it('leaves the live geometry untouched when a snapshot renders the same scene', () => {
    const { view, topEdge, innerEdge } = renderedFrame();
    const before = [view.edgeGeometryOf(topEdge), view.edgeGeometryOf(innerEdge)];

    view.renderSnapshot({
      canvas: createCanvasMock(),
      viewport: { width: 800, height: 600 },
      pixelRatio: 1,
      background: null,
      grid: false,
    });

    expect(view.edgeGeometryOf(topEdge)).toBe(before[0]);
    expect(view.edgeGeometryOf(innerEdge)).toBe(before[1]);
  });
});

// Dropping a port-drag on a node that lives in another graph resolves to a single-level
// subgraph refinement. These pin what the view hands to completeEdge, because the edge the
// document ends up with is not the edge the pointer described: §5.7 declares it on the frame's
// host with an `{Inner}` target, §5.8 declares it on the host with an `{Inner}` source.
describe('dragging an edge onto a node in another graph', () => {
  it('§5.7 retargets onto the frame host and names the inner node', () => {
    const { view, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    const sibling = nodeNamed('Sibling');
    view.select(sibling);

    dragOnCanvas(canvas, portOf(view, sibling), rectCenter(view.rect(nodeNamed('Inner A'))));

    expect(sourceOf(actions)).toBe(sibling);
    expect(dropOf(actions)).toEqual({ kind: 'into-frame', target: nodeNamed('Host'), innerName: 'Inner A' });
  });

  it('§5.8 keeps the sibling as target and declares the inner source on the host', () => {
    const { view, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    const innerA = nodeNamed('Inner A');
    view.select(innerA);

    dragOnCanvas(canvas, portOf(view, innerA), rectCenter(view.rect(nodeNamed('Sibling'))));

    expect(dropOf(actions)).toEqual({
      kind: 'out-of-frame',
      target: nodeNamed('Sibling'),
      host: nodeNamed('Host'),
      innerName: 'Inner A',
    });
  });

  // Reaching into a host's own frame has no single-level form, so the release falls back to
  // plain empty canvas — which at the top level still creates a node where it landed.
  it('does not join a host to a node inside its own frame', () => {
    const { view, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    const host = nodeNamed('Host');
    view.select(host);

    dragOnCanvas(canvas, portOf(view, host), rectCenter(view.rect(nodeNamed('Inner A'))));

    expect(dropOf(actions).kind).toBe('empty');
  });

  it('reports a drop back on the source as its own outcome, not as empty canvas', () => {
    const { view, actions, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    const sibling = nodeNamed('Sibling');
    view.select(sibling);

    dragOnCanvas(canvas, portOf(view, sibling), rectCenter(view.rect(sibling)));

    expect(dropOf(actions)).toEqual({ kind: 'source' });
  });

  // The drag highlight follows the node under the cursor, which for §5.7 is the inner node —
  // not the host the edge will actually be declared on.
  it('highlights the inner node during the drag, not the host it retargets to', () => {
    const { view, canvas, nodeNamed } = openedCanvas(FRAMED_FLOW, ['Host']);
    const sibling = nodeNamed('Sibling');
    view.select(sibling);

    const start = portOf(view, sibling);
    const over = rectCenter(view.rect(nodeNamed('Inner A')));
    listenerFor(canvas, 'pointerdown')({ button: 0, pointerId: 1, clientX: start.x, clientY: start.y, shiftKey: false, detail: 1 });
    listenerFor(canvas, 'pointermove')({ pointerId: 1, clientX: over.x, clientY: over.y });
    (view as unknown as { render(): void }).render();

    const strokeRects = (canvas.getContext('2d') as unknown as { strokeRect: Mock }).strokeRect.mock.calls;
    const outlined = (node: FlowNode) => {
      const rect = view.rect(node);
      return strokeRects.some(([x, y, w, h]: number[]) =>
        Math.abs(x - (rect.x - 3)) < 0.5 && Math.abs(y - (rect.y - 3)) < 0.5
        && Math.abs(w - (rect.w + 6)) < 0.5 && Math.abs(h - (rect.h + 6)) < 0.5);
    };
    expect(outlined(nodeNamed('Inner A'))).toBe(true);
    expect(outlined(nodeNamed('Host'))).toBe(false);
  });
});

// A hit radius is a screen-space tolerance applied to model-space distances, so it divides by
// the camera scale *and* the frame scale a node is nested in. The clamp is applied to the
// product, so neither factor can be dropped or reassembled from the other.
describe('hit tolerance inside a scaled frame', () => {
  it('keeps a nested badge reachable at the product of camera and frame scale', () => {
    const { view, layer, canvas, nodeNamed } = openedCanvas(NESTED_FLOW, ['Host']);
    const middle = nodeNamed('Middle');
    const frame = layer.frameFor(nodeNamed('Host'))!;
    const frameScale = frame.transform.scale;
    expect(frameScale).toBeLessThan(1);

    const cameraScale = 0.5;
    view.setViewNow({ x: 0, y: 0, scale: cameraScale });

    const radiusFor = (scale: number) => BADGE_HIT_RADIUS / Math.min(scale, 1);
    const correct = radiusFor(cameraScale * frameScale);
    const ignoringCamera = radiusFor(frameScale);
    expect(correct).toBeGreaterThan(ignoringCamera);

    // Between the two radii: reachable only if the camera scale is part of the tolerance.
    const probeDistance = (correct + ignoringCamera) / 2;
    const badge = nodeBadges(frame.model, middle, false)[0];
    const probe = view.worldToScreen(
      transformPoint({ x: badge.x + probeDistance, y: badge.y }, frame.transform),
    );

    listenerFor(canvas, 'pointermove')({ pointerId: 1, clientX: probe.x, clientY: probe.y });
    expect(canvas.style.cursor).toBe('pointer');
  });
});
