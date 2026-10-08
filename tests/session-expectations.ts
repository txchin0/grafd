// What a user can expect of a single step, judged with the step in hand: what was asked, with which
// tool, what was selected before and after, and what the files became. Where session-invariants.ts
// holds rules about any state, these hold the editor to common sense about each kind of action —
// a click changes nothing, shift changes one thing, a dragged thing stays under the pointer, a
// paste lands where it was asked to. Each was a bug once; the rule keeps its whole class closed.

import type { Tool } from '../src/client/canvas/canvas-view.js';
import type { Point } from '../src/client/geometry.js';
import { allNodes, buildModel, regionRectOf, type FlowModel } from '../src/client/flow-doc.js';
import { parseFlow, type Rect } from '../src/shared/flow-format.js';
import { canvasLayerPathOf, parseCanvasLayer } from '../src/shared/canvas-layer.js';
import { rectContainsRect } from '../src/shared/rect-math.js';
import { strokeBounds, strokePointsOf, type Stroke } from '../src/shared/canvas-drawings.js';
import type { HeadlessEditor } from './editor-harness.js';
import { isHistoryAction, type ActionTrace, type SessionAction } from './session-actions.js';
import { contentChanged, contentOf, differingPaths, type FileSnapshot, type Violation } from './session-invariants.js';

// Node moves snap to this grid, so a dragged node can land up to this far from the pointer's path.
const SNAP = 8;
// A pasted stroke's points are stored to a tenth of a unit, and a pasted offset is rounded.
const PASTE_TOLERANCE = 1;
// The same rounding lets a stroke that only moved measure a little wider or taller.
const STROKE_SIZE_TOLERANCE = 0.5;
const VIEWPORT = { width: 1280, height: 800 };

export interface SessionStep {
  editor: HeadlessEditor;
  flowPath: string;
  action: SessionAction;
  trace: ActionTrace;
  tool: Tool;
  before: FileSnapshot;
  after: FileSnapshot;
  // What was selected, as `kind:identity` entries; a group of drawings counts once.
  selectionBefore: ReadonlySet<string>;
  selectionAfter: ReadonlySet<string>;
  // Which graph was on screen before the step — a dive or a step back changes it, and a selection
  // never survives into another graph.
  graphBefore: string;
  stepsAdded: number;
}

export function graphOnScreen(editor: HeadlessEditor): string {
  const flow = editor.core.openFlow();
  return flow ? `${flow.path} ${flow.scope ?? ''}` : '';
}

// The graph of one file as a step left it: its top-level nodes by id, its regions by name, its
// top-level strokes by id, and every edge as the line that declares it.
interface GraphState {
  model: FlowModel;
  nodeIds: Set<string>;
  topNodes: Map<string, { name: string; pos: Rect | null }>;
  regions: Map<string, { pos: Rect | null; members: string[]; frame: Rect | null }>;
  strokes: Map<string, Stroke>;
  groups: string[][];
  edgesBySource: Map<string, string[]>;
}

function graphStateOf(snapshot: FileSnapshot, flowPath: string): GraphState {
  const doc = parseFlow(snapshot.get(flowPath) ?? '---\nname: gone\n---\n');
  const model = buildModel(doc, null);
  const layer = parseCanvasLayer(snapshot.get(canvasLayerPathOf(flowPath)) ?? null);
  const strokes = new Map<string, Stroke>();
  for (const drawing of layer.drawings) {
    const points = strokePointsOf(drawing.points);
    if (drawing.graph == null && points && typeof drawing.id === 'string') {
      strokes.set(drawing.id, { id: drawing.id, graph: null, color: null, width: 'medium', points });
    }
  }
  return {
    model,
    nodeIds: new Set(allNodes(doc).map((node) => node.id ?? node.name)),
    topNodes: new Map(model.nodes.map((node) => [node.id ?? node.name, { name: node.name, pos: node.pos ? { ...node.pos } : null }])),
    regions: new Map(model.contexts.map((context) => [
      context.block.name,
      { pos: context.block.pos, members: [...context.block.members], frame: regionRectOf(model, context) },
    ])),
    strokes,
    groups: layer.groups.map((group) => drawingIdsOfGroup(group)),
    edgesBySource: new Map(allNodes(doc).map((node) => [node.id ?? node.name, node.edges.map((spec) => JSON.stringify(spec))])),
  };
}

