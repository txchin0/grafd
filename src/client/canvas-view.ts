// Canvas rendering (rough.js) and pointer interaction for the flow editor. The view owns
// the pan/zoom transform, the active tool, hover/selection state, in-flight gestures, and
// camera animations; every document mutation is delegated to the `actions` callbacks
// supplied by main.ts. When an ExpansionLayer is attached it decorates each model with
// per-frame display geometry (`model.display`), which the view must prefer over a node's
// authored `pos` (see rectOf) so inline-expanded frames and warp offsets never touch the
// document itself.

// Resolved by the import map in index.html to the served copy of rough.esm.js.
import rough from 'roughjs';
import type { Options as RoughOptions } from 'roughjs/bin/core';
import {
  descriptionForNode,
  type EdgeDataField,
  type FlowNode,
  type Rect,
} from '../shared/flow-format.js';
import type { EdgeGeometry, FlowModel, GhostNode, ModelEdge, NodeTraits, Point } from './flow-doc.js';
import {
  cameraLinkFittingModelIntoRect,
  cameraLinkFromInlineModel,
  childViewLinkedTo,
  interpolateView,
  modelContentBounds,
  parentViewLinkedTo,
  type CameraLink,
  type View,
  type ViewportSize,
} from './camera-transition.js';
import {
  transformPoint,
  transformRect,
  type ExpansionLayer,
  type FrameExpansion,
  type FrameTransform,
} from './expansion.js';

export type { CameraLink, View, ViewportSize } from './camera-transition.js';
export { childViewLinkedTo, interpolateView, parentViewLinkedTo } from './camera-transition.js';

export type Tool = 'select' | 'node';

type BadgeKind = 'open' | 'inline' | 'collapse';

interface Badge {
  kind: BadgeKind;
  x: number;
  y: number;
}

interface BadgeHit {
  kind: BadgeKind;
  node: FlowNode;
}

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

type Gesture =
  | { type: 'pan'; startView: View; startScreen: Point }
  | {
      type: 'edge';
      from: FlowNode;
      toWorld: Point;
      hoverTarget: FlowNode | null;
      innerDrop: { host: FlowNode; innerName: string } | null;
      outerDrop: { host: FlowNode; innerName: string } | null;
    }
  | { type: 'resize'; node: FlowNode; corner: ResizeCorner; startRect: Rect; startWorld: Point; scale: number }
  | {
      type: 'move';
      nodes: FlowNode[];
      startPositions: Map<FlowNode, Point>;
      scales: Map<FlowNode, number>;
      startWorld: Point;
      startScreen: Point;
      moved: boolean;
      pressedNode: FlowNode;
      pressedBadge: BadgeHit | null;
    }
  | { type: 'create'; startWorld: Point; startScreen: Point; rect: Rect | null }
  | { type: 'marquee'; startWorld: Point; rect: Rect | null };

interface HeldScene {
  model: FlowModel;
  view: View;
}

type SceneTransition =
  | { phase: 'hold'; outgoing: HeldScene }
  | {
      phase: 'run';
      mode: 'in' | 'out';
      outgoing: HeldScene;
      incoming: { model: FlowModel };
      parentFrom: View;
      parentTo: View;
      incomingEnd: View;
      nodeRect: Rect;
      link: CameraLink;
      inlineAnchor: FrameTransform | null;
      bounds: ViewportSize;
      duration: number;
      startTime: number;
      resolve: () => void;
    };

export interface CanvasActions {
  createNode(rect: Rect): void;
  quickCreateNode(worldPoint: Point): void;
  nodeClicked(node: FlowNode): void;
  canvasClicked(): void;
  moveCommitted(nodes: FlowNode[]): void;
  completeEdge(
    fromNode: FlowNode,
    targetNode: FlowNode | null,
    worldPoint: Point,
    extra?: {
      droppedOnSource: boolean;
      ghostTarget: GhostNode | null;
      innerName?: string;
      outerSource?: { host: FlowNode; innerName: string };
    },
  ): void;
  editEdge(edge: ModelEdge): void;
  openExpand(node: FlowNode): void;
  toggleExpand(node: FlowNode): void;
  materializeGhost(ghost: GhostNode): void;
  contextMenu(target: ContextTarget, screenPoint: Point): void;
  viewChanged?(): void;
  afterRender?(): void;
}

export type ContextTarget =
  | { kind: 'node'; node: FlowNode }
  | { kind: 'edge'; edge: ModelEdge }
  | { kind: 'canvas'; world: Point };

const HAND_FONT = '"Segoe Print", "Comic Sans MS", cursive';

const COLORS = {
  grid: 'rgba(232, 226, 213, 0.07)',
  ink: '#e8e2d5',
  muted: 'rgba(232, 226, 213, 0.55)',
  nodeFill: 'rgba(36, 40, 48, 0.94)',
  nodeStroke: '#9ba8b8',
  entryStroke: '#7fc48a',
  decisionStroke: '#d9b96a',
  expandStroke: '#b48ad9',
  ghost: 'rgba(155, 168, 184, 0.45)',
  edge: '#8fa1b3',
  edgeLabel: '#b9c2cc',
  edgeLabelBg: '#20242b',
  error: '#d97a7a',
  updates: '#7fc48a',
  select: '#6aa9e9',
  marqueeFill: 'rgba(106, 169, 233, 0.08)',
};

const MIN_SCALE = 0.12;
const MAX_SCALE = 3;
const MAX_FIT_SCALE = 1.4;
const ZOOM_STEP_FACTOR = 1.1;
const MIN_NODE_WIDTH = 120;
const MIN_NODE_HEIGHT = 64;
const DRAG_THRESHOLD_PX = 4;
const SNAP = 8;
const PORT_RADIUS = 5;
const PORT_HIT_RADIUS = 11;
const EDGE_HIT_DISTANCE = 8;
const EDGE_LABEL_BOW_BIAS = 0.85;
const EDGE_DATA_LINE_HEIGHT = 13;
const EDGE_DATA_GAP = 2;
const BADGE_HIT_RADIUS = 12;
const BADGE_SLOT_SPACING = 24;
const FIT_PADDING = 80;
const BADGE_SYMBOLS: Record<BadgeKind, string> = { open: '⤢', inline: '⊞', collapse: '⊟' };
const DIVE_IN_MS = 650;
const BACK_OUT_MS = 560;
export const SNAPSHOT_PADDING = 48;

// A surface the scene can be drawn onto. The live canvas is one; an export renders the same
// scene onto a detached canvas at an arbitrary resolution by swapping the target for the
// duration of one synchronous draw.
export interface RenderTarget {
  ctx: CanvasRenderingContext2D;
  rough: ReturnType<typeof rough.canvas>;
  viewport: ViewportSize;
  pixelRatio: number;
}

export interface SnapshotRequest {
  canvas: HTMLCanvasElement;
  viewport: ViewportSize;
  pixelRatio: number;
  background: string | null;
  grid: boolean;
}

function targetForCanvas(canvas: HTMLCanvasElement, viewport: ViewportSize, pixelRatio: number): RenderTarget {
  return { ctx: canvas.getContext('2d')!, rough: rough.canvas(canvas), viewport, pixelRatio };
}

function centerBoundsAt(bounds: Rect, viewport: ViewportSize, scale: number): View {
  return {
    scale,
    x: (viewport.width - bounds.w * scale) / 2 - bounds.x * scale,
    y: (viewport.height - bounds.h * scale) / 2 - bounds.y * scale,
  };
}

function padRect(rect: Rect, padding: number): Rect {
  return { x: rect.x - padding, y: rect.y - padding, w: rect.w + padding * 2, h: rect.h + padding * 2 };
}

export function fitScaleFor(bounds: Rect, viewport: ViewportSize): number {
  return Math.min(viewport.width / bounds.w, viewport.height / bounds.h);
}

// Camera that frames `bounds` centered inside `viewport`, with no scale limits applied.
export function fitViewInto(bounds: Rect, viewport: ViewportSize): View {
  return centerBoundsAt(bounds, viewport, fitScaleFor(bounds, viewport));
}

function snap(value: number): number {
  return Math.round(value / SNAP) * SNAP;
}

function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0) % 2147483646 + 1;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function rectContains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h
  );
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return {
    x: left,
    y: top,
    w: Math.max(a.x + a.w, b.x + b.w) - left,
    h: Math.max(a.y + a.h, b.y + b.h) - top,
  };
}

