// Random sessions against the whole editor. fast-check generates sequences of gestures, menu
// choices and keyboard commands, plays them on the headless editor, and checks rules that no
// single feature owns after every step (session-invariants.ts), and what a user can expect of the
// step itself (session-expectations.ts). When a rule breaks, fast-check
// shrinks the session to the shortest one that still breaks it, and prints it with its seed.
//
// SESSION_RUNS raises the number of sessions per property for a deeper search than `npm test`
// affords, e.g. `SESSION_RUNS=2000 npx vitest run tests/editor-sessions.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CURSOR_GRABS, type CanvasCursor, type PressTargetKind, type Tool } from '../src/client/canvas/canvas-view.js';
import type { Point } from '../src/client/geometry.js';
import { createHeadlessEditor, disposeHeadlessEditor, type HeadlessEditor } from './editor-harness.js';
import { SESSION_FLOW_PATH, sessionWorkspaceFiles } from './session-fixtures.js';
import {
  gesturesIn,
  isHistoryAction,
  MAX_PICK_INDEX,
  pathBetween,
  performAction,
  resolveTarget,
  sessionAction,
  targetPick,
  TARGET_KINDS,
  TYPED_NAMES,
  type SessionAction,
  type TargetPick,
} from './session-actions.js';
import { createRepeatedPasteCheck, expectationViolations, graphOnScreen, selectionOf } from './session-expectations.js';
import {
  contentChanged,
  contentOf,
  differingPaths,
  dropMembershipViolations,
  fileViolations,
  selectionViolations,
  undoViolations,
  type Violation,
} from './session-invariants.js';

const SESSION_RUNS = Number(process.env.SESSION_RUNS ?? 60);
// A session takes a few milliseconds; the allowance grows with the count so a deep search is not
// cut off by the runner's default timeout.
const SESSION_TIMEOUT_MS = Math.max(30_000, SESSION_RUNS * 60);
const MAX_SESSION_LENGTH = 12;
const MAX_PREFIX_LENGTH = 6;
// A drag long enough to clear every snap and dead zone, short enough to stay near what it grabbed.
const PROBE_DRAG: Point = { x: 48, y: 32 };
// At right angles to the first, for what only moves across a line — an edge's grip bends it only
// away from its chord, so a drag along the edge rightly leaves it straight.
const ACROSS_PROBE_DRAG: Point = { x: -32, y: 48 };
// Both of those again, reversed, for what only moves one way along a line — a resize handle on a
// node already at its smallest only grows it, so a drag inward rightly changes nothing.
const FURTHER_PROBE_DRAGS: Point[] = [ACROSS_PROBE_DRAG, reversed(PROBE_DRAG), reversed(ACROSS_PROBE_DRAG)];
const TOOLS_THAT_KEEP_OBJECTS_GRABBABLE: Tool[] = ['node', 'context', 'text'];

