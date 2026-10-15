// A whole graph laid out from nothing, as a layered drawing: ranks follow the flow, the order down
// each rank crosses as few edges as it can, the longest path through the graph runs straight, and
// each region's members are kept together and apart from everything that is not a member. Pure and
// deterministic — the same graph is always placed the same way — because the editor, the linter and
// the command line each lay a file out for themselves and must agree on where every node stands.

import { shownEdgeLabel, type EdgeKind } from './canvas-edge-style.js';
import type { Rect } from './flow-format.js';
import { assignCrossCoordinates } from './layered-coordinates.js';
import { orderLayers, properLayering, type LayeringEdge } from './layered-ordering.js';
import { rankNodes, type RankedGraph, type WeightedEdge } from './layered-ranking.js';
import { estimateEdgeLabelWidth, estimateNodeSize, type NodeSize } from './node-size-estimate.js';
import { EDGE_LABEL_HEIGHT } from './node-text-metrics.js';
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
  label: string | null;
}

export interface LayeredGraph {
  nodes: LayeredNode[];
  edges: LayeredEdge[];
  // Each region's members, as node indices.
  regions: number[][];
}

export const RANK_GAP = 96;
// Room left on either side of an edge's label between two ranks, so the label never touches a node.
const LABEL_CLEARANCE = 24;
const GAP_STEP = 8;
const FLOW_EDGE_WEIGHT = 2;
// An error edge still places its handler after the node that fails into it, but the flow matters
// more wherever the two disagree.
const ERROR_EDGE_WEIGHT = 1;
const SPINE_WEIGHT_FACTOR = 4;

interface Axes {
  alongRank(size: NodeSize): number;
  acrossRank(size: NodeSize): number;
  // How much of the gap between two ranks a label takes: its pill is always drawn level, so its
  // width runs along the flow in a left-to-right layout and its height does in a top-to-bottom one.
  labelAlongRank(label: string): number;
  rectFrom(along: number, across: number, alongSize: number, acrossSize: number): Rect;
  pointFrom(along: number, across: number): Point;
}

const AXES: Record<LayoutDirection, Axes> = {
  LR: {
    alongRank: (size) => size.w,
    acrossRank: (size) => size.h,
    labelAlongRank: (label) => estimateEdgeLabelWidth(label),
    rectFrom: (along, across, alongSize, acrossSize) => ({ x: along, y: across, w: alongSize, h: acrossSize }),
    pointFrom: (along, across) => ({ x: along, y: across }),
  },
  TB: {
    alongRank: (size) => size.h,
    acrossRank: (size) => size.w,
    labelAlongRank: () => EDGE_LABEL_HEIGHT,
    rectFrom: (along, across, alongSize, acrossSize) => ({ x: across, y: along, w: acrossSize, h: alongSize }),
    pointFrom: (along, across) => ({ x: across, y: along }),
  },
};

export interface LayeredDrawing {
  // One per node, in the graph's node order.
  rects: Rect[];
  // One per edge, in the graph's edge order: the point a long edge should bend through to run along
  // the lane the layout kept clear for it, or null for an edge drawn straight. An edge is only ever
  // drawn as one curve through one point, so it bends through the middle of its lane.
  bendPoints: (Point | null)[];
}

// One rect per node, in the graph's node order, with the drawing's top-left corner at `origin`.
export function layOutLayered(graph: LayeredGraph, direction: LayoutDirection, origin: Point): Rect[] {
  return layOutLayeredDrawing(graph, direction, origin).rects;
}

