// The order of things down each rank of a layered drawing, chosen to cross as few edges as it can.
// An edge spanning several ranks is cut into one segment per rank by virtual items standing where
// it passes, so it reserves its own lane and its crossings can be counted rank by rank.
//
// Every item belongs to a band, and bands keep their order in every rank: band 0 above band 1
// everywhere. That is what lets the coordinates keep each region's members apart from the nodes
// that are not its members.

import type { WeightedEdge } from './layered-ranking.js';

export interface LayerItem {
  rank: number;
  band: number;
  // The real node this item is; null for an item standing where an edge passes through a rank.
  node: number | null;
  // For an item where an edge passes, the real nodes at the edge's two ends.
  passing: { from: number; to: number } | null;
}

// Joins two items in neighbouring ranks: `upper` is in the rank above `lower`.
export interface LayerSegment {
  upper: number;
  lower: number;
  weight: number;
  straight: boolean;
}

// An edge the coordinates must draw as one straight line, wherever its ends allow.
export interface LayeringEdge extends WeightedEdge {
  straight: boolean;
}

export interface ProperLayering {
  items: LayerItem[];
  segments: LayerSegment[];
  rankCount: number;
}

export interface Neighbour {
  item: number;
  weight: number;
  straight: boolean;
}

const ORDERING_SWEEPS = 24;
const SWEEPS_WITHOUT_IMPROVEMENT_BEFORE_STOPPING = 6;

// Real nodes keep their indices as items, so item n is node n for every node.
export function properLayering(ranks: number[], edges: LayeringEdge[], bands: number[]): ProperLayering {
  const items: LayerItem[] = ranks.map((rank, node) => ({ rank, band: bands[node], node, passing: null }));
  const segments: LayerSegment[] = [];
  for (const edge of edges) {
    let upper = edge.from;
    for (let rank = ranks[edge.from] + 1; rank < ranks[edge.to]; rank++) {
      items.push({ rank, band: bands[edge.from], node: null, passing: { from: edge.from, to: edge.to } });
      const passing = items.length - 1;
      segments.push({ upper, lower: passing, weight: edge.weight, straight: edge.straight });
      upper = passing;
    }
    segments.push({ upper, lower: edge.to, weight: edge.weight, straight: edge.straight });
  }
  const rankCount = ranks.length > 0 ? Math.max(...ranks) + 1 : 0;
  return { items, segments, rankCount };
}

// Each rank's items, first to last. Deterministic: ties always fall back to the items' indices,
// which follow the order of the file.
export function orderLayers(layering: ProperLayering): number[][] {
  const above = neighboursBy(layering, (segment) => [segment.lower, segment.upper]);
  const below = neighboursBy(layering, (segment) => [segment.upper, segment.lower]);
  const layers = initialLayers(layering, above);

  let best = layers.map((layer) => [...layer]);
  let fewestCrossings = totalCrossings(layering, layers);
  let sweepsWithoutImprovement = 0;
  for (let sweep = 0; sweep < ORDERING_SWEEPS && fewestCrossings > 0; sweep++) {
    const downward = sweep % 2 === 0;
    sweepLayers(layering, layers, downward ? above : below, downward);
    transposeLayers(layering, layers, above, below);
    const crossings = totalCrossings(layering, layers);
    if (crossings < fewestCrossings) {
      fewestCrossings = crossings;
      best = layers.map((layer) => [...layer]);
      sweepsWithoutImprovement = 0;
    } else if (++sweepsWithoutImprovement >= SWEEPS_WITHOUT_IMPROVEMENT_BEFORE_STOPPING) {
      break;
    }
  }
  return best;
}

export function neighboursBy(
  layering: ProperLayering,
  endsOf: (segment: LayerSegment) => [number, number],
): Neighbour[][] {
  const byItem = layering.items.map(() => [] as Neighbour[]);
  for (const segment of layering.segments) {
    const [item, neighbour] = endsOf(segment);
    byItem[item].push({ item: neighbour, weight: segment.weight, straight: segment.straight });
  }
  return byItem;
}

function initialLayers(layering: ProperLayering, above: Neighbour[][]): number[][] {
  const layers = itemsByRank(layering);
  const positions = new Map<number, number>();
  for (const layer of layers) {
    const keys = new Map(layer.map((item) => [item, barycenterOf(above[item], positions) ?? Infinity]));
    sortWithinBands(layer, layering, (item) => keys.get(item)!);
    layer.forEach((item, position) => positions.set(item, position));
  }
  return layers;
}

