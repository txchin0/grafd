// What a user can expect of a single step, judged with the step in hand: what was asked, with which
// tool, what was selected before and after, and what the files became. Where session-invariants.ts
// holds rules about any state, these hold the editor to common sense about each kind of action —
// a click changes nothing, shift changes one thing, a dragged thing stays under the pointer, a
// paste lands where it was asked to. Each was a bug once; the rule keeps its whole class closed.

import type { Tool } from '../src/client/canvas/canvas-view.js';
import type { Point } from '../src/client/geometry.js';
import { allNodes, buildModel, regionRectOf, type FlowModel } from '../src/client/flow-doc.js';
import { parseFlow, type Rect } from '../src/shared/flow-format.js';
import { canvasLayerPathOf, isCanvasLayerPath, parseCanvasLayer } from '../src/shared/canvas-layer.js';
import { isDrawableText, textDrawingOf, type TextDrawing } from '../src/shared/canvas-text.js';
import { axesOf, isResizeEdge, type ResizeEdge } from '../src/client/canvas/resize-handles.js';
import { boundsOfRects, rectContainsRect } from '../src/shared/rect-math.js';
import { STROKE_KIND, drawingBounds, strokeBounds, strokePointBounds, strokePointsOf, type Stroke } from '../src/shared/canvas-drawings.js';
import type { HeadlessEditor } from './editor-harness.js';
import { isHistoryAction, type ActionTrace, type SessionAction } from './session-actions.js';
import { contentChanged, contentOf, differingPaths, type FileSnapshot, type Violation } from './session-invariants.js';

// Node moves snap to this grid, so a dragged node can land up to this far from the pointer's path.
const SNAP = 8;
// A pasted stroke's points are stored to a tenth of a unit, and a pasted offset is rounded.
const PASTE_TOLERANCE = 1;
// The same rounding can leave two points carried by one move a tenth of a unit apart.
const RIGID_MOVE_TOLERANCE = 0.15;
// A text box is stored to a tenth of a unit too, which can tilt a resized box's proportions by
// that much over its height.
const TEXT_PROPORTION_TOLERANCE = 0.02;
// A node's or region's sides are stored exactly; a drawing's to a tenth of a unit.
const EXACT_SIDE_TOLERANCE = 0.01;
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
  texts: Map<string, TextDrawing>;
  groups: string[][];
  edgesBySource: Map<string, string[]>;
}

