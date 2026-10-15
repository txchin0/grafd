// Layout applied to a parsed .flow document: reading one graph scope (the file body, or a `graph:`
// block) as the layout's input, and writing the rects it gives back onto the nodes. The canvas,
// the Arrange command and `grafd layout` all read a document through here, so they cannot place
// a node differently; the linter reads its own scan of the file and is held to the same answer by
// a test.

import { arrangeScope, arrangeSelected, placeNodes, type Arrangement, type LayoutScope } from './auto-layout.js';
import { bendThroughPoint, type EdgeBend } from './canvas-edge-style.js';
import {
  getProp,
  parseEdgeExpression,
  unquote,
  type ContextItem,
  type EdgeSpec,
  type FlowDocument,
  type FlowItem,
  type FlowNode,
  type GraphItem,
  type Rect,
} from './flow-format.js';
import { rectCenter } from './rect-math.js';

// A bend that would move an edge less than this off its straight line is not worth storing.
const MIN_BEND_DEVIATION = 16;

// An edge of the document: the node declaring it, and its spec — or null for the node's
// `on_error`, whose spec is parsed afresh from the property every time and so has no identity.
export interface DocumentEdge {
  node: FlowNode;
  spec: EdgeSpec | null;
}

export interface PlannedBend extends DocumentEdge {
  bend: EdgeBend | null;
}

export interface ArrangeOutcome {
  // Whether any node moved, or a region released the area it reserved.
  moved: boolean;
  // The bends the arrangement settles, to be written to the graph's canvas layer.
  bends: PlannedBend[];
}

export function layoutScopeOfItems(items: FlowItem[]): LayoutScope {
  return layoutScopeWithEdgesOf(items).scope;
}

// `edges` names, for each of the scope's edges, the document edge it was read from.
export function layoutScopeWithEdgesOf(items: FlowItem[]): { scope: LayoutScope; edges: DocumentEdge[] } {
  const nodes = nodesOf(items);
  const edges = nodes.flatMap((node) => [
    ...node.edges.map((spec) => ({ node, spec, kind: 'flow' as const, read: spec })),
    ...errorEdgesOf(node).map((read) => ({ node, spec: null, kind: 'error' as const, read })),
  ]);
  const indexOf = new Map(nodes.map((node, index) => [node, index]));
  return {
    scope: {
      nodes: nodes.map((node) => ({
        name: node.name,
        pos: node.pos,
        description: unquote(getProp(node, 'description')) || null,
        entrypoint: getProp(node, 'entrypoint') === 'true',
      })),
      edges: edges.map((edge) => ({ from: indexOf.get(edge.node)!, target: edge.read.target, kind: edge.kind, label: edge.read.label })),
      regions: contextItemsOf(items).map(({ block }) => ({ members: block.members, pos: block.pos })),
    },
    edges: edges.map(({ node, spec }) => ({ node, spec })),
  };
}

// The item list of every graph scope in the document: its body first, then each `graph:` block.
export function graphScopesOf(doc: FlowDocument): FlowItem[][] {
  return [doc.items, ...doc.items.filter((item): item is GraphItem => item.kind === 'graph').map((item) => item.items)];
}

// Gives every node without a `pos` the place the canvas would give it; says whether any had none.
export function placeMissingPositions(doc: FlowDocument): boolean {
  let placedAny = false;
  for (const items of graphScopesOf(doc)) {
    const nodes = nodesOf(items);
    if (nodes.every((node) => node.pos)) continue;
    const rects = placeNodes(layoutScopeOfItems(items));
    nodes.forEach((node, index) => {
      if (node.pos) return;
      node.pos = rects[index];
      placedAny = true;
    });
  }
  return placedAny;
}

// Lays a scope out afresh — or only `chosen` of its nodes, around the rest — moving its nodes, and
// says which edges should bend where. Arranging a whole scope also lets go of the area each region
// reserved beyond its members: drawn around the old layout, it would now cover nodes that are not
// its members. The bends are not written here: they belong to the canvas layer, which only the
// editor writes.
export function arrangeGraphScope(items: FlowItem[], chosen?: Set<FlowNode>): ArrangeOutcome {
  const nodes = nodesOf(items);
  const { scope, edges } = layoutScopeWithEdgesOf(items);
  const chosenIndices = chosen && new Set([...nodes.keys()].filter((index) => chosen.has(nodes[index])));
  const wholeScope = !chosenIndices || chosenIndices.size === nodes.length;
  const arrangement = wholeScope ? arrangeScope(scope) : arrangeSelected(scope, chosenIndices);

  let moved = false;
  nodes.forEach((node, index) => {
    if (node.pos && sameRect(node.pos, arrangement.rects[index])) return;
    node.pos = arrangement.rects[index];
    moved = true;
  });
  if (wholeScope) moved = releaseReservedAreas(items, nodes) || moved;
  return { moved, bends: plannedBends(scope, edges, arrangement) };
}

function plannedBends(scope: LayoutScope, edges: DocumentEdge[], arrangement: Arrangement): PlannedBend[] {
  const indexOf = new Map(scope.nodes.map((node, index) => [node.name, index]));
  return [...arrangement.bendPoints].map(([edgeIndex, point]) => {
    const edge = scope.edges[edgeIndex];
    const from = rectCenter(arrangement.rects[edge.from]);
    const to = rectCenter(arrangement.rects[indexOf.get(edge.target)!]);
    return { ...edges[edgeIndex], bend: point ? worthwhileBend(bendThroughPoint(point, from, to), from, to) : null };
  });
}

// A bend so slight that the edge would look straight anyway is left out, so a layer is not filled
// with bends nobody can see.
function worthwhileBend(bend: EdgeBend | null, from: { x: number; y: number }, to: { x: number; y: number }): EdgeBend | null {
  if (!bend) return null;
  const chordLength = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.abs(bend.across) * chordLength < MIN_BEND_DEVIATION ? null : bend;
}

// Bends are left as they are: `grafd layout` never writes a canvas layer.
export function arrangeDocument(doc: FlowDocument): boolean {
  return graphScopesOf(doc).map((items) => arrangeGraphScope(items).moved).some((moved) => moved);
}

function releaseReservedAreas(items: FlowItem[], nodes: FlowNode[]): boolean {
  const names = new Set(nodes.map((node) => node.name));
  let released = false;
  for (const { block } of contextItemsOf(items)) {
    if (!block.pos || !block.members.some((member) => names.has(member))) continue;
    block.pos = null;
    released = true;
  }
  return released;
}

function nodesOf(items: FlowItem[]): FlowNode[] {
  return items.flatMap((item) => (item.kind === 'node' ? [item.node] : []));
}

function contextItemsOf(items: FlowItem[]): ContextItem[] {
  return items.filter((item): item is ContextItem => item.kind === 'context');
}

function errorEdgesOf(node: FlowNode): EdgeSpec[] {
  const onError = getProp(node, 'on_error');
  return onError?.startsWith('->') ? [parseEdgeExpression(onError)] : [];
}

function sameRect(first: Rect, second: Rect): boolean {
  return first.x === second.x && first.y === second.y && first.w === second.w && first.h === second.h;
}
