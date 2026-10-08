// What must hold after every step of every session, whatever the step was. None of these name a
// feature: each is a rule the whole editor owes the user, so a feature added later is held to it
// without anyone writing a test for that feature.

import { parseFlow, serializeFlow, type FlowDocument, type FlowNode } from '../src/shared/flow-format.js';
import { allNodes, buildModel, contextBlockNamed, regionRectOf } from '../src/client/flow-doc.js';
import { rectContainsRect } from '../src/shared/rect-math.js';
import { lintFlowFile } from '../src/shared/flow-lint.js';
import { lintCanvasLayer } from '../src/shared/canvas-layer-lint.js';
import { canvasLayerPathOf, flowPathOfCanvasLayer, isCanvasLayerPath, isFlowPath, parseCanvasLayer } from '../src/shared/canvas-layer.js';
import { MANIFEST_FILE_NAME } from '../src/shared/manifest.js';
import type { HeadlessEditor } from './editor-harness.js';

export interface Violation {
  invariant: string;
  detail: string;
}

export type FileSnapshot = ReadonlyMap<string, string>;

// The manifest is UI state — cameras, open frames — saved on its own debounce and outside the
// undo history by design, so it never counts as content.
export function contentOf(snapshot: FileSnapshot): Map<string, string> {
  return new Map([...snapshot].filter(([path]) => path !== MANIFEST_FILE_NAME));
}

export function contentChanged(before: FileSnapshot, after: FileSnapshot): boolean {
  return differingPaths(contentOf(before), contentOf(after)).length > 0;
}

export function differingPaths(expected: FileSnapshot, actual: FileSnapshot): string[] {
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  return [...paths].filter((path) => expected.get(path) !== actual.get(path)).sort();
}

// Every file the editor leaves behind is one it can read back without losing anything: a .flow
// lints without errors (content dropped or misread) and is a fixed point of parse → serialize,
// and a canvas layer lints without errors against its graph.
export function fileViolations(snapshot: FileSnapshot): Violation[] {
  const violations: Violation[] = [];
  for (const [path, text] of snapshot) {
    if (isFlowPath(path)) violations.push(...flowFileViolations(path, text));
    else if (isCanvasLayerPath(path)) violations.push(...layerFileViolations(path, text, snapshot.get(flowPathOfCanvasLayer(path)) ?? null));
  }
  return violations;
}

function flowFileViolations(path: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const diagnostic of lintFlowFile(text)) {
    if (diagnostic.severity !== 'error') continue;
    violations.push({ invariant: 'written .flow lints clean', detail: `${path}:${diagnostic.line} ${diagnostic.rule} — ${diagnostic.message}` });
  }
  if (serializeFlow(parseFlow(text)) !== text) {
    violations.push({ invariant: 'written .flow round-trips', detail: `${path} changes when parsed and serialized again` });
  }
  for (const node of allNodes(parseFlow(text))) {
    const pos = node.pos;
    if (pos && ![pos.x, pos.y, pos.w, pos.h].every(Number.isFinite)) {
      violations.push({ invariant: 'positions are finite', detail: `${path}: ${node.name} has pos ${JSON.stringify(pos)}` });
    }
  }
  return violations;
}

function layerFileViolations(path: string, text: string, flowText: string | null): Violation[] {
  return lintCanvasLayer(text, flowText)
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => ({ invariant: 'written canvas layer lints clean', detail: `${path} ${diagnostic.rule} — ${diagnostic.message}` }));
}

// R13–R16: a node a drag sets down is a member of exactly the regions whose frame, as it stood
// when the drag began, fully encloses it — however many regions overlap there and whatever else
// the drag carried along. Judged on the files alone, so it applies only to a step that translated
// top-level nodes and nothing else of the graph: region drags follow R28–R29 instead, which is why
// the caller holds this back whenever the step left a region selected.
export function dropMembershipViolations(before: FileSnapshot, after: FileSnapshot, path: string): Violation[] {
  const beforeText = before.get(path);
  const afterText = after.get(path);
  if (!beforeText || !afterText) return [];
  const beforeDoc = parseFlow(beforeText);
  const afterDoc = parseFlow(afterText);
  const moved = translatedNodes(beforeDoc, afterDoc);
  if (moved.length === 0 || regionAreasChanged(beforeDoc, afterDoc)) return [];
  const framesAtDragStart = buildModel(beforeDoc, null);
  const violations: Violation[] = [];
  for (const node of moved) {
    for (const context of framesAtDragStart.contexts) {
      const frame = regionRectOf(framesAtDragStart, context);
      if (!frame || !node.pos) continue;
      const enclosed = rectContainsRect(frame, node.pos);
      const member = contextBlockNamed(afterDoc, context.block.name)?.members.includes(node.name) ?? false;
      if (enclosed === member) continue;
      violations.push({
        invariant: 'a dropped node belongs to exactly the regions enclosing it',
        detail: enclosed
          ? `${node.name} came to rest inside ${context.block.name}'s frame but is not a member`
          : `${node.name} came to rest outside ${context.block.name}'s frame but is still a member`,
      });
    }
  }
  return violations;
}

