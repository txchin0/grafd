// How readable a laid-out graph is: a score out of 100, and the findings that cost it points, each
// with what to do about it. Meant for whoever arranges a graph by hand or by program — an agent
// that wrote positions can read the findings and apply the moves, then score again.
//
// Everything is judged as the canvas draws it: edges as they bend (edge-sketch.ts), labels in the
// pills they are drawn in, regions around their members, text by the painter's own budget. A move
// is given in snap steps, so applying it keeps a node on the lattice.

import { shownEdgeLabel, type EdgeBend, type EdgeKind } from './canvas-edge-style.js';
import { sketchEdge, type EdgeSketch } from './edge-sketch.js';
import { shapeContainsPoint } from './shape-text-box.js';
import type { NodeShape } from './canvas-layer.js';
import type { Rect } from './flow-format.js';
import { estimateEdgeLabelWidth, estimateNodeSize, textCutOff } from './node-size-estimate.js';
import { EDGE_LABEL_HEIGHT } from './node-text-metrics.js';
import { CANVAS_SNAP, rectCenter, regionRectFrom, type Point } from './rect-math.js';

export interface ScoredNode {
  name: string;
  rect: Rect;
  description: string | null;
  shape: NodeShape;
}

export interface ScoredEdge {
  from: number;
  to: number;
  kind: EdgeKind;
  label: string | null;
  bend: EdgeBend | null;
}

export interface ScoredRegion {
  name: string;
  members: number[];
  // The area its `context:` block reserves with its own `pos`.
  area: Rect | null;
}

export interface ScoredGraph {
  nodes: ScoredNode[];
  edges: ScoredEdge[];
  regions: ScoredRegion[];
}

