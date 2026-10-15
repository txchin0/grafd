// The last step of laying a scope out: the layered drawing, or the placement of new nodes among
// placed ones, settles where everything goes by rank and order, and can still leave an edge — a
// long one, or one looping back — drawn through a node, or a label lying on one. The score knows the
// move that clears each such finding, so layout takes those moves itself, one at a time, keeping
// each only when the drawing scores better for it and gains nothing the layered layout promises
// never to produce. Pure and deterministic, so arranging an arranged scope still changes nothing,
// and the canvas and the linter, placing the same scope, still place it alike.

import type { Arrangement, LayoutScope } from './auto-layout.js';
import { bendThroughPoint } from './canvas-edge-style.js';
import { DEFAULT_NODE_SHAPE } from './canvas-layer.js';
import type { Rect } from './flow-format.js';
import { scoreGraph, type FindingKind, type GraphScore, type NodeMove, type ScoredGraph } from './layout-score.js';
import { rectCenter, type Point } from './rect-math.js';

// Each move fixes one finding and the score is re-read after it, so this bounds the work on a
// graph whose moves keep trading one finding for another.
const MAX_MOVES = 12;

// What the layered layout guarantees never to draw; a move that adds one is refused however much
// else it clears.
const PROMISED_ABSENT: readonly FindingKind[] = ['overlap', 'outsider-in-region', 'regions-overlap', 'crowded', 'text-cut-off'];

interface Polishing {
  scope: LayoutScope;
  // By index into the scope's edges, the point each bent edge bends through. Moved nodes leave
  // them where they are, so an edge bent along a lane keeps running along it.
  bendPoints: ReadonlyMap<number, Point | null>;
  mayMove: (node: number) => boolean;
  // Whether a node may step aside where no finding's own move takes it.
  mayStepAside: (node: number, rects: Rect[]) => boolean;
  // Whether regions still hold the areas their `context:` blocks reserve; arranging lets go of them.
  keepsReservedAreas: boolean;
}

// The polished drawing is shifted back to the top-left corner the drawing had, bends and all:
// arranging starts from a scope's corner, so a node stepping above or left of it would otherwise
// move the next arrangement.
export function polishArrangement(scope: LayoutScope, arrangement: Arrangement): Arrangement {
  const { bendPoints } = arrangement;
  const polishing: Polishing = {
    scope,
    bendPoints,
    mayMove: () => true,
    mayStepAside: (node, current) => !isLinedUpWithANeighbour(scope, node, current),
    keepsReservedAreas: false,
  };
  const rects = polishedRects(polishing, arrangement.rects, () => []);
  return shiftedBy(cornerOf(arrangement.rects), cornerOf(rects), { rects, bendPoints });
}

// New nodes placed among placed ones, polished the same way; only the new ones move. They also try
// stepping aside all together, keeping the shape the placement gave them.
export function polishPlacement(scope: LayoutScope, rects: Rect[]): Rect[] {
  const newNodes = [...scope.nodes.keys()].filter((node) => !scope.nodes[node].pos);
  const isNew = (node: number): boolean => !scope.nodes[node].pos;
  const polishing: Polishing = { scope, bendPoints: new Map(), mayMove: isNew, mayStepAside: isNew, keepsReservedAreas: true };
  return polishedRects(polishing, rects, (current) => (newNodes.length > 1 ? stepsAside([newNodes], current) : []));
}

// How far a node may step aside, beyond the moves the findings name, in search of a clearer spot.
const STEP_ASIDE_DISTANCES = [64, 128, 192];

type RectsMove = Rect[];

// The findings worth searching around: something drawn over a node. A crossing names four nodes
// and is cheap, so searching around every one costs far more than it wins.
const STEPPED_ASIDE_FROM: readonly FindingKind[] = ['edge-through-node', 'label-collision'];

function stepsAside(groups: number[][], rects: Rect[]): RectsMove[] {
  const offsets = STEP_ASIDE_DISTANCES.flatMap((distance) => [
    { dx: 0, dy: -distance }, { dx: 0, dy: distance }, { dx: -distance, dy: 0 }, { dx: distance, dy: 0 },
  ]);
  return groups.flatMap((group) => offsets.map(({ dx, dy }) =>
    rects.map((rect, node) => (group.includes(node) ? { ...rect, x: rect.x + dx, y: rect.y + dy } : rect))));
}

// A finding's own move is for one node, and often walks into something else; any node the finding
// is about — an edge's ends, what it runs through — may also step aside.
function involvedStepsAside(polishing: Polishing, score: GraphScore, rects: Rect[]): RectsMove[] {
  const indexOf = new Map(polishing.scope.nodes.map((node, index) => [node.name, index]));
  const blocking = score.findings.filter((finding) => STEPPED_ASIDE_FROM.includes(finding.kind));
  const involved = new Set(blocking.flatMap((finding) => finding.nodes ?? []).flatMap((name) => indexOf.get(name) ?? []));
  const free = [...involved].filter((node) => polishing.mayMove(node) && polishing.mayStepAside(node, rects));
  return stepsAside(free.map((node) => [node]), rects);
}