// Labels sit near the curve's midpoint, biased toward its control point so they follow the bow.
function edgeLabelAnchor(geometry: EdgeGeometry): Point {
  if (geometry.selfLoop) return { x: geometry.mid.x, y: geometry.mid.y };
  const chordMidX = (geometry.a.x + geometry.b.x) / 2;
  const chordMidY = (geometry.a.y + geometry.b.y) / 2;
  return {
    x: chordMidX + (geometry.mid.x - chordMidX) * EDGE_LABEL_BOW_BIAS,
    y: chordMidY + (geometry.mid.y - chordMidY) * EDGE_LABEL_BOW_BIAS,
  };
}

function normalizedRect(pointA: Point, pointB: Point): Rect {
  return {
    x: Math.min(pointA.x, pointB.x),
    y: Math.min(pointA.y, pointB.y),
    w: Math.abs(pointA.x - pointB.x),
    h: Math.abs(pointA.y - pointB.y),
  };
}

function isGhost(target: FlowNode | GhostNode): target is GhostNode {
  return 'ghost' in target && target.ghost === true;
}

function rectBorderPointToward(rect: Rect, towardPoint: Point): Point {
  const center = rectCenter(rect);
  const dx = towardPoint.x - center.x;
  const dy = towardPoint.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const scaleX = dx === 0 ? Infinity : (rect.w / 2) / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : (rect.h / 2) / Math.abs(dy);
  const t = Math.min(scaleX, scaleY);
  return { x: center.x + dx * t, y: center.y + dy * t };
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const lengthSquared = abX * abX + abY * abY;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - a.x) * abX + (point.y - a.y) * abY) / lengthSquared));
  const closest = { x: a.x + abX * t, y: a.y + abY * t };
  return Math.hypot(point.x - closest.x, point.y - closest.y);
}

export class CanvasView {
  private readonly canvas: HTMLCanvasElement;
  private readonly liveTarget: RenderTarget;
  private readonly actions: CanvasActions;

  // Every draw method reaches its surface through `target`, so a snapshot can retarget the
  // whole scene by swapping this field for the duration of one synchronous render.
  private target: RenderTarget;

  private get ctx(): CanvasRenderingContext2D {
    return this.target.ctx;
  }

  private get rough(): ReturnType<typeof rough.canvas> {
    return this.target.rough;
  }

  private get devicePixelRatio(): number {
    return this.target.pixelRatio;
  }

  private get viewport(): ViewportSize {
    return this.target.viewport;
  }

  view: View = { x: 0, y: 0, scale: 1 };
  model: FlowModel;
  selection = new Set<FlowNode>();
  selectedEdge: ModelEdge | null = null;
  expansionLayer: ExpansionLayer | null = null;

  private hoverNode: FlowNode | null = null;
  private hoverPoint: Point | null = null;
  private gesture: Gesture | null = null;
  private tool: Tool = 'select';
  private sceneTransition: SceneTransition | null = null;
  private spaceDown = false;
  private renderQueued = false;

  constructor(canvasElement: HTMLCanvasElement, actions: CanvasActions) {
    this.canvas = canvasElement;
    this.liveTarget = targetForCanvas(canvasElement, { width: 0, height: 0 }, window.devicePixelRatio || 1);
    this.target = this.liveTarget;
    this.actions = actions;
    this.model = {
      nodes: [],
      edges: [],
      ghosts: [],
      nodesByName: new Map(),
      traits: new Map(),
      sourceDoc: { leading: [], preamble: null, items: [] },
      sourcePath: null,
    };

    this.bindEvents();
    this.syncCanvasSize();
  }

