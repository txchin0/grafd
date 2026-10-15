// Where a node with no authored `pos` stands on the canvas, shared so the linter places the same
// nodes the same way the editor does and the two cannot drift.
//
// A graph with no positions at all — one an agent just wrote — is laid out whole as a layered
// drawing (layered-layout.ts). Nodes added to a graph that is already laid out still go on the
// old grid below it, until placement around the existing nodes exists.
//
// The canvas never persists these positions — it assigns them to the in-memory document, which
// the save path writes back — so a file the editor has touched has no empty positions left. A
// file that has not is judged by the layout it will get on first open.

import type { EdgeKind } from './canvas-edge-style.js';
import type { Rect } from './flow-format.js';
import { layOutLayered, type LayeredGraph } from './layered-layout.js';
import { DEFAULT_NODE_SIZE } from './node-size-estimate.js';

export { DEFAULT_NODE_SIZE };

const LAYOUT_COLUMN_WIDTH = 280;
const LAYOUT_ROW_HEIGHT = 140;
const LAYOUT_ORIGIN = { x: 80, y: 80 };
const GAP_BELOW_PLACED_NODES = 90;

export interface LayoutNode {
  name: string;
  pos: Rect | null;
  description: string | null;
  entrypoint: boolean;
}

// An edge leaves the node at index `from` for whichever node is named `target`; a name that
// matches none (the canvas draws a placeholder for it) does not take part in the layout.
export interface LayoutEdge {
  from: number;
  target: string;
  kind: EdgeKind;
}

export interface LayoutRegion {
  members: string[];
}

export interface LayoutScope {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  regions: LayoutRegion[];
}

// Every node's rect, in the scope's node order: its own `pos` where it has one.
export function placeNodes(scope: LayoutScope): Rect[] {
  if (scope.nodes.every((node) => node.pos)) return scope.nodes.map((node) => node.pos!);
  if (scope.nodes.every((node) => !node.pos)) return layOutLayered(layeredGraphOf(scope), 'LR', LAYOUT_ORIGIN);
  return placeOnGridBelow(scope);
}

// A name declared twice resolves to its last declaration, as the canvas's name lookup does.
function indicesByName(nodes: LayoutNode[]): Map<string, number> {
  return new Map(nodes.map((node, index) => [node.name, index]));
}

function layeredGraphOf(scope: LayoutScope): LayeredGraph {
  const indexOf = indicesByName(scope.nodes);
  return {
    nodes: scope.nodes.map((node) => ({ title: node.name, description: node.description, entrypoint: node.entrypoint })),
    edges: scope.edges.flatMap((edge) => {
      const to = indexOf.get(edge.target);
      return to === undefined ? [] : [{ from: edge.from, to, kind: edge.kind }];
    }),
    regions: scope.regions.map((region) => region.members.flatMap((member) => indexOf.get(member) ?? [])),
  };
}

function placeOnGridBelow(scope: LayoutScope): Rect[] {
  const depths = computeFlowDepths(scope);
  const startY = bottomOfPlacedNodes(scope.nodes) + GAP_BELOW_PLACED_NODES;
  const rowsUsedPerColumn = new Map<number, number>();
  return scope.nodes.map((node, index) => {
    if (node.pos) return node.pos;
    const column = depths.get(index) ?? 0;
    const row = rowsUsedPerColumn.get(column) ?? 0;
    rowsUsedPerColumn.set(column, row + 1);
    return {
      x: LAYOUT_ORIGIN.x + column * LAYOUT_COLUMN_WIDTH,
      y: startY + row * LAYOUT_ROW_HEIGHT,
      w: DEFAULT_NODE_SIZE.w,
      h: DEFAULT_NODE_SIZE.h,
    };
  });
}

function bottomOfPlacedNodes(nodes: LayoutNode[]): number {
  return Math.max(...nodes.flatMap((node) => (node.pos ? [node.pos.y + node.pos.h] : [])));
}

// Column of the longest path of flow edges ending at each node; a node with no incoming flow
// edges anchors column 0. Error edges do not advance the flow.
function computeFlowDepths(scope: LayoutScope): Map<number, number> {
  const indexOf = indicesByName(scope.nodes);
  const outgoing = scope.nodes.map(() => [] as number[]);
  const withIncoming = new Set<number>();
  for (const edge of scope.edges) {
    const target = indexOf.get(edge.target);
    if (edge.kind !== 'flow' || target === undefined) continue;
    outgoing[edge.from].push(target);
    withIncoming.add(target);
  }

  const depths = new Map<number, number>();
  const queue = [...scope.nodes.keys()]
    .filter((index) => !withIncoming.has(index))
    .map((index) => ({ index, depth: 0 }));

  while (queue.length > 0) {
    const { index, depth } = queue.shift()!;
    if (depths.has(index)) continue;
    depths.set(index, depth);
    for (const target of outgoing[index]) queue.push({ index: target, depth: depth + 1 });
  }
  return depths;
}
