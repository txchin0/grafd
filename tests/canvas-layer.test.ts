import { describe, expect, it } from 'vitest';
import {
  applyCapturedVisuals,
  applyRegionVisuals,
  canvasLayerPathOf,
  captureRegionVisuals,
  captureVisuals,
  documentIdentities,
  emptyCanvasLayer,
  flowPathOfCanvasLayer,
  followIdentityChanges,
  isCanvasLayerPath,
  nodeShapeOf,
  nodeTextSizeOf,
  onErrorEdgeKey,
  parseCanvasLayer,
  serializeCanvasLayer,
  setNodeShape,
  setNodeTextSize,
  type CanvasLayer,
} from '../src/shared/canvas-layer.js';
import { parseFlow, setProp, type FlowDocument, type FlowNode } from '../src/shared/flow-format.js';
import * as FlowDoc from '../src/client/flow-doc.js';
import { edgeStyleOf, setEdgeStyle } from '../src/shared/canvas-edge-style.js';
import { regionStyleOf, setRegionStyle } from '../src/shared/canvas-region-style.js';

// An edge's colour reads and writes alike whatever its kind, so these tests treat every edge as a
// flow edge.
function setEdgeColor(layer: CanvasLayer, edgeKey: string, color: string | null): void {
  setEdgeStyle(layer, edgeKey, { color }, 'flow');
}

function edgeColorOf(layer: CanvasLayer | null, edgeKey: string | null): string | null {
  return edgeStyleOf(layer, edgeKey, 'flow').color;
}

const IDS = {
  start: '11111111-1111-4111-8111-111111111111',
  check: '22222222-2222-4222-8222-222222222222',
  done: '33333333-3333-4333-8333-333333333333',
};

const FLOW = `---
name: demo
---

Start
  id: ${IDS.start}
  pos: 0, 0, 180, 80
  on_error: -> Done
  -> Check : "go"
  -> Check : "go"

Check
  id: ${IDS.check}
  pos: 300, 0, 180, 80
  -> Done

Done
  id: ${IDS.done}
  pos: 600, 0, 180, 80
`;

function nodeNamed(doc: FlowDocument, name: string): FlowNode {
  return FlowDoc.allNodes(doc).find((node) => node.name === name)!;
}

function keyOf(doc: FlowDocument, nodeName: string, edgeIndex: number): string {
  return documentIdentities(doc).edgeKeys.get(nodeNamed(doc, nodeName).edges[edgeIndex])!;
}

describe('canvas layer paths', () => {
  it('sits beside its .flow under the full file name', () => {
    expect(canvasLayerPathOf('auth/login.flow')).toBe('auth/login.flow.canvas.json');
    expect(flowPathOfCanvasLayer('auth/login.flow.canvas.json')).toBe('auth/login.flow');
    expect(isCanvasLayerPath('auth/login.flow.canvas.json')).toBe(true);
    expect(isCanvasLayerPath('auth/login.flow')).toBe(false);
    expect(isCanvasLayerPath('notes.canvas.json')).toBe(false);
  });
});

