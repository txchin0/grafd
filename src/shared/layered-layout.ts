// A whole graph laid out from nothing, as a layered drawing: ranks follow the flow, the order down
// each rank crosses as few edges as it can, the longest path through the graph runs straight, and
// each region's members are kept together and apart from everything that is not a member. Pure and
// deterministic — the same graph is always placed the same way — because the editor, the linter and
// the command line each lay a file out for themselves and must agree on where every node stands.

import type { EdgeKind } from './canvas-edge-style.js';
import type { Rect } from './flow-format.js';
import { assignCrossCoordinates } from './layered-coordinates.js';
import { orderLayers, properLayering, type LayeringEdge } from './layered-ordering.js';
import { rankNodes, type RankedGraph, type WeightedEdge } from './layered-ranking.js';
import { estimateNodeSize, type NodeSize } from './node-size-estimate.js';
import { snapToCanvasGrid, type Point } from './rect-math.js';

export type LayoutDirection = 'LR' | 'TB';

export interface LayeredNode {
  title: string;
  description: string | null;
  entrypoint: boolean;
}

export interface LayeredEdge {
  from: number;
  to: number;
  kind: EdgeKind;
}

export interface LayeredGraph {
  nodes: LayeredNode[];
  edges: LayeredEdge[];
  // Each region's members, as node indices.
  regions: number[][];
}

export const RANK_GAP = 96;
const FLOW_EDGE_WEIGHT = 2;
// An error edge still places its handler after the node that fails into it, but the flow matters
// more wherever the two disagree.
const ERROR_EDGE_WEIGHT = 1;
const SPINE_WEIGHT_FACTOR = 4;

interface Axes {
  alongRank(size: NodeSize): number;
  acrossRank(size: NodeSize): number;
  rectFrom(along: number, across: number, alongSize: number, acrossSize: number): Rect;
}

const AXES: Record<LayoutDirection, Axes> = {
  LR: {
    alongRank: (size) => size.w,
    acrossRank: (size) => size.h,
    rectFrom: (along, across, alongSize, acrossSize) => ({ x: along, y: across, w: alongSize, h: acrossSize }),
  },
  TB: {
    alongRank: (size) => size.h,
    acrossRank: (size) => size.w,
    rectFrom: (along, across, alongSize, acrossSize) => ({ x: across, y: along, w: acrossSize, h: alongSize }),
  },
};

// One rect per node, in the graph's node order, with the drawing's top-left corner at `origin`.
export function layOutLayered(graph: LayeredGraph, direction: LayoutDirection, origin: Point): Rect[] {
  if (graph.nodes.length === 0) return [];
  const axes = AXES[direction];
  const sizes = graph.nodes.map((node) => estimateNodeSize(node.title, node.description));

  const ranked = rankNodes(graph.nodes.length, weightedEdgesOf(graph), visitOrderOf(graph));
  const layering = properLayering(ranked.ranks, withSpineStraightened(ranked), bandsOf(graph));
  const layers = orderLayers(layering);
  const crossCentres = assignCrossCoordinates(layering, layers, sizes.map(axes.acrossRank));
  const rankExtents = extentsPerRank(ranked.ranks, sizes.map(axes.alongRank), layering.rankCount);
  const rankStarts = startsOfRanks(rankExtents);

  const rects = graph.nodes.map((_, node) => {
    const rank = ranked.ranks[node];
    const acrossSize = axes.acrossRank(sizes[node]);
    return axes.rectFrom(rankStarts[rank], crossCentres[node] - acrossSize / 2, rankExtents[rank], acrossSize);
  });
  return placedAt(origin, rects);
}

function weightedEdgesOf(graph: LayeredGraph): WeightedEdge[] {
  return graph.edges
    .filter((edge) => edge.from !== edge.to)
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      weight: edge.kind === 'error' ? ERROR_EDGE_WEIGHT : FLOW_EDGE_WEIGHT,
    }));
}

// Where cycles are entered from: the declared entry points, then the nodes nothing leads into.
function visitOrderOf(graph: LayeredGraph): number[] {
  const targets = new Set(graph.edges.filter((edge) => edge.from !== edge.to).map((edge) => edge.to));
  const indices = [...graph.nodes.keys()];
  return [
    ...indices.filter((node) => graph.nodes[node].entrypoint),
    ...indices.filter((node) => !targets.has(node)),
  ];
}

