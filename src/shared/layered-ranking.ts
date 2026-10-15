// Which rank each node of a layered drawing stands in — the column, in a left-to-right layout.
// Every edge must point down the ranks, so a cycle is broken first by turning its closing edges
// around (a retry loop is drawn running backwards, not dropped). Ranks are then pulled together so
// edges span as few ranks as they can: an edge may carry a single bend, so a long edge cannot be
// routed around what lies between its ends the way waypoints would let it.

export interface WeightedEdge {
  from: number;
  to: number;
  weight: number;
}

export interface RankedGraph {
  ranks: number[];
  // Every edge running down the ranks: those closing a cycle turned around, and edges that end up
  // joining the same two nodes the same way merged into one carrying both weights.
  edges: WeightedEdge[];
  // For each edge given, the index of the ranked edge it became.
  rankedEdgeOf: number[];
}

const UNVISITED = 0;
const ON_PATH = 1;
const FINISHED = 2;

// `visitOrder` says where cycles are entered from, so which edge of a cycle turns around is
// decided by the file (its entry points, then its order) rather than by chance.
export function rankNodes(nodeCount: number, edges: WeightedEdge[], visitOrder: number[]): RankedGraph {
  const merged = mergeParallelEdges(orientAcyclically(nodeCount, edges, visitOrder));
  const ranks = longestPathRanks(nodeCount, merged.edges);
  tightenRanks(ranks, merged.edges);
  return { ranks: startingAtZero(ranks), edges: merged.edges, rankedEdgeOf: merged.mergedInto };
}

function orientAcyclically(nodeCount: number, edges: WeightedEdge[], visitOrder: number[]): WeightedEdge[] {
  const outgoing = edgeIndicesBy(nodeCount, edges, (edge) => edge.from);
  const state = new Array<number>(nodeCount).fill(UNVISITED);
  const closesCycle = new Array<boolean>(edges.length).fill(false);

  const visit = (root: number): void => {
    if (state[root] !== UNVISITED) return;
    state[root] = ON_PATH;
    const path = [{ node: root, nextEdge: 0 }];
    while (path.length > 0) {
      const top = path[path.length - 1];
      const edgeIndex = outgoing[top.node][top.nextEdge++];
      if (edgeIndex === undefined) {
        state[top.node] = FINISHED;
        path.pop();
        continue;
      }
      const target = edges[edgeIndex].to;
      if (state[target] === ON_PATH) closesCycle[edgeIndex] = true;
      if (state[target] !== UNVISITED) continue;
      state[target] = ON_PATH;
      path.push({ node: target, nextEdge: 0 });
    }
  };
  visitOrder.forEach(visit);
  for (let node = 0; node < nodeCount; node++) visit(node);

  return edges.map((edge, index) => (closesCycle[index] ? { from: edge.to, to: edge.from, weight: edge.weight } : edge));
}

function mergeParallelEdges(edges: WeightedEdge[]): { edges: WeightedEdge[]; mergedInto: number[] } {
  const merged: WeightedEdge[] = [];
  const indexByEnds = new Map<string, number>();
  const mergedInto = edges.map((edge) => {
    const key = `${edge.from}>${edge.to}`;
    const existing = indexByEnds.get(key);
    if (existing !== undefined) {
      merged[existing].weight += edge.weight;
      return existing;
    }
    indexByEnds.set(key, merged.length);
    merged.push({ ...edge });
    return merged.length - 1;
  });
  return { edges: merged, mergedInto };
}

function longestPathRanks(nodeCount: number, edges: WeightedEdge[]): number[] {
  const ranks = new Array<number>(nodeCount).fill(0);
  const outgoing = edgeIndicesBy(nodeCount, edges, (edge) => edge.from);
  const pendingIncoming = new Array<number>(nodeCount).fill(0);
  for (const edge of edges) pendingIncoming[edge.to] += 1;

  const ready = [...ranks.keys()].filter((node) => pendingIncoming[node] === 0);
  while (ready.length > 0) {
    const node = ready.shift()!;
    for (const edgeIndex of outgoing[node]) {
      const target = edges[edgeIndex].to;
      ranks[target] = Math.max(ranks[target], ranks[node] + 1);
      pendingIncoming[target] -= 1;
      if (pendingIncoming[target] === 0) ready.push(target);
    }
  }
  return ranks;
}

// Moves each node within the ranks its edges allow, toward whichever side pulls harder. Every move
// strictly shortens the weighted span of all edges, which is a whole number, so this settles.
function tightenRanks(ranks: number[], edges: WeightedEdge[]): void {
  const incoming = edgeIndicesBy(ranks.length, edges, (edge) => edge.to);
  const outgoing = edgeIndicesBy(ranks.length, edges, (edge) => edge.from);
  let moved = true;
  while (moved) {
    moved = false;
    for (let node = 0; node < ranks.length; node++) {
      const preferred = preferredRank(node, ranks, edges, incoming[node], outgoing[node]);
      if (preferred === ranks[node]) continue;
      ranks[node] = preferred;
      moved = true;
    }
  }
}

function preferredRank(
  node: number,
  ranks: number[],
  edges: WeightedEdge[],
  incoming: number[],
  outgoing: number[],
): number {
  const incomingWeight = sumOf(incoming.map((index) => edges[index].weight));
  const outgoingWeight = sumOf(outgoing.map((index) => edges[index].weight));
  if (incomingWeight > outgoingWeight && incoming.length > 0) {
    return Math.max(...incoming.map((index) => ranks[edges[index].from] + 1));
  }
  if (outgoingWeight > incomingWeight && outgoing.length > 0) {
    return Math.min(...outgoing.map((index) => ranks[edges[index].to] - 1));
  }
  return ranks[node];
}

function startingAtZero(ranks: number[]): number[] {
  const lowest = ranks.length > 0 ? Math.min(...ranks) : 0;
  return ranks.map((rank) => rank - lowest);
}

function edgeIndicesBy(
  nodeCount: number,
  edges: WeightedEdge[],
  endOf: (edge: WeightedEdge) => number,
): number[][] {
  const byNode = Array.from({ length: nodeCount }, () => [] as number[]);
  edges.forEach((edge, index) => byNode[endOf(edge)].push(index));
  return byNode;
}

function sumOf(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
