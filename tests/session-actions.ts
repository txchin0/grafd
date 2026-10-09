// What a random session does: the gestures, menu choices, text edits and keyboard commands a user
// can perform, each aimed at a *kind* of place rather than at coordinates. A pick says "the second
// region's border" or "a point on a stroke", and is resolved against whatever is on the canvas
// when the step runs — so the same generated session stays meaningful as earlier steps create,
// move and delete things, and fast-check can shrink it without the aims going stale.

import fc from 'fast-check';
import type { Tool } from '../src/client/canvas/canvas-view.js';
import { regionRectOf } from '../src/client/flow-doc.js';
import { collapseToSingleLine, type FlowNode } from '../src/shared/flow-format.js';
import type { Point } from '../src/client/geometry.js';
import type { MenuItem } from '../src/client/context-menu.js';
import { nodeBadges } from '../src/client/canvas/node-badges.js';
import { EDITOR_COMMANDS, type EditorCommand } from '../src/client/editor-commands.js';
import { STROKE_KIND, type Stroke } from '../src/shared/canvas-drawings.js';
import { TEXT_KIND, type TextDrawing } from '../src/shared/canvas-text.js';
import type { TextEditRequest } from '../src/client/text-drawing-editor.js';
import type { ResizeHandle } from '../src/client/canvas/resize-handles.js';
import type { HeadlessEditor } from './editor-harness.js';

