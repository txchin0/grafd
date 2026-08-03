// Where a node with no authored `pos` stands on the canvas: the editor's auto-layout grid,
// shared so the linter places the same nodes the same way and the two cannot drift.
//
// The canvas never persists these positions — it assigns them to the in-memory document, which
// the save path writes back — so a file the editor has touched has no empty positions left. A
// file that has not (one an agent just wrote) is judged by the grid it will get on first open.

import type { Rect } from './flow-format.js';

export const DEFAULT_NODE_SIZE = { w: 200, h: 88 };

const LAYOUT_COLUMN_WIDTH = 280;
const LAYOUT_ROW_HEIGHT = 140;
const LAYOUT_ORIGIN = { x: 80, y: 80 };

/** The parts of a model node and edge that placement reads; the flow-doc types satisfy these. */
export interface LayoutNode {
  name: string;
  pos: Rect | null;
}

export interface LayoutEdge {
  from: LayoutNode;
  spec: { target: string };
  kind: string;
}

export function autoLayout(nodes: LayoutNode[], edges: LayoutEdge[]): void {
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

function bottomOfPlacedNodes(nodes: LayoutNode[]): number | null {
  const placed = nodes.filter((node) => node.pos);
  if (placed.length === 0) return null;
  return Math.max(...placed.map((node) => node.pos!.y + node.pos!.h)) + 90;
}

// Column of the longest path of flow edges ending at each node; a node with no incoming flow
// edges anchors column 0. Error edges (`kind: 'error'`) do not advance the flow.
function computeFlowDepths(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, number> {
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
