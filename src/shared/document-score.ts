// Scores every graph of a .flow file as the canvas shows it — nodes without a position where the
// canvas places them, edges bent as its canvas layer says — and beside each, what arranging that
// graph would score, so the report can say when arranging is the better fix.

import { placeNodes } from './auto-layout.js';
import { documentIdentities, nodeShapeOf, type CanvasLayer, type NodeShape } from './canvas-layer.js';
import { edgeStyleOf, type EdgeBend } from './canvas-edge-style.js';
import { arrangeGraphScope, graphScopesOf, layoutScopeWithEdgesOf, type DocumentEdge } from './document-layout.js';
import { parseFlow, type ContextItem, type FlowDocument, type FlowItem, type FlowNode, type GraphItem, type Rect } from './flow-format.js';
import { scoreGraph, type GraphScore, type ScoredGraph } from './layout-score.js';

export interface ScopeScore {
  // The `graph:` block scored, or null for the file body.
  scope: string | null;
  current: GraphScore;
  // What the graph would score once arranged (the editor's Arrange, or `grafd layout --all`).
  arranged: number;
}

export function scoreDocumentText(text: string, layer: CanvasLayer | null): ScopeScore[] {
  const doc = parseFlow(text);
  const arrangedCopy = parseFlow(text);
  const scopes = graphScopesOf(doc);
  const copies = graphScopesOf(arrangedCopy);
  const names = scopeNamesOf(doc);
  return scopes.flatMap((items, index) => {
    if (!items.some((item) => item.kind === 'node')) return [];
    const shapeOf = (node: FlowNode): NodeShape => nodeShapeOf(layer, node.id);
    const current = scoreGraph(scoredGraphOf(items, placeNodes(layoutScopeWithEdgesOf(items).scope), layerBends(doc, layer), shapeOf));
    return [{ scope: names[index], current, arranged: arrangedScoreOf(copies[index], shapeOf) }];
  });
}

function arrangedScoreOf(items: FlowItem[], shapeOf: (node: FlowNode) => NodeShape): number {
  const { bends } = arrangeGraphScope(items, undefined, shapeOf);
  const bendOf = ({ node, spec }: DocumentEdge): EdgeBend | null =>
    bends.find((plan) => plan.node === node && plan.spec === spec)?.bend ?? null;
  const rects = layoutScopeWithEdgesOf(items).scope.nodes.map((node) => node.pos!);
  return scoreGraph(scoredGraphOf(items, rects, bendOf, shapeOf)).score;
}

function layerBends(doc: FlowDocument, layer: CanvasLayer | null): (edge: DocumentEdge, kind: 'flow' | 'error') => EdgeBend | null {
  const identities = documentIdentities(doc);
  return ({ node, spec }, kind) => {
    const key = identities.edgeKeys.get(spec ?? node) ?? null;
    return edgeStyleOf(layer, key, kind).bend;
  };
}

function scoredGraphOf(
  items: FlowItem[],
  rects: Rect[],
  bendOf: (edge: DocumentEdge, kind: 'flow' | 'error') => EdgeBend | null,
  shapeOf: (node: FlowNode) => NodeShape,
): ScoredGraph {
  const { scope, edges } = layoutScopeWithEdgesOf(items);
  const nodes = items.flatMap((item) => (item.kind === 'node' ? [item.node] : []));
  const indexOf = new Map(scope.nodes.map((node, index) => [node.name, index]));
  const regionNames = items.filter((item): item is ContextItem => item.kind === 'context').map((item) => item.block.name);
  return {
    nodes: scope.nodes.map((node, index) => ({ name: node.name, rect: rects[index], description: node.description, shape: shapeOf(nodes[index]) })),
    edges: scope.edges.flatMap((edge, index) => {
      const to = indexOf.get(edge.target);
      if (to === undefined) return [];
      return [{ from: edge.from, to, kind: edge.kind, label: edge.label, bend: bendOf(edges[index], edge.kind) }];
    }),
    regions: scope.regions.map((region, index) => ({
      name: regionNames[index],
      members: region.members.flatMap((member) => indexOf.get(member) ?? []),
      area: region.pos,
    })),
  };
}

function scopeNamesOf(doc: FlowDocument): (string | null)[] {
  return [null, ...doc.items.filter((item): item is GraphItem => item.kind === 'graph').map((item) => item.name)];
}