function graphStateOf(snapshot: FileSnapshot, flowPath: string): GraphState {
  const doc = parseFlow(snapshot.get(flowPath) ?? '---\nname: gone\n---\n');
  const model = buildModel(doc, null);
  const layer = parseCanvasLayer(snapshot.get(canvasLayerPathOf(flowPath)) ?? null);
  const strokes = new Map<string, Stroke>();
  const texts = new Map<string, TextDrawing>();
  for (const drawing of layer.drawings) {
    const points = strokePointsOf(drawing.points);
    if (drawing.graph == null && points && typeof drawing.id === 'string') {
      strokes.set(drawing.id, { kind: STROKE_KIND, id: drawing.id, graph: null, color: null, width: 'medium', points });
    }
    const text = textDrawingOf(drawing);
    if (text && text.graph == null) texts.set(text.id, text);
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
    texts,
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
    ...emptiedRegionsMovedOffTheirFrame(step, was, now),
    ...edgesDuplicated(step, was, now),
    ...pasteAwayFromThePointer(step, was, now),
    ...copiesLeftUnselected(step, was, now),
    ...deleteThatMissedTheSelection(step, was, now),
    ...abandonedDragThatWrote(step),
    ...selectAllThatMissedSomething(step),
    ...fitThatLeftSomethingOut(step),
    ...newNodesInTheWrongRegions(step, was, now),
    ...newTextNotAsTyped(step, was, now),
    ...editedTextNotAsTyped(step),
    ...textResizedOtherThanWhole(step, was, now),
    ...sideDragThatMovedOtherSides(step, was, now),
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
  if (createdAnything(was, now) || reshapedAnything(was, now)) return [];
  const pointer = travelOf(step.trace.path);
  return translationsOf(was, now)
    .filter(({ delta }) => Math.abs(delta.x - pointer.x) > SNAP || Math.abs(delta.y - pointer.y) > SNAP)
    .flatMap(({ what, delta }) => violation('a dragged thing follows the pointer', `${what} moved ${Math.round(delta.x)},${Math.round(delta.y)} for a pointer move of ${Math.round(pointer.x)},${Math.round(pointer.y)}`));
}

// R28b: a dragged region takes along the drawings lying wholly inside its frame, a group only whole.
function regionDragThatLeftDrawings(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  const isDrag = step.action.type === 'drag' || step.action.type === 'nudge';
  if (!isDrag || createdAnything(was, now) || reshapedAnything(was, now)) return [];
  const violations: Violation[] = [];
  for (const entry of step.selectionAfter) {
    if (!entry.startsWith('region:')) continue;
    const name = entry.slice('region:'.length);
    const delta = regionTravel(name, was, now);
    const frame = was.regions.get(name)?.frame;
    if (!delta || !frame || (delta.x === 0 && delta.y === 0)) continue;
    for (const id of [...was.strokes.keys(), ...was.texts.keys()]) {
      if (!drawingAndGroupInside(id, frame, was)) continue;
      const travel = drawingTravel(id, was, now);
      if (!travel) continue;
      if (Math.abs(travel.x - delta.x) > PASTE_TOLERANCE || Math.abs(travel.y - delta.y) > PASTE_TOLERANCE) {
        violations.push({ invariant: 'a dragged region takes the drawings inside it', detail: `region ${name} moved ${delta.x},${delta.y} but drawing ${id} inside it moved ${travel.x},${travel.y}` });
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

// R18a again: the frame an emptied region keeps is the one the file gave it. An unfolded frame
// warps the nodes around it on screen, and the frame painted around them with it, but the warp is
// view-only and never reaches disk. A resize shapes the area it leaves, so it is judged by the
// side-drag rule instead.
function emptiedRegionsMovedOffTheirFrame(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  if (isHistoryAction(step.action) || step.trace.pressedKind === 'region-handle') return [];
  return [...now.regions].flatMap(([name, region]) => {
    const before = was.regions.get(name);
    if (!before?.frame || before.pos || !region.pos || region.members.length > 0) return [];
    if (sameRect(region.pos, roundedRect(before.frame))) return [];
    return violation('an emptied region keeps the frame the file gave it', `region ${name} was laid out at ${JSON.stringify(before.frame)} but kept ${JSON.stringify(region.pos)}`);
  });
}

function roundedRect(rect: Rect): Rect {
  return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
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

// Pasting the same copy again from the keyboard lands each paste a step further on than the last,
// so no paste hides exactly under the one before it. Unlike the rules above this one remembers an
// earlier step — the last keyboard paste's landing — so a session keeps one checker for its whole
// run; copying or cutting afresh starts the cascade over.
export function createRepeatedPasteCheck(): (step: SessionStep) => Violation[] {
  let lastLanding: Point | null = null;
  return (step) => {
    if (refillsTheClipboard(step)) lastLanding = null;
    if (!isKeyboardPaste(step)) return [];
    const landing = boundsOfAdded(graphStateOf(step.before, step.flowPath), graphStateOf(step.after, step.flowPath));
    if (!landing) return [];
    const previous = lastLanding;
    lastLanding = landing;
    if (!previous || previous.x !== landing.x || previous.y !== landing.y) return [];
    return violation('pasting again never lands on the last paste', `two pastes in a row both landed at ${landing.x},${landing.y}`);
  };
}

function refillsTheClipboard(step: SessionStep): boolean {
  const { action, trace } = step;
  const copyCommand = action.type === 'command' && (action.command === 'copy' || action.command === 'cut');
  return copyCommand || /^(Copy|Cut)$/.test(trace.menuItem ?? '');
}

function isKeyboardPaste(step: SessionStep): boolean {
  return step.action.type === 'command' && step.action.command === 'paste';
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
    ...(view.model.visuals?.drawings() ?? [])
      .filter((laidOut) => !view.selectedDrawings.some((drawing) => drawing.id === laidOut.id && drawing.model === view.model))
      .map((laidOut) => `drawing ${laidOut.id}`),
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
    ...(view.model.visuals?.drawings() ?? []).filter((drawing) => !rectOnScreen(drawingBounds(drawing))).map((drawing) => `drawing ${drawing.id}`),
  ];
  return outside.length === 0 ? [] : violation('fit to content shows everything', `off screen after fitting: ${outside.join(', ')}`);
}

// R9a: a node made inside a region joins it; one made outside does not. R9b: a subgraph host also
// stays in a region that held everything it was folded from. Judged where the node ended up, so a
// grab-affordance step is left out: its click can make a ghost real, and its drag then resize that
// node across a region's frame — and a resize never changes which regions a node belongs to.
function newNodesInTheWrongRegions(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  if (isCopying(step) || isHistoryAction(step.action) || step.action.type === 'grab-affordance') return [];
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

// A text typed into a new text's editor lands as typed, once, where the press was — less the blank
// lines and spaces Enter and the space bar leave at its end. Nothing but blanks writes nothing.
function newTextNotAsTyped(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  const request = step.trace.textRequest;
  if (step.action.type !== 'type-text' || request?.kind !== 'new' || step.trace.typed == null) return [];
  const typed = step.trace.typed.trimEnd();
  const added = [...textsIn(step.after)].filter(([id]) => !textsIn(step.before).has(id)).map(([, text]) => text);
  if (!isDrawableText(typed)) {
    if (!contentChanged(step.before, step.after) && step.stepsAdded === 0) return [];
    return violation('a blank text writes nothing', `finishing a new text as ${JSON.stringify(step.trace.typed)} changed ${differingPaths(contentOf(step.before), contentOf(step.after)).join(', ') || 'nothing'}`);
  }
  if (added.length !== 1 || added[0].text !== typed) {
    return violation('a text lands as typed', `typed ${JSON.stringify(step.trace.typed)} and the layers gained ${JSON.stringify(added.map((text) => text.text))}`);
  }
  const landedOnScreen = request.frameHost == null && step.editor.core.openFlow()?.scope == null;
  const landed = now.texts.get(added[0].id);
  if (!landedOnScreen || !landed || was.texts.has(landed.id)) return [];
  const offBy = Math.max(Math.abs(landed.box.x - request.topLeft.x), Math.abs(landed.box.y - request.topLeft.y));
  if (offBy <= RIGID_MOVE_TOLERANCE) return [];
  return violation('a text lands where it was placed', `placed at ${request.topLeft.x},${request.topLeft.y}, its box starts at ${landed.box.x},${landed.box.y}`);
}

// Typing into an existing text changes its words and nothing else of it: it stays where it starts
// and as large as it was. Emptied, it is gone.
function editedTextNotAsTyped(step: SessionStep): Violation[] {
  const request = step.trace.textRequest;
  if (step.action.type !== 'type-text' || request?.kind !== 'existing' || step.trace.typed == null) return [];
  const typed = step.trace.typed.trimEnd();
  const before = textsIn(step.before).get(request.drawing.id);
  const after = textsIn(step.after).get(request.drawing.id);
  if (!before) return [];
  if (!isDrawableText(typed)) {
    return after ? violation('an emptied text is deleted', `text ${before.id} was emptied but is still there`) : [];
  }
  if (!after || after.text !== typed) {
    return violation('a text lands as typed', `text ${before.id} was typed as ${JSON.stringify(typed)} but reads ${JSON.stringify(after?.text ?? null)}`);
  }
  const moved = Math.abs(after.box.x - before.box.x) > RIGID_MOVE_TOLERANCE || Math.abs(after.box.y - before.box.y) > RIGID_MOVE_TOLERANCE;
  const resized = Math.abs(after.size - before.size) > RIGID_MOVE_TOLERANCE;
  if (!moved && !resized) return [];
  return violation('editing a text keeps where it starts and its size', `text ${before.id} went from ${JSON.stringify(before.box)} to ${JSON.stringify(after.box)}`);
}

// A text resizes one of two ways, alone or in a group: whole, its size growing with its box, or
// re-wrapped to a new width at the size it had. A box stretched any other way draws nothing like
// what the user dragged.
function textResizedOtherThanWhole(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  if (isHistoryAction(step.action) || step.action.type === 'type-text') return [];
  return [...now.texts]
    .filter(([id, text]) => {
      const before = was.texts.get(id);
      return before !== undefined && sizeChanged(before.box, text.box) && !scaledWhole(before, text) && !rewrapped(before, text);
    })
    .flatMap(([id, text]) => {
      const before = was.texts.get(id)!;
      return violation('a resized text scales whole or re-wraps', `text ${id} went from ${JSON.stringify(before.box)} at ${before.size} to ${JSON.stringify(text.box)} at ${text.size}`);
    });
}

function scaledWhole(before: TextDrawing, after: TextDrawing): boolean {
  const widthScale = after.box.w / before.box.w;
  const isProportional = (scale: number) => Math.abs(scale - widthScale) / widthScale <= TEXT_PROPORTION_TOLERANCE;
  return isProportional(after.box.h / before.box.h) && isProportional(after.size / before.size);
}

function rewrapped(before: TextDrawing, after: TextDrawing): boolean {
  return after.wrap && Math.abs(after.size - before.size) <= RIGID_MOVE_TOLERANCE;
}

// A side drags only its own side: the side opposite it stays, and so does the side at the start
// of the axis it runs along — the top for a left or right side, the left for a top or bottom.
// The far end of that axis stays too, unless text is being resized: re-wrapped text grows
// downward, and text scaled evenly grows rightward.
function sideDragThatMovedOtherSides(step: SessionStep, was: GraphState, now: GraphState): Violation[] {
  const handle = step.trace.grabbedHandle;
  if (step.action.type !== 'grab-affordance' || !handle || !isResizeEdge(handle)) return [];
  return reshapedRects(was, now).flatMap(({ what, before, after, holdsText, tolerance }) => {
    const moved = sidesHeldBy(handle, holdsText).filter((side) => !sideStayed(before, after, side, handle, tolerance));
    return moved.length === 0 ? [] : violation('a side drag moves only that side', `dragging the ${handle} side moved the ${moved.join(', ')} side of ${what}: ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
  });
}

type RectSide = 'left' | 'right' | 'top' | 'bottom';

function sidesHeldBy(handle: ResizeEdge, holdsText: boolean): RectSide[] {
  const axes = axesOf(handle);
  const held: RectSide[] = axes.x !== 0
    ? [oppositeSideOf(handle), 'top', ...(holdsText ? [] : ['bottom' as const])]
    : [oppositeSideOf(handle), 'left', ...(holdsText ? [] : ['right' as const])];
  return held;
}

function oppositeSideOf(handle: ResizeEdge): RectSide {
  const axes = axesOf(handle);
  if (axes.x !== 0) return axes.x === 1 ? 'left' : 'right';
  return axes.y === 1 ? 'top' : 'bottom';
}

// A region has no minimum size, so its dragged side can be taken past the opposite one, which
// turns the rectangle over: the side that stayed is then the other end of its axis.
function sideStayed(before: Rect, after: Rect, side: RectSide, handle: ResizeEdge, tolerance: number): boolean {
  const stayedAt = sideOf(before, side);
  const endsItCanBe = side === oppositeSideOf(handle) ? endsOfAxisOf(side) : [side];
  return endsItCanBe.some((end) => Math.abs(sideOf(after, end) - stayedAt) <= tolerance);
}

function endsOfAxisOf(side: RectSide): RectSide[] {
  return side === 'left' || side === 'right' ? ['left', 'right'] : ['top', 'bottom'];
}

function sideOf(rect: Rect, side: RectSide): number {
  switch (side) {
    case 'left':
      return rect.x;
    case 'right':
      return rect.x + rect.w;
    case 'top':
      return rect.y;
    case 'bottom':
      return rect.y + rect.h;
  }
}

// Everything whose shape a step changed: each node and region on its own, and the drawings — a
// lone one or a whole group, resized as one — by their combined geometry.
function reshapedRects(was: GraphState, now: GraphState): { what: string; before: Rect; after: Rect; holdsText: boolean; tolerance: number }[] {
  const reshaped: { what: string; before: Rect; after: Rect; holdsText: boolean; tolerance: number }[] = [];
  for (const [id, node] of now.topNodes) {
    const before = was.topNodes.get(id)?.pos;
    if (before && node.pos && sizeChanged(before, node.pos)) reshaped.push({ what: `node ${node.name}`, before, after: node.pos, holdsText: false, tolerance: EXACT_SIDE_TOLERANCE });
  }
  // A region is measured from the frame the file gave it — its drawn area grown to hold its
  // members, or their bounds when it has none — since that is what a resize starts from. The one
  // painted can differ while a subgraph is unfolded, and that difference must never be written.
  for (const [name, region] of now.regions) {
    const before = was.regions.get(name);
    const posChanged = region.pos && !(before?.pos && sameRect(before.pos, region.pos));
    if (before?.frame && region.pos && posChanged && sizeChanged(before.frame, region.pos)) {
      reshaped.push({ what: `region ${name}`, before: before.frame, after: region.pos, holdsText: false, tolerance: EXACT_SIDE_TOLERANCE });
    }
  }
  const changedStrokes = [...now.strokes.keys()].filter((id) => was.strokes.has(id) && drawingTravel(id, was, now) === null);
  const changedTexts = [...now.texts.keys()].filter((id) => was.texts.has(id) && drawingTravel(id, was, now) === null);
  const geometryIn = (state: GraphState) => boundsOfRects([
    ...changedStrokes.map((id) => strokePointBounds(state.strokes.get(id)!)),
    ...changedTexts.map((id) => state.texts.get(id)!.box),
  ]);
  const before = geometryIn(was);
  const after = geometryIn(now);
  if (before && after) {
    reshaped.push({ what: `drawings ${[...changedStrokes, ...changedTexts].join(', ')}`, before, after, holdsText: changedTexts.length > 0, tolerance: RIGID_MOVE_TOLERANCE });
  }
  return reshaped;
}

// Every text in every layer of a snapshot, by id: a text can be made inside any graph on screen.
function textsIn(snapshot: FileSnapshot): Map<string, TextDrawing> {
  const texts = new Map<string, TextDrawing>();
  for (const [path, contents] of snapshot) {
    if (!isCanvasLayerPath(path)) continue;
    for (const drawing of parseCanvasLayer(contents).drawings) {
      const text = textDrawingOf(drawing);
      if (text) texts.set(text.id, text);
    }
  }
  return texts;
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
  return [...now.nodeIds].some((id) => !was.nodeIds.has(id))
    || [...now.strokes.keys()].some((id) => !was.strokes.has(id))
    || [...now.texts.keys()].some((id) => !was.texts.has(id));
}

// Anything changed in shape rather than only moved: a node or a region's drawn area resized
// against the frame it had — a resized region always ends with a drawn area (R30) — a stroke
// whose points did not all travel together, or a text whose box changed size. Judging a stroke by
// every point rather than by its size means any transform other than a move counts, whatever it
// does to the bounds.
function reshapedAnything(was: GraphState, now: GraphState): boolean {
  const resizedNode = [...now.topNodes].some(([id, node]) => sizeChanged(was.topNodes.get(id)?.pos, node.pos));
  const resizedRegion = [...now.regions].some(([name, region]) => sizeChanged(was.regions.get(name)?.frame, region.pos));
  const reshapedStroke = [...now.strokes].some(([id, stroke]) => {
    const before = was.strokes.get(id);
    return before !== undefined && rigidTranslation(before, stroke) === null;
  });
  const resizedText = [...now.texts].some(([id, text]) => sizeChanged(was.texts.get(id)?.box, text.box));
  return resizedNode || resizedRegion || reshapedStroke || resizedText;
}

function sizeChanged(before: Rect | null | undefined, after: Rect | null | undefined): boolean {
  if (!before || !after) return false;
  return before.w !== after.w || before.h !== after.h;
}

// How far a stroke moved when every one of its points moved that far; null when it changed in any
// other way.
function rigidTranslation(before: Stroke, after: Stroke): Point | null {
  if (before.points.length !== after.points.length) return null;
  const offset = { x: after.points[0].x - before.points[0].x, y: after.points[0].y - before.points[0].y };
  const carried = before.points.every((point, index) =>
    Math.abs(after.points[index].x - point.x - offset.x) <= RIGID_MOVE_TOLERANCE
    && Math.abs(after.points[index].y - point.y - offset.y) <= RIGID_MOVE_TOLERANCE);
  return carried ? offset : null;
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
    const delta = old ? rigidTranslation(old, stroke) : null;
    if (delta && (delta.x !== 0 || delta.y !== 0)) moves.push({ what: `stroke ${id}`, delta });
  }
  for (const id of now.texts.keys()) {
    const delta = drawingTravel(id, was, now);
    if (delta && (delta.x !== 0 || delta.y !== 0)) moves.push({ what: `text ${id}`, delta });
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

function drawingAndGroupInside(id: string, frame: Rect, state: GraphState): boolean {
  const members = state.groups.find((group) => group.includes(id)) ?? [id];
  return members.every((member) => {
    const bounds = boundsOfDrawing(member, state);
    return bounds != null && rectContainsRect(frame, bounds);
  });
}

function boundsOfDrawing(id: string, state: GraphState): Rect | null {
  const stroke = state.strokes.get(id);
  if (stroke) return strokeBounds(stroke);
  return state.texts.get(id)?.box ?? null;
}

// How far a drawing moved when it only moved: every point of a stroke alike, a text's box at the
// same size. Null when it changed in any other way, or is not in both states.
function drawingTravel(id: string, was: GraphState, now: GraphState): Point | null {
  const [strokeBefore, strokeAfter] = [was.strokes.get(id), now.strokes.get(id)];
  if (strokeBefore && strokeAfter) return rigidTranslation(strokeBefore, strokeAfter);
  const [textBefore, textAfter] = [was.texts.get(id), now.texts.get(id)];
  if (!textBefore || !textAfter || sizeChanged(textBefore.box, textAfter.box)) return null;
  return { x: textAfter.box.x - textBefore.box.x, y: textAfter.box.y - textBefore.box.y };
}

function boundsOfAdded(was: GraphState, now: GraphState): Point | null {
  const corners: Point[] = [];
  for (const [id, node] of now.topNodes) if (!was.nodeIds.has(id) && node.pos) corners.push(node.pos);
  for (const [name, region] of now.regions) if (!was.regions.has(name) && region.pos) corners.push(region.pos);
  for (const [id, stroke] of now.strokes) if (!was.strokes.has(id)) corners.push(...stroke.points);
  for (const [id, text] of now.texts) if (!was.texts.has(id)) corners.push(text.box);
  if (corners.length === 0) return null;
  return { x: Math.min(...corners.map((corner) => corner.x)), y: Math.min(...corners.map((corner) => corner.y)) };
}