// A node level or plumb with a node it is joined to is part of a straight line the layout drew —
// the spine, a column of a fork — and stepping it aside to clear something else would bend that
// line, which the score does not count against it.
function isLinedUpWithANeighbour(scope: LayoutScope, node: number, rects: Rect[]): boolean {
  const indexOf = new Map(scope.nodes.map((scoped, index) => [scoped.name, index]));
  const neighbours = scope.edges.flatMap((edge) => {
    const target = indexOf.get(edge.target);
    if (target === undefined || edge.from === target) return [];
    if (edge.from === node) return [target];
    return target === node ? [edge.from] : [];
  });
  const centre = rectCenter(rects[node]);
  return neighbours.some((neighbour) => {
    const other = rectCenter(rects[neighbour]);
    return other.x === centre.x || other.y === centre.y;
  });
}

function polishedRects(polishing: Polishing, rects: Rect[], groupMoves: (current: Rect[]) => RectsMove[]): Rect[] {
  let current = rects;
  let score = scoreGraph(scoredGraphOf(polishing, current));
  for (let moves = 0; moves < MAX_MOVES; moves += 1) {
    // The findings' own moves are few and usually enough; searching around is the fallback.
    const better = bestMove(polishing, current, score, findingMoves(polishing, current, score))
      ?? bestMove(polishing, current, score, [...involvedStepsAside(polishing, score, current), ...groupMoves(current)]);
    if (!better) break;
    ({ rects: current, score } = better);
  }
  return current;
}

function cornerOf(rects: Rect[]): Point {
  return { x: Math.min(...rects.map((rect) => rect.x)), y: Math.min(...rects.map((rect) => rect.y)) };
}

function shiftedBy(corner: Point, drifted: Point, arrangement: Arrangement): Arrangement {
  const dx = corner.x - drifted.x;
  const dy = corner.y - drifted.y;
  if (dx === 0 && dy === 0) return arrangement;
  return {
    rects: arrangement.rects.map((rect) => ({ ...rect, x: rect.x + dx, y: rect.y + dy })),
    bendPoints: new Map([...arrangement.bendPoints].map(([edge, point]) => [edge, point && { x: point.x + dx, y: point.y + dy }])),
  };
}

function findingMoves(polishing: Polishing, rects: Rect[], score: GraphScore): RectsMove[] {
  return distinctMoves(score)
    .map((move) => rectsAfter(polishing, rects, move))
    .filter((moved): moved is RectsMove => moved !== null);
}

function bestMove(polishing: Polishing, rects: Rect[], score: GraphScore, candidates: RectsMove[]): { rects: Rect[]; score: GraphScore } | null {
  let best: { rects: Rect[]; score: GraphScore } | null = null;
  for (const moved of candidates) {
    const candidate = scoreGraph(scoredGraphOf(polishing, moved));
    if (candidate.score <= (best ?? { score }).score.score || addsPromisedAbsent(score, candidate)) continue;
    best = { rects: moved, score: candidate };
  }
  return best;
}

function distinctMoves(score: GraphScore): NodeMove[] {
  const seen = new Set<string>();
  return score.findings.flatMap(({ move, otherMove }) => [move, otherMove].flatMap((candidate) => {
    if (!candidate) return [];
    const key = `${candidate.node}\u0000${candidate.dx}\u0000${candidate.dy}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [candidate];
  }));
}

function addsPromisedAbsent(before: GraphScore, after: GraphScore): boolean {
  return PROMISED_ABSENT.some((kind) => after.counts[kind] > before.counts[kind]);
}

function rectsAfter({ scope, mayMove }: Polishing, rects: Rect[], move: NodeMove): Rect[] | null {
  const index = scope.nodes.findIndex((node) => node.name === move.node);
  if (index < 0 || !mayMove(index)) return null;
  return rects.map((rect, other) => (other === index ? { ...rect, x: rect.x + move.dx, y: rect.y + move.dy } : rect));
}

function scoredGraphOf({ scope, bendPoints, keepsReservedAreas }: Polishing, rects: Rect[]): ScoredGraph {
  const indexOf = new Map(scope.nodes.map((node, index) => [node.name, index]));
  return {
    nodes: scope.nodes.map((node, index) => ({
      name: node.name,
      rect: rects[index],
      description: node.description,
      shape: node.shape ?? DEFAULT_NODE_SHAPE,
    })),
    edges: scope.edges.flatMap((edge, index) => {
      const to = indexOf.get(edge.target);
      if (to === undefined) return [];
      const point = bendPoints.get(index) ?? null;
      const bend = point && bendThroughPoint(point, rectCenter(rects[edge.from]), rectCenter(rects[to]));
      return [{ from: edge.from, to, kind: edge.kind, label: edge.label, bend }];
    }),
    regions: scope.regions.map((region, index) => ({
      name: `region ${index}`,
      members: region.members.flatMap((member) => indexOf.get(member) ?? []),
      area: keepsReservedAreas ? region.pos : null,
    })),
  };
}
