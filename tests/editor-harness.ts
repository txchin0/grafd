// The whole editor, headless: the real editor core (src/client/editor-core.ts) on a stand-in
// canvas and an in-memory workspace, driven by the pointer and keyboard input a user would
// produce and judged by the files it writes. The canvas-view tests check what a gesture reports;
// this checks what it does — through the session, the layers and the undo history to the disk.
//
// Time is fake. Rendering, commit debounces and animations all run on timers, so `settle` is the
// one way to let the editor catch up, and a test never depends on how long its machine took.
// Ids are counted rather than random, so a session replays byte for byte, and two runs of the
// same operation from the same point can be compared file for file.

import { vi } from 'vitest';
import { createEditorCore, type EditorCore, type EditorOverlays, type EditorShell } from '../src/client/editor-core.js';
import type { Workspace, WorkspaceDelegate } from '../src/client/workspace.js';
import type { MenuItem } from '../src/client/context-menu.js';
import type { Point } from '../src/client/geometry.js';
import type { Tool } from '../src/client/canvas/canvas-view.js';
import { companionLayerOf, isFlowPath } from '../src/shared/canvas-layer.js';
import { VIEWPORT } from './canvas-mock.js';

// Long enough for every timer the editor runs to fire: the commit debounce, the manifest save,
// an unfold animation, a dive.
const SETTLE_MS = 1500;
// A hand never lets go exactly where it pressed. Under the editor's drag threshold, so a click
// stays a click — and anything that acts on movement before the threshold is caught writing.
const CLICK_JITTER_SCREEN_PX = 2;
const FRAME_MS = 16;

const doNothing = () => {};

// Files kept in a map. Like every real backend, it lists only .flow files and moves or deletes a
// .flow's canvas layer with it.
export class MemoryWorkspace implements Workspace {
  readonly kind = 'browser';
  readonly label = 'memory';
  private readonly files = new Map<string, string>();
  private delegate: WorkspaceDelegate | null = null;

  constructor(initialFiles: Record<string, string>) {
    for (const [path, text] of Object.entries(initialFiles)) this.files.set(path, text);
  }

  async start(delegate: WorkspaceDelegate): Promise<string[]> {
    this.delegate = delegate;
    return this.flowPaths();
  }

  stop(): void {
    this.delegate = null;
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  writeFile(path: string, text: string): void {
    this.files.set(path, text);
  }

  deleteFile(path: string): void {
    this.files.delete(path);
    const layer = companionLayerOf(path);
    if (layer) this.files.delete(layer);
  }

  async renameFile(from: string, to: string): Promise<boolean> {
    const text = this.files.get(from);
    if (text == null || this.files.has(to)) return false;
    this.files.delete(from);
    this.files.set(to, text);
    const fromLayer = companionLayerOf(from);
    const toLayer = companionLayerOf(to);
    const layerText = fromLayer ? this.files.get(fromLayer) : undefined;
    if (fromLayer && toLayer && layerText != null) {
      this.files.delete(fromLayer);
      this.files.set(toLayer, layerText);
    }
    return true;
  }

  file(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  snapshot(): Map<string, string> {
    return new Map(this.files);
  }

  // Another tool writing to the workspace, as a watcher would report it.
  writeExternally(path: string, text: string): void {
    this.files.set(path, text);
    this.delegate?.fileChanged(path, text);
  }

  private flowPaths(): string[] {
    return [...this.files.keys()].filter(isFlowPath).sort();
  }
}

export interface PointerOptions {
  shiftKey?: boolean;
  button?: number;
  // Which click of a multi-click this press is, as the browser counts them.
  clickCount?: number;
}

export interface HeadlessEditor {
  core: EditorCore;
  workspace: MemoryWorkspace;
  canvas: HTMLCanvasElement;
  // Every menu the core has asked the shell to show, newest last.
  menus: MenuItem[][];
  settle(): Promise<void>;
  setTool(tool: Tool): void;
  tool(): Tool;
  screenOf(world: Point): Point;
  hover(world: Point): void;
  press(world: Point, options?: PointerOptions): void;
  moveTo(world: Point): void;
  release(world: Point): void;
  drag(path: Point[], options?: PointerOptions): Promise<void>;
  click(world: Point, options?: PointerOptions): Promise<void>;
  doubleClick(world: Point): Promise<void>;
  rightClick(world: Point): Promise<void>;
  chooseMenuItem(label: string): Promise<void>;
  cursor(): string;
  // How many ids the editor has minted so far, and a way to mint the same ones again — for
  // comparing an operation with a replay of it from the same starting point.
  idsIssued(): number;
  rewindIds(to: number): void;
}

type Listener = (event: unknown) => void;

export async function createHeadlessEditor(
  files: Record<string, string>,
  { open = null }: { open?: string | null } = {},
): Promise<HeadlessEditor> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  stubBrowserGlobals();
  let idsIssued = 0;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => countedUuid(++idsIssued));

  const { canvas, listeners } = createHeadlessCanvas();
  const menus: MenuItem[][] = [];
  const core = createEditorCore({ canvas, shell: createInertShell(menus) });
  const workspace = new MemoryWorkspace(files);
  await core.switchWorkspace(workspace, { preferredPath: open });

  let pointerId = 1;
  let currentTool: Tool = 'select';
  let activePointer = pointerId;

  function screenOf(world: Point): Point {
    return core.view.worldToScreen(world);
  }

  function dispatch(type: string, event: object): void {
    for (const listener of listeners.get(type) ?? []) listener(event);
  }

