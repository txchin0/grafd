// Where nodes with no `pos` go in a graph that is already laid out: beside the placed nodes they
// connect to, in the direction the graph already flows, without moving anything that has a place.
// This is what an agent adding to an existing diagram gets, so it must read as if the new nodes had
// been there all along.
//
// New nodes connected to one another are placed together, as one block laid out like a graph of
// its own (layered-layout.ts). The block goes where its edges to placed nodes want it — a successor
// a rank after the node it follows, level with it — and if that spot is taken it slides across the
// flow, a snap step at a time, to the nearest place that is clear of every node and that neither
// puts a new node inside a region it is not a member of nor grows a region over a node outside it.
// Only if no such place exists does it settle for the nearest one clear of nodes. New nodes joined
// to nothing placed are laid out together below everything.

import type { Rect } from './flow-format.js';
import { NODE_GAP } from './layered-coordinates.js';
import { layOutLayered, rankGapFor, type LayeredEdge, type LayeredGraph, type LayoutDirection } from './layered-layout.js';
import { CANVAS_SNAP, padRect, rectCenter, regionRectFrom, snapToCanvasGrid } from './rect-math.js';

export interface PinnedGraph extends LayeredGraph {
  // Each node's authored rect, or null for a node still to be placed.
  pins: (Rect | null)[];
  // The area each region reserves (its `context:` block's own `pos`), parallel to `regions`.
  regionAreas: (Rect | null)[];
}

const GAP_BELOW_PLACED_CONTENT = 90;
// How far a block slides across the flow, each way, looking for a spot that keeps regions honest
// before it settles for one that is only clear of nodes. Far enough to clear any real diagram.
const MAX_SLIDE_STEPS = 600;

interface Axes {
  alongStart(rect: Rect): number;
  alongSize(rect: Rect): number;
  acrossCentre(rect: Rect): number;
  offset(along: number, across: number): { x: number; y: number };
}

const AXES: Record<LayoutDirection, Axes> = {
  LR: {
    alongStart: (rect) => rect.x,
    alongSize: (rect) => rect.w,
    acrossCentre: (rect) => rectCenter(rect).y,
    offset: (along, across) => ({ x: along, y: across }),
  },
  TB: {
    alongStart: (rect) => rect.y,
    alongSize: (rect) => rect.h,
    acrossCentre: (rect) => rectCenter(rect).x,
    offset: (along, across) => ({ x: across, y: along }),
  },
};

interface Offset {
  x: number;
  y: number;
}

export function placeAroundPinned(graph: PinnedGraph): Rect[] {
  const direction = flowDirectionOf(graph);
  const placed = [...graph.pins];
  const detached: number[] = [];

  for (const component of membersFirst(graph, unplacedComponents(graph))) {
    const anchoringEdges = graph.edges.filter((edge) => joinsToPinned(edge, component, graph.pins));
    if (anchoringEdges.length === 0) {
      detached.push(...component);
      continue;
    }
    const block = layOutLayered(subgraphOf(graph, component), direction, { x: 0, y: 0 });
    const blockIndexOf = new Map(component.map((node, index) => [node, index]));
    const ideal = idealOffset(anchoringEdges, blockIndexOf, block, graph.pins, direction);
    const offset = nearestFreeOffset(graph, placed, component, block, ideal, direction);
    component.forEach((node, index) => {
      placed[node] = translated(block[index], offset);
    });
  }

  if (detached.length > 0) placeBelowEverything(graph, placed, detached, direction);
  return placed.map((rect) => rect!);
}

// The direction the placed part of the graph already flows in: whichever way its flow edges run
// further, measured between the centres of the nodes they join.
export function flowDirectionOf(graph: PinnedGraph): LayoutDirection {
  let rightward = 0;
  let downward = 0;
  for (const edge of graph.edges) {
    const from = graph.pins[edge.from];
    const to = graph.pins[edge.to];
    if (edge.kind !== 'flow' || !from || !to) continue;
    rightward += rectCenter(to).x - rectCenter(from).x;
    downward += rectCenter(to).y - rectCenter(from).y;
  }
  return downward > rightward ? 'TB' : 'LR';
}

