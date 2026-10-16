// What a node is to its flow — where it starts or ends, where it branches, a store of data, a
// system outside it — and how each role is drawn: a node's role sets its shape in the graph's
// canvas layer (flowchart convention: a decision is a diamond, a store a cylinder), and an error
// role marks the edges leading into it. Roles are never written to the .flow; the format has no
// place for style, and a role is only ever a way of choosing one.
//
// Some roles can be read off a graph's structure (`inferRoles`); the rest — what is a store, what
// is outside the system — only whoever wrote the graph knows.

import { DEFAULT_NODE_SHAPE, documentIdentities, nodeShapeOf, setNodeShape, type CanvasLayer, type NodeShape } from './canvas-layer.js';
import { setEdgeStyle } from './canvas-edge-style.js';
import { assignMissingNodeIds } from './document-layout.js';
import { getProp, parseEdgeExpression, unquote, type FlowDocument, type FlowItem, type FlowNode, type Rect } from './flow-format.js';
import { estimateNodeSize, textCutOff } from './node-size-estimate.js';
import { rectCenter, snapToCanvasGrid } from './rect-math.js';

export const NODE_ROLES = ['start', 'end', 'process', 'decision', 'datastore', 'io', 'external', 'event', 'error'] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

export const ROLE_SHAPES: Record<NodeRole, NodeShape> = {
  start: 'rounded',
  end: 'rounded',
  process: 'rectangle',
  decision: 'diamond',
  datastore: 'cylinder',
  io: 'parallelogram',
  external: 'hexagon',
  event: 'ellipse',
  error: 'rectangle',
};

export const ROLE_MEANINGS: Record<NodeRole, string> = {
  start: 'where the flow begins',
  end: 'where it finishes',
  process: 'a step that does something',
  decision: 'a step that branches on a condition',
  datastore: 'a database, cache, queue or file',
  io: 'input from or output to a user or device',
  external: 'a system or actor outside this one',
  event: 'something that happens and sets things off',
  error: 'where things go when they fail; edges into it are drawn red and dashed',
};

export function isNodeRole(value: unknown): value is NodeRole {
  return (NODE_ROLES as readonly unknown[]).includes(value);
}

// A node whose outgoing edges are told apart by their labels: two or more labelled ways on.
export function branchesOnLabels(node: FlowNode): boolean {
  return node.edges.filter((edge) => edge.label).length >= 2;
}

// Where a flow begins: declared so, or with no edge leading into it — an `on_error` included, since
// a node only failed into is reached when something fails rather than where the flow starts.
export function isEntryNode(node: FlowNode, namesLedInto: ReadonlySet<string>): boolean {
  return getProp(node, 'entrypoint') === 'true' || !namesLedInto.has(node.name);
}

// The roles a graph scope's structure gives its nodes: an entry that leads somewhere starts the
// flow, a node only ever failed into handles errors, one that branches on labels decides, and one
// that leads nowhere ends it. Everything else is a process.
export function inferRoles(items: FlowItem[]): Map<FlowNode, NodeRole> {
  const nodes = nodesOf(items);
  const flowTargets = new Set(nodes.flatMap((node) => node.edges.map((edge) => edge.target)));
  const errorTargets = new Set(nodes.flatMap((node) => errorTargetsOf(node)));
  const targets = { flow: flowTargets, error: errorTargets, any: new Set([...flowTargets, ...errorTargets]) };
  return new Map(nodes.map((node) => [node, inferredRoleOf(node, targets)]));
}

interface ScopeTargets {
  flow: ReadonlySet<string>;
  error: ReadonlySet<string>;
  any: ReadonlySet<string>;
}

function inferredRoleOf(node: FlowNode, targets: ScopeTargets): NodeRole {
  const leadsSomewhere = node.edges.length > 0;
  if (targets.error.has(node.name) && !targets.flow.has(node.name)) return 'error';
  if (isEntryNode(node, targets.any) && leadsSomewhere) return 'start';
  if (branchesOnLabels(node)) return 'decision';
  if (!leadsSomewhere && targets.flow.has(node.name)) return 'end';
  return 'process';
}