// Sessions that once broke a rule, shrunk by fast-check to the fewest steps that still broke it.
// They run ahead of the random ones on every run, so a bug that took a deep search to find stays
// caught by the default one.
const ON_A_STROKE: TargetPick = { kind: 'stroke', index: 0, nudge: { x: 0, y: 0 } };
// The affordances a lone selection shows, by their place in `CanvasView.affordances`: the corner
// handles first (north-west, north-east, south-west, south-east), then the side handles (north,
// east, south, west — every side of a node at the sessions' zoom is long enough to grab), then a
// selected node's ports (top, right, bottom, left).
const CORNER_HANDLES = 4;
const SIDE_HANDLES = 4;
const NORTH_WEST_HANDLE = 0;
const SOUTH_WEST_HANDLE = 2;
const SOUTH_EAST_HANDLE = 3;
const NORTH_SIDE_HANDLE = CORNER_HANDLES;
const WEST_SIDE_HANDLE = CORNER_HANDLES + 3;
// Too short a region keeps no left or right side handle, so its bottom one comes next after the top.
const SOUTH_SIDE_HANDLE_OF_A_FLAT_REGION = CORNER_HANDLES + 1;
const TOP_PORT_OF_A_SELECTED_NODE = CORNER_HANDLES + SIDE_HANDLES;
const RIGHT_PORT_OF_A_SELECTED_NODE = CORNER_HANDLES + SIDE_HANDLES + 1;
const FIRST_NODE_TO_EMPTY_CANVAS: SessionAction = {
  type: 'drag',
  from: { kind: 'node', index: 0, nudge: { x: 0, y: 0 } },
  to: { kind: 'empty', index: 0, nudge: { x: 0, y: 0 } },
  shift: false,
};
const CURSOR_REGRESSIONS: [SessionAction[], Tool, TargetPick][] = [
  // The cursor stayed plain over a stroke the press then dragged.
  [[], 'select', ON_A_STROKE],
  // With an edge now running across the region's border, the cursor promised a region move while
  // the press selected the edge.
  [[FIRST_NODE_TO_EMPTY_CANVAS], 'select', { kind: 'region-border', index: 0, nudge: { x: 0, y: 0 } }],
  // A ghost made real comes in at the smallest height, so its top side only grows it, and both
  // probes dragged that side inward.
  [[{ type: 'click', target: { kind: 'ghost', index: 0, nudge: { x: 0, y: 0 } }, shift: false }], 'select', affordancePick(NORTH_SIDE_HANDLE)],
];
const SESSION_REGRESSIONS: [SessionAction[]][] = [
  // A name starting with `#` turned its node's own line into a comment.
  [[{ type: 'rename', target: nodePick(0), name: TYPED_NAMES.indexOf('# heading') }]],
  // A `"` in a name broke the labelled edge into it.
  [[{ type: 'rename', target: nodePick(1), name: TYPED_NAMES.indexOf('say "hi"') }]],
  // Clearing the graph's name wrote a file without its required name.
  [[{ type: 'rename-graph', name: TYPED_NAMES.indexOf('') }]],
  // A click on a selected node's port, without dragging, made a node and an edge to it.
  [[{ type: 'click', target: nodePick(0), shift: false }, { type: 'click', target: affordancePick(RIGHT_PORT_OF_A_SELECTED_NODE, { x: 3, y: 0 }), shift: false }]],
  // Dragging an edge to where an unlabelled one already ran duplicated it.
  [[
    { type: 'click', target: nodePick(0), shift: false },
    { type: 'drag', from: affordancePick(RIGHT_PORT_OF_A_SELECTED_NODE, { x: 3, y: 0 }), to: nodePick(2), shift: false },
  ]],
  // A node deleted inside an unfolded frame stayed selected, and a paste brought it back.
  [[
    { type: 'click', target: { kind: 'badge', index: 1, nudge: { x: 0, y: 0 } }, shift: false },
    { type: 'click', target: { kind: 'frame-node', index: 1, nudge: { x: 0, y: 0 } }, shift: false },
    { type: 'command', command: 'delete' },
  ]],
  // Dragging the only member out of a region with no drawn area left the region invisible.
  [[{ type: 'drag', from: nodePick(2), to: { kind: 'empty', index: 0, nudge: { x: 0, y: 0 } }, shift: false }]],
  // Paste here anchored on whichever node had been selected first.
  [[
    { type: 'click', target: nodePick(2), shift: false },
    { type: 'click', target: nodePick(0), shift: true },
    { type: 'command', command: 'copy' },
    { type: 'menu', target: { kind: 'empty', index: 0, nudge: { x: 0, y: 0 } }, choice: 1 },
  ]],
  // Pasting again landed the new copy exactly on top of the last one.
  [[
    { type: 'click', target: nodePick(0), shift: false },
    { type: 'command', command: 'copy' },
    { type: 'command', command: 'paste' },
    { type: 'command', command: 'paste' },
  ]],
  // Shift-clicking an edge dropped everything else that was selected.
  [[{ type: 'click', target: nodePick(0), shift: false }, { type: 'click', target: { kind: 'edge-line', index: 0, nudge: { x: 0, y: 0 } }, shift: true }]],
  // Clicking one item of a multi-selection kept the whole selection.
  [[
    { type: 'click', target: nodePick(0), shift: false },
    { type: 'click', target: nodePick(1), shift: true },
    { type: 'click', target: nodePick(0), shift: false },
  ]],
  // Escape did not cancel the drag under way.
  [[{ type: 'abandoned-drag', from: nodePick(0), by: { x: 100, y: 60 } }]],
  // Dragging a region left the drawing inside it behind.
  [[{ type: 'nudge', from: { kind: 'region-border', index: 0, nudge: { x: 0, y: 0 } }, by: { x: 200, y: 120 }, shift: false }]],
  // A subgraph folded from nodes inside and outside a region landed inside it without joining.
  [[
    { type: 'click', target: nodePick(0), shift: false },
    { type: 'click', target: nodePick(3), shift: true },
    { type: 'menu', target: nodePick(0), choice: 1 },
  ]],
  // Pressing a ghost made it a node on the press, so Escape before letting go could not take it back.
  [[{ type: 'abandoned-drag', from: { kind: 'ghost', index: 0, nudge: { x: 0, y: 0 } }, by: { x: 0, y: 0 } }]],
  // A click on a member-derived region's corner handle gave it a drawn area: resizes acted
  // without a drag threshold, and the region's `pos` was written on press.
  [[
    { type: 'click', target: { kind: 'region-border', index: 1, nudge: { x: 0, y: 0 } }, shift: false },
    { type: 'click', target: affordancePick(SOUTH_EAST_HANDLE), shift: false },
  ]],
  // Dragging an edge from a node onto the ghost its own edge already pointed at made the ghost real
  // and gave the node a second, identical edge to it.
  [[
    { type: 'click', target: nodePick(3), shift: false },
    { type: 'drag', from: affordancePick(TOP_PORT_OF_A_SELECTED_NODE), to: { kind: 'ghost', index: 0, nudge: { x: 0, y: 0 } }, shift: false },
  ]],
  // Narrowing a text from its left side past one letter's width moved its right side: the floor
  // was applied after the stretch, from the left.
  [[{ type: 'grab-affordance', owner: textPick(1), affordance: WEST_SIDE_HANDLE, by: { x: 41, y: 0 } }]],
  // A text shrunk by a corner to almost nothing lost its proportions to the rounding of its size.
  [[{ type: 'grab-affordance', owner: textPick(3), affordance: NORTH_WEST_HANDLE, by: { x: 0, y: 70 } }]],
  // With Delta unfolded, resizing region Nested by its top side wrote the frame the warp painted
  // around Beta, moving its left side too.
  [[
    { type: 'click', target: { kind: 'badge', index: 7, nudge: { x: 0, y: 0 } }, shift: false },
    { type: 'grab-affordance', owner: { kind: 'region-border', index: 4, nudge: { x: 0, y: 0 } }, affordance: NORTH_SIDE_HANDLE, by: { x: 0, y: 6 } },
  ]],
  // A region left with no members had its own `pos` as the rectangle a resize started from, so
  // every pointer move resized it again from where the last one left it.
  [[
    { type: 'grab-affordance', owner: { kind: 'region-border', index: 4, nudge: { x: 0, y: 0 } }, affordance: SOUTH_WEST_HANDLE, by: { x: 0, y: -117 } },
    { type: 'grab-affordance', owner: { kind: 'region-border', index: 1, nudge: { x: 0, y: 0 } }, affordance: SOUTH_SIDE_HANDLE_OF_A_FLAT_REGION, by: { x: 0, y: -25 } },
  ]],
];
const TOOL_PARITY_REGRESSIONS: [SessionAction[], TargetPick, Tool][] = [
  // The node and region tools drew a new node or region over a stroke instead of dragging it.
  [[], ON_A_STROKE, 'node'],
  [[], ON_A_STROKE, 'context'],
];