// Unplaced nodes grouped by the edges between them, each group in file order, groups in the order
// their first node appears.
function unplacedComponents(graph: PinnedGraph): number[][] {
  const groupOf = new Map<number, number[]>();
  const unplaced = [...graph.pins.keys()].filter((node) => !graph.pins[node]);
  const neighbours = new Map(unplaced.map((node) => [node, [] as number[]]));
  for (const edge of graph.edges) {
    if (!neighbours.has(edge.from) || !neighbours.has(edge.to)) continue;
    neighbours.get(edge.from)!.push(edge.to);
    neighbours.get(edge.to)!.push(edge.from);
  }

  const components: number[][] = [];
  for (const start of unplaced) {
    if (groupOf.has(start)) continue;
    const component: number[] = [];
    const frontier = [start];
    groupOf.set(start, component);
    while (frontier.length > 0) {
      const node = frontier.pop()!;
      component.push(node);
      for (const neighbour of neighbours.get(node)!) {
        if (groupOf.has(neighbour)) continue;
        groupOf.set(neighbour, component);
        frontier.push(neighbour);
      }
    }
    components.push(component.sort((first, second) => first - second));
  }
  return components;
}

// A new region member can only go where its region can grow, while a node outside every region
// can go almost anywhere, so members choose their spots first.
function membersFirst(graph: PinnedGraph, components: number[][]): number[][] {
  const members = new Set(graph.regions.flat());
  const holdsMember = (component: number[]): boolean => component.some((node) => members.has(node));
  return [...components.filter(holdsMember), ...components.filter((component) => !holdsMember(component))];
}

function joinsToPinned(edge: { from: number; to: number }, component: number[], pins: (Rect | null)[]): boolean {
  const fromInside = component.includes(edge.from);
  const toInside = component.includes(edge.to);
  return (fromInside && pins[edge.to] !== null) || (toInside && pins[edge.from] !== null);
}

function subgraphOf(graph: LayeredGraph, nodes: number[]): LayeredGraph {
  const indexOf = new Map(nodes.map((node, index) => [node, index]));
  return {
    nodes: nodes.map((node) => graph.nodes[node]),
    edges: graph.edges
      .filter((edge) => indexOf.has(edge.from) && indexOf.has(edge.to))
      .map((edge) => ({ from: indexOf.get(edge.from)!, to: indexOf.get(edge.to)!, kind: edge.kind, label: edge.label })),
    regions: graph.regions.map((members) => members.flatMap((member) => indexOf.get(member) ?? [])),
  };
}