function drawingIdsOfGroup(group: unknown): string[] {
  const members = (group as { members?: unknown }).members;
  if (!Array.isArray(members)) return [];
  return members.flatMap((member) => (typeof member?.id === 'string' && member.kind === 'drawing' ? [member.id] : []));
}

// The selection as entries a test can compare across steps: every node, region and edge on its own,
// and a group of drawings as the one thing it is.
export function selectionOf(editor: HeadlessEditor, flowPath: string): Set<string> {
  const { view } = editor.core;
  const groups = parseCanvasLayer(editor.workspace.file(canvasLayerPathOf(flowPath))).groups.map(drawingIdsOfGroup);
  const entries = new Set<string>();
  for (const node of view.selection) entries.add(`node:${node.id ?? node.name}`);
  for (const region of view.selectedRegions) entries.add(`region:${region.block.name}`);
  for (const edge of view.selectedEdges) entries.add(`edge:${edge.from.id ?? edge.from.name}:${JSON.stringify(edge.spec)}`);
  for (const drawing of view.selectedDrawings) {
    const group = groups.find((members) => members.includes(drawing.id));
    entries.add(group ? `group:${group.join(',')}` : `drawing:${drawing.id}`);
  }
  return entries;
}

export function expectationViolations(step: SessionStep): Violation[] {
  const was = graphStateOf(step.before, step.flowPath);
  const now = graphStateOf(step.after, step.flowPath);
  return [
    ...undoStepWithoutChange(step),
    ...clickThatChangedFiles(step, was, now),
    ...plainClickThatSelectedMany(step),
    ...shiftClickThatChangedMany(step),
    ...draggedThingsOffThePointer(step, was, now),
    ...regionDragThatLeftDrawings(step, was, now),
    ...regionsMadeUnreachable(step, was, now),
    ...edgesDuplicated(step, was, now),
    ...pasteAwayFromThePointer(step, was, now),
    ...copiesLeftUnselected(step, was, now),
    ...deleteThatMissedTheSelection(step, was, now),
    ...abandonedDragThatWrote(step),
    ...selectAllThatMissedSomething(step),
    ...fitThatLeftSomethingOut(step),
    ...newNodesInTheWrongRegions(step, was, now),
  ];
}

function violation(invariant: string, detail: string): Violation[] {
  return [{ invariant, detail }];
}

// An undo step with nothing in it makes the next Ctrl+Z look broken. Opening another file starts
// its own history, which shows here as steps going away rather than added.
function undoStepWithoutChange(step: SessionStep): Violation[] {
  if (isHistoryAction(step.action) || step.stepsAdded <= 0 || contentChanged(step.before, step.after)) return [];
  return violation('every undo step undoes something', `${step.action.type} added ${step.stepsAdded} undo step(s) but changed no file`);
}

// A click selects, opens or toggles; it never edits. Two clicks are deliberate exceptions: the
// pen's, which draws a dot, and one on a ghost, which is how a ghost is made real.
function clickThatChangedFiles(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  if (step.action.type !== 'click' || !isClickThatRan(step) || step.tool === 'draw' || !contentChanged(step.before, step.after)) return [];
  const materializedGhost = [...now.topNodes.values()].some((node) => was.model.ghosts.some((ghost) => ghost.name === node.name));
  if (materializedGhost) return [];
  return violation('a click changes no file', `clicking a ${step.action.target.kind} changed ${differingPaths(contentOf(step.before), contentOf(step.after)).join(', ')}`);
}