// The spine is what every longest path through the graph runs along; the coordinates draw it as one
// straight line. Where two equally long paths part ways neither is the spine, so a fork with
// matching branches is drawn symmetric rather than straight along whichever came first.
function withSpineStraightened(ranked: RankedGraph): LayeringEdge[] {
  const spine = edgesOnEveryLongestPath(ranked);
  return ranked.edges.map((edge, index) => (spine.has(index)
    ? { ...edge, weight: edge.weight * SPINE_WEIGHT_FACTOR, straight: true }
    : { ...edge, straight: false }));
}

function edgesOnEveryLongestPath(ranked: RankedGraph): Set<number> {
  const downTheRanks = [...ranked.ranks.keys()].sort((first, second) => ranked.ranks[first] - ranked.ranks[second] || first - second);
  const arriving = longestPathsArriving(downTheRanks, ranked.edges, (edge) => edge.from, (edge) => edge.to);
  const leaving = longestPathsArriving([...downTheRanks].reverse(), ranked.edges, (edge) => edge.to, (edge) => edge.from);
  const longest = Math.max(...arriving.lengths);
  const pathCount = sumOf(arriving.counts.filter((_, node) => arriving.lengths[node] === longest));

  const spine = new Set<number>();
  ranked.edges.forEach((edge, index) => {
    const onALongestPath = arriving.lengths[edge.from] + leaving.lengths[edge.to] === longest;
    if (onALongestPath && arriving.counts[edge.from] * leaving.counts[edge.to] === pathCount) spine.add(index);
  });
  return spine;
}

// For each node, how many nodes the longest path ending there has, and how many such paths there
// are. `order` must visit every edge's start before its end.
function longestPathsArriving(
  order: number[],
  edges: WeightedEdge[],
  startOf: (edge: WeightedEdge) => number,
  endOf: (edge: WeightedEdge) => number,
): { lengths: number[]; counts: number[] } {
  const lengths = new Array<number>(order.length).fill(1);
  const counts = new Array<number>(order.length).fill(1);
  const arrivingAt = order.map(() => [] as WeightedEdge[]);
  for (const edge of edges) arrivingAt[endOf(edge)].push(edge);

  for (const node of order) {
    for (const edge of arrivingAt[node]) {
      const start = startOf(edge);
      const length = lengths[start] + 1;
      if (length > lengths[node]) {
        lengths[node] = length;
        counts[node] = counts[start];
      } else if (length === lengths[node]) {
        counts[node] += counts[start];
      }
    }
  }
  return { lengths, counts };
}

function sumOf(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// Nodes listed by exactly the same regions share a band. Bands are ordered by the regions they
// stand for, so the bands of any one region come out next to each other wherever regions overlap
// in a chain: [A], [A, B], [B] keeps both A's and B's bands together.
function bandsOf(graph: LayeredGraph): number[] {
  const memberships = graph.nodes.map(() => [] as number[]);
  graph.regions.forEach((members, region) => {
    for (const member of new Set(members)) memberships[member].push(region);
  });
  const signatures = memberships.map((regions) => regions.join(','));
  const distinct = [...new Map(signatures.map((signature, node) => [signature, memberships[node]])).entries()]
    .sort(([, first], [, second]) => compareRegionLists(first, second))
    .map(([signature]) => signature);
  return signatures.map((signature) => distinct.indexOf(signature));
}

function compareRegionLists(first: number[], second: number[]): number {
  for (let index = 0; index < Math.min(first.length, second.length); index++) {
    if (first[index] !== second[index]) return first[index] - second[index];
  }
  return first.length - second.length;
}

// Every node of a rank is as long along the flow as the longest of them, so ranks have straight
// edges and the gaps between them are even.
function extentsPerRank(ranks: number[], alongSizes: number[], rankCount: number): number[] {
  const extents = new Array<number>(rankCount).fill(0);
  ranks.forEach((rank, node) => {
    extents[rank] = Math.max(extents[rank], alongSizes[node]);
  });
  return extents;
}

function startsOfRanks(extents: number[]): number[] {
  const starts: number[] = [];
  let start = 0;
  for (const extent of extents) {
    starts.push(start);
    start += extent + RANK_GAP;
  }
  return starts;
}

function placedAt(origin: Point, rects: Rect[]): Rect[] {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  return rects.map((rect) => ({
    x: origin.x + snapToCanvasGrid(rect.x - left),
    y: origin.y + snapToCanvasGrid(rect.y - top),
    w: rect.w,
    h: rect.h,
  }));
}
