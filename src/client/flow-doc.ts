// Document-level operations on a parsed .flow AST: scope resolution for `graph:` blocks,
// building the canvas view-model (nodes, resolved edges, ghost targets, inferred traits),
// deterministic auto-layout for nodes that have no `pos` yet, and all editor mutations.

import {
  emptyNode,
  getProp,
  setProp,
  newUuid,
  parseEdgeExpression,
  serializeEdgeExpression,
  parseListValue,
  sanitizeName,
  uniqueName,
  type EdgeSpec,
  type FlowDocument,
  type FlowItem,
  type FlowNode,
  type GraphItem,
  type Rect,
} from '../shared/flow-format.js';
import type { DisplayGeometry } from './expansion.js';

export interface Point {
  x: number;
  y: number;
}

export interface GhostNode {
  name: string;
  ghost: true;
  pos: Rect;
}

export type EdgeKind = 'flow' | 'error';

export interface EdgeGeometry {
  a: Point;
  b: Point;
  mid: Point;
  labelRect: Rect | null;
  selfLoop?: boolean;
}

export interface ModelEdge {
  from: FlowNode;
  spec: EdgeSpec;
  kind: EdgeKind;
  to?: FlowNode | GhostNode;
  geometry?: EdgeGeometry | null;
}

export interface NodeTraits {
  entry: boolean;
  decision: boolean;
  expand: string | null;
  updates: string[];
  hasErrorHandler: boolean;
}

export interface FlowModel {
  nodes: FlowNode[];
  edges: ModelEdge[];
  ghosts: GhostNode[];
  nodesByName: Map<string, FlowNode>;
  traits: Map<FlowNode, NodeTraits>;
  sourceDoc: FlowDocument;
  sourcePath: string | null;
  display?: DisplayGeometry;
  embedded?: boolean;
}

export const DEFAULT_NODE_SIZE = { w: 200, h: 88 };
const LAYOUT_COLUMN_WIDTH = 280;
const LAYOUT_ROW_HEIGHT = 140;
const LAYOUT_ORIGIN = { x: 80, y: 80 };

export function assignMissingIds(doc: FlowDocument): void {
  for (const node of allNodes(doc)) {
    if (!node.id) node.id = newUuid();
  }
}

export function allNodes(doc: FlowDocument): FlowNode[] {
  const nodes: FlowNode[] = [];
  for (const item of doc.items) {
    if (item.kind === 'node') nodes.push(item.node);
    if (item.kind === 'graph') {
      for (const inner of item.items) {
        if (inner.kind === 'node') nodes.push(inner.node);
      }
    }
  }
  return nodes;
}

export function graphBlockNames(doc: FlowDocument): string[] {
  return doc.items.filter((item): item is GraphItem => item.kind === 'graph').map((item) => item.name);
}

export function scopeItems(doc: FlowDocument, scopeName: string | null): FlowItem[] {
  if (!scopeName) return doc.items;
  const graph = doc.items.find((item): item is GraphItem => item.kind === 'graph' && item.name === scopeName);
  return graph ? graph.items : doc.items;
}

export function nodesIn(items: FlowItem[]): FlowNode[] {
  return items.filter((item): item is { kind: 'node'; node: FlowNode } => item.kind === 'node').map((item) => item.node);
}

export function findNodeById(doc: FlowDocument, nodeId: string | null): FlowNode | null {
  return allNodes(doc).find((node) => node.id === nodeId) ?? null;
}

export function containingItems(doc: FlowDocument, node: FlowNode): FlowItem[] {
  for (const item of doc.items) {
    if (item.kind === 'node' && item.node === node) return doc.items;
    if (item.kind === 'graph' && item.items.some((inner) => inner.kind === 'node' && inner.node === node)) {
      return item.items;
    }
  }
  return doc.items;
}