// Most costly first, which is also the order findings are listed in.
export const FINDING_KINDS = [
  'overlap',
  'edge-through-node',
  'outsider-in-region',
  'regions-overlap',
  'crossing',
  'label-collision',
  'crowded',
  'text-cut-off',
  'near-miss',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

// What each finding costs, out of 100. Anything that hides or misstates something — nodes on top
// of each other, an edge that looks like it passes through a node, a region seeming to hold a node
// it does not — costs most; what only looks untidy costs least.
const PENALTY: Record<FindingKind, number> = {
  overlap: 12,
  'edge-through-node': 6,
  'outsider-in-region': 6,
  'regions-overlap': 5,
  crossing: 3,
  'label-collision': 3,
  crowded: 3,
  'text-cut-off': 2,
  'near-miss': 1,
};

// Nodes closer than this read as touching.
const MIN_NODE_GAP = 24;
// What a move clears by: the gap it leaves between a node and what it was in the way of.
const CLEARANCE = 32;
// Centres this close across an edge look as if they were meant to line up and missed. Anything
// within half a snap step is the lattice's doing, not a miss.
const NEAR_MISS = 12;
// Room wanted on either side of a label between the two nodes its edge joins.
const LABEL_ROOM = 12;

export interface NodeMove {
  node: string;
  dx: number;
  dy: number;
}

export interface Finding {
  kind: FindingKind;
  // What is wrong, naming what it is wrong with.
  message: string;
  // What to do about it.
  fix: string;
  // The one node move that does it, when there is one.
  move?: NodeMove;
  // The size that does it, for text that is cut off.
  resize?: { node: string; w: number; h: number };
}

export interface GraphScore {
  score: number;
  counts: Record<FindingKind, number>;
  findings: Finding[];
}

export function scoreGraph(graph: ScoredGraph): GraphScore {
  const sketches = graph.edges.map((edge) =>
    (edge.from === edge.to ? null : sketchEdge(
      graph.nodes[edge.from].rect, graph.nodes[edge.to].rect, edge.bend, graph.nodes[edge.from].shape, graph.nodes[edge.to].shape,
    )));
  const findings = [
    ...overlaps(graph),
    ...edgesThroughNodes(graph, sketches),
    ...outsidersInRegions(graph),
    ...overlappingRegions(graph),
    ...crossings(graph, sketches),
    ...labelCollisions(graph, sketches),
    ...crowding(graph),
    ...cutOffText(graph),
    ...nearMisses(graph),
  ];
  const counts = Object.fromEntries(FINDING_KINDS.map((kind) => [kind, findings.filter((finding) => finding.kind === kind).length])) as Record<FindingKind, number>;
  const penalty = findings.reduce((total, finding) => total + PENALTY[finding.kind], 0);
  return { score: Math.max(0, 100 - penalty), counts, findings };
}

function overlaps({ nodes }: ScoredGraph): Finding[] {
  return pairsOf(nodes.length).flatMap(([first, second]) => {
    const [a, b] = [nodes[first], nodes[second]];
    if (!rectsOverlap(a.rect, b.rect)) return [];
    const move = separatingMove(a.rect, b, CLEARANCE);
    return [{ kind: 'overlap' as const, message: `"${b.name}" overlaps "${a.name}".`, fix: `${describeMove(move)}.`, move }];
  });
}

function crowding({ nodes }: ScoredGraph): Finding[] {
  return pairsOf(nodes.length).flatMap(([first, second]) => {
    const [a, b] = [nodes[first], nodes[second]];
    const gap = facingGap(a.rect, b.rect);
    if (gap === null || gap >= MIN_NODE_GAP) return [];
    const move = separatingMove(a.rect, b, CLEARANCE);
    return [{ kind: 'crowded' as const, message: `"${a.name}" and "${b.name}" are only ${Math.round(gap)} px apart.`, fix: `${describeMove(move)}.`, move }];
  });
}

function edgesThroughNodes(graph: ScoredGraph, sketches: (EdgeSketch | null)[]): Finding[] {
  return graph.edges.flatMap((edge, index) => {
    const sketch = sketches[index];
    if (!sketch) return [];
    return graph.nodes.flatMap((node, nodeIndex) => {
      if (nodeIndex === edge.from || nodeIndex === edge.to) return [];
      if (!sketch.points.some((point) => shapeContainsPoint(node.shape, node.rect, point))) return [];
      const [move, otherWay] = movesClearing(node, sketch.points, runsLevel(graph, edge));
      return [{
        kind: 'edge-through-node' as const,
        message: `${edgeName(graph, edge)} runs through "${node.name}".`,
        fix: `${describeMove(move)} (or ${describeMove(otherWay, false)}), or bend the edge around it.`,
        move,
      }];
    });
  });
}

function outsidersInRegions(graph: ScoredGraph): Finding[] {
  return graph.regions.flatMap((region) => {
    const frame = frameOf(graph, region);
    if (!frame) return [];
    return graph.nodes.flatMap((node, index) => {
      if (region.members.includes(index) || !rectsOverlap(frame, node.rect)) return [];
      const move = exitMove(node, frame);
      return [{
        kind: 'outsider-in-region' as const,
        message: `"${node.name}" stands in region "${region.name}" without being one of its members.`,
        fix: `${describeMove(move)}, or, if it belongs there, list it under the region's \`nodes:\`.`,
        move,
      }];
    });
  });
}

function overlappingRegions(graph: ScoredGraph): Finding[] {
  return pairsOf(graph.regions.length).flatMap(([first, second]) => {
    const [a, b] = [graph.regions[first], graph.regions[second]];
    const [frameA, frameB] = [frameOf(graph, a), frameOf(graph, b)];
    const sharesMembers = a.members.some((member) => b.members.includes(member));
    if (!frameA || !frameB || sharesMembers || !rectsOverlap(frameA, frameB)) return [];
    return [{
      kind: 'regions-overlap' as const,
      message: `Regions "${a.name}" and "${b.name}" overlap, though no node belongs to both.`,
      fix: `Move the members of one away from the other, or arrange the graph.`,
    }];
  });
}

function crossings(graph: ScoredGraph, sketches: (EdgeSketch | null)[]): Finding[] {
  return pairsOf(graph.edges.length).flatMap(([first, second]) => {
    const [a, b] = [sketches[first], sketches[second]];
    if (!a || !b || joinSameNodes(graph.edges[first], graph.edges[second]) || !polylinesCross(a.points, b.points)) return [];
    return [{
      kind: 'crossing' as const,
      message: `${edgeName(graph, graph.edges[first])} crosses ${edgeName(graph, graph.edges[second])}.`,
      fix: 'Move one of their ends so the two no longer cross, or arrange the graph.',
    }];
  });
}

function labelCollisions(graph: ScoredGraph, sketches: (EdgeSketch | null)[]): Finding[] {
  const pills = graph.edges.map((edge, index) => {
    const text = shownEdgeLabel(edge.label, edge.kind);
    const sketch = sketches[index];
    return text && sketch ? pillAt(sketch.grip, text) : null;
  });
  const onNodes = graph.edges.flatMap((edge, index) => {
    const pill = pills[index];
    if (!pill) return [];
    const label = `The label of ${edgeName(graph, edge)}`;
    const ends = [edge.from, edge.to];
    const squeezed = ends.some((end) => pillCovers(pill, graph.nodes[end]));
    const squeezedFinding = squeezed ? [{
      kind: 'label-collision' as const,
      message: `${label} does not fit between its nodes.`,
      ...withMove(roomForLabel(graph, edge, pill)),
    }] : [];
    const coveredFindings = graph.nodes.flatMap((node, nodeIndex) => {
      if (ends.includes(nodeIndex) || !pillCovers(pill, node)) return [];
      return [{ kind: 'label-collision' as const, message: `${label} lies on "${node.name}".`, ...withMove(exitMove(node, pill)) }];
    });
    return [...squeezedFinding, ...coveredFindings];
  });
  const onLabels = pairsOf(pills.length).flatMap(([first, second]) => {
    const [a, b] = [pills[first], pills[second]];
    if (!a || !b || joinSameNodes(graph.edges[first], graph.edges[second]) || !rectsOverlap(a, b)) return [];
    return [{
      kind: 'label-collision' as const,
      message: `The labels of ${edgeName(graph, graph.edges[first])} and ${edgeName(graph, graph.edges[second])} overlap.`,
      fix: 'Move the nodes of one edge away from the other, or bend one of them.',
    }];
  });
  return [...onNodes, ...onLabels];
}

function cutOffText({ nodes }: ScoredGraph): Finding[] {
  return nodes.flatMap((node) => {
    if (!textCutOff(node.name, node.description, node.rect, node.shape)) return [];
    const needed = estimateNodeSize(node.name, node.description, node.shape);
    const resize = { node: node.name, w: Math.max(node.rect.w, needed.w), h: Math.max(node.rect.h, needed.h) };
    return [{
      kind: 'text-cut-off' as const,
      message: `The text of "${node.name}" does not fit in ${node.rect.w}×${node.rect.h}.`,
      fix: `Resize "${node.name}" to ${resize.w}×${resize.h}.`,
      resize,
    }];
  });
}

function nearMisses(graph: ScoredGraph): Finding[] {
  const reported = new Set<string>();
  return graph.edges.flatMap((edge) => {
    if (edge.from === edge.to) return [];
    const pair = [Math.min(edge.from, edge.to), Math.max(edge.from, edge.to)].join(',');
    const [from, to] = [graph.nodes[edge.from], graph.nodes[edge.to]];
    const level = runsLevel(graph, edge);
    const offset = level ? rectCenter(to.rect).y - rectCenter(from.rect).y : rectCenter(to.rect).x - rectCenter(from.rect).x;
    if (reported.has(pair) || Math.abs(offset) <= CANVAS_SNAP / 2 || Math.abs(offset) > NEAR_MISS) return [];
    reported.add(pair);
    const move = { node: to.name, dx: level ? 0 : -offset, dy: level ? -offset : 0 };
    return [{
      kind: 'near-miss' as const,
      message: `"${from.name}" and "${to.name}" are ${Math.abs(offset)} px out of line.`,
      fix: `${describeMove(move)} to line them up.`,
      move,
    }];
  });
}

// Whether an edge runs more across the page than down it, which decides which way a node in its
// way should step aside and which way its ends should line up.
function runsLevel(graph: ScoredGraph, edge: ScoredEdge): boolean {
  const from = rectCenter(graph.nodes[edge.from].rect);
  const to = rectCenter(graph.nodes[edge.to].rect);
  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
}

// The two ways a node can step aside from a path, across it, the shorter first.
function movesClearing(node: ScoredNode, points: Point[], pathLevel: boolean): [NodeMove, NodeMove] {
  const { rect } = node;
  const near = points.filter((point) => (pathLevel
    ? point.x > rect.x - CLEARANCE && point.x < rect.x + rect.w + CLEARANCE
    : point.y > rect.y - CLEARANCE && point.y < rect.y + rect.h + CLEARANCE));
  const along = near.map((point) => (pathLevel ? point.y : point.x));
  const start = pathLevel ? rect.y : rect.x;
  const end = start + (pathLevel ? rect.h : rect.w);
  const back = -snapUp(end - Math.min(...along) + CLEARANCE);
  const forward = snapUp(Math.max(...along) + CLEARANCE - start);
  const moveBy = (distance: number): NodeMove => ({ node: node.name, dx: pathLevel ? 0 : distance, dy: pathLevel ? distance : 0 });
  return Math.abs(back) <= forward ? [moveBy(back), moveBy(forward)] : [moveBy(forward), moveBy(back)];
}

// The shortest move taking a node clear of an area, on whichever side is nearest.
function exitMove(node: ScoredNode, area: Rect): NodeMove {
  const { rect } = node;
  const options = [
    { dx: -snapUp(rect.x + rect.w - area.x + CLEARANCE), dy: 0 },
    { dx: snapUp(area.x + area.w - rect.x + CLEARANCE), dy: 0 },
    { dx: 0, dy: -snapUp(rect.y + rect.h - area.y + CLEARANCE) },
    { dx: 0, dy: snapUp(area.y + area.h - rect.y + CLEARANCE) },
  ];
  const shortest = options.reduce((best, option) =>
    (Math.abs(option.dx) + Math.abs(option.dy) < Math.abs(best.dx) + Math.abs(best.dy) ? option : best));
  return { node: node.name, ...shortest };
}

// Moves `moving` away from `fixed` along whichever axis they overlap or face each other on least,
// until `gap` lies between them.
function separatingMove(fixed: Rect, moving: ScoredNode, gap: number): NodeMove {
  const rect = moving.rect;
  const fromFixed = { x: rectCenter(rect).x - rectCenter(fixed).x, y: rectCenter(rect).y - rectCenter(fixed).y };
  const toClearX = fromFixed.x >= 0 ? fixed.x + fixed.w + gap - rect.x : -(rect.x + rect.w + gap - fixed.x);
  const toClearY = fromFixed.y >= 0 ? fixed.y + fixed.h + gap - rect.y : -(rect.y + rect.h + gap - fixed.y);
  return Math.abs(toClearX) <= Math.abs(toClearY)
    ? { node: moving.name, dx: snapAway(toClearX), dy: 0 }
    : { node: moving.name, dx: 0, dy: snapAway(toClearY) };
}

// Moves an edge's far end along the edge until its label has room between the two nodes.
function roomForLabel(graph: ScoredGraph, edge: ScoredEdge, pill: Rect): NodeMove {
  const [from, to] = [graph.nodes[edge.from].rect, graph.nodes[edge.to].rect];
  const level = runsLevel(graph, edge);
  const forward = level ? rectCenter(to).x >= rectCenter(from).x : rectCenter(to).y >= rectCenter(from).y;
  const gap = level
    ? (forward ? to.x - (from.x + from.w) : from.x - (to.x + to.w))
    : (forward ? to.y - (from.y + from.h) : from.y - (to.y + to.h));
  const needed = (level ? pill.w : pill.h) + 2 * LABEL_ROOM - gap;
  const distance = (forward ? 1 : -1) * snapUp(needed);
  return { node: graph.nodes[edge.to].name, dx: level ? distance : 0, dy: level ? 0 : distance };
}

// Whether a label's pill lies on any of a node as drawn — judged by points around the pill and
// across it, so a pill beside a diamond's empty corner is not counted as lying on it.
function pillCovers(pill: Rect, node: ScoredNode): boolean {
  const columns = [pill.x, pill.x + pill.w / 2, pill.x + pill.w];
  const rows = [pill.y, pill.y + pill.h / 2, pill.y + pill.h];
  const pillPoints = columns.flatMap((x) => rows.map((y) => ({ x, y })));
  return pillPoints.some((point) => shapeContainsPoint(node.shape, node.rect, point))
    || rectContains(pill, rectCenter(node.rect));
}

function rectContains(rect: Rect, point: Point): boolean {
  return point.x > rect.x && point.x < rect.x + rect.w && point.y > rect.y && point.y < rect.y + rect.h;
}

function pillAt(grip: Point, text: string): Rect {
  const w = estimateEdgeLabelWidth(text);
  return { x: grip.x - w / 2, y: grip.y - EDGE_LABEL_HEIGHT / 2, w, h: EDGE_LABEL_HEIGHT };
}

function frameOf(graph: ScoredGraph, region: ScoredRegion): Rect | null {
  return regionRectFrom(region.area, region.members.map((member) => graph.nodes[member].rect));
}

function polylinesCross(first: Point[], second: Point[]): boolean {
  for (let i = 0; i + 1 < first.length; i++) {
    for (let j = 0; j + 1 < second.length; j++) {
      if (segmentsMeet(first[i], first[i + 1], second[j], second[j + 1])) return true;
    }
  }
  return false;
}

// Whether two segments of sampled curves meet. Meeting at a sample point counts: two symmetric
// edges cross exactly on one, which a test for interiors crossing would miss. Two segments lying
// along one line do not count — that is one edge running over another, not a crossing.
function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const sideOfC = orientation(a, b, c);
  const sideOfD = orientation(a, b, d);
  if (sideOfC === 0 && sideOfD === 0) return false;
  return sideOfC * sideOfD <= 0 && orientation(c, d, a) * orientation(c, d, b) <= 0;
}