// The top-level nodes a step moved without resizing, or none when the step did anything else to
// them — created, deleted or resized one.
function translatedNodes(beforeDoc: FlowDocument, afterDoc: FlowDocument): FlowNode[] {
  const beforeNodes = buildModel(beforeDoc, null).nodes;
  const afterNodes = buildModel(afterDoc, null).nodes;
  if (beforeNodes.length !== afterNodes.length) return [];
  const moved: FlowNode[] = [];
  for (const node of afterNodes) {
    const previous = beforeNodes.find((candidate) => candidate.id === node.id);
    if (!previous?.pos || !node.pos) return [];
    if (previous.pos.w !== node.pos.w || previous.pos.h !== node.pos.h) return [];
    if (previous.pos.x !== node.pos.x || previous.pos.y !== node.pos.y) moved.push(node);
  }
  return moved;
}

function regionAreasChanged(beforeDoc: FlowDocument, afterDoc: FlowDocument): boolean {
  const areasOf = (doc: FlowDocument) => JSON.stringify(buildModel(doc, null).contexts.map((context) => [context.block.name, context.block.pos]));
  return areasOf(beforeDoc) !== areasOf(afterDoc);
}

// The selection only ever holds things that exist: nodes some loaded document still contains,
// regions of the model on screen, strokes still in their file's layer.
export function selectionViolations(editor: HeadlessEditor): Violation[] {
  const { core } = editor;
  const view = core.view;
  const violations: Violation[] = [];
  for (const node of view.selection) {
    const live = node.id ? core.findNode(node.id) : null;
    if (live !== node) {
      violations.push({ invariant: 'selection holds only live objects', detail: `node ${node.name} (${node.id}) is selected but no document holds it` });
    }
  }
  for (const edge of view.selectedEdges) {
    if (!core.findEdgeWhere((candidate) => candidate === edge)) {
      violations.push({ invariant: 'selection holds only live objects', detail: `edge ${edge.from.name} -> ${edge.spec.target} is selected but not on the canvas` });
    }
  }
  for (const region of view.selectedRegions) {
    if (!view.model.contexts.includes(region)) {
      violations.push({ invariant: 'selection holds only live objects', detail: `region ${region.block.name} is selected but not in the model` });
    }
  }
  for (const drawing of view.selectedDrawings) {
    const flowPath = drawing.model.sourcePath;
    const layerText = flowPath ? editor.workspace.file(canvasLayerPathOf(flowPath)) : null;
    const stored = parseCanvasLayer(layerText).drawings.some((entry) => entry.id === drawing.id);
    if (!stored) {
      violations.push({ invariant: 'selection holds only live objects', detail: `stroke ${drawing.id} is selected but not in ${flowPath}'s layer` });
    }
  }
  return violations;
}

export interface HistoryGrowth {
  // Undo steps the action added to the history.
  stepsAdded: number;
  // Separate gestures the action was made of — a double-click is two presses.
  gestures: number;
}

// Every gesture is at most one undo step, and an edit with no step at all is one the user cannot
// take back. Undoing the steps an action added puts back every file exactly as it was before it;
// redoing them puts back exactly what it wrote. A .flow file the action created is the one thing
// undo may leave — an extracted subgraph's new file is not part of the step.
export async function undoViolations(
  editor: HeadlessEditor,
  before: FileSnapshot,
  after: FileSnapshot,
  { stepsAdded, gestures }: HistoryGrowth,
): Promise<Violation[]> {
  if (stepsAdded === 0) {
    return [{ invariant: 'every edit is undoable', detail: `the action changed ${differingPaths(contentOf(before), contentOf(after)).join(', ')} but added no undo step` }];
  }
  const violations: Violation[] = [];
  if (stepsAdded > gestures) {
    violations.push({ invariant: 'one gesture is one undo step', detail: `${gestures} gesture(s) added ${stepsAdded} undo steps` });
  }
  for (let step = 0; step < stepsAdded; step++) {
    editor.core.undo();
    await editor.settle();
  }
  const restored = contentOf(editor.workspace.snapshot());
  const createdFlows = [...contentOf(after).keys()].filter((path) => isFlowPath(path) && !before.has(path));
  const leftByDesign = (path: string) => createdFlows.some((created) => path === created || path === canvasLayerPathOf(created));
  const notRestored = differingPaths(contentOf(before), restored).filter((path) => !leftByDesign(path));
  if (notRestored.length > 0) {
    violations.push({ invariant: 'undo restores the action', detail: `undo left ${notRestored.join(', ')} different from before the action` });
  }
  for (let step = 0; step < stepsAdded; step++) {
    editor.core.redo();
    await editor.settle();
  }
  const notRedone = differingPaths(contentOf(after), contentOf(editor.workspace.snapshot()));
  if (notRedone.length > 0) {
    violations.push({ invariant: 'redo reapplies the step', detail: `redo left ${notRedone.join(', ')} different from after the action` });
  }
  return violations;
}