export function layOutLayeredDrawing(graph: LayeredGraph, direction: LayoutDirection, origin: Point): LayeredDrawing {
  if (graph.nodes.length === 0) return { rects: [], bendPoints: graph.edges.map(() => null) };
  const axes = AXES[direction];
  const sizes = graph.nodes.map((node) => estimateNodeSize(node.title, node.description));

  const { weighted, graphEdgeOf } = weightedEdgesOf(graph);
  const ranked = rankNodes(graph.nodes.length, weighted, visitOrderOf(graph));
  const bands = bandsOf(graph);
  const layering = properLayering(ranked.ranks, withSpineStraightened(ranked), bands);
  const layers = orderLayers(layering);
  const crossCentres = assignCrossCoordinates(layering, layers, sizes.map(axes.acrossRank));
  const rankExtents = extentsPerRank(ranked.ranks, sizes.map(axes.alongRank), layering.rankCount);
  const rankStarts = startsOfRanks(rankExtents, gapsAfterRanks(graph, ranked.ranks, layering.rankCount, direction));

  const rects = graph.nodes.map((_, node) => {
    const rank = ranked.ranks[node];
    const acrossSize = axes.acrossRank(sizes[node]);
    return axes.rectFrom(rankStarts[rank], crossCentres[node] - acrossSize / 2, rankExtents[rank], acrossSize);
  });
  const pointAt = (item: number): Point => {
    const rank = layering.items[item].rank;
    return axes.pointFrom(rankStarts[rank] + rankExtents[rank] / 2, crossCentres[item]);
  };
  const lanePoints = graph.edges.map(() => null as Point | null);
  const laneTaken = new Set<number>();
  graphEdgeOf.forEach((graphEdge, weightedIndex) => {
    const rankedIndex = ranked.rankedEdgeOf[weightedIndex];
    const passage = layering.passages[rankedIndex];
    const { from, to } = graph.edges[graphEdge];
    // Edges merged into one lane would bend through the same point and lie on top of each other;
    // only the first takes the lane, and the rest keep to the bundle the canvas fans out. An edge
    // between two bands has its lane in the band it leaves, so bending through it would drag the
    // curve along that band before it dives across: it runs straight across the gap instead.
    if (passage.length === 0 || laneTaken.has(rankedIndex) || bands[from] !== bands[to]) return;
    laneTaken.add(rankedIndex);
    lanePoints[graphEdge] = middleOf(passage.map(pointAt));
  });

  const offset = offsetPlacing(origin, rects);
  return {
    rects: rects.map((rect) => ({
      x: origin.x + snapToCanvasGrid(rect.x + offset.x - origin.x),
      y: origin.y + snapToCanvasGrid(rect.y + offset.y - origin.y),
      w: rect.w,
      h: rect.h,
    })),
    bendPoints: lanePoints.map((point) => (point ? { x: point.x + offset.x, y: point.y + offset.y } : null)),
  };
}

// The gap after each rank: wide enough for every label on an edge joining it to the next.
function gapsAfterRanks(graph: LayeredGraph, ranks: number[], rankCount: number, direction: LayoutDirection): number[] {
  const labelsAfter = Array.from({ length: rankCount }, () => [] as string[]);
  for (const edge of graph.edges) {
    const label = shownEdgeLabel(edge.label, edge.kind);
    if (!label || Math.abs(ranks[edge.to] - ranks[edge.from]) !== 1) continue;
    labelsAfter[Math.min(ranks[edge.from], ranks[edge.to])].push(label);
  }
  return labelsAfter.map((labels) => rankGapFor(labels, direction));
}

// The gap between two neighbouring ranks joined by edges carrying these labels.
export function rankGapFor(labels: (string | null)[], direction: LayoutDirection): number {
  const widest = Math.max(0, ...labels.flatMap((label) => (label ? [AXES[direction].labelAlongRank(label)] : [])));
  return Math.max(RANK_GAP, Math.ceil((widest + 2 * LABEL_CLEARANCE) / GAP_STEP) * GAP_STEP);
}

function middleOf(points: Point[]): Point {
  const middle = (points.length - 1) / 2;
  const before = points[Math.floor(middle)];
  const after = points[Math.ceil(middle)];
  return { x: (before.x + after.x) / 2, y: (before.y + after.y) / 2 };
}

// Self-loops never take part in the layout; `graphEdgeOf` says which graph edge each weighted
// edge came from.
function weightedEdgesOf(graph: LayeredGraph): { weighted: WeightedEdge[]; graphEdgeOf: number[] } {
  const graphEdgeOf = [...graph.edges.keys()].filter((index) => graph.edges[index].from !== graph.edges[index].to);
  return {
    weighted: graphEdgeOf.map((index) => {
      const edge = graph.edges[index];
      return { from: edge.from, to: edge.to, weight: edge.kind === 'error' ? ERROR_EDGE_WEIGHT : FLOW_EDGE_WEIGHT };
    }),
    graphEdgeOf,
  };
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

function startsOfRanks(extents: number[], gapsAfter: number[]): number[] {
  const starts: number[] = [];
  let start = 0;
  extents.forEach((extent, rank) => {
    starts.push(start);
    start += extent + gapsAfter[rank];
  });
  return starts;
}

// What moves the drawing's top-left corner onto `origin`.
function offsetPlacing(origin: Point, rects: Rect[]): Point {
  return {
    x: origin.x - Math.min(...rects.map((rect) => rect.x)),
    y: origin.y - Math.min(...rects.map((rect) => rect.y)),
  };
}
