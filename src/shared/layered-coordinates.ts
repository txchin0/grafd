// Where each item of an ordered layering stands across its rank (up and down, in a left-to-right
// layout).
//
// Each band is laid out on its own and the bands are then stacked, each clear of the one before by
// a gap wider than a region's frame. A region is drawn around its members, so keeping every band's
// span apart from every other's is what keeps a node out of a region it is not a member of. An edge
// between two bands is drawn across that gap whatever happens, so it does not pull on either end.
//
// Within a band, sweeping down the ranks and back up, each rank is placed toward the weighted
// median of its neighbours in the rank just placed, keeping the order the crossing reduction chose
// and the gaps between items exactly. Items are placed by priority: those on an edge that must run
// straight first, then those where a long edge passes, then the rest. A higher-priority item stands
// exactly where its neighbours want it and the others make room around it — which is what draws the
// spine as one straight line. Items of equal priority are placed together, as close to where each
// wants to be as the gaps allow, so a fork whose branches are alike stays symmetric rather than
// favouring the one that happened to come first.

import { neighboursBy, type Neighbour, type ProperLayering } from './layered-ordering.js';

// With two default-height nodes this puts their centres 144 apart, so a node centred between two
// such branches still lands on the snap lattice and a symmetric fork stays exactly symmetric.
export const NODE_GAP = 56;
const EDGE_LANE_GAP = 24;
// Wider than twice the padding a region keeps around its members (REGION_MEMBER_PADDING), so the
// frames of neighbouring bands neither touch nor reach the other band's nodes.
export const BAND_GAP = 80;
const VIRTUAL_ITEM_SIZE = 16;

// An even number, so the last sweep runs upward and every rank ends up placed against its
// successors, which is where a flow's branches fan out from.
const COORDINATE_SWEEPS = 8;

const PRIORITY = { unconnected: 0, node: 1, passingEdge: 2, straight: 3 } as const;
type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

// A node at the end of a long edge is drawn toward the line that edge's lane lies on, harder than
// toward its other neighbours: the lane is only clear of nodes if the edge is drawn through it.
const LANE_PULL_FACTOR = 4;

type Pull = Neighbour;

// `crossSizes` holds each real node's extent across its rank; returns each item's centre.
export function assignCrossCoordinates(
  layering: ProperLayering,
  layers: number[][],
  crossSizes: number[],
): number[] {
  const sizeOf = (item: number): number => (layering.items[item].node === null ? VIRTUAL_ITEM_SIZE : crossSizes[item]);
  const separation = (first: number, second: number): number =>
    sizeOf(first) / 2 + sizeOf(second) / 2 + gapBetween(layering, first, second);
  const onStraightEdge = itemsOnStraightEdges(layering);
  const pullsFromAbove = pullsOf(layering, onStraightEdge, (segment) => [segment.lower, segment.upper]);
  const pullsFromBelow = pullsOf(layering, onStraightEdge, (segment) => [segment.upper, segment.lower]);
  const priorityOf = (item: number, pulls: Pull[][]): Priority => {
    if (pulls[item].length === 0) return PRIORITY.unconnected;
    if (onStraightEdge.has(item)) return PRIORITY.straight;
    return layering.items[item].node === null ? PRIORITY.passingEdge : PRIORITY.node;
  };

  const centres = new Array<number>(layering.items.length).fill(0);
  const bands = layersPerBand(layering, layers);
  for (const bandLayers of bands) {
    packCentres(bandLayers, centres, separation);
    for (let sweep = 0; sweep < COORDINATE_SWEEPS; sweep++) {
      const downward = sweep % 2 === 0;
      const pulls = downward ? pullsFromAbove : pullsFromBelow;
      const ranks = [...bandLayers.keys()];
      for (const rank of downward ? ranks.slice(1) : ranks.slice(0, -1).reverse()) {
        const desiredCentreOf = (item: number): number =>
          pointOnChordOf(layering, item, centres) ?? pulledCentreOf(layering, item, pulls[item], centres) ?? centres[item];
        placeLayer(bandLayers[rank], centres, pulls, desiredCentreOf, (item) => priorityOf(item, pulls), separation);
      }
    }
  }
  stackBands(bands, centres, sizeOf);
  return centres;
}

function gapBetween(layering: ProperLayering, first: number, second: number): number {
  return layering.items[first].node !== null && layering.items[second].node !== null ? NODE_GAP : EDGE_LANE_GAP;
}