afterEach(() => disposeHeadlessEditor());

function nodePick(index: number): TargetPick {
  return { kind: 'node', index, nudge: { x: 0, y: 0 } };
}

function textPick(index: number): TargetPick {
  return { kind: 'text', index, nudge: { x: 0, y: 0 } };
}

function affordancePick(index: number, nudge: Point = { x: 0, y: 0 }): TargetPick {
  return { kind: 'affordance', index, nudge };
}

function cursorGrabs(cursor: string): boolean {
  return CURSOR_GRABS[cursor as CanvasCursor] === true;
}

// Every kind of thing a press can land on, as the view names them. A record, so a kind added to
// the view's PressTarget does not compile here until it is listed — and once it is, the coverage
// test below fails until a session target can reach it.
const EVERY_PRESS_TARGET: Record<PressTargetKind, true> = {
  'port': true,
  'drawing-handle': true,
  'selected-edge-grip': true,
  'node-handle': true,
  'region-handle': true,
  'node': true,
  'ghost': true,
  'edge': true,
  'region': true,
  'drawing': true,
  'canvas': true,
};

class SessionBroke extends Error {
  constructor(step: number, action: SessionAction, violations: Violation[]) {
    super(`step ${step} (${JSON.stringify(action)}) broke:\n${violations.map((violation) => `  ${violation.invariant}: ${violation.detail}`).join('\n')}`);
  }
}

function openSession(): Promise<HeadlessEditor> {
  return createHeadlessEditor(sessionWorkspaceFiles(), { open: SESSION_FLOW_PATH });
}

async function playPrefix(editor: HeadlessEditor, actions: SessionAction[]): Promise<void> {
  for (const action of actions) await performAction(editor, action);
}

function probeEnd(start: Point): Point {
  return { x: start.x + PROBE_DRAG.x, y: start.y + PROBE_DRAG.y };
}