function itemsByRank(layering: ProperLayering): number[][] {
  const layers = Array.from({ length: layering.rankCount }, () => [] as number[]);
  layering.items.forEach((item, index) => layers[item.rank].push(index));
  return layers;
}

// Reorders every rank by where its neighbours stand in the rank just settled — the one above on a
// downward sweep, below on an upward one. An item with no neighbours there keeps its place.
function sweepLayers(layering: ProperLayering, layers: number[][], toward: Neighbour[][], downward: boolean): void {
  const ranks = [...layers.keys()];
  const sweepOrder = downward ? ranks.slice(1) : ranks.slice(0, -1).reverse();
  for (const rank of sweepOrder) {
    const fixedPositions = positionsIn(layers[downward ? rank - 1 : rank + 1]);
    const layer = layers[rank];
    const keys = new Map(layer.map((item, position) => [item, barycenterOf(toward[item], fixedPositions) ?? position]));
    sortWithinBands(layer, layering, (item) => keys.get(item)!);
  }
}

function sortWithinBands(layer: number[], layering: ProperLayering, keyOf: (item: number) => number): void {
  const currentPositions = positionsIn(layer);
  layer.sort((first, second) =>
    layering.items[first].band - layering.items[second].band
    || keyOf(first) - keyOf(second)
    || currentPositions.get(first)! - currentPositions.get(second)!
    || first - second);
}

function barycenterOf(neighbours: Neighbour[], positions: Map<number, number>): number | null {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const neighbour of neighbours) {
    const position = positions.get(neighbour.item);
    if (position === undefined) continue;
    weightedSum += position * neighbour.weight;
    totalWeight += neighbour.weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

// Swaps neighbouring items of one band wherever that alone crosses fewer edges, until no swap does.
function transposeLayers(
  layering: ProperLayering,
  layers: number[][],
  above: Neighbour[][],
  below: Neighbour[][],
): void {
  let improved = true;
  while (improved) {
    improved = false;
    layers.forEach((layer, rank) => {
      const positionsAbove = positionsIn(layers[rank - 1] ?? []);
      const positionsBelow = positionsIn(layers[rank + 1] ?? []);
      for (let index = 0; index + 1 < layer.length; index++) {
        const first = layer[index];
        const second = layer[index + 1];
        if (layering.items[first].band !== layering.items[second].band) continue;
        const crossingsAsIs = pairCrossings(first, second, above, positionsAbove)
          + pairCrossings(first, second, below, positionsBelow);
        const crossingsSwapped = pairCrossings(second, first, above, positionsAbove)
          + pairCrossings(second, first, below, positionsBelow);
        if (crossingsSwapped >= crossingsAsIs) continue;
        layer[index] = second;
        layer[index + 1] = first;
        improved = true;
      }
    });
  }
}

// The weighted crossings between the edges of `first` and those of `second` toward one
// neighbouring rank, with `first` placed before `second`.
function pairCrossings(
  first: number,
  second: number,
  neighbours: Neighbour[][],
  positions: Map<number, number>,
): number {
  let crossings = 0;
  for (const firstNeighbour of neighbours[first]) {
    for (const secondNeighbour of neighbours[second]) {
      if (positions.get(firstNeighbour.item)! > positions.get(secondNeighbour.item)!) {
        crossings += firstNeighbour.weight * secondNeighbour.weight;
      }
    }
  }
  return crossings;
}

export function totalCrossings(layering: ProperLayering, layers: number[][]): number {
  const positions = new Map<number, number>();
  for (const layer of layers) layer.forEach((item, position) => positions.set(item, position));
  const segmentsByRank = Array.from({ length: layering.rankCount }, () => [] as LayerSegment[]);
  for (const segment of layering.segments) segmentsByRank[layering.items[segment.upper].rank].push(segment);

  let crossings = 0;
  for (const segments of segmentsByRank) {
    for (let first = 0; first < segments.length; first++) {
      for (let second = first + 1; second < segments.length; second++) {
        if (segmentsCross(segments[first], segments[second], positions)) {
          crossings += segments[first].weight * segments[second].weight;
        }
      }
    }
  }
  return crossings;
}

function segmentsCross(first: LayerSegment, second: LayerSegment, positions: Map<number, number>): boolean {
  const upperOrder = positions.get(first.upper)! - positions.get(second.upper)!;
  const lowerOrder = positions.get(first.lower)! - positions.get(second.lower)!;
  return upperOrder * lowerOrder < 0;
}

function positionsIn(layer: number[]): Map<number, number> {
  return new Map(layer.map((item, position) => [item, position]));
}