function plainClickThatSelectedMany(step: SessionStep): Violation[] {
  if (graphOnScreen(step.editor) !== step.graphBefore) return [];
  if (!isClickThatRan(step) || step.action.type !== 'click' || step.action.shift || step.tool !== 'select') return [];
  if (contentChanged(step.before, step.after) || step.selectionAfter.size <= 1) return [];
  return violation('a plain click selects one thing', `clicking a ${step.action.target.kind} left ${[...step.selectionAfter].join(', ')} selected`);
}

function shiftClickThatChangedMany(step: SessionStep): Violation[] {
  if (graphOnScreen(step.editor) !== step.graphBefore) return [];
  if (!isClickThatRan(step) || step.action.type !== 'click' || !step.action.shift || step.tool !== 'select') return [];
  if (contentChanged(step.before, step.after)) return [];
  const added = [...step.selectionAfter].filter((entry) => !step.selectionBefore.has(entry));
  const removed = [...step.selectionBefore].filter((entry) => !step.selectionAfter.has(entry));
  if (added.length + removed.length <= 1) return [];
  return violation('shift-click adds or removes one thing', `shift-clicking a ${step.action.target.kind} added ${added.join(', ') || 'nothing'} and removed ${removed.join(', ') || 'nothing'}`);
}

// Whatever a drag picks up stays under the pointer: everything it moved, moved as far as the
// pointer did. Node positions snap, so they may land a grid step off.
function draggedThingsOffThePointer(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  const isDrag = step.action.type === 'drag' || step.action.type === 'nudge';
  if (!isDrag || step.tool !== 'select' || !step.trace.path || !contentChanged(step.before, step.after)) return [];
  if (createdAnything(was, now) || resizedAnything(was, now)) return [];
  const pointer = travelOf(step.trace.path);
  return translationsOf(was, now)
    .filter(({ delta }) => Math.abs(delta.x - pointer.x) > SNAP || Math.abs(delta.y - pointer.y) > SNAP)
    .flatMap(({ what, delta }) => violation('a dragged thing follows the pointer', `${what} moved ${Math.round(delta.x)},${Math.round(delta.y)} for a pointer move of ${Math.round(pointer.x)},${Math.round(pointer.y)}`));
}

// R28b: a dragged region takes along the drawings lying wholly inside its frame, a group only whole.
function regionDragThatLeftDrawings(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  const isDrag = step.action.type === 'drag' || step.action.type === 'nudge';
  if (!isDrag || createdAnything(was, now) || resizedAnything(was, now)) return [];
  const violations: Violation[] = [];
  for (const entry of step.selectionAfter) {
    if (!entry.startsWith('region:')) continue;
    const name = entry.slice('region:'.length);
    const delta = regionTravel(name, was, now);
    const frame = was.regions.get(name)?.frame;
    if (!delta || !frame || (delta.x === 0 && delta.y === 0)) continue;
    for (const [id, stroke] of was.strokes) {
      if (!strokeAndGroupInside(id, frame, was)) continue;
      const moved = now.strokes.get(id);
      if (!moved) continue;
      const travel = { x: moved.points[0].x - stroke.points[0].x, y: moved.points[0].y - stroke.points[0].y };
      if (Math.abs(travel.x - delta.x) > PASTE_TOLERANCE || Math.abs(travel.y - delta.y) > PASTE_TOLERANCE) {
        violations.push({ invariant: 'a dragged region takes the drawings inside it', detail: `region ${name} moved ${delta.x},${delta.y} but stroke ${id} inside it moved ${travel.x},${travel.y}` });
      }
    }
  }
  return violations;
}

// R18a: anything a gesture leaves in the file, the canvas still shows — a region that had a frame
// keeps one.
function regionsMadeUnreachable(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  if (isHistoryAction(step.action)) return [];
  return [...was.regions]
    .filter(([name, region]) => region.frame && now.regions.has(name) && !now.regions.get(name)!.frame)
    .flatMap(([name]) => violation('a region stays on the canvas', `region ${name} is still in the file but no longer has a frame to see or select it by`));
}