export interface RoleStyling {
  // Each node given a role, with the shape it now has.
  styled: { node: FlowNode; role: NodeRole; shape: NodeShape }[];
  // Nodes grown so their text still fits the shape they now have.
  resized: { node: FlowNode; size: { w: number; h: number } }[];
  // Edges drawn red and dashed for leading into an error.
  edgesIntoErrors: number;
  // Whether the .flow changed too — a node given the id the layer keys it by, or grown — and must
  // be written back.
  flowChanged: boolean;
}

// Styles the nodes of one graph scope by their roles, in the document's canvas layer.
export function styleByRoles(doc: FlowDocument, items: FlowItem[], layer: CanvasLayer, roles: ReadonlyMap<FlowNode, NodeRole>): RoleStyling {
  // Every node of the scope, as the editor does on opening a file: an edge's key in the layer is
  // made of the ids at both its ends.
  const idsAssigned = assignMissingNodeIds(items);
  const styled = [...roles].map(([node, role]) => {
    setNodeShape(layer, node.id!, ROLE_SHAPES[role]);
    return { node, role, shape: ROLE_SHAPES[role] };
  });
  const resized = styled.flatMap(({ node, shape }) => {
    const grown = grownToFit(node, shape);
    if (!grown) return [];
    node.pos = grown;
    return [{ node, size: { w: grown.w, h: grown.h } }];
  });
  return {
    styled,
    resized,
    edgesIntoErrors: markEdgesIntoErrors(doc, items, layer, roles),
    flowChanged: idsAssigned || resized.length > 0,
  };
}

// A diamond, an ellipse or a hexagon leaves a node less room for text than the rectangle it was
// sized as, so a node whose text no longer fits grows — about its centre, so it stays where it was
// — to the size its shape needs. Null for a node that still fits, or has no place yet.
function grownToFit(node: FlowNode, shape: NodeShape): Rect | null {
  const rect = node.pos;
  const description = unquote(getProp(node, 'description')) || null;
  if (!rect || !textCutOff(node.name, description, rect, shape)) return null;
  const needed = estimateNodeSize(node.name, description, shape);
  const w = Math.max(rect.w, needed.w);
  const h = Math.max(rect.h, needed.h);
  const center = rectCenter(rect);
  return { x: snapToCanvasGrid(center.x - w / 2), y: snapToCanvasGrid(center.y - h / 2), w, h };
}

function markEdgesIntoErrors(doc: FlowDocument, items: FlowItem[], layer: CanvasLayer, roles: ReadonlyMap<FlowNode, NodeRole>): number {
  const errorNames = new Set([...roles].filter(([, role]) => role === 'error').map(([node]) => node.name));
  const identities = documentIdentities(doc);
  let marked = 0;
  for (const node of nodesOf(items)) {
    for (const spec of node.edges) {
      const key = identities.edgeKeys.get(spec);
      if (!errorNames.has(spec.target) || !key) continue;
      setEdgeStyle(layer, key, { color: 'red', line: 'dashed' }, 'flow');
      marked += 1;
    }
  }
  return marked;
}

// The roles to apply: every role named explicitly, and — when inferring — the inferred role of
// each node not named, as long as it still has the default shape. A shape someone chose is never
// replaced by a guess.
export function rolesToApply(
  items: FlowItem[],
  layer: CanvasLayer,
  named: ReadonlyMap<FlowNode, NodeRole>,
  infer: boolean,
): Map<FlowNode, NodeRole> {
  const roles = new Map(named);
  if (!infer) return roles;
  for (const [node, role] of inferRoles(items)) {
    if (!roles.has(node) && nodeShapeOf(layer, node.id) === DEFAULT_NODE_SHAPE) roles.set(node, role);
  }
  return roles;
}

function nodesOf(items: FlowItem[]): FlowNode[] {
  return items.flatMap((item) => (item.kind === 'node' ? [item.node] : []));
}

function errorTargetsOf(node: FlowNode): string[] {
  const onError = getProp(node, 'on_error');
  return onError?.startsWith('->') ? [parseEdgeExpression(onError).target] : [];
}