// Only neighbours in the item's own band pull on it, and an item on the spine answers to the spine
// alone, so nothing that joins it from the side can bend it.
function pullsOf(
  layering: ProperLayering,
  onStraightEdge: Set<number>,
  endsOf: Parameters<typeof neighboursBy>[1],
): Pull[][] {
  return neighboursBy(layering, endsOf).map((neighbours, item) => {
    const sameBand = neighbours.filter((pull) => layering.items[pull.item].band === layering.items[item].band);
    return onStraightEdge.has(item) ? sameBand.filter((pull) => pull.straight) : sameBand;
  });
}

function itemsOnStraightEdges(layering: ProperLayering): Set<number> {
  const items = new Set<number>();
  for (const segment of layering.segments) {
    if (!segment.straight) continue;
    items.add(segment.upper);
    items.add(segment.lower);
  }
  return items;
}

// Each band's own items, rank by rank, in the order the ranks hold them.
function layersPerBand(layering: ProperLayering, layers: number[][]): number[][][] {
  const bandCount = Math.max(-1, ...layering.items.map((item) => item.band)) + 1;
  return Array.from({ length: bandCount }, (_, band) =>
    layers.map((layer) => layer.filter((item) => layering.items[item].band === band)));
}

function packCentres(
  layers: number[][],
  centres: number[],
  separation: (first: number, second: number) => number,
): void {
  for (const layer of layers) {
    let centre = 0;
    layer.forEach((item, index) => {
      if (index > 0) centre += separation(layer[index - 1], item);
      centres[item] = centre;
    });
    const middle = layer.length > 0 ? (centres[layer[0]] + centres[layer[layer.length - 1]]) / 2 : 0;
    for (const item of layer) centres[item] -= middle;
  }
}

// Places a rank one priority at a time, highest first. Every item placed so far bounds the items
// between it and the next placed one: they must fit in the room left between the two, gaps
// included, so a later placement can never push an earlier one.
function placeLayer(
  layer: number[],
  centres: number[],
  pulls: Pull[][],
  desiredCentreOf: (item: number) => number,
  priorityOf: (item: number) => Priority,
  separation: (first: number, second: number) => number,
): void {
  const offsets = [0];
  for (let index = 1; index < layer.length; index++) {
    offsets.push(offsets[index - 1] + separation(layer[index - 1], layer[index]));
  }
  const room = (from: number, to: number): number => offsets[to] - offsets[from];
  const placed = new Array<number | null>(layer.length).fill(null);

  const priorities = [...new Set(layer.map(priorityOf))].sort((first, second) => second - first);
  for (const priority of priorities) {
    for (const run of runsBetweenPlaced(layer, placed, (item) => priorityOf(item) === priority)) {
      if (priority === PRIORITY.unconnected) {
        packAgainstPlaced(run, layer, centres, placed, room);
        continue;
      }
      const desired = run.indices.map((index) => desiredCentreOf(layer[index]));
      const weights = run.indices.map((index) => totalWeight(pulls[layer[index]]) || 1);
      const separations = run.indices.slice(1).map((index, position) => room(run.indices[position], index));
      closestOrderedPlacement(desired, weights, separations).forEach((centre, position) => {
        const index = run.indices[position];
        const lowest = run.placedBefore === null ? -Infinity : placed[run.placedBefore]! + room(run.placedBefore, index);
        const highest = run.placedAfter === null ? Infinity : placed[run.placedAfter]! - room(index, run.placedAfter);
        placed[index] = Math.min(highest, Math.max(lowest, centre));
      });
    }
  }
  layer.forEach((item, index) => {
    centres[item] = placed[index]!;
  });
}

interface Run {
  indices: number[];
  placedBefore: number | null;
  placedAfter: number | null;
}

// An item with nothing pulling on it from the rank just placed closes up against the item placed
// before it (or after it, at the start of a rank), so a band never spreads out around a node that
// only connects to other bands.
function packAgainstPlaced(
  run: Run,
  layer: number[],
  centres: number[],
  placed: (number | null)[],
  room: (from: number, to: number) => number,
): void {
  for (const index of run.indices) {
    if (run.placedBefore !== null) placed[index] = placed[run.placedBefore]! + room(run.placedBefore, index);
    else if (run.placedAfter !== null) placed[index] = placed[run.placedAfter]! - room(index, run.placedAfter);
    else placed[index] = centres[layer[index]];
  }
}

// The selected, unplaced positions of a rank, grouped by the placed items on either side of them.
function runsBetweenPlaced(layer: number[], placed: (number | null)[], selected: (item: number) => boolean): Run[] {
  const runs: Run[] = [];
  let current: Run = { indices: [], placedBefore: null, placedAfter: null };
  layer.forEach((item, index) => {
    if (placed[index] !== null) {
      current.placedAfter = index;
      if (current.indices.length > 0) runs.push(current);
      current = { indices: [], placedBefore: index, placedAfter: null };
      return;
    }
    if (selected(item)) current.indices.push(index);
  });
  if (current.indices.length > 0) runs.push(current);
  return runs;
}