  function pointerEvent(world: Point, pointer: number, options: PointerOptions = {}) {
    const screen = screenOf(world);
    return {
      pointerId: pointer,
      button: options.button ?? 0,
      shiftKey: options.shiftKey ?? false,
      clientX: screen.x,
      clientY: screen.y,
      detail: options.clickCount ?? 1,
      target: canvas,
      timeStamp: performance.now(),
      preventDefault: () => {},
    };
  }

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
  }

  function press(world: Point, options: PointerOptions = {}): void {
    activePointer = ++pointerId;
    dispatch('pointerdown', pointerEvent(world, activePointer, options));
  }

  function moveTo(world: Point): void {
    dispatch('pointermove', pointerEvent(world, activePointer));
  }

  function release(world: Point, options: PointerOptions = {}): void {
    dispatch('pointerup', pointerEvent(world, activePointer, options));
  }

  const editor: HeadlessEditor = {
    core,
    workspace,
    canvas,
    menus,
    settle,
    setTool: (tool) => {
      currentTool = tool;
      core.view.setTool(tool);
    },
    tool: () => currentTool,
    screenOf,
    hover: (world) => dispatch('pointermove', pointerEvent(world, 0)),
    press,
    moveTo,
    release,
    async drag(path, options = {}) {
      const [first, ...rest] = path;
      press(first, options);
      for (const point of rest) moveTo(point);
      release(path[path.length - 1]);
      await settle();
    },
    async click(world, options = {}) {
      const screen = screenOf(world);
      const letGo = core.view.screenToWorld({ x: screen.x + CLICK_JITTER_SCREEN_PX, y: screen.y + CLICK_JITTER_SCREEN_PX });
      press(world, options);
      moveTo(letGo);
      release(letGo);
      await settle();
    },

    // The browser's own order: two press-release pairs counting up, then the dblclick event.
    async doubleClick(world) {
      for (const clickCount of [1, 2]) {
        press(world, { clickCount });
        release(world, { clickCount });
      }
      const screen = screenOf(world);
      dispatch('dblclick', { clientX: screen.x, clientY: screen.y, detail: 2, preventDefault: () => {} });
      await settle();
    },
    async rightClick(world) {
      const screen = screenOf(world);
      dispatch('contextmenu', { clientX: screen.x, clientY: screen.y, button: 2, preventDefault: () => {} });
      await settle();
    },
    async chooseMenuItem(label) {
      const menu = menus[menus.length - 1] ?? [];
      const item = menu.find((candidate) => 'label' in candidate && candidate.label === label);
      if (!item || !('onSelect' in item)) throw new Error(`No menu item "${label}" in the last menu`);
      if (item.disabled) throw new Error(`Menu item "${label}" is disabled`);
      item.onSelect();
      await settle();
    },
    cursor: () => String(canvas.style.cursor ?? ''),
    idsIssued: () => idsIssued,
    rewindIds: (to) => {
      idsIssued = to;
    },
  };
  await settle();
  return editor;
}

// A canvas whose drawing calls go nowhere. Plain functions rather than mocks: a mock records every
// call it receives and the test runner keeps every mock alive, which a long run of sessions —
// each painting thousands of frames — turns into an out-of-memory crash.
function createHeadlessCanvas(): { canvas: HTMLCanvasElement; listeners: Map<string, Listener[]> } {
  const listeners = new Map<string, Listener[]>();
  const { width, height } = VIEWPORT;
  const context = createHeadlessContext();
  const canvas = {
    width,
    height,
    style: {},
    parentElement: { tagName: 'DIV' },
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    setPointerCapture: doNothing,
    releasePointerCapture: doNothing,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }),
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, listeners };
}

function createHeadlessContext() {
  const drawingCalls = [
    'setTransform', 'clearRect', 'fillRect', 'strokeRect', 'save', 'restore', 'beginPath', 'moveTo', 'lineTo',
    'bezierCurveTo', 'quadraticCurveTo', 'ellipse', 'stroke', 'fill', 'fillText', 'setLineDash', 'clip', 'rect',
    'roundRect', 'arc', 'closePath', 'translate', 'scale',
  ];
  return {
    ...Object.fromEntries(drawingCalls.map((name) => [name, doNothing])),
    measureText: () => ({ width: 0 }),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
  };
}

function countedUuid(count: number): `${string}-${string}-${string}-${string}-${string}` {
  return `00000000-0000-4000-8000-${count.toString(16).padStart(12, '0')}`;
}

// The chrome a headless run has no use for: editors open into nothing and menus are recorded so
// a test can pick from them.
function createInertShell(menus: MenuItem[][]): EditorShell {
  const editors: EditorOverlays = {
    openNodeEditor: () => {},
    openEdgeEditor: () => {},
    openRegionEditor: () => {},
    openTitleEditor: () => {},
    openRegionNameEditor: () => {},
    closeAll: () => {},
    reposition: () => {},
    refreshFromDoc: () => {},
  };
  return {
    editors,
    openMenu: (items) => menus.push(items),
    openFlowChanged: () => {},
    trailChanged: () => {},
    fileListChanged: () => {},
    workspaceChanged: () => {},
    connectionChanged: () => {},
    flowShown: () => {},
    workspaceEmpty: () => {},
    canvasRendered: () => {},
    applyWorkspaceDisplay: async () => {},
  };
}

// Frames are timers here, so they advance with the fake clock rather than firing inline.
function stubBrowserGlobals(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), FRAME_MS) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    addEventListener: doNothing,
    removeEventListener: doNothing,
  });
}

export function disposeHeadlessEditor(): void {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}