describe('parse and serialize', () => {
  it('round-trips entries and carries unknown keys and fields through untouched', () => {
    const text = JSON.stringify({
      format: 'grafd-canvas/1',
      nodes: { a: { shape: 'diamond', glow: 3 } },
      edges: { 'a -> b': { color: 'red' } },
      drawings: [{ id: 'd1', kind: 'stroke', points: [[0, 0], [4, 4]] }],
    });
    const layer = parseCanvasLayer(text);
    expect(layer.nodes.a).toEqual({ shape: 'diamond', glow: 3 });
    expect(layer.drawings).toEqual([{ id: 'd1', kind: 'stroke', points: [[0, 0], [4, 4]] }]);
    expect(parseCanvasLayer(serializeCanvasLayer(layer))).toEqual(layer);
  });

  it('serializes an empty layer to null, so an emptied layer is deleted rather than written', () => {
    expect(serializeCanvasLayer(emptyCanvasLayer())).toBeNull();
    const layer = emptyCanvasLayer();
    setNodeShape(layer, 'a', 'ellipse');
    setNodeShape(layer, 'a', null);
    expect(serializeCanvasLayer(layer)).toBeNull();
  });

  it('never writes the default text size, keeps a shape beside a size, and validates what it reads', () => {
    const layer = emptyCanvasLayer();
    setNodeTextSize(layer, 'a', 'medium');
    expect(layer.nodes).toEqual({});
    setNodeShape(layer, 'a', 'ellipse');
    setNodeTextSize(layer, 'a', 'x-large');
    expect(layer.nodes).toEqual({ a: { shape: 'ellipse', textSize: 'x-large' } });
    setNodeTextSize(layer, 'a', null);
    expect(layer.nodes).toEqual({ a: { shape: 'ellipse' } });
    layer.nodes.b = { textSize: 40 };
    expect(nodeTextSizeOf(layer, 'b')).toBe('medium');
    expect(nodeTextSizeOf(null, 'a')).toBe('medium');
  });

  it('reads anything that is not a JSON object as an empty layer', () => {
    expect(parseCanvasLayer('{ broken')).toEqual(emptyCanvasLayer());
    expect(parseCanvasLayer('[1, 2]')).toEqual(emptyCanvasLayer());
    expect(parseCanvasLayer(null)).toEqual(emptyCanvasLayer());
  });

  it('never writes the default shape, and validates what it reads', () => {
    const layer = emptyCanvasLayer();
    setNodeShape(layer, 'a', 'rectangle');
    expect(layer.nodes).toEqual({});
    layer.nodes.b = { shape: 'blob' };
    expect(nodeShapeOf(layer, 'b')).toBe('rectangle');
    layer.edges.k = { color: 'not-a-colour' };
    expect(edgeColorOf(layer, 'k')).toBeNull();
    setEdgeColor(layer, 'k', '#12ab9f');
    expect(edgeColorOf(layer, 'k')).toBe('#12ab9f');
  });
});

describe('edge keys', () => {
  it('names a resolved target by id, so renaming the target keeps the key', () => {
    const doc = parseFlow(FLOW);
    const before = keyOf(doc, 'Check', 0);
    expect(before).toBe(`${IDS.check} -> #${IDS.done}`);
    FlowDoc.renameNode(doc.items, nodeNamed(doc, 'Done'), 'Finish', doc);
    expect(keyOf(doc, 'Check', 0)).toBe(before);
  });

  it('changes when the label changes, and numbers identical edges from one node', () => {
    const doc = parseFlow(FLOW);
    expect(keyOf(doc, 'Start', 0)).toBe(`${IDS.start} -> #${IDS.check} : "go"`);
    expect(keyOf(doc, 'Start', 1)).toBe(`${IDS.start} -> #${IDS.check} : "go" : #2`);
    nodeNamed(doc, 'Check').edges[0].label = 'finished';
    expect(keyOf(doc, 'Check', 0)).toBe(`${IDS.check} -> #${IDS.done} : "finished"`);
  });

  it('names an unresolved target by name', () => {
    const doc = parseFlow(FLOW);
    nodeNamed(doc, 'Done').edges.push({ target: 'Ghost', innerSource: null, innerTarget: null, label: null, data: null });
    expect(keyOf(doc, 'Done', 0)).toBe(`${IDS.done} -> Ghost`);
  });

  it('keys an on_error edge by the node that carries it', () => {
    const doc = parseFlow(FLOW);
    const identities = documentIdentities(doc);
    expect(identities.edgeKeys.get(nodeNamed(doc, 'Start'))).toBe(`${IDS.start} on_error`);
    expect(identities.edgeKeys.has(nodeNamed(doc, 'Check'))).toBe(false);
  });
});