// What a pick can aim at. Handles, ports and grips are all one kind, `affordance`, resolved
// against what the view itself reports is on screen (`CanvasView.affordances`), so a target never
// re-derives where the view draws one.
export const TARGET_KINDS = [
  'node',
  'frame-node',
  'badge',
  'ghost',
  'region-border',
  'region-inside',
  'edge',
  'edge-line',
  'stroke',
  'text',
  'affordance',
  'empty',
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface TargetPick {
  kind: TargetKind;
  // Wrapped around however many of that kind are on the canvas when the step runs.
  index: number;
  nudge: Point;
}

export const TOOLS = ['select', 'node', 'context', 'draw', 'text'] as const satisfies readonly Tool[];

// Every keyboard command the page binds, from the same table it binds them with.
export const COMMANDS = EDITOR_COMMANDS;
export type Command = EditorCommand;

// What people actually type into a name or description field, the awkward cases included: the
// format's own punctuation, surrounding and inner whitespace, a name already taken, nothing. A
// name field is a single-line input, so no name here holds a line break.
export const TYPED_NAMES = [
  'Renamed',
  'Beta',
  '',
  '   ',
  'a: b',
  'x -> y',
  '# heading',
  '{Inner}',
  'say "hi"',
  'trailing  ',
  'émoji 🎉',
  '- item',
  'id: fake',
  '---',
] as const;

export const TYPED_DESCRIPTIONS = [
  'plain words',
  '',
  'two\nlines',
  'a "quoted" word',
  'colon: here',
  '  padded  ',
  'back\\slash',
  '# not a comment',
  'ends with a backslash\\',
] as const;

// What people type as free text on the canvas: a word, several lines, nothing at all, only the
// blank lines Enter leaves behind, and characters that mean something elsewhere in the format.
export const TYPED_TEXTS = [
  'Note',
  'two\nlines',
  '',
  '   ',
  'trailing\n\n',
  '-> not an edge',
  'émoji 🎉',
  '{"json": true}',
] as const;

export type SessionAction =
  | { type: 'tool'; tool: Tool }
  | { type: 'click'; target: TargetPick; shift: boolean }
  | { type: 'double-click'; target: TargetPick }
  | { type: 'drag'; from: TargetPick; to: TargetPick; shift: boolean }
  | { type: 'nudge'; from: TargetPick; by: Point; shift: boolean }
  // Pressed, carried away, brought back to where it started, released.
  | { type: 'wiggle'; from: TargetPick; by: Point }
  // Pressed and carried away, then Escape before letting go.
  | { type: 'abandoned-drag'; from: TargetPick; by: Point }
  // Clicks something, then drags one of the affordances that selecting it put on screen — the only
  // way to a corner handle or a bend grip that does not wait on an earlier step to select it.
  | { type: 'grab-affordance'; owner: TargetPick; affordance: number; by: Point }
  | { type: 'menu'; target: TargetPick; choice: number }
  | { type: 'rename'; target: TargetPick; name: number }
  | { type: 'describe'; target: TargetPick; text: number }
  | { type: 'rename-region'; region: number; name: number }
  | { type: 'rename-graph'; name: number }
  // Typed into the inline text editor, if a step before opened it, and finished with Ctrl+Enter.
  | { type: 'type-text'; text: number }
  | { type: 'command'; command: Command };

// What an action actually did once its picks were resolved, for rules that judge an outcome
// against what was asked for.
export interface ActionTrace {
  // The pointer's path in world coordinates, press first, for a gesture that ran.
  path: Point[] | null;
  // Where a context menu was opened, and the entry chosen from it.
  menuAt: Point | null;
  menuItem: string | null;
  // The node a text edit went to, and what was typed.
  editedNode: FlowNode | null;
  typed: string | null;
  // The free text the inline text editor was open on when it was typed into.
  textRequest: TextEditRequest | null;
  // The corner or side a grab-affordance step dragged, when the affordance was a resize handle.
  grabbedHandle: ResizeHandle | null;
}

export const MAX_PICK_INDEX = 7;
const MAX_NUDGE = 4;
const MAX_DRAG_OFFSET = 160;
// Far from anything the fixture draws, so a press there lands on bare canvas.
const EMPTY_ORIGIN: Point = { x: -700, y: -600 };
const EMPTY_SPACING = 37;
// Along an edge, well clear of both ends and of the grip at its middle.
const EDGE_LINE_FRACTION = 0.3;

export const targetPick: fc.Arbitrary<TargetPick> = fc.record({
  kind: fc.constantFrom(...TARGET_KINDS),
  index: fc.nat(MAX_PICK_INDEX),
  nudge: fc.record({ x: fc.integer({ min: -MAX_NUDGE, max: MAX_NUDGE }), y: fc.integer({ min: -MAX_NUDGE, max: MAX_NUDGE }) }),
});

const dragOffset: fc.Arbitrary<Point> = fc.record({
  x: fc.integer({ min: -MAX_DRAG_OFFSET, max: MAX_DRAG_OFFSET }),
  y: fc.integer({ min: -MAX_DRAG_OFFSET, max: MAX_DRAG_OFFSET }),
});

export const sessionAction: fc.Arbitrary<SessionAction> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ type: fc.constant('tool' as const), tool: fc.constantFrom(...TOOLS) }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant('click' as const), target: targetPick, shift: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('double-click' as const), target: targetPick }) },
  { weight: 4, arbitrary: fc.record({ type: fc.constant('drag' as const), from: targetPick, to: targetPick, shift: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant('nudge' as const), from: targetPick, by: dragOffset, shift: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('wiggle' as const), from: targetPick, by: dragOffset }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('abandoned-drag' as const), from: targetPick, by: dragOffset }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('grab-affordance' as const), owner: targetPick, affordance: fc.nat(MAX_PICK_INDEX), by: dragOffset }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('menu' as const), target: targetPick, choice: fc.nat(12) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('rename' as const), target: targetPick, name: fc.nat(TYPED_NAMES.length - 1) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('describe' as const), target: targetPick, text: fc.nat(TYPED_DESCRIPTIONS.length - 1) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('rename-region' as const), region: fc.nat(MAX_PICK_INDEX), name: fc.nat(TYPED_NAMES.length - 1) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('rename-graph' as const), name: fc.nat(TYPED_NAMES.length - 1) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('type-text' as const), text: fc.nat(TYPED_TEXTS.length - 1) }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant('command' as const), command: fc.constantFrom(...COMMANDS) }) },
);

// Where a pick lands on the canvas as it stands now, or null when nothing of that kind is there.
export function resolveTarget(editor: HeadlessEditor, pick: TargetPick): Point | null {
  const point = anchorOf(editor, pick);
  return point ? { x: point.x + pick.nudge.x, y: point.y + pick.nudge.y } : null;
}