// A second edge identical to an unlabelled one already there says nothing new.
function edgesDuplicated(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  const violations: Violation[] = [];
  for (const [source, edges] of now.edgesBySource) {
    const before = was.edgesBySource.get(source) ?? [];
    for (const edge of new Set(edges)) {
      const count = edges.filter((candidate) => candidate === edge).length;
      const countBefore = before.filter((candidate) => candidate === edge).length;
      if (count > 1 && count > countBefore) {
        violations.push({ invariant: 'no node gains a duplicate edge', detail: `${step.action.type} gave ${source} ${count} identical edges ${edge}` });
      }
    }
  }
  return violations;
}

// "Paste" from the canvas menu puts the top-left corner of what was copied where the menu opened.
function pasteAwayFromThePointer(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  if (step.trace.menuItem !== 'Paste' || !step.trace.menuAt) return [];
  const pasted = boundsOfAdded(was, now);
  if (!pasted) return [];
  const at = step.trace.menuAt;
  if (Math.abs(pasted.x - at.x) <= PASTE_TOLERANCE && Math.abs(pasted.y - at.y) <= PASTE_TOLERANCE) return [];
  return violation('paste here lands at the pointer', `asked to paste at ${Math.round(at.x)},${Math.round(at.y)}; the copy's top-left landed at ${Math.round(pasted.x)},${Math.round(pasted.y)}`);
}

// Pasted or duplicated copies are what is selected afterwards, so they can be moved straight away.
// Judged in the graph on screen — a dive can put it inside a `graph:` block — since a copied host's
// own subgraph is copied too, and what is inside it is never selected on its own.
function copiesLeftUnselected(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  if (!isCopying(step) || !contentChanged(step.before, step.after)) return [];
  const onScreen = new Set(step.editor.core.view.model.nodes.map((node) => node.id ?? node.name));
  const selectedNodes = [...step.selectionAfter].filter((entry) => entry.startsWith('node:')).map((entry) => entry.slice('node:'.length));
  const originals = selectedNodes.filter((id) => was.nodeIds.has(id));
  const unselectedCopies = [...now.nodeIds].filter((id) => !was.nodeIds.has(id) && onScreen.has(id) && !selectedNodes.includes(id));
  if (originals.length === 0 && unselectedCopies.length === 0) return [];
  return violation('copies are selected after a paste', `still selected: ${originals.join(', ') || 'none'}; copies not selected: ${unselectedCopies.join(', ') || 'none'}`);
}

// Delete removes what is selected — all of it, and nothing else.
function deleteThatMissedTheSelection(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  if (step.action.type !== 'command' || step.action.command !== 'delete') return [];
  const violations: Violation[] = [];
  const selected = step.selectionBefore;
  if (selected.size === 0 && contentChanged(step.before, step.after)) {
    violations.push({ invariant: 'delete removes exactly the selection', detail: 'delete with nothing selected changed files' });
  }
  for (const id of was.nodeIds) {
    const gone = !now.nodeIds.has(id);
    if (gone !== selected.has(`node:${id}`) && (gone || was.topNodes.has(id))) {
      violations.push({ invariant: 'delete removes exactly the selection', detail: `node ${id} was ${selected.has(`node:${id}`) ? '' : 'not '}selected but is ${gone ? 'gone' : 'still there'}` });
    }
  }
  for (const name of was.regions.keys()) {
    const gone = !now.regions.has(name);
    if (gone !== selected.has(`region:${name}`)) {
      violations.push({ invariant: 'delete removes exactly the selection', detail: `region ${name} was ${selected.has(`region:${name}`) ? '' : 'not '}selected but is ${gone ? 'gone' : 'still there'}` });
    }
  }
  return violations;
}

// Escape during a drag means the drag never happened.
function abandonedDragThatWrote(step: SessionStep): Violation[] {
  if (step.action.type !== 'abandoned-drag') return [];
  if (!contentChanged(step.before, step.after) && step.stepsAdded === 0) return [];
  return violation('escape cancels a drag', `a drag abandoned with Escape changed ${differingPaths(contentOf(step.before), contentOf(step.after)).join(', ') || 'nothing'} and added ${step.stepsAdded} undo step(s)`);
}