// Where the straight line between an edge's two ends crosses this item's rank. The canvas draws an
// edge as that line, so a lane reserved anywhere else would keep nodes off a path the edge never
// takes. Null for a node, and for an edge between two bands, whose ends are placed apart and only
// meet their final positions once the bands are stacked.
function pointOnChordOf(layering: ProperLayering, item: number, centres: number[]): number | null {
  const passing = layering.items[item].passing;
  if (!passing) return null;
  const from = layering.items[passing.from];
  const to = layering.items[passing.to];
  if (from.band !== to.band) return null;
  const along = (layering.items[item].rank - from.rank) / (to.rank - from.rank);
  return centres[passing.from] + along * (centres[passing.to] - centres[passing.from]);
}

function pulledCentreOf(layering: ProperLayering, item: number, pulls: Pull[], centres: number[]): number | null {
  return weightedMedian(pulls.map((pull) => {
    const onLaneLine = laneLinePointFor(layering, item, pull.item, centres);
    return onLaneLine === null
      ? { position: centres[pull.item], weight: pull.weight }
      : { position: onLaneLine, weight: pull.weight * LANE_PULL_FACTOR };
  }));
}

// Where `end` would have to stand for the straight line from the far end of a long edge through
// `lane`, the item where that edge passes the neighbouring rank, to reach it.
function laneLinePointFor(layering: ProperLayering, end: number, lane: number, centres: number[]): number | null {
  const passing = layering.items[lane].passing;
  if (!passing || layering.items[passing.from].band !== layering.items[passing.to].band) return null;
  const farEnd = passing.from === end ? passing.to : passing.from;
  const rankOf = (index: number): number => layering.items[index].rank;
  const reach = (rankOf(end) - rankOf(farEnd)) / (rankOf(lane) - rankOf(farEnd));
  return centres[farEnd] + reach * (centres[lane] - centres[farEnd]);
}

function weightedMedian(positions: { position: number; weight: number }[]): number | null {
  if (positions.length === 0) return null;
  const sorted = [...positions].sort((first, second) => first.position - second.position);
  const half = totalWeight(sorted) / 2;
  let accumulated = 0;
  for (let index = 0; index < sorted.length; index++) {
    accumulated += sorted[index].weight;
    if (accumulated > half) return sorted[index].position;
    if (accumulated === half) return (sorted[index].position + sorted[index + 1].position) / 2;
  }
  return sorted[sorted.length - 1].position;
}

function totalWeight(pulls: { weight: number }[]): number {
  return pulls.reduce((total, pull) => total + pull.weight, 0);
}

// The positions nearest the desired ones (least squares, weighted) that keep the given order and
// at least the given separation between neighbours. Subtracting each item's minimum offset from
// the first turns the separations into plain order constraints, which pooling adjacent violators
// solves exactly. Clamping that solution to bounds that are the same for every item, once the
// offsets are taken out, keeps it optimal — which is how placeLayer bounds a run.
export function closestOrderedPlacement(desired: number[], weights: number[], separations: number[]): number[] {
  const offsets = [0];
  separations.forEach((separation, index) => offsets.push(offsets[index] + separation));

  const blocks: { count: number; weight: number; mean: number }[] = [];
  desired.forEach((position, index) => {
    blocks.push({ count: 1, weight: weights[index], mean: position - offsets[index] });
    while (blocks.length > 1 && blocks[blocks.length - 2].mean > blocks[blocks.length - 1].mean) {
      const last = blocks.pop()!;
      const previous = blocks[blocks.length - 1];
      const weight = previous.weight + last.weight;
      previous.mean = (previous.mean * previous.weight + last.mean * last.weight) / weight;
      previous.weight = weight;
      previous.count += last.count;
    }
  });

  const placed: number[] = [];
  for (const block of blocks) {
    for (let member = 0; member < block.count; member++) placed.push(block.mean + offsets[placed.length]);
  }
  return placed;
}

// Moves every band to start a gap below where the band before it ends. Everything in a band is
// counted — where its edges pass as well as its nodes — so no rank's items fall out of order.
function stackBands(bands: number[][][], centres: number[], sizeOf: (item: number) => number): void {
  let previousBottom: number | null = null;
  for (const bandLayers of bands) {
    const items = bandLayers.flat();
    if (items.length === 0) continue;
    const top = Math.min(...items.map((item) => centres[item] - sizeOf(item) / 2));
    const bottom = Math.max(...items.map((item) => centres[item] + sizeOf(item) / 2));
    const shift: number = previousBottom === null ? 0 : previousBottom + BAND_GAP - top;
    for (const item of items) centres[item] += shift;
    previousBottom = bottom + shift;
  }
}