function anchorOf(editor: HeadlessEditor, pick: TargetPick): Point | null {
  const { view } = editor.core;
  const model = view.model;
  switch (pick.kind) {
    case 'node':
    case 'frame-node': {
      const node = pickedNode(editor, pick);
      if (!node) return null;
      const { x, y, w, h } = view.rect(node);
      return { x: x + w / 2, y: y + h / 2 };
    }
    case 'ghost': {
      const ghost = itemAt(model.ghosts, pick.index);
      return ghost ? { x: ghost.pos.x + ghost.pos.w / 2, y: ghost.pos.y + ghost.pos.h / 2 } : null;
    }
    case 'affordance':
      return itemAt(view.affordances(), pick.index)?.point ?? null;
    case 'badge': {
      const badges = model.nodes.flatMap((node) => nodeBadges(model, node, editor.core.expansions.isOpen(node.id)));
      return itemAt(badges, pick.index);
    }
    case 'region-border':
    case 'region-inside': {
      const context = itemAt(model.contexts, pick.index);
      const rect = context ? regionRectOf(model, context) : null;
      if (!rect) return null;
      if (pick.kind === 'region-inside') return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      return { x: rect.x + rect.w / 3, y: rect.y };
    }
    case 'edge':
    case 'edge-line': {
      const edge = itemAt(model.edges.filter((candidate) => view.edgeGeometryOf(candidate)), pick.index);
      if (!edge) return null;
      if (pick.kind === 'edge') return view.edgeAnchor(edge);
      const path = view.edgeGeometryOf(edge)!.path;
      return path[Math.floor((path.length - 1) * EDGE_LINE_FRACTION)];
    }
    case 'stroke': {
      const stroke = itemAt((model.visuals?.drawings() ?? []).filter((drawing): drawing is Stroke => drawing.kind === STROKE_KIND), pick.index);
      return stroke ? stroke.points[Math.floor(stroke.points.length / 2)] : null;
    }
    case 'text': {
      const text = itemAt((model.visuals?.drawings() ?? []).filter((drawing): drawing is TextDrawing => drawing.kind === TEXT_KIND), pick.index);
      return text ? { x: text.box.x + text.box.w / 2, y: text.box.y + text.box.h / 2 } : null;
    }

    case 'empty':
      return { x: EMPTY_ORIGIN.x + pick.index * EMPTY_SPACING, y: EMPTY_ORIGIN.y };
  }
}

// A node on screen: one of the graph's own for most picks, one inside an unfolded frame for a
// frame-node pick.
export function pickedNode(editor: HeadlessEditor, pick: TargetPick): FlowNode | null {
  const { core } = editor;
  if (pick.kind === 'frame-node') {
    const embedded = [...(core.expansions.locus?.keys() ?? [])].filter((node) => core.expansions.isEmbedded(node));
    return itemAt(embedded, pick.index);
  }
  return itemAt(core.view.model.nodes.filter((candidate) => candidate.pos), pick.index);
}

function itemAt<T>(items: readonly T[], index: number): T | null {
  return items.length === 0 ? null : items[index % items.length];
}

// The menu entries a user could actually pick: not separators, not greyed out.
export function choosableItems(menu: readonly MenuItem[]): { label: string; onSelect: () => void }[] {
  return menu.flatMap((item) => ('onSelect' in item && !item.disabled ? [{ label: item.label, onSelect: item.onSelect }] : []));
}

function emptyTrace(): ActionTrace {
  return { path: null, menuAt: null, menuItem: null, editedNode: null, typed: null, textRequest: null, grabbedHandle: null };
}