describe('following identity changes', () => {
  function layerWithEdge(doc: FlowDocument, nodeName: string, edgeIndex: number, color: string): CanvasLayer {
    const layer = emptyCanvasLayer();
    setEdgeColor(layer, keyOf(doc, nodeName, edgeIndex), color);
    return layer;
  }

  it('moves an edge colour to the key a relabel gives it', () => {
    const doc = parseFlow(FLOW);
    const layer = layerWithEdge(doc, 'Check', 0, 'blue');
    const before = documentIdentities(doc);
    nodeNamed(doc, 'Check').edges[0].label = 'finished';
    expect(followIdentityChanges(layer, before, documentIdentities(doc))).toBe(true);
    expect(edgeColorOf(layer, keyOf(doc, 'Check', 0))).toBe('blue');
    expect(Object.keys(layer.edges)).toHaveLength(1);
  });

  it("moves an edge's whole look — line, heads and bend too — with a relabel", () => {
    const doc = parseFlow(FLOW);
    const layer = emptyCanvasLayer();
    const look = { color: 'blue', line: 'dotted', startHead: 'dot', endHead: 'triangle', bend: [0.3, 0.1] };
    layer.edges[keyOf(doc, 'Check', 0)] = { ...look };
    const before = documentIdentities(doc);
    nodeNamed(doc, 'Check').edges[0].label = 'finished';
    followIdentityChanges(layer, before, documentIdentities(doc));
    expect(layer.edges[keyOf(doc, 'Check', 0)]).toEqual(look);
  });

  it('keeps the colour of the second of two identical edges when the first is deleted', () => {
    const doc = parseFlow(FLOW);
    const layer = layerWithEdge(doc, 'Start', 1, 'red');
    const before = documentIdentities(doc);
    const start = nodeNamed(doc, 'Start');
    start.edges = start.edges.slice(1);
    followIdentityChanges(layer, before, documentIdentities(doc));
    expect(layer.edges).toEqual({ [keyOf(doc, 'Start', 0)]: { color: 'red' } });
  });

  it('drops the visuals of a deleted node, its edges and its on_error edge', () => {
    const doc = parseFlow(FLOW);
    const layer = layerWithEdge(doc, 'Start', 0, 'red');
    setNodeShape(layer, IDS.start, 'diamond');
    setNodeShape(layer, IDS.done, 'ellipse');
    setEdgeColor(layer, onErrorEdgeKey(IDS.start), 'orange');
    const before = documentIdentities(doc);
    FlowDoc.deleteNodes(doc.items, [nodeNamed(doc, 'Start')], doc);
    followIdentityChanges(layer, before, documentIdentities(doc));
    expect(layer.nodes).toEqual({ [IDS.done]: { shape: 'ellipse' } });
    expect(layer.edges).toEqual({});
  });

  it('drops an on_error colour when the handler is removed, and keeps it while it stays', () => {
    const doc = parseFlow(FLOW);
    const layer = emptyCanvasLayer();
    setEdgeColor(layer, onErrorEdgeKey(IDS.start), 'orange');
    let before = documentIdentities(doc);
    setProp(nodeNamed(doc, 'Start'), 'on_error', '-> Check');
    followIdentityChanges(layer, before, documentIdentities(doc));
    expect(edgeColorOf(layer, onErrorEdgeKey(IDS.start))).toBe('orange');
    before = documentIdentities(doc);
    setProp(nodeNamed(doc, 'Start'), 'on_error', null);
    followIdentityChanges(layer, before, documentIdentities(doc));
    expect(layer.edges).toEqual({});
  });

  it('keeps the bend and solid line of an on_error edge whose handler is retargeted', () => {
    const doc = parseFlow(FLOW);
    const layer = emptyCanvasLayer();
    const look = { line: 'solid', bend: { along: 0.4, across: -0.3 } } as const;
    setEdgeStyle(layer, onErrorEdgeKey(IDS.start), look, 'error');
    const before = documentIdentities(doc);
    setProp(nodeNamed(doc, 'Start'), 'on_error', '-> Check');
    followIdentityChanges(layer, before, documentIdentities(doc));
    expect(edgeStyleOf(layer, onErrorEdgeKey(IDS.start), 'error')).toMatchObject(look);
  });

  it('follows an edge lifted onto the host when its source is extracted into a subgraph', () => {
    const doc = parseFlow(FLOW);
    const layer = layerWithEdge(doc, 'Check', 0, 'green');
    setNodeShape(layer, IDS.check, 'hexagon');
    const before = documentIdentities(doc);
    const { host } = FlowDoc.extractSubgraph(doc.items, [nodeNamed(doc, 'Start'), nodeNamed(doc, 'Check')], doc);
    FlowDoc.assignMissingIds(doc);
    const after = documentIdentities(doc);
    followIdentityChanges(layer, before, after);
    const lifted = host.edges.find((spec) => spec.innerSource === 'Check')!;
    expect(edgeColorOf(layer, after.edgeKeys.get(lifted)!)).toBe('green');
    expect(nodeShapeOf(layer, IDS.check)).toBe('hexagon');
  });

  it('follows an {Inner} refinement renamed by the inner-ref ripple', () => {
    const doc = parseFlow(`---
name: demo
---

Caller
  id: ${IDS.start}
  -> Host {Inner A} : "in"

Host
  id: ${IDS.check}
  expand: Steps

graph: Steps
  Inner A
    id: ${IDS.done}
`);
    const layer = layerWithEdge(doc, 'Caller', 0, 'purple');
    const before = documentIdentities(doc);
    FlowDoc.retargetInnerRefs([{ doc, path: 'main.flow' }], { kind: 'graph-block', name: 'Steps' }, 'Inner A', 'Inner B');
    expect(nodeNamed(doc, 'Caller').edges[0].innerTarget).toBe('Inner B');
    followIdentityChanges(layer, before, documentIdentities(doc));
    expect(edgeColorOf(layer, keyOf(doc, 'Caller', 0))).toBe('purple');
  });

  it('leaves entries alone that the earlier capture does not account for', () => {
    const doc = parseFlow(FLOW);
    const layer = emptyCanvasLayer();
    setEdgeColor(layer, 'orphaned by an outside edit', 'gray');
    const before = documentIdentities(doc);
    nodeNamed(doc, 'Check').edges[0].label = 'x';
    expect(followIdentityChanges(layer, before, documentIdentities(doc))).toBe(false);
    expect(Object.keys(layer.edges)).toEqual(['orphaned by an outside edit']);
  });
});