export function buildModel(doc: FlowDocument, scopeName: string | null): FlowModel {
  const nodes = nodesIn(scopeItems(doc, scopeName));
  const nodesByName = new Map(nodes.map((node) => [node.name, node]));

  const edges: ModelEdge[] = [];
  for (const node of nodes) {
    for (const spec of node.edges) edges.push({ from: node, spec, kind: 'flow' });
    const onError = getProp(node, 'on_error');
    if (onError?.startsWith('->')) {
      edges.push({ from: node, spec: parseEdgeExpression(onError), kind: 'error' });
    }
  }

  autoLayout(nodes, edges);

  const ghosts = resolveEdgeTargets(edges, nodesByName);
  const traits = inferTraits(nodes, edges);
  return { nodes, edges, ghosts, nodesByName, traits, sourceDoc: doc, sourcePath: null };
}

function resolveEdgeTargets(edges: ModelEdge[], nodesByName: Map<string, FlowNode>): GhostNode[] {
  const ghosts: GhostNode[] = [];
  const ghostsByName = new Map<string, GhostNode>();
  for (const edge of edges) {
    let target = nodesByName.get(edge.spec.target) ?? ghostsByName.get(edge.spec.target);
    if (!target) {
      const ghost = makeGhost(edge, ghosts.length);
      ghosts.push(ghost);
      ghostsByName.set(ghost.name, ghost);
      target = ghost;
    }
    edge.to = target;
  }
  return ghosts;
}

function makeGhost(edge: ModelEdge, ghostIndex: number): GhostNode {
  const source = edge.from.pos ?? { x: 0, y: 0, w: DEFAULT_NODE_SIZE.w, h: DEFAULT_NODE_SIZE.h };
  return {
    name: edge.spec.target,
    ghost: true,
    pos: {
      x: source.x + source.w + 140,
      y: source.y + ghostIndex * 70,
      w: DEFAULT_NODE_SIZE.w,
      h: 64,
    },
  };
}

function inferTraits(nodes: FlowNode[], edges: ModelEdge[]): Map<FlowNode, NodeTraits> {
  const namesWithIncoming = new Set(
    edges.filter((edge) => edge.kind === 'flow').map((edge) => edge.spec.target),
  );
  const traits = new Map<FlowNode, NodeTraits>();
  for (const node of nodes) {
    const labeledOutgoing = node.edges.filter((edge) => edge.label).length;
    traits.set(node, {
      entry: getProp(node, 'entrypoint') === 'true' || !namesWithIncoming.has(node.name),
      decision: labeledOutgoing >= 2,
      expand: getProp(node, 'expand'),
      updates: parseListValue(getProp(node, 'updates')),
      hasErrorHandler: getProp(node, 'on_error') != null,
    });
  }
  return traits;
}

export function autoLayout(nodes: FlowNode[], edges: ModelEdge[]): void {
  const unplaced = nodes.filter((node) => !node.pos);
  if (unplaced.length === 0) return;

  const depths = computeFlowDepths(nodes, edges);
  const startY = bottomOfPlacedNodes(nodes) ?? LAYOUT_ORIGIN.y;
  const rowsUsedPerColumn = new Map<number, number>();

  for (const node of unplaced) {
    const column = depths.get(node.name) ?? 0;
    const row = rowsUsedPerColumn.get(column) ?? 0;
    rowsUsedPerColumn.set(column, row + 1);
    node.pos = {
      x: LAYOUT_ORIGIN.x + column * LAYOUT_COLUMN_WIDTH,
      y: startY + row * LAYOUT_ROW_HEIGHT,
      w: DEFAULT_NODE_SIZE.w,
      h: DEFAULT_NODE_SIZE.h,
    };
  }
}

function bottomOfPlacedNodes(nodes: FlowNode[]): number | null {
  const placed = nodes.filter((node) => node.pos);
  if (placed.length === 0) return null;
  return Math.max(...placed.map((node) => node.pos!.y + node.pos!.h)) + 90;
}