function orientation(origin: Point, toward: Point, point: Point): number {
  return Math.sign((toward.x - origin.x) * (point.y - origin.y) - (toward.y - origin.y) * (point.x - origin.x));
}

// Two edges between the same two nodes are fanned apart by the canvas, so they never meet.
function joinSameNodes(first: ScoredEdge, second: ScoredEdge): boolean {
  return (first.from === second.from && first.to === second.to) || (first.from === second.to && first.to === second.from);
}

// The gap between two rects that face each other across one axis while overlapping on the other;
// null for rects that do not face each other, or overlap.
function facingGap(a: Rect, b: Rect): number | null {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlapX > 0 && overlapY > 0) return null;
  if (overlapY > 0) return -overlapX;
  if (overlapX > 0) return -overlapY;
  return null;
}

function edgeName(graph: ScoredGraph, edge: ScoredEdge): string {
  return `"${graph.nodes[edge.from].name} -> ${graph.nodes[edge.to].name}"`;
}

function withMove(move: NodeMove): { fix: string; move: NodeMove } {
  return { fix: `${describeMove(move)}.`, move };
}

function describeMove(move: NodeMove, named = true): string {
  const parts = [
    move.dx !== 0 ? `${move.dx > 0 ? 'right' : 'left'} ${Math.abs(move.dx)}` : null,
    move.dy !== 0 ? `${move.dy > 0 ? 'down' : 'up'} ${Math.abs(move.dy)}` : null,
  ].filter((part): part is string => part !== null);
  return `${named ? `Move "${move.node}" ` : ''}${parts.join(' and ')}`;
}

function snapUp(distance: number): number {
  return Math.ceil(distance / CANVAS_SNAP) * CANVAS_SNAP;
}

function snapAway(distance: number): number {
  return Math.sign(distance) * snapUp(Math.abs(distance));
}

function rectsOverlap(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.w && second.x < first.x + first.w
    && first.y < second.y + second.h && second.y < first.y + first.h;
}

function pairsOf(count: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let first = 0; first < count; first++) {
    for (let second = first + 1; second < count; second++) pairs.push([first, second]);
  }
  return pairs;
}