// Each edge to a placed node asks for the block at one offset: the new node a rank after the node
// it follows (or before the node it leads to), level with it across the flow. Along the flow the
// nodes it follows decide, so it lands in the column after them even when its successor stands in
// that very column — the column grid is what a reader follows, and there is no room between two
// neighbouring columns. Across the flow every edge has its say, and the block takes the median.
function idealOffset(
  anchoringEdges: LayeredEdge[],
  blockIndexOf: Map<number, number>,
  block: Rect[],
  pins: (Rect | null)[],
  direction: LayoutDirection,
): Offset {
  const axes = AXES[direction];
  const gapFor = (edge: LayeredEdge): number => rankGapFor([edge.label], direction);
  const afterPredecessors: number[] = [];
  const beforeSuccessors: number[] = [];
  const acrossWishes: number[] = [];
  for (const edge of anchoringEdges) {
    const followsAnchor = blockIndexOf.has(edge.to);
    const member = block[blockIndexOf.get(followsAnchor ? edge.to : edge.from)!];
    const anchor = pins[followsAnchor ? edge.from : edge.to]!;
    if (followsAnchor) {
      afterPredecessors.push(axes.alongStart(anchor) + axes.alongSize(anchor) + gapFor(edge) - axes.alongStart(member));
    } else {
      beforeSuccessors.push(axes.alongStart(anchor) - gapFor(edge) - axes.alongSize(member) - axes.alongStart(member));
    }
    acrossWishes.push(axes.acrossCentre(anchor) - axes.acrossCentre(member));
  }
  const along = medianOf(afterPredecessors.length > 0 ? afterPredecessors : beforeSuccessors);
  const offset = axes.offset(along, medianOf(acrossWishes));
  return { x: snapToCanvasGrid(offset.x), y: snapToCanvasGrid(offset.y) };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nearestFreeOffset(
  graph: PinnedGraph,
  placed: (Rect | null)[],
  component: number[],
  block: Rect[],
  ideal: Offset,
  direction: LayoutDirection,
): Offset {
  const others = placed.flatMap((rect, node) => (rect ? [{ node, rect }] : []));
  const slide = (step: number): Offset => {
    const across = AXES[direction].offset(0, step * CANVAS_SNAP);
    return { x: ideal.x + across.x, y: ideal.y + across.y };
  };
  const clearOfNodes = (offset: Offset): boolean =>
    block.every((rect) => others.every((other) => !rectsOverlap(spaced(translated(rect, offset)), spaced(other.rect))));
  const regionsAfter = (offset: Offset): RegionChange => regionChange(graph, placed, component, block.map((rect) => translated(rect, offset)));
  const strictly = (offset: Offset): boolean => {
    const change = regionsAfter(offset);
    return keepsOutsidersOut(change) && keepsRegionsApart(change);
  };
  const honestly = (offset: Offset): boolean => keepsOutsidersOut(regionsAfter(offset));

  for (const acceptable of [strictly, honestly]) {
    for (let distance = 0; distance <= MAX_SLIDE_STEPS; distance++) {
      for (const step of distance === 0 ? [0] : [distance, -distance]) {
        if (clearOfNodes(slide(step)) && acceptable(slide(step))) return slide(step);
      }
    }
  }
  for (let distance = 0; ; distance++) {
    for (const step of distance === 0 ? [0] : [distance, -distance]) {
      if (clearOfNodes(slide(step))) return slide(step);
    }
  }
}

// Half the gap on each side, so two spaced rects that do not overlap stand a full gap apart.
function spaced(rect: Rect): Rect {
  return padRect(rect, NODE_GAP / 2);
}

interface RegionChange {
  graph: PinnedGraph;
  placed: (Rect | null)[];
  withBlock: (Rect | null)[];
  before: (Rect | null)[];
  after: (Rect | null)[];
}

function regionChange(graph: PinnedGraph, placed: (Rect | null)[], component: number[], blockRects: Rect[]): RegionChange {
  const withBlock = [...placed];
  component.forEach((node, index) => {
    withBlock[node] = blockRects[index];
  });
  const regionRects = (rects: (Rect | null)[]): (Rect | null)[] =>
    graph.regions.map((members, region) => regionRectFrom(graph.regionAreas[region], rectsOf(members, rects)));
  return { graph, placed, withBlock, before: regionRects(placed), after: regionRects(withBlock) };
}

// No new node in a region it is not a member of, and no region grown over a node outside it that
// it did not already reach.
function keepsOutsidersOut({ graph, placed, withBlock, before, after }: RegionChange): boolean {
  return graph.regions.every((members, region) => {
    const regionAfter = after[region];
    if (!regionAfter) return true;
    const memberSet = new Set(members);
    return withBlock.every((rect, node) => {
      if (!rect || memberSet.has(node) || !rectsOverlap(regionAfter, rect)) return true;
      const regionBefore = before[region];
      return placed[node] !== null && regionBefore !== null && rectsOverlap(regionBefore, rect);
    });
  });
}

// No region grown into another region it did not already reach, which would cross their frames.
function keepsRegionsApart({ before, after }: RegionChange): boolean {
  return after.every((regionAfter, region) => {
    if (!regionAfter) return true;
    return after.every((otherAfter, other) => {
      if (other === region || !otherAfter || !rectsOverlap(regionAfter, otherAfter)) return true;
      const regionBefore = before[region];
      const otherBefore = before[other];
      return regionBefore !== null && otherBefore !== null && rectsOverlap(regionBefore, otherBefore);
    });
  });
}

function rectsOf(nodes: number[], rects: (Rect | null)[]): Rect[] {
  return nodes.flatMap((node) => (rects[node] ? [rects[node]!] : []));
}

function placeBelowEverything(
  graph: PinnedGraph,
  placed: (Rect | null)[],
  detached: number[],
  direction: LayoutDirection,
): void {
  const occupied = [...placed.filter((rect): rect is Rect => rect !== null), ...graph.regionAreas.filter((area): area is Rect => area !== null)];
  const origin = {
    x: snapToCanvasGrid(Math.min(...occupied.map((rect) => rect.x))),
    y: snapToCanvasGrid(Math.max(...occupied.map((rect) => rect.y + rect.h)) + GAP_BELOW_PLACED_CONTENT),
  };
  const rects = layOutLayered(subgraphOf(graph, detached), direction, origin);
  detached.forEach((node, index) => {
    placed[node] = rects[index];
  });
}

function translated(rect: Rect, offset: Offset): Rect {
  return { x: rect.x + offset.x, y: rect.y + offset.y, w: rect.w, h: rect.h };
}

function rectsOverlap(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.w && second.x < first.x + first.w
    && first.y < second.y + second.h && second.y < first.y + first.h;
}