function computeFlowDepths(nodes: FlowNode[], edges: ModelEdge[]): Map<string, number> {
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.name, []]));
  const namesWithIncoming = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== 'flow') continue;
    outgoing.get(edge.from.name)?.push(edge.spec.target);
    namesWithIncoming.add(edge.spec.target);
  }

  const depths = new Map<string, number>();
  const queue = nodes
    .filter((node) => !namesWithIncoming.has(node.name))
    .map((node) => ({ name: node.name, depth: 0 }));

  while (queue.length > 0) {
    const { name, depth } = queue.shift()!;
    if (depths.has(name)) continue;
    depths.set(name, depth);
    for (const targetName of outgoing.get(name) ?? []) {
      queue.push({ name: targetName, depth: depth + 1 });
    }
  }
  return depths;
}

export function ensureLayoutEverywhere(doc: FlowDocument): void {
  buildModel(doc, null);
  for (const graphName of graphBlockNames(doc)) buildModel(doc, graphName);
}

export function addNode(items: FlowItem[], rect: Rect, requestedName = 'Untitled'): FlowNode {
  const takenNames = new Set(nodesIn(items).map((node) => node.name));
  const node = emptyNode(uniqueName(takenNames, sanitizeName(requestedName) || 'Untitled'));
  node.id = newUuid();
  node.pos = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  };
  items.push({ kind: 'node', node });
  return node;
}

export function deleteNodes(items: FlowItem[], nodesToDelete: FlowNode[]): void {
  const deletedNames = new Set(nodesToDelete.map((node) => node.name));
  const deletedSet = new Set(nodesToDelete);

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'node' && deletedSet.has(item.node)) items.splice(index, 1);
  }

  for (const node of nodesIn(items)) {
    node.edges = node.edges.filter((edge) => !deletedNames.has(edge.target));
    const onError = getProp(node, 'on_error');
    if (onError?.startsWith('->') && deletedNames.has(parseEdgeExpression(onError).target)) {
      setProp(node, 'on_error', null);
    }
  }
}

export function renameNode(items: FlowItem[], node: FlowNode, requestedName: string): string {
  const cleanName = sanitizeName(requestedName);
  if (!cleanName || cleanName === node.name) return node.name;

  const takenNames = new Set(nodesIn(items).filter((other) => other !== node).map((other) => other.name));
  const oldName = node.name;
  node.name = uniqueName(takenNames, cleanName);

  for (const other of nodesIn(items)) {
    for (const edge of other.edges) {
      if (edge.target === oldName) edge.target = node.name;
    }
    const onError = getProp(other, 'on_error');
    if (onError?.startsWith('->')) {
      const parsed = parseEdgeExpression(onError);
      if (parsed.target === oldName) {
        parsed.target = node.name;
        setProp(other, 'on_error', serializeEdgeExpression(parsed));
      }
    }
  }
  return node.name;
}

export function renameGraphBlock(doc: FlowDocument, graphItem: GraphItem, requestedName: string): string {
  const cleanName = sanitizeName(requestedName);
  if (!cleanName || cleanName === graphItem.name) return graphItem.name;

  const takenNames = new Set(graphBlockNames(doc).filter((name) => name !== graphItem.name));
  const oldName = graphItem.name;
  graphItem.name = uniqueName(takenNames, cleanName);

  for (const node of allNodes(doc)) {
    if (getProp(node, 'expand') === oldName) setProp(node, 'expand', graphItem.name);
  }
  return graphItem.name;
}

export function addEdge(fromNode: FlowNode, targetName: string, label: string | null = null): EdgeSpec {
  fromNode.edges.push({ target: targetName, label, data: null });
  return fromNode.edges[fromNode.edges.length - 1];
}

export function deleteEdge(edge: ModelEdge): void {
  if (edge.kind === 'error') {
    setProp(edge.from, 'on_error', null);
    return;
  }
  edge.from.edges = edge.from.edges.filter((spec) => spec !== edge.spec);
}

export function setEdgeLabel(edge: ModelEdge, label: string | null): void {
  const cleanLabel = label?.trim() || null;
  if (edge.kind === 'error') {
    edge.spec.label = cleanLabel;
    setProp(edge.from, 'on_error', serializeEdgeExpression(edge.spec));
    return;
  }
  edge.spec.label = cleanLabel;
}