function selectAllThatMissedSomething(step: SessionStep): Violation[] {
  if (step.action.type !== 'command' || step.action.command !== 'select-all') return [];
  const { view } = step.editor.core;
  const missing = [
    ...view.model.nodes.filter((node) => !view.selection.has(node)).map((node) => `node ${node.name}`),
    ...view.model.contexts.filter((context) => !view.selectedRegions.has(context)).map((context) => `region ${context.block.name}`),
    ...(view.model.visuals?.strokes() ?? [])
      .filter((stroke) => !view.selectedDrawings.some((drawing) => drawing.id === stroke.id && drawing.model === view.model))
      .map((stroke) => `stroke ${stroke.id}`),
  ];
  return missing.length === 0 ? [] : violation('select all selects everything', `left out ${missing.join(', ')}`);
}

function fitThatLeftSomethingOut(step: SessionStep): Violation[] {
  if (step.action.type !== 'command' || step.action.command !== 'fit') return [];
  const { view } = step.editor.core;
  const onScreen = (point: Point) => {
    const screen = view.worldToScreen(point);
    return screen.x >= -1 && screen.y >= -1 && screen.x <= VIEWPORT.width + 1 && screen.y <= VIEWPORT.height + 1;
  };
  const rectOnScreen = (rect: Rect) => onScreen(rect) && onScreen({ x: rect.x + rect.w, y: rect.y + rect.h });
  const outside = [
    ...view.model.nodes.filter((node) => !rectOnScreen(view.rect(node))).map((node) => `node ${node.name}`),
    ...view.model.contexts
      .filter((context) => {
        const frame = regionRectOf(view.model, context);
        return frame && !rectOnScreen(frame);
      })
      .map((context) => `region ${context.block.name}`),
    ...(view.model.visuals?.strokes() ?? []).filter((stroke) => !stroke.points.every(onScreen)).map((stroke) => `stroke ${stroke.id}`),
  ];
  return outside.length === 0 ? [] : violation('fit to content shows everything', `off screen after fitting: ${outside.join(', ')}`);
}

// R9a: a node made inside a region joins it; one made outside does not. R9b: a subgraph host also
// stays in a region that held everything it was folded from.
function newNodesInTheWrongRegions(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  if (isCopying(step) || isHistoryAction(step.action)) return [];
  const folded = [...was.topNodes].filter(([id]) => !now.topNodes.has(id)).map(([, node]) => node.name);
  const heldAllFolded = (members: readonly string[]) => folded.length > 0 && folded.every((name) => members.includes(name));
  const violations: Violation[] = [];
  for (const [id, node] of now.topNodes) {
    if (was.nodeIds.has(id) || !node.pos) continue;
    for (const [name, region] of was.regions) {
      const after = now.regions.get(name);
      if (!region.frame || !after) continue;
      const enclosed = rectContainsRect(region.frame, node.pos);
      const belongs = enclosed || heldAllFolded(region.members);
      if (belongs !== after.members.includes(node.name)) {
        violations.push({ invariant: 'a new node joins the regions around it', detail: `${node.name} was made ${enclosed ? 'inside' : 'outside'} region ${name} but is ${belongs ? 'not ' : ''}a member` });
      }
    }
  }
  return violations;
}

// A click whose target was on the canvas — one aimed at a kind of thing there is none of never ran.
function isClickThatRan(step: SessionStep): boolean {
  return step.action.type === 'click' && step.trace.path != null;
}

function isCopying(step: SessionStep): boolean {
  const { action, trace } = step;
  const copyCommand = action.type === 'command' && (action.command === 'paste' || action.command === 'duplicate');
  return copyCommand || /^(Paste|Duplicate)/.test(trace.menuItem ?? '');
}

function createdAnything(was: GraphState, now: GraphState): boolean {
  return [...now.nodeIds].some((id) => !was.nodeIds.has(id)) || [...now.strokes.keys()].some((id) => !was.strokes.has(id));
}