describe('the fixture every session starts from', () => {
  it('is itself valid', async () => {
    const editor = await openSession();
    expect(fileViolations(editor.workspace.snapshot())).toEqual([]);
  });
});

describe('the session targets', () => {
  // The sessions find only what they can aim at. Each pick is tried as the sessions use it — on
  // the fixture as it opens, and then on each affordance clicking it puts on screen, as a
  // grab-affordance step does — and every kind of press target must turn up.
  it('reach every kind of thing a press can land on', async () => {
    const reached = new Set<PressTargetKind>();
    for (const kind of TARGET_KINDS) {
      for (let index = 0; index <= MAX_PICK_INDEX; index++) {
        const editor = await openSession();
        try {
          for (const kindReached of await pressTargetsReachedFrom(editor, { kind, index, nudge: { x: 0, y: 0 } })) reached.add(kindReached);
        } finally {
          disposeHeadlessEditor();
        }
      }
    }
    const unreached = (Object.keys(EVERY_PRESS_TARGET) as PressTargetKind[]).filter((kind) => !reached.has(kind));
    expect(unreached).toEqual([]);
  }, SESSION_TIMEOUT_MS);
});

async function pressTargetsReachedFrom(editor: HeadlessEditor, pick: TargetPick): Promise<PressTargetKind[]> {
  const { view } = editor.core;
  const point = resolveTarget(editor, pick);
  if (!point) return [];
  const reached = [view.pressTargetKindAt(point)];
  await performAction(editor, { type: 'click', target: pick, shift: false });
  for (let index = 0; index <= MAX_PICK_INDEX; index++) {
    const affordance = resolveTarget(editor, affordancePick(index));
    if (affordance) reached.push(view.pressTargetKindAt(affordance));
  }
  return reached;
}

describe('a random session', () => {
  it('leaves every file valid, every selection live, every edit undoable in one step, and does what each step asked', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(sessionAction, { minLength: 1, maxLength: MAX_SESSION_LENGTH }), async (actions) => {
        const editor = await openSession();
        const repeatedPasteViolations = createRepeatedPasteCheck();
        try {
          for (const [step, action] of actions.entries()) {
            const before = editor.workspace.snapshot();
            const depthBefore = editor.core.session.undoDepth;
            const selectionBefore = selectionOf(editor, SESSION_FLOW_PATH);
            const graphBefore = graphOnScreen(editor);
            const trace = await performAction(editor, action);
            const after = editor.workspace.snapshot();
            const stepsAdded = editor.core.session.undoDepth - depthBefore;
            const sessionStep = {
              editor,
              flowPath: SESSION_FLOW_PATH,
              action,
              trace,
              tool: editor.tool(),
              before,
              after,
              selectionBefore,
              selectionAfter: selectionOf(editor, SESSION_FLOW_PATH),
              graphBefore,
              stepsAdded,
            };
            const violations = [
              ...fileViolations(after),
              ...selectionViolations(editor),
              ...expectationViolations(sessionStep),
              ...repeatedPasteViolations(sessionStep),
            ];
            if (isTopLevelDrag(editor, action)) violations.push(...dropMembershipViolations(before, after, SESSION_FLOW_PATH, selectedRegionNames(editor)));
            if (contentChanged(before, after) && !isHistoryAction(action)) {
              const growth = { stepsAdded, gestures: gesturesIn(action) };
              violations.push(...(await undoViolations(editor, before, after, growth)));
            }
            if (violations.length > 0) throw new SessionBroke(step, action, violations);
          }
        } finally {
          disposeHeadlessEditor();
        }
      }),
      { numRuns: SESSION_RUNS, examples: SESSION_REGRESSIONS },
    );
  }, SESSION_TIMEOUT_MS);
});

describe('the cursor', () => {
  // The hover cursor is a promise about the press: a grab cursor means a drag from here moves or
  // resizes something, and the select tool's plain cursor means it only sweeps a marquee.
  it('predicts whether a drag from under it changes anything', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(sessionAction, { maxLength: MAX_PREFIX_LENGTH }),
        fc.constantFrom<Tool>('select', 'node', 'context', 'text'),
        targetPick,
        async (prefix, tool, pick) => {
          const editor = await openSession();
          try {
            await playPrefix(editor, prefix);
            const point = resolveTarget(editor, pick);
            if (!point) return;
            editor.setTool(tool);
            editor.hover(point);
            const cursor = editor.cursor();
            const before = editor.workspace.snapshot();
            const changed = await draggingChangesFiles(editor, point, PROBE_DRAG);
            const grabbed = changed || (cursorGrabs(cursor) && await anyDragChangesFiles(editor, point, FURTHER_PROBE_DRAGS));
            if (cursorGrabs(cursor) && !grabbed) {
              throw new Error(`with the ${tool} tool the cursor over ${pick.kind} was "${cursor}", but dragging from there changed nothing`);
            }
            if (tool === 'select' && cursor === 'default' && changed) {
              throw new Error(`with the select tool the cursor over ${pick.kind} was "default", but dragging from there changed ${differingPaths(contentOf(before), contentOf(editor.workspace.snapshot())).join(', ')}`);
            }
          } finally {
            disposeHeadlessEditor();
          }
        },
      ),
      { numRuns: SESSION_RUNS, examples: CURSOR_REGRESSIONS },
    );
  }, SESSION_TIMEOUT_MS);
});