describe('region looks', () => {
  const REGION_FLOW = `---
name: demo
---

context: Auth
  nodes: Start

Start
  id: ${IDS.start}
  pos: 0, 0, 180, 80
  expand: Inner

graph: Inner
  context: Session
    nodes: Step

  Step
    id: ${IDS.check}
    pos: 0, 0, 180, 80
`;

  function styledRegions(doc: FlowDocument): CanvasLayer {
    const layer = emptyCanvasLayer();
    setRegionStyle(layer, 'Auth', { color: 'blue' });
    setRegionStyle(layer, 'Session', { fill: 'dots' });
    expect([...documentIdentities(doc).contextNames.values()]).toEqual(['Auth', 'Session']);
    return layer;
  }

  it('serializes regions beside nodes and edges, and reads them back', () => {
    const layer = emptyCanvasLayer();
    setRegionStyle(layer, 'Auth', { color: 'blue', fill: 'solid' });
    const text = serializeCanvasLayer(layer)!;
    expect(JSON.parse(text).regions).toEqual({ Auth: { color: 'blue', fill: 'solid' } });
    expect(parseCanvasLayer(text).regions).toEqual(layer.regions);
  });

  it('moves a look to the new name when a region is renamed, in the body or in a graph block', () => {
    const doc = parseFlow(REGION_FLOW);
    const layer = styledRegions(doc);
    const before = documentIdentities(doc);
    FlowDoc.renameContextBlock(doc, FlowDoc.contextBlockNamed(doc, 'Auth')!, 'Login');
    FlowDoc.renameContextBlock(doc, FlowDoc.contextBlockNamed(doc, 'Session')!, 'Visit');
    expect(followIdentityChanges(layer, before, documentIdentities(doc))).toBe(true);
    expect(regionStyleOf(layer, 'Login').color).toBe('blue');
    expect(regionStyleOf(layer, 'Visit').fill).toBe('dots');
    expect(Object.keys(layer.regions).sort()).toEqual(['Login', 'Visit']);
  });

  it('drops the look of a deleted region', () => {
    const doc = parseFlow(REGION_FLOW);
    const layer = styledRegions(doc);
    const before = documentIdentities(doc);
    FlowDoc.deleteContextBlock(doc.items, FlowDoc.contextBlockNamed(doc, 'Auth')!);
    followIdentityChanges(layer, before, documentIdentities(doc));
    expect(Object.keys(layer.regions)).toEqual(['Session']);
  });

  it('leaves a look alone that names no region the earlier capture knew', () => {
    const doc = parseFlow(REGION_FLOW);
    const layer = emptyCanvasLayer();
    setRegionStyle(layer, 'Renamed outside the editor', { color: 'gray' });
    const before = documentIdentities(doc);
    FlowDoc.renameContextBlock(doc, FlowDoc.contextBlockNamed(doc, 'Auth')!, 'Login');
    expect(followIdentityChanges(layer, before, documentIdentities(doc))).toBe(false);
    expect(Object.keys(layer.regions)).toEqual(['Renamed outside the editor']);
  });

  it('carries looks onto copies by position, and clears a leftover under an unstyled copy\'s name', () => {
    const layer = emptyCanvasLayer();
    setRegionStyle(layer, 'Auth', { color: 'red' });
    setRegionStyle(layer, 'Session 2', { color: 'gray' });
    const sources = [{ name: 'Auth' }, { name: 'Session' }].map((source) => ({ ...source, pos: null, props: [], references: [], members: [] }));
    const copies = [{ ...sources[0], name: 'Auth 2' }, { ...sources[1], name: 'Session 2' }];
    applyRegionVisuals(layer, copies, captureRegionVisuals(layer, sources));
    expect(regionStyleOf(layer, 'Auth 2').color).toBe('red');
    expect(layer.regions['Session 2']).toBeUndefined();
  });
});

