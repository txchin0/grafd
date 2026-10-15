// Where a node with no authored `pos` stands on the canvas, shared so the linter places the same
// nodes the same way the editor does and the two cannot drift.
//
// A graph with no positions at all — one an agent just wrote — is laid out whole as a layered
// drawing (layered-layout.ts). Nodes added to a graph that is already laid out go beside the
// placed nodes they connect to, and nothing placed ever moves (anchored-placement.ts).
//
// The canvas never persists these positions — it assigns them to the in-memory document, which
// the save path writes back — so a file the editor has touched has no empty positions left. A
// file that has not is judged by the layout it will get on first open.

import { flowDirectionOf, placeAroundPinned, type PinnedGraph } from './anchored-placement.js';
import type { EdgeKind } from './canvas-edge-style.js';
import type { Rect } from './flow-format.js';
import { layOutLayered, type LayeredGraph, type LayoutDirection } from './layered-layout.js';
import { DEFAULT_NODE_SIZE } from './node-size-estimate.js';
import { snapToCanvasGrid } from './rect-math.js';

export { DEFAULT_NODE_SIZE };

const LAYOUT_ORIGIN = { x: 80, y: 80 };

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
  // The area the region's `context:` block reserves with its own `pos`.
  pos: Rect | null;
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
  return placeAroundPinned(pinnedGraphOf(scope));
}

// Every node laid out afresh, whatever it had: a layered drawing flowing the way the scope already
// does, its top-left corner where the scope's was, so the graph tidies up in place rather than
// jumping. Arranging an arranged scope changes nothing: a scope already laid out in either
// direction keeps it, since the direction guessed from its edges can come out the other way — a
// graph whose regions stack bands has edges running down between them however it flows.
export function arrangeScope(scope: LayoutScope): Rect[] {
  const placed = scope.nodes.flatMap((node) => (node.pos ? [node.pos] : []));
  const origin = placed.length === 0
    ? LAYOUT_ORIGIN
    : { x: snapToCanvasGrid(Math.min(...placed.map((rect) => rect.x))), y: snapToCanvasGrid(Math.min(...placed.map((rect) => rect.y))) };
  const graph = layeredGraphOf(scope);
  const guessed = flowDirectionOf(pinnedGraphOf(scope));
  const directions: LayoutDirection[] = guessed === 'LR' ? ['LR', 'TB'] : ['TB', 'LR'];
  const layouts = directions.map((direction) => layOutLayered(graph, direction, origin));
  return layouts.find((rects) => rects.every((rect, index) => sameRect(rect, scope.nodes[index].pos))) ?? layouts[0];
}

function sameRect(rect: Rect, other: Rect | null): boolean {
  return other !== null && rect.x === other.x && rect.y === other.y && rect.w === other.w && rect.h === other.h;
}

// The chosen nodes, by index, placed again around all the others, which stay where they are.
export function arrangeSelected(scope: LayoutScope, chosen: Set<number>): Rect[] {
  if (chosen.size === scope.nodes.length) return arrangeScope(scope);
  return placeNodes({
    ...scope,
    nodes: scope.nodes.map((node, index) => (chosen.has(index) ? { ...node, pos: null } : node)),
  });
}

function pinnedGraphOf(scope: LayoutScope): PinnedGraph {
  return {
    ...layeredGraphOf(scope),
    pins: scope.nodes.map((node) => node.pos),
    regionAreas: scope.regions.map((region) => region.pos),
  };
}

// A name declared twice resolves to its last declaration, as the canvas's name lookup does.
function layeredGraphOf(scope: LayoutScope): LayeredGraph {
  const indexOf = new Map(scope.nodes.map((node, index) => [node.name, index]));
  return {
    nodes: scope.nodes.map((node) => ({ title: node.name, description: node.description, entrypoint: node.entrypoint })),
    edges: scope.edges.flatMap((edge) => {
      const to = indexOf.get(edge.target);
      return to === undefined ? [] : [{ from: edge.from, to, kind: edge.kind }];
    }),
    regions: scope.regions.map((region) => region.members.flatMap((member) => indexOf.get(member) ?? [])),
  };
}