// A resize is told from a move by a change of size: a node's, a stroke's, or a region's drawn area
// against the frame it had — a resized region always ends with a drawn area (R30).
function resizedAnything(was: GraphState, now: GraphState): boolean {
  const resizedNode = [...now.topNodes].some(([id, node]) => sizeChanged(was.topNodes.get(id)?.pos, node.pos));
  const resizedRegion = [...now.regions].some(([name, region]) => sizeChanged(was.regions.get(name)?.frame, region.pos));
  const resizedStroke = [...now.strokes].some(([id, stroke]) => {
    const before = was.strokes.get(id);
    return before !== undefined && sizeChanged(strokeBounds(before), strokeBounds(stroke), STROKE_SIZE_TOLERANCE);
  });
  return resizedNode || resizedRegion || resizedStroke;
}

function sizeChanged(before: Rect | null | undefined, after: Rect | null | undefined, tolerance = 0): boolean {
  if (!before || !after) return false;
  return Math.abs(before.w - after.w) > tolerance || Math.abs(before.h - after.h) > tolerance;
}

function travelOf(path: readonly Point[]): Point {
  const [first, last] = [path[0], path[path.length - 1]];
  return { x: last.x - first.x, y: last.y - first.y };
}

function translationsOf(was: GraphState, now: GraphState): { what: string; delta: Point }[] {
  const moves: { what: string; delta: Point }[] = [];
  for (const [id, node] of now.topNodes) {
    const old = was.topNodes.get(id)?.pos;
    if (old && node.pos && (old.x !== node.pos.x || old.y !== node.pos.y)) moves.push({ what: `node ${node.name}`, delta: { x: node.pos.x - old.x, y: node.pos.y - old.y } });
  }
  for (const [name, region] of now.regions) {
    const old = was.regions.get(name)?.pos;
    if (old && region.pos && old.w === region.pos.w && old.h === region.pos.h && (old.x !== region.pos.x || old.y !== region.pos.y)) {
      moves.push({ what: `region ${name}`, delta: { x: region.pos.x - old.x, y: region.pos.y - old.y } });
    }
  }
  for (const [id, stroke] of now.strokes) {
    const old = was.strokes.get(id);
    if (!old || old.points.length !== stroke.points.length) continue;
    const delta = { x: stroke.points[0].x - old.points[0].x, y: stroke.points[0].y - old.points[0].y };
    if (delta.x !== 0 || delta.y !== 0) moves.push({ what: `stroke ${id}`, delta });
  }
  return moves;
}

// How far a region travelled: its drawn area's move, or — with none drawn — its members'.
function regionTravel(name: string, was: GraphState, now: GraphState): Point | null {
  const before = was.regions.get(name);
  const after = now.regions.get(name);
  if (!before || !after) return null;
  if (before.pos && after.pos) return { x: after.pos.x - before.pos.x, y: after.pos.y - before.pos.y };
  const member = [...was.topNodes].find(([, node]) => before.members.includes(node.name));
  const start = member?.[1].pos;
  const end = member ? now.topNodes.get(member[0])?.pos : null;
  return start && end ? { x: end.x - start.x, y: end.y - start.y } : null;
}

function strokeAndGroupInside(id: string, frame: Rect, state: GraphState): boolean {
  const members = state.groups.find((group) => group.includes(id)) ?? [id];
  return members.every((member) => {
    const stroke = state.strokes.get(member);
    return stroke != null && rectContainsRect(frame, strokeBounds(stroke));
  });
}

function boundsOfAdded(was: GraphState, now: GraphState): Point | null {
  const corners: Point[] = [];
  for (const [id, node] of now.topNodes) if (!was.nodeIds.has(id) && node.pos) corners.push(node.pos);
  for (const [name, region] of now.regions) if (!was.regions.has(name) && region.pos) corners.push(region.pos);
  for (const [id, stroke] of now.strokes) if (!was.strokes.has(id)) corners.push(...stroke.points);
  if (corners.length === 0) return null;
  return { x: Math.min(...corners.map((corner) => corner.x)), y: Math.min(...corners.map((corner) => corner.y)) };
}