export async function performAction(editor: HeadlessEditor, action: SessionAction): Promise<ActionTrace> {
  const trace = emptyTrace();
  switch (action.type) {
    case 'tool':
      editor.setTool(action.tool);
      return trace;
    case 'click': {
      const point = resolveTarget(editor, action.target);
      if (!point) return trace;
      trace.path = [point];
      await editor.click(point, { shiftKey: action.shift });
      return trace;
    }
    case 'double-click': {
      const point = resolveTarget(editor, action.target);
      if (!point) return trace;
      trace.path = [point];
      await editor.doubleClick(point);
      return trace;
    }
    case 'drag': {
      const from = resolveTarget(editor, action.from);
      const to = resolveTarget(editor, action.to);
      if (!from || !to) return trace;
      trace.path = pathBetween(from, to);
      await editor.drag(trace.path, { shiftKey: action.shift });
      return trace;
    }
    case 'nudge': {
      const from = resolveTarget(editor, action.from);
      if (!from) return trace;
      trace.path = pathBetween(from, { x: from.x + action.by.x, y: from.y + action.by.y });
      await editor.drag(trace.path, { shiftKey: action.shift });
      return trace;
    }
    case 'wiggle': {
      const from = resolveTarget(editor, action.from);
      if (!from) return trace;
      const away = { x: from.x + action.by.x, y: from.y + action.by.y };
      trace.path = [...pathBetween(from, away), ...pathBetween(away, from).slice(1)];
      await editor.drag(trace.path);
      return trace;
    }
    case 'abandoned-drag': {
      const from = resolveTarget(editor, action.from);
      if (!from) return trace;
      const away = { x: from.x + action.by.x, y: from.y + action.by.y };
      trace.path = pathBetween(from, away);
      editor.press(from);
      for (const point of trace.path.slice(1)) editor.moveTo(point);
      editor.core.runCommand('escape');
      editor.moveTo({ x: away.x + action.by.x, y: away.y + action.by.y });
      editor.release(away);
      await editor.settle();
      return trace;
    }
    case 'grab-affordance': {
      const owner = resolveTarget(editor, action.owner);
      if (!owner) return trace;
      await editor.click(owner);
      const from = resolveTarget(editor, { kind: 'affordance', index: action.affordance, nudge: { x: 0, y: 0 } });
      if (!from) return trace;
      trace.grabbedHandle = itemAt(editor.core.view.affordances(), action.affordance)?.handle ?? null;
      trace.path = pathBetween(from, { x: from.x + action.by.x, y: from.y + action.by.y });
      await editor.drag(trace.path);
      return trace;
    }
    case 'menu': {
      const point = resolveTarget(editor, action.target);
      if (!point) return trace;
      const menusBefore = editor.menus.length;
      await editor.rightClick(point);
      if (editor.menus.length === menusBefore) return trace;
      const choices = choosableItems(editor.menus[editor.menus.length - 1]);
      if (choices.length === 0) return trace;
      const choice = choices[action.choice % choices.length];
      trace.menuAt = point;
      trace.menuItem = choice.label;
      choice.onSelect();
      await editor.settle();
      return trace;
    }
    case 'rename': {
      const node = pickedNode(editor, action.target);
      if (!node) return trace;
      trace.editedNode = node;
      trace.typed = TYPED_NAMES[action.name];
      editor.core.renameNodeAction(node, trace.typed);
      await editor.settle();
      return trace;
    }
    case 'describe': {
      const node = pickedNode(editor, action.target);
      if (!node) return trace;
      trace.editedNode = node;
      trace.typed = TYPED_DESCRIPTIONS[action.text];
      // The node editor's description box folds line breaks before it writes, as here.
      editor.core.applyDescriptionEdit(node, collapseToSingleLine(trace.typed));
      await editor.settle();
      return trace;
    }
    case 'rename-region': {
      const { view } = editor.core;
      const context = itemAt(view.model.contexts, action.region);
      if (!context) return trace;
      trace.typed = TYPED_NAMES[action.name];
      editor.core.contextOps.renameRegion({ block: context.block, doc: view.model.sourceDoc, path: view.model.sourcePath }, trace.typed);
      await editor.settle();
      return trace;
    }
    case 'rename-graph': {
      if (editor.core.openFlow()?.scope) return trace;
      trace.typed = TYPED_NAMES[action.name];
      editor.core.renameGraph(trace.typed);
      await editor.settle();
      return trace;
    }
    case 'type-text': {
      const request = editor.openText();
      if (!request) return trace;
      trace.textRequest = request;
      trace.typed = TYPED_TEXTS[action.text];
      await editor.finishText(trace.typed);
      return trace;
    }
    case 'command':
      editor.core.runCommand(action.command);
      await editor.settle();
      return trace;
  }
}

// A drag passes through intermediate points, as a real pointer does, so gestures that only
// commit once they have travelled a little are given the chance to.
export function pathBetween(from: Point, to: Point): Point[] {
  const steps = 4;
  return Array.from({ length: steps + 1 }, (_, step) => ({
    x: from.x + ((to.x - from.x) * step) / steps,
    y: from.y + ((to.y - from.y) * step) / steps,
  }));
}

export function gesturesIn(action: SessionAction): number {
  return action.type === 'double-click' || action.type === 'grab-affordance' ? 2 : 1;
}

export function isHistoryAction(action: SessionAction): boolean {
  return action.type === 'command' && (action.command === 'undo' || action.command === 'redo');
}
