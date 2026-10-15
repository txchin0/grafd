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
import { layOutLayered, layOutLayeredDrawing, type LayeredGraph, type LayoutDirection } from './layered-layout.js';
import { DEFAULT_NODE_SIZE } from './node-size-estimate.js';
import { snapToCanvasGrid, type Point } from './rect-math.js';

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
  label: string | null;
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

export interface Arrangement {
  // Every node's rect, in the scope's node order.
  rects: Rect[];
  // By index into the scope's edges, the edges whose bend the arrangement settles: the point it
  // bends through, or null to draw it straight. An edge left out keeps whatever bend it had — a
  // self-loop, an edge to a name that matches no node, or one the arrangement did not move.
  bendPoints: Map<number, Point | null>;
}

// Every node laid out afresh, whatever it had: a layered drawing flowing the way the scope already
// does, its top-left corner where the scope's was, so the graph tidies up in place rather than
// jumping. Every edge it lays out gets the bend that runs it along its lane, or none. Arranging an
// arranged scope changes nothing: a scope already laid out in either direction keeps it, since the
// direction guessed from its edges can come out the other way — a graph whose regions stack bands
// has edges running down between them however it flows.
export function arrangeScope(scope: LayoutScope): Arrangement {
  const placed = scope.nodes.flatMap((node) => (node.pos ? [node.pos] : []));
  const origin = placed.length === 0
    ? LAYOUT_ORIGIN
    : { x: snapToCanvasGrid(Math.min(...placed.map((rect) => rect.x))), y: snapToCanvasGrid(Math.min(...placed.map((rect) => rect.y))) };
  const { graph, scopeEdgeOf } = layeredGraphWithEdgesOf(scope);
  const guessed = flowDirectionOf(pinnedGraphOf(scope));
  const directions: LayoutDirection[] = guessed === 'LR' ? ['LR', 'TB'] : ['TB', 'LR'];
  const drawings = directions.map((direction) => layOutLayeredDrawing(graph, direction, origin));
  const drawing = drawings.find(({ rects }) => rects.every((rect, index) => sameRect(rect, scope.nodes[index].pos))) ?? drawings[0];

  const bendPoints = new Map<number, Point | null>();
  graph.edges.forEach((edge, index) => {
    if (edge.from !== edge.to) bendPoints.set(scopeEdgeOf[index], drawing.bendPoints[index]);
  });
  return { rects: drawing.rects, bendPoints };
}

function sameRect(rect: Rect, other: Rect | null): boolean {
  return other !== null && rect.x === other.x && rect.y === other.y && rect.w === other.w && rect.h === other.h;
}

// The chosen nodes, by index, placed again around all the others, which stay where they are. An
// edge with a chosen end runs straight: whatever bend it had was shaped for where that end was.
export function arrangeSelected(scope: LayoutScope, chosen: Set<number>): Arrangement {
  if (chosen.size === scope.nodes.length) return arrangeScope(scope);
  const rects = placeNodes({
    ...scope,
    nodes: scope.nodes.map((node, index) => (chosen.has(index) ? { ...node, pos: null } : node)),
  });
  const { graph, scopeEdgeOf } = layeredGraphWithEdgesOf(scope);
  const bendPoints = new Map<number, Point | null>();
  graph.edges.forEach((edge, index) => {
    const touchesChosen = chosen.has(edge.from) || chosen.has(edge.to);
    if (edge.from !== edge.to && touchesChosen) bendPoints.set(scopeEdgeOf[index], null);
  });
  return { rects, bendPoints };
}

function pinnedGraphOf(scope: LayoutScope): PinnedGraph {
  return {
    ...layeredGraphOf(scope),
    pins: scope.nodes.map((node) => node.pos),
    regionAreas: scope.regions.map((region) => region.pos),
  };
}

function layeredGraphOf(scope: LayoutScope): LayeredGraph {
  return layeredGraphWithEdgesOf(scope).graph;
}

// A name declared twice resolves to its last declaration, as the canvas's name lookup does. An edge
// to a name that matches none is left out; `scopeEdgeOf` says which scope edge each graph edge is.
function layeredGraphWithEdgesOf(scope: LayoutScope): { graph: LayeredGraph; scopeEdgeOf: number[] } {
  const indexOf = new Map(scope.nodes.map((node, index) => [node.name, index]));
  const scopeEdgeOf = [...scope.edges.keys()].filter((index) => indexOf.has(scope.edges[index].target));
  return {
    graph: {
      nodes: scope.nodes.map((node) => ({ title: node.name, description: node.description, entrypoint: node.entrypoint })),
      edges: scopeEdgeOf.map((index) => {
        const edge = scope.edges[index];
        return { from: edge.from, to: indexOf.get(edge.target)!, kind: edge.kind, label: edge.label };
      }),
      regions: scope.regions.map((region) => region.members.flatMap((member) => indexOf.get(member) ?? [])),
    },
    scopeEdgeOf,
  };
}