describe('copies', () => {
  it('puts captured visuals on duplicates, which have fresh ids and possibly new names', () => {
    const doc = parseFlow(FLOW);
    const layer = layerWithShapes(doc);
    const sources = [nodeNamed(doc, 'Start'), nodeNamed(doc, 'Check')];
    const captured = captureVisuals(layer, documentIdentities(doc), sources);
    const copies = FlowDoc.duplicateNodes(doc.items, sources, { x: 20, y: 20 });
    const after = documentIdentities(doc);
    applyCapturedVisuals(layer, after, copies, captured);

    expect(nodeShapeOf(layer, copies[0].id)).toBe('diamond');
    expect(nodeShapeOf(layer, copies[1].id)).toBe('cylinder');
    // The copy of Start's first edge targets the copy of Check, under the copies' ids.
    expect(edgeColorOf(layer, after.edgeKeys.get(copies[0].edges[0])!)).toBe('red');
    expect(edgeColorOf(layer, onErrorEdgeKey(copies[0].id!))).toBe('orange');
    expect(nodeShapeOf(layer, IDS.start)).toBe('diamond');
  });

  it("carries an edge's line, heads and bend onto its copy", () => {
    const doc = parseFlow(FLOW);
    const layer = emptyCanvasLayer();
    const look = { line: 'dashed', endHead: 'diamond', bend: [0.5, -0.3] };
    layer.edges[keyOf(doc, 'Check', 0)] = { ...look };
    const sources = [nodeNamed(doc, 'Check'), nodeNamed(doc, 'Done')];
    const captured = captureVisuals(layer, documentIdentities(doc), sources);
    const copies = FlowDoc.duplicateNodes(doc.items, sources, { x: 20, y: 20 });
    const after = documentIdentities(doc);
    applyCapturedVisuals(layer, after, copies, captured);
    expect(layer.edges[after.edgeKeys.get(copies[0].edges[0])!]).toEqual(look);
  });

  function layerWithShapes(doc: FlowDocument): CanvasLayer {
    const layer = emptyCanvasLayer();
    setNodeShape(layer, IDS.start, 'diamond');
    setNodeShape(layer, IDS.check, 'cylinder');
    setEdgeColor(layer, keyOf(doc, 'Start', 0), 'red');
    setEdgeColor(layer, onErrorEdgeKey(IDS.start), 'orange');
    return layer;
  }
});