  private bindEvents(): void {
    const resizeObserver = new ResizeObserver(() => this.syncCanvasSize());
    resizeObserver.observe(this.canvas.parentElement!);

    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverNode = null;
      this.hoverPoint = null;
      this.requestRender();
    });
    this.canvas.addEventListener('dblclick', (event) => this.onDoubleClick(event));
    this.canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.canvas.addEventListener('contextmenu', (event) => this.onContextMenu(event));

    window.addEventListener('keydown', (event) => {
      if (event.code === 'Space' && !isTypingTarget(event.target)) {
        this.spaceDown = true;
        this.updateCursor();
        event.preventDefault();
      }
    });
    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space') {
        this.spaceDown = false;
        this.updateCursor();
      }
    });
    window.addEventListener('blur', () => {
      this.spaceDown = false;
      this.gesture = null;
      this.requestRender();
    });
  }

  private syncCanvasSize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    this.liveTarget.viewport = { width: bounds.width, height: bounds.height };
    this.liveTarget.pixelRatio = pixelRatio;
    this.canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
    this.canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
    this.requestRender();
  }

  setModel(model: FlowModel): void {
    const selectedEdgeSpec = this.selectedEdge?.spec ?? null;

    this.model = model;
    // Top-level nodes are re-resolved by id; embedded subgraph nodes keep their identity
    // across rebuilds (they are the same AST objects), so they stay selected as-is. Nodes
    // that truly disappeared are dropped from drawing by the locus visibility check.
    this.selection = new Set(
      [...this.selection]
        .map((node) => model.nodes.find((candidate) => candidate.id === node.id)
          ?? (this.expansionLayer?.isEmbedded(node) ? node : null))
        .filter((node): node is FlowNode => node != null),
    );
    this.selectedEdge = model.edges.find((edge) => edge.spec === selectedEdgeSpec)
      ?? (this.selectedEdge && this.expansionLayer?.isEmbedded(this.selectedEdge.from) ? this.selectedEdge : null);
    if (this.hoverNode) {
      const previousHoverId = this.hoverNode.id;
      this.hoverNode = model.nodes.find((node) => node.id === previousHoverId)
        ?? (this.expansionLayer?.isEmbedded(this.hoverNode) ? this.hoverNode : null);
    }
    this.requestRender();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.updateCursor(this.hoverPoint ?? undefined);
  }

  private layoutDisplayGeometry(model: FlowModel): void {
    this.expansionLayer?.layout(model, performance.now());
    this.expansionLayer?.collectLoci(model);
  }

  private rectOf(model: FlowModel, node: FlowNode): Rect {
    return model.display?.rects.get(node) ?? node.pos!;
  }

  // World-space rect of any visible node, including nodes inside unfolded frames: the
  // node's local display rect pushed through its locus transform.
  rect(node: FlowNode): Rect {
    const locus = this.expansionLayer?.locusOf(node);
    if (!locus) return this.rectOf(this.model, node);
    return transformRect(this.rectOf(locus.model, node), locus.transform);
  }

  private isNodeVisible(node: FlowNode): boolean {
    return !this.expansionLayer || this.expansionLayer.locusOf(node) != null;
  }

  edgeAnchor(edge: ModelEdge): Point {
    const mid = edge.geometry?.mid ?? rectCenter(this.rect(edge.from));
    const locus = this.expansionLayer?.locusOf(edge.from);
    if (!locus) return mid;
    return transformPoint(mid, locus.transform);
  }

  select(node: FlowNode): void {
    this.selection = new Set([node]);
    this.selectedEdge = null;
    this.requestRender();
  }

  setSelection(nodes: FlowNode[]): void {
    this.selection = new Set(nodes);
    this.selectedEdge = null;
    this.requestRender();
  }

  clearSelection(): void {
    this.selection.clear();
    this.selectedEdge = null;
    this.requestRender();
  }

  worldToScreen(point: Point): Point {
    return { x: point.x * this.view.scale + this.view.x, y: point.y * this.view.scale + this.view.y };
  }

  screenToWorld(point: Point): Point {
    return { x: (point.x - this.view.x) / this.view.scale, y: (point.y - this.view.y) / this.view.scale };
  }

  worldRectToScreen(rect: Rect): Rect {
    const topLeft = this.worldToScreen(rect);
    return { x: topLeft.x, y: topLeft.y, w: rect.w * this.view.scale, h: rect.h * this.view.scale };
  }

  private eventPoint(event: MouseEvent): Point {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private zoomAt(screenPoint: Point, factor: number): void {
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.view.scale * factor));
    const appliedFactor = newScale / this.view.scale;
    this.view.x = screenPoint.x - (screenPoint.x - this.view.x) * appliedFactor;
    this.view.y = screenPoint.y - (screenPoint.y - this.view.y) * appliedFactor;
    this.view.scale = newScale;
    this.requestRender();
    this.actions.viewChanged?.();
  }

  setZoom(scale: number): void {
    const { width, height } = this.viewport;
    this.zoomAt({ x: width / 2, y: height / 2 }, scale / this.view.scale);
  }

  stepZoom(direction: 1 | -1, screenPoint?: Point): void {
    const { width, height } = this.viewport;
    const anchor = screenPoint ?? { x: width / 2, y: height / 2 };
    this.zoomAt(anchor, direction > 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR);
  }

  setViewNow(view: View): void {
    this.view = { ...view };
    this.requestRender();
    this.actions.viewChanged?.();
  }

  private paddedContentBounds(padding: number): Rect | null {
    const rects = [
      ...this.model.nodes.map((node) => this.rect(node)),
      ...this.model.ghosts.map((ghost) => ghost.pos),
    ].filter((rect): rect is Rect => rect != null);
    if (rects.length === 0) return null;
    const minX = Math.min(...rects.map((rect) => rect.x));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
    return padRect({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, padding);
  }

  private clampedFitView(bounds: Rect | null, viewport: ViewportSize): View {
    if (!bounds) {
      return { x: viewport.width / 2 - 200, y: viewport.height / 2 - 150, scale: 1 };
    }
    const scale = Math.max(MIN_SCALE, Math.min(fitScaleFor(bounds, viewport), MAX_FIT_SCALE));
    return centerBoundsAt(bounds, viewport, scale);
  }

  private computeFitView(padding = FIT_PADDING, viewport: ViewportSize = this.viewport): View {
    // Fit runs synchronously right after a model/scope swap, before the render loop's
    // next layout pass; without eager display layout, unfolded frames measure at their
    // collapsed pos and expanded subgraphs get clipped — the same reason a manual
    // zoom-to-fit a moment later frames them correctly.
    this.layoutDisplayGeometry(this.model);
    return this.clampedFitView(this.paddedContentBounds(padding), viewport);
  }

  // The camera zoom-to-fit would give a model that is not the active one, in that model's own
  // coordinates. Used to reconstruct the camera a skipped navigation level would have had.
  fitViewForModel(model: FlowModel, padding = FIT_PADDING): View {
    return this.clampedFitView(padRect(modelContentBounds(model), padding), this.viewport);
  }

  fitToContent(padding = FIT_PADDING): void {
    this.setViewNow(this.computeFitView(padding));
  }

  // World-space rect a snapshot frames: the same padded content bounds zoom-to-fit uses,
  // with display geometry laid out first so unfolded frames measure at their frame rect.
  snapshotBounds(padding = SNAPSHOT_PADDING): Rect {
    this.layoutDisplayGeometry(this.model);
    return this.paddedContentBounds(padding) ?? { x: 0, y: 0, w: 400, h: 300 };
  }

  // Draws the scene onto a caller-owned canvas at an arbitrary resolution, framed exactly
  // like zoom-to-fit. Editing chrome (selection, ports, gesture overlay) is deliberately
  // omitted, and the draw is synchronous rather than rAF-queued so the caller can read the
  // pixels back the moment this returns.
  renderSnapshot({ canvas, viewport, pixelRatio, background, grid }: SnapshotRequest): void {
    const previousTarget = this.target;
    this.target = targetForCanvas(canvas, viewport, pixelRatio);
    try {
      const { ctx } = this;
      const view = this.computeFitView(SNAPSHOT_PADDING, viewport);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      if (grid) {
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        this.drawGrid(view);
      }
      ctx.setTransform(
        pixelRatio * view.scale, 0, 0, pixelRatio * view.scale,
        pixelRatio * view.x, pixelRatio * view.y,
      );
      this.drawScene(this.model);
    } finally {
      this.target = previousTarget;
    }
  }

  // --- Seamless subgraph navigation ------------------------------------------------------
  //
  // A zoom transition renders TWO scenes at once with mathematically linked cameras: the
  // "parent" scene (where the expandable node lives) and the "child" scene (its subgraph).
  // The child camera is always derived from the parent camera so that the child's content
  // bounds track the node's rectangle — scaled down by `growth` and pinned to the node's
  // center. Interpolating only the parent camera therefore makes the subgraph ride inside
  // the node while it inflates past the viewport, and a crossfade swaps which scene is
  // solid. Diving in ends exactly on the child's fitted view; backing out ends exactly on
  // the stored parent view.
  //
  // beginSceneHold freezes rendering on a captured copy of the outgoing scene so the app
  // can swap its state (async file loads included) without a single frame of the new graph
  // flashing at the old camera.

  beginSceneHold(model: FlowModel, view: View): void {
    this.sceneTransition = { phase: 'hold', outgoing: { model, view: { ...view } } };
    this.requestRender();
  }

  releaseSceneHold(): void {
    if (this.sceneTransition?.phase === 'hold') this.sceneTransition = null;
    this.requestRender();
  }

  zoomDiveIn(
    { nodeRect, inlineAnchor = null, duration = DIVE_IN_MS }:
      { nodeRect: Rect; inlineAnchor?: FrameTransform | null; duration?: number },
  ): Promise<void> {
    return this.startZoomTransition({ mode: 'in', nodeRect, inlineAnchor, duration });
  }

  zoomBackOut(
    { nodeRect, targetView, inlineAnchor = null, duration = BACK_OUT_MS }:
      { nodeRect: Rect; targetView: View; inlineAnchor?: FrameTransform | null; duration?: number },
  ): Promise<void> {
    return this.startZoomTransition({ mode: 'out', nodeRect, targetView, inlineAnchor, duration });
  }

  private startZoomTransition(
    { mode, nodeRect, targetView, inlineAnchor, duration }:
      { mode: 'in' | 'out'; nodeRect: Rect; targetView?: View; inlineAnchor: FrameTransform | null; duration: number },
  ): Promise<void> {
    const held = this.sceneTransition?.phase === 'hold' ? this.sceneTransition.outgoing : null;
    if (!held) {
      this.sceneTransition = null;
      this.setViewNow(mode === 'in' ? this.computeFitView() : targetView!);
      return Promise.resolve();
    }
    const bounds = this.viewport;
    const childModel = mode === 'in' ? this.model : held.model;
    this.layoutDisplayGeometry(childModel);
    const link = inlineAnchor
      ? cameraLinkFromInlineModel(childModel, inlineAnchor)
      : cameraLinkFittingModelIntoRect(childModel, nodeRect);

    let parentFrom: View;
    let parentTo: View;
    let incomingEnd: View;
    if (mode === 'in') {
      const fit = this.computeFitView();
      parentFrom = held.view;
      parentTo = parentViewLinkedTo(fit, link);
      incomingEnd = fit;
    } else {
      parentFrom = parentViewLinkedTo(held.view, link);
      parentTo = targetView!;
      incomingEnd = targetView!;
    }

    return new Promise((resolve) => {
      this.sceneTransition = {
        phase: 'run',
        mode,
        outgoing: held,
        incoming: { model: this.model },
        parentFrom,
        parentTo,
        incomingEnd,
        nodeRect,
        link,
        inlineAnchor,
        bounds,
        duration,
        startTime: performance.now(),
        resolve,
      };
      this.requestRender();
    });
  }

  private finishSceneTransition(): void {
    const transition = this.sceneTransition;
    if (!transition) return;
    this.sceneTransition = null;
    if (transition.phase === 'run') {
      this.view = { ...transition.incomingEnd };
      transition.resolve();
      this.actions.viewChanged?.();
    }
    this.requestRender();
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (this.sceneTransition) {
      this.finishSceneTransition();
      return;
    }
    if (event.deltaY === 0) return;
    this.stepZoom(event.deltaY < 0 ? 1 : -1, this.eventPoint(event));
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.sceneTransition) {
      this.finishSceneTransition();
      return;
    }
    const screen = this.eventPoint(event);
    const world = this.screenToWorld(screen);
    this.canvas.setPointerCapture(event.pointerId);

    const wantsPan = event.button === 1 || (event.button === 0 && this.spaceDown);
    if (wantsPan) {
      this.gesture = { type: 'pan', startView: { ...this.view }, startScreen: screen };
      this.updateCursor();
      return;
    }
    if (event.button !== 0) return;

    const port = this.hitPort(world);
    if (port) {
      this.gesture = { type: 'edge', from: port.node, toWorld: world, hoverTarget: null, innerDrop: null, outerDrop: null };
      return;
    }

    const handle = this.hitResizeHandle(world);
    if (handle) {
      this.gesture = {
        type: 'resize',
        node: handle.node,
        corner: handle.corner,
        startRect: { ...handle.node.pos! },
        startWorld: world,
        scale: this.expansionLayer?.scaleOf(handle.node) ?? 1,
      };
      return;
    }

    const node = this.hitNode(world);
    if (node) {
      if (event.shiftKey && this.selection.has(node)) {
        this.selection.delete(node);
        this.requestRender();
        return;
      }
      if (!this.selection.has(node)) {
        if (!event.shiftKey) this.selection.clear();
        this.selection.add(node);
        this.selectedEdge = null;
      }
      this.gesture = {
        type: 'move',
        nodes: [...this.selection],
        startPositions: new Map([...this.selection].map((n) => [n, { x: n.pos!.x, y: n.pos!.y }])),
        // World-space drag deltas are divided by each node's locus scale so nodes inside
        // scaled-down frames track the cursor instead of racing ahead of it.
        scales: new Map([...this.selection].map((n) => [n, this.expansionLayer?.scaleOf(n) ?? 1])),
        startWorld: world,
        startScreen: screen,
        moved: false,
        pressedNode: node,
        pressedBadge: this.hitBadge(world),
      };
      this.requestRender();
      return;
    }

    const ghost = this.hitGhost(world);
    if (ghost) {
      this.actions.materializeGhost(ghost);
      return;
    }

    const edge = this.hitEdge(world);
    if (edge) {
      this.selectedEdge = edge;
      this.selection.clear();
      this.actions.canvasClicked();
      this.requestRender();
      return;
    }

    if (!event.shiftKey) {
      this.selection.clear();
      this.selectedEdge = null;
      this.actions.canvasClicked();
    }
    const wantsCreate = this.tool === 'node' && !event.shiftKey;
    this.gesture = wantsCreate
      ? { type: 'create', startWorld: world, startScreen: screen, rect: null }
      : { type: 'marquee', startWorld: world, rect: null };
    this.requestRender();
  }

  private onPointerMove(event: PointerEvent): void {
    const screen = this.eventPoint(event);
    const world = this.screenToWorld(screen);
    this.hoverPoint = world;

    if (!this.gesture) {
      const previousHover = this.hoverNode;
      this.hoverNode = this.hitNode(world);
      if (previousHover !== this.hoverNode) this.requestRender();
      this.updateCursor(world);
      return;
    }

    const gesture = this.gesture;
    if (gesture.type === 'pan') {
      this.view.x = gesture.startView.x + (screen.x - gesture.startScreen.x);
      this.view.y = gesture.startView.y + (screen.y - gesture.startScreen.y);
      this.requestRender();
      this.actions.viewChanged?.();
    } else if (gesture.type === 'move') {
      const dx = world.x - gesture.startWorld.x;
      const dy = world.y - gesture.startWorld.y;
      const screenDistance = Math.hypot(screen.x - gesture.startScreen.x, screen.y - gesture.startScreen.y);
      if (!gesture.moved && screenDistance < DRAG_THRESHOLD_PX) return;
      gesture.moved = true;
      for (const node of gesture.nodes) {
        const start = gesture.startPositions.get(node)!;
        const scale = gesture.scales.get(node) ?? 1;
        node.pos!.x = snap(start.x + dx / scale);
        node.pos!.y = snap(start.y + dy / scale);
      }
      this.requestRender();
      this.actions.viewChanged?.();
    } else if (gesture.type === 'resize') {
      this.applyResize(gesture, world);
      this.requestRender();
      this.actions.viewChanged?.();
    } else if (gesture.type === 'edge') {
      gesture.toWorld = world;
      const drop = this.resolveEdgeDrop(gesture.from, this.hitNode(world));
      gesture.hoverTarget = drop.hoverTarget;
      gesture.innerDrop = drop.innerDrop;
      gesture.outerDrop = drop.outerDrop;
      this.requestRender();
    } else if (gesture.type === 'create' || gesture.type === 'marquee') {
      gesture.rect = normalizedRect(gesture.startWorld, world);
      this.requestRender();
    }
  }

  private applyResize(gesture: Extract<Gesture, { type: 'resize' }>, world: Point): void {
    const dx = (world.x - gesture.startWorld.x) / (gesture.scale ?? 1);
    const dy = (world.y - gesture.startWorld.y) / (gesture.scale ?? 1);
    const start = gesture.startRect;
    const rect = gesture.node.pos!;
    const vertical = gesture.corner[0];
    const horizontal = gesture.corner[1];

    if (horizontal === 'e') rect.w = Math.max(MIN_NODE_WIDTH, snap(start.w + dx));
    if (vertical === 's') rect.h = Math.max(MIN_NODE_HEIGHT, snap(start.h + dy));
    if (horizontal === 'w') {
      const width = Math.max(MIN_NODE_WIDTH, snap(start.w - dx));
      rect.x = start.x + start.w - width;
      rect.w = width;
    }
    if (vertical === 'n') {
      const height = Math.max(MIN_NODE_HEIGHT, snap(start.h - dy));
      rect.y = start.y + start.h - height;
      rect.h = height;
    }
  }

  private onPointerUp(event: PointerEvent): void {
    const gesture = this.gesture;
    this.gesture = null;
    this.updateCursor();
    if (!gesture) return;

    const screen = this.eventPoint(event);
    const world = this.screenToWorld(screen);

    if (gesture.type === 'move') {
      if (gesture.moved) {
        this.actions.moveCommitted(gesture.nodes);
      } else {
        this.dispatchNodePress(gesture, world);
      }
    } else if (gesture.type === 'resize') {
      this.actions.moveCommitted([gesture.node]);
    } else if (gesture.type === 'edge') {
      const rawTarget = this.hitNode(world);
      const drop = this.resolveEdgeDrop(gesture.from, rawTarget);
      this.actions.completeEdge(gesture.from, drop.targetNode, world, {
        droppedOnSource: rawTarget === gesture.from,
        ghostTarget: this.expansionLayer?.isEmbedded(gesture.from) ? null : this.hitGhost(world),
        innerName: drop.innerDrop?.innerName,
        outerSource: drop.outerDrop ?? undefined,
      });
    } else if (gesture.type === 'create') {
      const bigEnoughOnScreen =
        gesture.rect != null &&
        gesture.rect.w * this.view.scale > 14 &&
        gesture.rect.h * this.view.scale > 10;
      if (bigEnoughOnScreen) {
        this.actions.createNode(this.snapCreateRect(gesture.rect!));
      }
    } else if (gesture.type === 'marquee' && gesture.rect) {
      this.selectNodesInMarquee(gesture.rect);
    }
    this.requestRender();
  }

  private inSameModel(nodeA: FlowNode | null, nodeB: FlowNode | null): boolean {
    if (!nodeA || !nodeB) return false;
    if (!this.expansionLayer) return true;
    return (this.expansionLayer.modelOf(nodeA) ?? this.model) === (this.expansionLayer.modelOf(nodeB) ?? this.model);
  }

  // Port-drag between an expanded frame and the surrounding graph resolves to a single-level
  // subgraph refinement (§5.7 target-side entering a frame, §5.8 source-side leaving one).
  private resolveEdgeDrop(
    from: FlowNode,
    rawTarget: FlowNode | null,
  ): {
    hoverTarget: FlowNode | null;
    targetNode: FlowNode | null;
    innerDrop: { host: FlowNode; innerName: string } | null;
    outerDrop: { host: FlowNode; innerName: string } | null;
  } {
    if (!rawTarget || rawTarget === from) {
      return { hoverTarget: null, targetNode: null, innerDrop: null, outerDrop: null };
    }
    if (this.inSameModel(from, rawTarget)) {
      return { hoverTarget: rawTarget, targetNode: rawTarget, innerDrop: null, outerDrop: null };
    }
    if (this.expansionLayer?.isEmbedded(from)) {
      // §5.8: an edge dragged out of a frame lands on a sibling of the frame's host and
      // becomes an `{Inner Source}` edge declared on the host. Single-level: the host must
      // share a graph with the drop target.
      const host = this.expansionLayer?.hostOf(from) ?? null;
      if (!host || host === rawTarget || !this.inSameModel(host, rawTarget)) {
        return { hoverTarget: null, targetNode: null, innerDrop: null, outerDrop: null };
      }
      return {
        hoverTarget: rawTarget,
        targetNode: rawTarget,
        innerDrop: null,
        outerDrop: { host, innerName: from.name },
      };
    }
    const host = this.expansionLayer?.hostOf(rawTarget) ?? null;
    // Dropping from a host onto a node inside its own frame would be a self-edge; reject it.
    if (!host || host === from || !this.inSameModel(from, host)) {
      return { hoverTarget: null, targetNode: null, innerDrop: null, outerDrop: null };
    }
    return {
      hoverTarget: rawTarget,
      targetNode: host,
      innerDrop: { host, innerName: rawTarget.name },
      outerDrop: null,
    };
  }

  // Marquee reaches into unfolded frames, but a node is skipped when one of its host
  // frames is also caught — dragging a frame already carries its contents.
  private selectNodesInMarquee(rect: Rect): void {
    const candidates = this.expansionLayer?.locus ? [...this.expansionLayer.locus.keys()] : this.model.nodes;
    for (const node of candidates) {
      if (rectsIntersect(rect, this.rect(node))) this.selection.add(node);
    }
    for (const node of [...this.selection]) {
      if (this.hasSelectedAncestorFrame(node)) this.selection.delete(node);
    }
  }

  private hasSelectedAncestorFrame(node: FlowNode): boolean {
    let host = this.expansionLayer?.hostOf(node);
    while (host) {
      if (this.selection.has(host)) return true;
      host = this.expansionLayer?.hostOf(host);
    }
    return false;
  }

  private dispatchNodePress(gesture: Extract<Gesture, { type: 'move' }>, world: Point): void {
    const badge = this.hitBadge(world);
    const pressedBadge = gesture.pressedBadge;
    if (badge && pressedBadge && badge.node === pressedBadge.node && badge.kind === pressedBadge.kind) {
      if (badge.kind === 'open') this.actions.openExpand(badge.node);
      else this.actions.toggleExpand(badge.node);
      return;
    }
    this.actions.nodeClicked(gesture.pressedNode);
  }

  private snapCreateRect(rect: Rect): Rect {
    return {
      x: snap(rect.x),
      y: snap(rect.y),
      w: Math.max(MIN_NODE_WIDTH, snap(rect.w)),
      h: Math.max(MIN_NODE_HEIGHT, snap(rect.h)),
    };
  }

  private onDoubleClick(event: MouseEvent): void {
    if (this.sceneTransition) return;
    const world = this.screenToWorld(this.eventPoint(event));
    // Edges win over nodes so edges inside unfolded frames stay editable — a frame always
    // contains its subgraph's edges.
    const edge = this.hitEdge(world);
    if (edge) {
      this.selectedEdge = edge;
      this.actions.editEdge(edge);
      this.requestRender();
      return;
    }
    if (this.hitNode(world) || this.hitGhost(world)) return;
    this.actions.quickCreateNode(world);
  }

  // Right-click classifies the target with the same hit chain as onPointerDown and hands it to
  // the app to build a menu. A node that is not already part of the selection becomes the sole
  // selection first, so the menu acts on it; an existing multi-selection is left intact.
  private onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const world = this.screenToWorld(this.eventPoint(event));
    const screenPoint = { x: event.clientX, y: event.clientY };

    const node = this.hitNode(world);
    if (node) {
      if (!this.selection.has(node)) this.select(node);
      this.actions.contextMenu({ kind: 'node', node }, screenPoint);
      return;
    }
    const edge = this.hitEdge(world);
    if (edge) {
      this.selectedEdge = edge;
      this.selection.clear();
      this.requestRender();
      this.actions.contextMenu({ kind: 'edge', edge }, screenPoint);
      return;
    }
    this.actions.contextMenu({ kind: 'canvas', world }, screenPoint);
  }

  private hitNode(world: Point): FlowNode | null {
    return this.hitNodeIn(this.model, world);
  }

  private hitNodeIn(model: FlowModel, world: Point): FlowNode | null {
    for (let index = model.nodes.length - 1; index >= 0; index -= 1) {
      const node = model.nodes[index];
      const expansion = model.display?.expansions.get(node);
      if (expansion && rectContains(expansion.inner, world)) {
        const transform = expansion.transform;
        const local = { x: (world.x - transform.tx) / transform.scale, y: (world.y - transform.ty) / transform.scale };
        return this.hitNodeIn(expansion.subModel, local) ?? node;
      }
      if (rectContains(this.rectOf(model, node), world)) return node;
    }
    return null;
  }

  private hitGhost(world: Point): GhostNode | null {
    return this.model.ghosts.find((ghost) => rectContains(ghost.pos, world)) ?? null;
  }

  private portPositions(node: FlowNode): Point[] {
    const { x, y, w, h } = this.rect(node);
    return [
      { x: x + w / 2, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w / 2, y: y + h },
      { x, y: y + h / 2 },
    ];
  }

  private hitPort(world: Point): { node: FlowNode; port: Point } | null {
    const candidates = new Set([...this.selection]);
    if (this.hoverNode) candidates.add(this.hoverNode);
    const hitRadius = PORT_HIT_RADIUS / this.view.scale;
    for (const node of candidates) {
      for (const port of this.portPositions(node)) {
        if (Math.hypot(world.x - port.x, world.y - port.y) <= hitRadius) return { node, port };
      }
    }
    return null;
  }

  private hitResizeHandle(world: Point): { node: FlowNode; corner: ResizeCorner } | null {
    if (this.selection.size !== 1) return null;
    const [node] = this.selection;
    const hitRadius = 9 / this.view.scale;
    const { x, y, w, h } = this.rect(node);
    const corners: Array<{ corner: ResizeCorner; x: number; y: number }> = [
      { corner: 'nw', x, y },
      { corner: 'ne', x: x + w, y },
      { corner: 'sw', x, y: y + h },
      { corner: 'se', x: x + w, y: y + h },
    ];
    for (const candidate of corners) {
      if (Math.hypot(world.x - candidate.x, world.y - candidate.y) <= hitRadius) {
        return { node, corner: candidate.corner };
      }
    }
    return null;
  }

  // Badge slots run right-to-left from the node's top-right corner. Nodes inside unfolded
  // frames offer full-page navigation too: the dive synthesizes a breadcrumb crumb for every
  // frame level it skips over.
  private nodeBadges(model: FlowModel, node: FlowNode): Badge[] {
    if (!model.traits.get(node)?.expand) return [];
    const rect = this.rectOf(model, node);
    const slotCenter = (slot: number) => ({ x: rect.x + rect.w - 16 - slot * BADGE_SLOT_SPACING, y: rect.y + 15 });
    if (this.expansionLayer?.isOpen(node.id)) {
      return [
        { kind: 'open', ...slotCenter(0) },
        { kind: 'collapse', ...slotCenter(1) },
      ];
    }
    return [
      { kind: 'open', ...slotCenter(0) },
      { kind: 'inline', ...slotCenter(1) },
    ];
  }

  private hitBadge(world: Point): BadgeHit | null {
    return this.hitBadgeIn(this.model, world, this.view.scale);
  }

  private hitBadgeIn(model: FlowModel, world: Point, effectiveScale: number): BadgeHit | null {
    const hitRadius = BADGE_HIT_RADIUS / Math.min(effectiveScale, 1);
    for (let index = model.nodes.length - 1; index >= 0; index -= 1) {
      const node = model.nodes[index];
      for (const badge of this.nodeBadges(model, node)) {
        if (Math.hypot(world.x - badge.x, world.y - badge.y) <= hitRadius) {
          return { kind: badge.kind, node };
        }
      }
      const expansion = model.display?.expansions.get(node);
      if (expansion && rectContains(expansion.inner, world)) {
        const transform = expansion.transform;
        const subWorld = {
          x: (world.x - transform.tx) / transform.scale,
          y: (world.y - transform.ty) / transform.scale,
        };
        const hit = this.hitBadgeIn(expansion.subModel, subWorld, effectiveScale * transform.scale);
        if (hit) return hit;
      }
    }
    return null;
  }

  private hitEdge(world: Point): ModelEdge | null {
    return this.hitEdgeIn(this.model, world, this.view.scale);
  }

  private hitEdgeIn(model: FlowModel, world: Point, effectiveScale: number): ModelEdge | null {
    for (const [, expansion] of model.display?.expansions ?? []) {
      if (!rectContains(expansion.inner, world)) continue;
      const transform = expansion.transform;
      const local = { x: (world.x - transform.tx) / transform.scale, y: (world.y - transform.ty) / transform.scale };
      const hit = this.hitEdgeIn(expansion.subModel, local, effectiveScale * transform.scale);
      if (hit) return hit;
    }
    const hitDistance = EDGE_HIT_DISTANCE / effectiveScale;
    for (const edge of model.edges) {
      const geometry = edge.geometry;
      if (!geometry) continue;
      if (geometry.labelRect && rectContains(geometry.labelRect, world)) return edge;
      if (distanceToSegment(world, geometry.a, geometry.b) <= hitDistance) return edge;
    }
    return null;
  }

  private updateCursor(world?: Point): void {
    let cursor = this.tool === 'node' ? 'crosshair' : 'default';
    if (this.spaceDown || this.gesture?.type === 'pan') cursor = 'grab';
    else if (world) {
      if (this.hitBadge(world)) cursor = 'pointer';
      else if (this.hitPort(world)) cursor = 'crosshair';
      else if (this.hitResizeHandle(world)) cursor = 'nwse-resize';
      else if (this.hitNode(world) || this.hitGhost(world)) cursor = 'move';
    }
    this.canvas.style.cursor = cursor;
  }

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.sceneTransition) {
      this.renderSceneTransition(this.sceneTransition);
      return;
    }

    const expansionState = this.expansionLayer?.layout(this.model, performance.now()) ?? { animating: false };
    this.expansionLayer?.collectLoci(this.model);
    const dpr = this.devicePixelRatio;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawGrid(this.view);

    const { x, y, scale } = this.view;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);

    this.drawScene(this.model);
    this.drawSelectionDecorations();
    this.drawPorts();
    this.drawGestureOverlay();

    this.actions.afterRender?.();
    if (expansionState.animating) this.requestRender();
  }

  private renderSceneTransition(transition: SceneTransition): void {
    const { ctx } = this;
    const dpr = this.devicePixelRatio;
    const now = performance.now();

    if (transition.phase === 'hold') {
      this.expansionLayer?.layout(transition.outgoing.model, now);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawGrid(transition.outgoing.view);
      this.drawWorldScene(transition.outgoing.model, transition.outgoing.view, 1);
      return;
    }

    const t = Math.min(1, (now - transition.startTime) / transition.duration);
    const eased = easeInOutCubic(t);
    const parentView = interpolateView(transition.parentFrom, transition.parentTo, eased, transition.bounds);
    const childView = childViewLinkedTo(parentView, transition.link);
    const parentIsIncoming = transition.mode === 'out';

    const parentModel = parentIsIncoming ? transition.incoming.model : transition.outgoing.model;
    const childModel = parentIsIncoming ? transition.outgoing.model : transition.incoming.model;
    if (!transition.inlineAnchor) this.expansionLayer?.layout(parentModel, now);
    this.expansionLayer?.layout(childModel, now);

    this.view = { ...(parentIsIncoming ? parentView : childView) };
    const parentAlpha = parentIsIncoming ? eased : 1 - eased;
    const childAlpha = transition.inlineAnchor ? 1 : (parentIsIncoming ? 1 - eased : eased);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawGrid(this.view);
    this.drawWorldScene(parentModel, parentView, parentAlpha);

    // The child scene is clipped to the node's on-screen rectangle so the subgraph reads
    // as living inside the node; by the end of the dive that rectangle exceeds the
    // viewport and the clip becomes a no-op.
    const nodeScreen = {
      x: transition.nodeRect.x * parentView.scale + parentView.x,
      y: transition.nodeRect.y * parentView.scale + parentView.y,
      w: transition.nodeRect.w * parentView.scale,
      h: transition.nodeRect.h * parentView.scale,
    };
    this.drawWorldScene(childModel, childView, childAlpha, nodeScreen);

    this.actions.viewChanged?.();
    this.actions.afterRender?.();
    if (t >= 1) this.finishSceneTransition();
    else this.requestRender();
  }

  private drawWorldScene(model: FlowModel, view: View, alpha: number, clipScreenRect: Rect | null = null): void {
    if (alpha <= 0.01) return;
    const { ctx } = this;
    const dpr = this.devicePixelRatio;
    ctx.save();
    if (clipScreenRect) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.rect(clipScreenRect.x, clipScreenRect.y, clipScreenRect.w, clipScreenRect.h);
      ctx.clip();
    }
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    ctx.globalAlpha = alpha;
    this.drawScene(model);
    ctx.restore();
  }

  // Labels get their own pass after nodes so they stay readable even where an edge dives
  // under a node or an expanded frame. Edges that terminate inside an open frame are drawn
  // after nodes so the frame fill does not occlude them (§5.7 expanded display).
  private drawScene(model: FlowModel): void {
    this.computeEdgeGeometry(model);
    const redirected: ModelEdge[] = [];
    for (const edge of model.edges) {
      if (this.edgeTerminatesInsideOpenFrame(model, edge) || this.edgeOriginatesInsideOpenFrame(model, edge)) {
        redirected.push(edge);
      } else {
        this.drawEdge(edge);
      }
    }
    for (const node of model.nodes) this.drawNode(model, node);
    for (const edge of redirected) this.drawEdge(edge);
    for (const edge of model.edges) this.drawEdgeLabel(edge);
    for (const ghost of model.ghosts) this.drawGhost(ghost, { clickable: !model.embedded });
  }

  private drawGrid(view: View): void {
    const { ctx } = this;
    const spacing = 32 * view.scale;
    if (spacing < 9) return;
    const bounds = this.viewport;
    ctx.fillStyle = COLORS.grid;
    const offsetX = ((view.x % spacing) + spacing) % spacing;
    const offsetY = ((view.y % spacing) + spacing) % spacing;
    for (let gridX = offsetX; gridX < bounds.width; gridX += spacing) {
      for (let gridY = offsetY; gridY < bounds.height; gridY += spacing) {
        ctx.fillRect(gridX - 0.75, gridY - 0.75, 1.5, 1.5);
      }
    }
  }

  private computeEdgeGeometry(model: FlowModel): void {
    const pairCounts = new Map<string, number>();
    for (const edge of model.edges) {
      if (!edge.to?.pos || !edge.from?.pos) {
        edge.geometry = null;
        continue;
      }
      if (edge.to === edge.from) {
        edge.geometry = this.selfLoopGeometry(model, edge.from);
        continue;
      }
      let fromRect = this.rectOf(model, edge.from);
      let toRect = isGhost(edge.to) ? edge.to.pos : this.rectOf(model, edge.to);
      if (edge.kind === 'flow' && edge.spec.innerSource) {
        const innerRect = this.innerNodeRect(model, edge.from, edge.spec.innerSource);
        if (innerRect) fromRect = innerRect;
      }
      if (edge.kind === 'flow' && edge.spec.innerTarget && !isGhost(edge.to)) {
        const innerRect = this.innerNodeRect(model, edge.to, edge.spec.innerTarget);
        if (innerRect) toRect = innerRect;
      }
      const pairKey = [edge.from.name, edge.to.name].sort().join(' ');
      const occurrence = pairCounts.get(pairKey) ?? 0;
      pairCounts.set(pairKey, occurrence + 1);

      const a = rectBorderPointToward(fromRect, rectCenter(toRect));
      const b = rectBorderPointToward(toRect, rectCenter(fromRect));
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
      const bowMagnitude = (Math.min(34, length * 0.1) + Math.floor(occurrence / 2) * 26)
        * (occurrence % 2 === 0 ? 1 : -1);
      const mid = {
        x: (a.x + b.x) / 2 + normal.x * bowMagnitude,
        y: (a.y + b.y) / 2 + normal.y * bowMagnitude,
      };
      edge.geometry = { a, b, mid, labelRect: null };
    }
  }

  private edgeTerminatesInsideOpenFrame(model: FlowModel, edge: ModelEdge): boolean {
    if (edge.kind !== 'flow' || !edge.spec.innerTarget || !edge.to || isGhost(edge.to)) return false;
    return this.innerNodeRect(model, edge.to, edge.spec.innerTarget) != null;
  }

  private edgeOriginatesInsideOpenFrame(model: FlowModel, edge: ModelEdge): boolean {
    if (edge.kind !== 'flow' || !edge.spec.innerSource) return false;
    return this.innerNodeRect(model, edge.from, edge.spec.innerSource) != null;
  }

  // When a host frame is expanded far enough, map its named inner node into this model's
  // coordinates so an edge can start/end on it (collapsed / unresolved → plain host border).
  private innerNodeRect(model: FlowModel, host: FlowNode, innerName: string): Rect | null {
    const expansion = model.display?.expansions.get(host);
    if (!expansion || expansion.alpha <= 0.15) return null;
    const innerNode = expansion.subModel.nodesByName.get(innerName);
    if (!innerNode) return null;
    return transformRect(this.rectOf(expansion.subModel, innerNode), expansion.transform);
  }

  private selfLoopGeometry(model: FlowModel, node: FlowNode): NonNullable<ModelEdge['geometry']> {
    const { x, y, w } = this.rectOf(model, node);
    const a = { x: x + w - 30, y };
    const b = { x: x + w, y: y + 24 };
    const mid = { x: x + w + 42, y: y - 40 };
    return { a, b, mid, labelRect: null, selfLoop: true };
  }

  private edgeColor(edge: ModelEdge): string {
    if (edge === this.selectedEdge) return COLORS.select;
    return edge.kind === 'error' ? COLORS.error : COLORS.edge;
  }

  private drawEdge(edge: ModelEdge): void {
    const geometry = edge.geometry;
    if (!geometry) return;
    const color = this.edgeColor(edge);
    const seed = seedFrom(`${edge.from.name}->${edge.spec.target}:${edge.spec.label ?? ''}`);
    const options: RoughOptions = {
      seed,
      stroke: color,
      strokeWidth: edge === this.selectedEdge ? 2.2 : 1.5,
      roughness: 1.1,
      bowing: 0.4,
    };
    if (edge.kind === 'error') options.strokeLineDash = [7, 5];

    this.rough.curve(
      [[geometry.a.x, geometry.a.y], [geometry.mid.x, geometry.mid.y], [geometry.b.x, geometry.b.y]],
      options,
    );
    this.drawArrowhead(geometry.mid, geometry.b, color);
  }

  private drawEdgeLabel(edge: ModelEdge): void {
    const geometry = edge.geometry;
    if (!geometry) return;
    const labelText = edge.spec.label ?? (edge.kind === 'error' ? 'on error' : null);
    const anchor = edgeLabelAnchor(geometry);
    const fields = edge.spec.data ?? [];

    const labelRect = labelText
      ? this.drawEdgeLabelPill(labelText, anchor, edge.kind === 'error')
      : null;
    if (!fields.length) {
      geometry.labelRect = labelRect;
      return;
    }

    const fieldsTop = labelRect
      ? labelRect.y + labelRect.h + EDGE_DATA_GAP
      : anchor.y - (fields.length * EDGE_DATA_LINE_HEIGHT) / 2;
    const fieldsRect = this.drawEdgeDataFields(fields, anchor.x, fieldsTop);
    geometry.labelRect = labelRect ? unionRect(labelRect, fieldsRect) : fieldsRect;
  }

  private drawEdgeLabelPill(text: string, anchor: Point, isError: boolean): Rect {
    const { ctx } = this;
    ctx.font = `12px ${HAND_FONT}`;
    const paddingX = 7;
    const rect = {
      x: anchor.x - ctx.measureText(text).width / 2 - paddingX,
      y: anchor.y - 11,
      w: ctx.measureText(text).width + paddingX * 2,
      h: 21,
    };
    ctx.fillStyle = COLORS.edgeLabelBg;
    this.roundedRect(rect, 7);
    ctx.fill();
    ctx.fillStyle = isError ? COLORS.error : COLORS.edgeLabel;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, anchor.x, anchor.y + 1);
    return rect;
  }

  // Each field paints as `key: type`, the key in label ink and the type muted, so the schema
  // is readable on the canvas without opening the edge editor.
  private drawEdgeDataFields(fields: EdgeDataField[], centerX: number, top: number): Rect {
    const { ctx } = this;
    ctx.font = `10.5px ${HAND_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const keyTexts = fields.map((field) => (field.type ? `${field.key}:` : field.key));
    const lineWidths = fields.map(
      (field, index) => ctx.measureText(`${keyTexts[index]} ${field.type}`).width,
    );
    const paddingX = 6;
    const paddingY = 3;
    const rect = {
      x: centerX - Math.max(...lineWidths) / 2 - paddingX,
      y: top - paddingY,
      w: Math.max(...lineWidths) + paddingX * 2,
      h: fields.length * EDGE_DATA_LINE_HEIGHT + paddingY * 2,
    };
    ctx.fillStyle = COLORS.edgeLabelBg;
    this.roundedRect(rect, 6);
    ctx.fill();

    fields.forEach((field, index) => {
      const lineLeft = centerX - lineWidths[index] / 2;
      const lineMiddle = top + index * EDGE_DATA_LINE_HEIGHT + EDGE_DATA_LINE_HEIGHT / 2;
      ctx.fillStyle = COLORS.edgeLabel;
      ctx.fillText(keyTexts[index], lineLeft, lineMiddle);
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(field.type, lineLeft + ctx.measureText(`${keyTexts[index]} `).width, lineMiddle);
    });
    return rect;
  }

  private drawArrowhead(fromPoint: Point, tip: Point, color: string): void {
    const { ctx } = this;
    const angle = Math.atan2(tip.y - fromPoint.y, tip.x - fromPoint.x);
    const length = 11;
    const spread = 0.46;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - length * Math.cos(angle - spread), tip.y - length * Math.sin(angle - spread));
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - length * Math.cos(angle + spread), tip.y - length * Math.sin(angle + spread));
    ctx.stroke();
  }

  private roundedRect(rect: Rect, radius: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
  }

  private nodeStrokeColor(traits: NodeTraits | undefined): string {
    if (traits?.expand) return COLORS.expandStroke;
    if (traits?.decision) return COLORS.decisionStroke;
    if (traits?.entry) return COLORS.entryStroke;
    return COLORS.nodeStroke;
  }

  private drawNode(model: FlowModel, node: FlowNode): void {
    const expansion = model.display?.expansions.get(node);
    if (expansion) {
      this.drawExpandedNode(model, node, expansion);
      return;
    }

    const traits = model.traits.get(node);
    const rect = this.rectOf(model, node);
    const stroke = this.nodeStrokeColor(traits);

    this.rough.rectangle(rect.x, rect.y, rect.w, rect.h, {
      seed: seedFrom(node.id ?? node.name),
      roughness: 1.4,
      bowing: 0.7,
      stroke,
      strokeWidth: 1.6,
      fill: COLORS.nodeFill,
      fillStyle: 'solid',
    });

    this.drawNodeText(model, node, rect);
    this.drawTraitBadges(node, model.traits.get(node), rect);
    this.drawExpandBadges(model, node);
  }

  private drawExpandedNode(model: FlowModel, node: FlowNode, expansion: FrameExpansion): void {
    const { ctx } = this;
    const { frame, inner, transform, subModel } = expansion;

    this.rough.rectangle(frame.x, frame.y, frame.w, frame.h, {
      seed: seedFrom(node.id ?? node.name),
      roughness: 1.1,
      bowing: 0.5,
      stroke: COLORS.expandStroke,
      strokeWidth: 1.6,
      fill: COLORS.nodeFill,
      fillStyle: 'solid',
    });

    ctx.font = `600 13px ${HAND_FONT}`;
    ctx.fillStyle = COLORS.expandStroke;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.name, frame.x + 12, frame.y + 16, frame.w - 64);

    if (expansion.alpha > 0.02) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(inner.x, inner.y, inner.w, inner.h);
      ctx.clip();
      ctx.globalAlpha *= expansion.alpha;
      ctx.translate(transform.tx, transform.ty);
      ctx.scale(transform.scale, transform.scale);
      if (subModel.nodes.length === 0) this.drawEmptySubgraphHint();
      else this.drawScene(subModel);
      ctx.restore();
    }
    this.drawExpandBadges(model, node);
  }

  private drawEmptySubgraphHint(): void {
    const { ctx } = this;
    ctx.font = `13px ${HAND_FONT}`;
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('empty subgraph', 160, 90);
  }

  private drawNodeText(model: FlowModel, node: FlowNode, rect: Rect): void {
    const { ctx } = this;
    const { x, y, w, h } = rect;
    const maxWidth = w - 26;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = `600 15px ${HAND_FONT}`;
    const titleLines = this.wrapText(node.name, maxWidth, 2);
    const description = this.descriptionText(model, node);
    ctx.font = `12.5px ${HAND_FONT}`;
    const descriptionLineBudget = Math.max(0, Math.floor((h - 20 - titleLines.length * 20) / 16));
    const descriptionLines = description
      ? this.wrapText(description, maxWidth, Math.min(4, descriptionLineBudget))
      : [];

    const blockHeight = titleLines.length * 20 + (descriptionLines.length ? 6 + descriptionLines.length * 16 : 0);
    let lineY = y + h / 2 - blockHeight / 2 + 10;

    ctx.font = `600 15px ${HAND_FONT}`;
    ctx.fillStyle = COLORS.ink;
    for (const line of titleLines) {
      ctx.fillText(line, x + w / 2, lineY, maxWidth);
      lineY += 20;
    }
    if (descriptionLines.length) {
      lineY += 4;
      ctx.font = `12.5px ${HAND_FONT}`;
      ctx.fillStyle = COLORS.muted;
      for (const line of descriptionLines) {
        ctx.fillText(line, x + w / 2, lineY, maxWidth);
        lineY += 16;
      }
    }
  }

  private descriptionText(model: FlowModel, node: FlowNode): string | null {
    const expandDoc = this.expansionLayer?.expandDocumentFor(node, model.sourcePath) ?? null;
    const text = descriptionForNode(node, expandDoc);
    return text || null;
  }

  private wrapText(text: string, maxWidth: number, maxLines: number): string[] {
    if (maxLines <= 0) return [];
    const { ctx } = this;
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
        if (lines.length === maxLines) break;
      }
    }
    if (lines.length < maxLines && current) lines.push(current);
    if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
      lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '…');
    }
    return lines;
  }

  private drawTraitBadges(node: FlowNode, traits: NodeTraits | undefined, rect: Rect): void {
    const { ctx } = this;
    const { x, y, w, h } = rect;
    ctx.textBaseline = 'middle';

    if (traits?.entry) {
      ctx.font = `11px ${HAND_FONT}`;
      ctx.fillStyle = COLORS.entryStroke;
      ctx.textAlign = 'left';
      ctx.fillText('▶', x + 8, y + 14);
    }
    if (traits?.hasErrorHandler) {
      ctx.font = `12px ${HAND_FONT}`;
      ctx.fillStyle = COLORS.error;
      ctx.textAlign = 'right';
      ctx.fillText('⚠', x + w - 8, y + h - 12);
    }
    if (traits?.updates.length) {
      ctx.font = `10.5px ${HAND_FONT}`;
      ctx.fillStyle = COLORS.updates;
      ctx.textAlign = 'left';
      ctx.fillText(`↺ ${traits.updates.join(', ')}`, x + 8, y + h - 12, w - 30);
    }
  }

  private drawExpandBadges(model: FlowModel, node: FlowNode): void {
    const { ctx } = this;
    for (const badge of this.nodeBadges(model, node)) {
      this.rough.circle(badge.x, badge.y, 20, {
        seed: seedFrom(`${node.id}-${badge.kind}`),
        stroke: COLORS.expandStroke,
        strokeWidth: 1.3,
        roughness: 0.9,
      });
      ctx.font = `12px ${HAND_FONT}`;
      ctx.fillStyle = COLORS.expandStroke;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(BADGE_SYMBOLS[badge.kind], badge.x, badge.y + 1);
    }
  }

  private drawGhost(ghost: GhostNode, { clickable = true }: { clickable?: boolean } = {}): void {
    const { ctx } = this;
    const { x, y, w, h } = ghost.pos;
    ctx.save();
    ctx.strokeStyle = COLORS.ghost;
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.3;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 14px ${HAND_FONT}`;
    ctx.fillStyle = COLORS.ghost;
    ctx.fillText(ghost.name, x + w / 2, y + h / 2 - 8, w - 20);
    if (clickable) {
      ctx.font = `10.5px ${HAND_FONT}`;
      ctx.fillText('click to create', x + w / 2, y + h / 2 + 14, w - 20);
    }
  }

  private drawSelectionDecorations(): void {
    const { ctx } = this;
    const inflate = 5;
    ctx.save();
    ctx.strokeStyle = COLORS.select;
    ctx.lineWidth = 1.4 / this.view.scale;
    ctx.setLineDash([6 / this.view.scale, 4 / this.view.scale]);
    for (const node of this.selection) {
      if (!this.isNodeVisible(node)) continue;
      const { x, y, w, h } = this.rect(node);
      ctx.strokeRect(x - inflate, y - inflate, w + inflate * 2, h + inflate * 2);
    }
    ctx.restore();

    if (this.selection.size === 1) {
      const [node] = this.selection;
      if (!this.isNodeVisible(node)) return;
      const handleSize = 8 / this.view.scale;
      const { x, y, w, h } = this.rect(node);
      ctx.fillStyle = COLORS.select;
      for (const corner of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
        ctx.fillRect(corner[0] - handleSize / 2, corner[1] - handleSize / 2, handleSize, handleSize);
      }
    }
  }

  private drawPorts(): void {
    if (this.gesture && this.gesture.type !== 'edge') return;
    const { ctx } = this;
    const nodesWithPorts = new Set([...this.selection]);
    if (this.hoverNode) nodesWithPorts.add(this.hoverNode);
    const radius = PORT_RADIUS / Math.min(this.view.scale, 1.2);
    for (const node of nodesWithPorts) {
      if (!this.isNodeVisible(node)) continue;
      for (const port of this.portPositions(node)) {
        ctx.beginPath();
        ctx.arc(port.x, port.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#1b1e24';
        ctx.fill();
        ctx.strokeStyle = COLORS.select;
        ctx.lineWidth = 1.4 / this.view.scale;
        ctx.stroke();
      }
    }
  }

  private drawGestureOverlay(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const { ctx } = this;

    if (gesture.type === 'create' && gesture.rect) {
      ctx.save();
      ctx.strokeStyle = COLORS.select;
      ctx.setLineDash([7 / this.view.scale, 5 / this.view.scale]);
      ctx.lineWidth = 1.4 / this.view.scale;
      ctx.strokeRect(gesture.rect.x, gesture.rect.y, gesture.rect.w, gesture.rect.h);
      ctx.restore();
    } else if (gesture.type === 'marquee' && gesture.rect) {
      ctx.fillStyle = COLORS.marqueeFill;
      ctx.fillRect(gesture.rect.x, gesture.rect.y, gesture.rect.w, gesture.rect.h);
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = 1 / this.view.scale;
      ctx.strokeRect(gesture.rect.x, gesture.rect.y, gesture.rect.w, gesture.rect.h);
    } else if (gesture.type === 'edge') {
      const start = rectBorderPointToward(this.rect(gesture.from), gesture.toWorld);
      const end = gesture.hoverTarget
        ? rectBorderPointToward(this.rect(gesture.hoverTarget), rectCenter(this.rect(gesture.from)))
        : gesture.toWorld;
      ctx.save();
      ctx.strokeStyle = COLORS.select;
      ctx.setLineDash([7 / this.view.scale, 5 / this.view.scale]);
      ctx.lineWidth = 1.6 / this.view.scale;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.restore();
      this.drawArrowhead(start, end, COLORS.select);
      if (gesture.hoverTarget) {
        const { x, y, w, h } = this.rect(gesture.hoverTarget);
        ctx.strokeStyle = COLORS.select;
        ctx.lineWidth = 2 / this.view.scale;
        ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
      }
    }
  }
}

function isTypingTarget(element: EventTarget | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

