// Layout applied to a parsed .flow document: reading one graph scope (the file body, or a `graph:`
// block) as the layout's input, and writing the rects it gives back onto the nodes. The canvas,
// the Arrange command and `grafd layout` all read a document through here, so they cannot place
// a node differently; the linter reads its own scan of the file and is held to the same answer by
// a test.

import { arrangeScope, arrangeSelected, placeNodes, type LayoutScope } from './auto-layout.js';
import {
  getProp,
  parseEdgeExpression,
  unquote,
  type ContextItem,
  type FlowDocument,
  type FlowItem,
  type FlowNode,
  type GraphItem,
  type Rect,
} from './flow-format.js';

export function layoutScopeOfItems(items: FlowItem[]): LayoutScope {
  const nodes = nodesOf(items);
  return {
    nodes: nodes.map((node) => ({
      name: node.name,
      pos: node.pos,
      description: unquote(getProp(node, 'description')) || null,
      entrypoint: getProp(node, 'entrypoint') === 'true',
    })),
    edges: nodes.flatMap((node, index) => [
      ...node.edges.map((edge) => ({ from: index, target: edge.target, kind: 'flow' as const })),
      ...errorEdgeTargetsOf(node).map((target) => ({ from: index, target, kind: 'error' as const })),
    ]),
    regions: contextItemsOf(items).map(({ block }) => ({ members: block.members, pos: block.pos })),
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

// Lays a scope out afresh — or only `chosen` of its nodes, around the rest — and says whether
// anything moved. Arranging a whole scope also lets go of the area each region reserved beyond
// its members: drawn around the old layout, it would now cover nodes that are not its members.
export function arrangeGraphScope(items: FlowItem[], chosen?: Set<FlowNode>): boolean {
  const nodes = nodesOf(items);
  const scope = layoutScopeOfItems(items);
  const chosenIndices = chosen && new Set([...nodes.keys()].filter((index) => chosen.has(nodes[index])));
  const wholeScope = !chosenIndices || chosenIndices.size === nodes.length;
  const rects = wholeScope ? arrangeScope(scope) : arrangeSelected(scope, chosenIndices);

  let changed = false;
  nodes.forEach((node, index) => {
    if (node.pos && sameRect(node.pos, rects[index])) return;
    node.pos = rects[index];
    changed = true;
  });
  if (wholeScope) changed = releaseReservedAreas(items, nodes) || changed;
  return changed;
}

export function arrangeDocument(doc: FlowDocument): boolean {
  return graphScopesOf(doc).map((items) => arrangeGraphScope(items)).some((changed) => changed);
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

function errorEdgeTargetsOf(node: FlowNode): string[] {
  const onError = getProp(node, 'on_error');
  return onError?.startsWith('->') ? [parseEdgeExpression(onError).target] : [];
}

function sameRect(first: Rect, second: Rect): boolean {
  return first.x === second.x && first.y === second.y && first.w === second.w && first.h === second.h;
}