describe('the drawing tools', () => {
  // A tool decides what a press on empty canvas makes; it never takes away the user's grip on
  // what is already there. Whatever the select tool lets you drag, the node, region and text tools
  // let you drag the same way — except a frame's empty interior, which those tools draw into.
  it('leave every grabbable object draggable as the select tool would drag it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(sessionAction, { maxLength: MAX_PREFIX_LENGTH }),
        targetPick,
        fc.constantFrom(...TOOLS_THAT_KEEP_OBJECTS_GRABBABLE),
        async (prefix, pick, otherTool) => {
          const editor = await openSession();
          try {
            await playPrefix(editor, prefix);
            const point = resolveTarget(editor, pick);
            if (!point || isInsideUnfoldedFrame(editor, point)) return;
            const path = pathBetween(point, probeEnd(point));

            // Judged by what the drag did rather than by the cursor, so a cursor that lies cannot
            // hide an object from this rule.
            const start = editor.workspace.snapshot();
            const idsBeforeDrag = editor.idsIssued();
            const withSelect = await dragFromCleanSelection(editor, 'select', point, path);
            if (!contentChanged(start, withSelect.files)) return;
            editor.core.undo();
            await editor.settle();
            editor.rewindIds(idsBeforeDrag);

            const withOther = await dragFromCleanSelection(editor, otherTool, point, path);
            const differences = differingPaths(contentOf(withSelect.files), contentOf(withOther.files));
            if (differences.length > 0) {
              throw new Error(`dragging ${pick.kind} with the ${otherTool} tool wrote ${differences.join(', ')} differently from the select tool`);
            }
          } finally {
            disposeHeadlessEditor();
          }
        },
      ),
      { numRuns: SESSION_RUNS, examples: TOOL_PARITY_REGRESSIONS },
    );
  }, SESSION_TIMEOUT_MS);
});

async function draggingChangesFiles(editor: HeadlessEditor, from: Point, by: Point): Promise<boolean> {
  const before = editor.workspace.snapshot();
  await editor.drag(pathBetween(from, { x: from.x + by.x, y: from.y + by.y }));
  return contentChanged(before, editor.workspace.snapshot());
}

async function anyDragChangesFiles(editor: HeadlessEditor, from: Point, drags: Point[]): Promise<boolean> {
  for (const by of drags) {
    if (await draggingChangesFiles(editor, from, by)) return true;
  }
  return false;
}

function reversed(drag: Point): Point {
  return { x: -drag.x, y: -drag.y };
}

// A drag that set nodes down on the top level with no frame unfolded — the case where a node's
// drawn rectangle is its file position, so the files alone say which regions it came to rest in.
function isTopLevelDrag(editor: HeadlessEditor, action: SessionAction): boolean {
  const { core } = editor;
  const isDrag = action.type === 'drag' || action.type === 'nudge';
  return isDrag
    && core.openFlow()?.scope == null
    && core.expansions.openVisibleNodeIds().length === 0;
}

function selectedRegionNames(editor: HeadlessEditor): Set<string> {
  return new Set([...editor.core.view.selectedRegions].map((context) => context.block.name));
}

// A real press always follows a hover, which is what shows a node's ports.
async function dragFromCleanSelection(editor: HeadlessEditor, tool: Tool, point: Point, path: Point[]) {
  editor.core.view.clearSelection();
  editor.setTool(tool);
  editor.hover(point);
  await editor.drag(path);
  return { files: editor.workspace.snapshot() };
}

function isInsideUnfoldedFrame(editor: HeadlessEditor, point: Point): boolean {
  return editor.core.view.model.nodes.some((node) => {
    if (!node.pos || !editor.core.expansions.isOpen(node.id)) return false;
    const rect = editor.core.view.rect(node);
    return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
  });
}
