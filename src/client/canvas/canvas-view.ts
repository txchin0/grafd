// The canvas as an interactive surface: the pan/zoom transform, the active tool, hover and
// selection state, in-flight pointer gestures, hit-testing, and the camera animations for
// subgraph navigation. Every document mutation is delegated to the `actions` callbacks
// supplied by main.ts.
//
// Drawing the scene itself belongs to ScenePainter, which this builds fresh for each render
// pass; what stays here is the editing chrome the painter must not know about — selection
// outlines, ports, the marquee and the in-flight edge.
//
// The ExpansionLayer decorates each model with per-frame display geometry (`model.display`).
// Read a node's rect through `displayRectOf`, never its authored `pos`, or an unfolded frame
// measures at its collapsed size and warp offsets are ignored.

// Resolved by the import map in index.html to the served copy of rough.esm.js.
import rough from 'roughjs';
import type { FlowNode, Rect } from '../../shared/flow-format.js';
import { DEFAULT_ROUGHNESS } from '../../shared/manifest.js';
import { displayRectOf, displayRects, type FlowModel, type GhostNode, type ModelEdge } from '../flow-doc.js';
import {
  boundsOfRects,
  easeInOutCubic,
  normalizedRect,
  padRect,
  rectBorderPointToward,
  rectCenter,
  rectContains,
  rectsIntersect,
  type Point,
} from '../geometry.js';
import {
  distanceToEdgePath,
  type EdgeGeometry,
  edgePathMidpoint,
} from './edge-path.js';
import type { EdgeGeometryMap } from './edge-layout.js';
import { BADGE_HIT_RADIUS, nodeBadges, type BadgeHit } from './node-badges.js';
import { ScenePainter } from './scene-painter.js';
import {
  FRAME_TITLE_FONT_PX,
  TITLE_FONT_PX,
  frameTitleBand,
  layOutNodeText,
  titleBandOf,
  type NodeTextLayout,
} from './node-metrics.js';
// A live object refilled in place on every theme change, never reassigned.
import { canvasPalette } from '../theme.js';
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
  inverseTransformPoint,
  inverseTransformRect,
  transformPoint,
  transformRect,
  type ExpansionLayer,
  type FrameTransform,
} from './expansion.js';

export type { CameraLink, View, ViewportSize } from './camera-transition.js';
export { childViewLinkedTo, interpolateView, parentViewLinkedTo } from './camera-transition.js';

export type Tool = 'select' | 'node';




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
      childDrawnByParent: boolean;
      bounds: ViewportSize;
      duration: number;
      startTime: number;
      resolve: () => void;
    };

// Where an edge released on empty canvas should put the node it creates. Only edges leaving
// a node inside an unfolded frame need one: at the top level the drop point is already in
// the owning graph's coordinates.
export type EmptyEdgeDrop =
  // Inside the same frame the edge left from: an ordinary edge within that subgraph.
  | { kind: 'inner'; host: FlowNode; point: Point }
  // One level out, in the graph that owns the frame: an `{Inner Source}` edge on the host.
  | { kind: 'outer'; host: FlowNode; innerName: string; point: Point };

// Rects and points reaching these callbacks are expressed in the coordinate space of the
// graph that will own the new node — world space at the top level, frame-local space
// whenever a frame host comes with them.
export interface CanvasActions {
  createNode(rect: Rect, frameHost: FlowNode | null): void;
  quickCreateNode(point: Point, frameHost: FlowNode | null): void;
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
      emptyDrop?: EmptyEdgeDrop;
    },
  ): void;
  editEdge(edge: ModelEdge): void;
  editNodeTitle(node: FlowNode): void;
  openExpand(node: FlowNode): void;
  toggleExpand(node: FlowNode): void;
  materializeGhost(ghost: GhostNode): void;
  contextMenu(target: ContextTarget, screenPoint: Point): void;
  viewChanged?(): void;
  afterRender?(): void;
}


export interface TitlePlacement {
  rect: Rect;
  fontPx: number;
  align: 'center' | 'left';
  color: string;
  screenScale: number;
}

export type ContextTarget =
  | { kind: 'node'; node: FlowNode }
  | { kind: 'edge'; edge: ModelEdge }
  | { kind: 'canvas'; world: Point };


const MIN_SCALE = 0.12;
const MAX_SCALE = 3;
const MAX_FIT_SCALE = 1.4;
const ZOOM_STEP_FACTOR = 1.1;
const MIN_NODE_WIDTH = 120;
const MIN_NODE_HEIGHT = 64;
const DRAG_THRESHOLD_PX = 4;
// Below this the drawn rectangle reads as a stray click rather than a deliberate node.
const CREATE_MIN_SCREEN_WIDTH = 14;
const CREATE_MIN_SCREEN_HEIGHT = 10;
const SNAP = 8;
const PORT_RADIUS = 5;
const PORT_HIT_RADIUS = 14;
const EDGE_HIT_DISTANCE = 10;
const FIT_PADDING = 80;
// Where the origin sits relative to the viewport centre when there is nothing to frame.
const EMPTY_CANVAS_ORIGIN = { x: 200, y: 150 };
const EMPTY_SNAPSHOT_SIZE = { w: 400, h: 300 };
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

function fitScaleFor(bounds: Rect, viewport: ViewportSize): number {
  return Math.min(viewport.width / bounds.w, viewport.height / bounds.h);
}

function snap(value: number): number {
  return Math.round(value / SNAP) * SNAP;
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
  readonly expansionLayer: ExpansionLayer;
  gridIsVisible = true;
  doubleClickOpensSubgraph = true;
  baseRoughness = DEFAULT_ROUGHNESS;
  titleEditingNodeId: string | null = null;

  private hoverNode: FlowNode | null = null;
  private hoverPoint: Point | null = null;
  private gesture: Gesture | null = null;
  private tool: Tool = 'select';
  private sceneTransition: SceneTransition | null = null;
  private spaceDown = false;
  private renderQueued = false;

  // Where each edge currently sits on screen. Accumulated across a whole render — drawScene
  // recurses into every unfolded subgraph, and each level contributes its own edges — so this
  // is cleared once per pass rather than once per model.
  private edgeGeometry: EdgeGeometryMap = new Map();

  constructor(canvasElement: HTMLCanvasElement, actions: CanvasActions, expansionLayer: ExpansionLayer) {
    this.canvas = canvasElement;
    this.liveTarget = targetForCanvas(canvasElement, { width: 0, height: 0 }, window.devicePixelRatio || 1);
    this.target = this.liveTarget;
    this.actions = actions;
    this.expansionLayer = expansionLayer;
    this.model = {
      nodes: [],
      edges: [],
      ghosts: [],
      nodesByName: new Map(),
      traits: new Map(),
      sourceDoc: { leading: [], preamble: null, items: [] },
      sourcePath: null,
      sourceScope: null,
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
          ?? (this.expansionLayer.isEmbedded(node) ? node : null))
        .filter((node): node is FlowNode => node != null),
    );
    this.selectedEdge = model.edges.find((edge) => edge.spec === selectedEdgeSpec)
      ?? (this.selectedEdge && this.expansionLayer.isEmbedded(this.selectedEdge.from) ? this.selectedEdge : null);
    if (this.hoverNode) {
      const previousHoverId = this.hoverNode.id;
      this.hoverNode = model.nodes.find((node) => node.id === previousHoverId)
        ?? (this.expansionLayer.isEmbedded(this.hoverNode) ? this.hoverNode : null);
    }
    this.requestRender();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.updateCursor(this.hoverPoint ?? undefined);
  }

  private layoutDisplayGeometry(model: FlowModel): void {
    this.expansionLayer.layout(model, performance.now());
    this.expansionLayer.collectLoci(model);
  }

  // Brings frame geometry and loci up to date without waiting for the next animation frame,
  // so a node just added inside a frame can be measured and edited immediately.
  refreshDisplayGeometry(): void {
    this.layoutDisplayGeometry(this.model);
  }

  // Which graph a point on the canvas belongs to, and the point in that graph's own
  // coordinates: the innermost unfolded frame containing it, or the top-level graph.
  creationTargetAt(world: Point): { frameHost: FlowNode | null; point: Point } {
    const frame = this.expansionLayer.frameAt(world);
    if (!frame) return { frameHost: null, point: world };
    return { frameHost: frame.host, point: inverseTransformPoint(world, frame.transform) };
  }

  // World-space rect of any visible node, including nodes inside unfolded frames: the
  // node's local display rect pushed through its locus transform.
  rect(node: FlowNode): Rect {
    const locus = this.expansionLayer.locusOf(node);
    if (!locus) return displayRectOf(this.model, node);
    return transformRect(displayRectOf(locus.model, node), locus.transform);
  }

  private isNodeVisible(node: FlowNode): boolean {
    return !this.expansionLayer.hasLoci() || this.expansionLayer.locusOf(node) != null;
  }

  // Where an edge currently is on screen, or null when it has not been drawn — an unresolved
  // target, or no render yet. Keyed by edge here rather than stored on it because it describes
  // how the scene is drawn, which is the view's business and not the document's.
  edgeGeometryOf(edge: ModelEdge): EdgeGeometry | null {
    return this.edgeGeometry.get(edge) ?? null;
  }

  edgeAnchor(edge: ModelEdge): Point {
    const geometry = this.edgeGeometryOf(edge);
    const mid = geometry ? edgePathMidpoint(geometry.path) : rectCenter(this.rect(edge.from));
    const locus = this.expansionLayer.locusOf(edge.from);
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

  private contentBounds(): Rect | null {
    return boundsOfRects(displayRects(this.model));
  }

  private clampedFitView(bounds: Rect, viewport: ViewportSize): View {
    const scale = Math.max(MIN_SCALE, Math.min(fitScaleFor(bounds, viewport), MAX_FIT_SCALE));
    return centerBoundsAt(bounds, viewport, scale);
  }

  // An empty canvas has no content to frame, so it parks at unit scale instead of fitting.
  private emptyCanvasView(viewport: ViewportSize): View {
    return {
      x: viewport.width / 2 - EMPTY_CANVAS_ORIGIN.x,
      y: viewport.height / 2 - EMPTY_CANVAS_ORIGIN.y,
      scale: 1,
    };
  }

  private computeFitView(padding = FIT_PADDING, viewport: ViewportSize = this.viewport): View {
    // Fit runs synchronously right after a model/scope swap, before the render loop's
    // next layout pass; without eager display layout, unfolded frames measure at their
    // collapsed pos and expanded subgraphs get clipped — the same reason a manual
    // zoom-to-fit a moment later frames them correctly.
    this.layoutDisplayGeometry(this.model);
    const bounds = this.contentBounds();
    return bounds ? this.clampedFitView(padRect(bounds, padding), viewport) : this.emptyCanvasView(viewport);
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
    const bounds = this.contentBounds();
    // The empty fallback is deliberately unpadded — it is already a whole notional page
    // rather than content that needs room around it.
    return bounds ? padRect(bounds, padding) : { x: 0, y: 0, ...EMPTY_SNAPSHOT_SIZE };
  }

  // Draws the scene onto a caller-owned canvas at an arbitrary resolution, framed exactly
  // like zoom-to-fit. Editing chrome (selection, ports, gesture overlay) is deliberately
  // omitted, and the draw is synchronous rather than rAF-queued so the caller can read the
  // pixels back the moment this returns.
  renderSnapshot({ canvas, viewport, pixelRatio, background, grid }: SnapshotRequest): void {
    const previousTarget = this.target;
    const previousEdgeGeometry = this.edgeGeometry;
    this.target = targetForCanvas(canvas, viewport, pixelRatio);
    this.edgeGeometry = new Map();
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
      this.scenePainter(null).drawScene(this.model);
    } finally {
      this.target = previousTarget;
      this.edgeGeometry = previousEdgeGeometry;
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
    // A dive is only ever anchored to a frame that is unfolded on screen, so an anchor here
    // always means the subgraph is already drawn inside the node it grows out of.
    return this.startZoomTransition({
      mode: 'in',
      nodeRect,
      inlineAnchor,
      childDrawnByParent: inlineAnchor !== null,
      duration,
    });
  }

  zoomBackOut(
    { nodeRect, targetView, inlineAnchor = null, childDrawnByParent = false, duration = BACK_OUT_MS }:
      {
        nodeRect: Rect;
        targetView: View;
        inlineAnchor?: FrameTransform | null;
        childDrawnByParent?: boolean;
        duration?: number;
      },
  ): Promise<void> {
    return this.startZoomTransition({ mode: 'out', nodeRect, targetView, inlineAnchor, childDrawnByParent, duration });
  }

  private startZoomTransition(
    { mode, nodeRect, targetView, inlineAnchor, childDrawnByParent, duration }:
      {
        mode: 'in' | 'out';
        nodeRect: Rect;
        targetView?: View;
        inlineAnchor: FrameTransform | null;
        childDrawnByParent: boolean;
        duration: number;
      },
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
        childDrawnByParent,
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
        scale: this.expansionLayer.scaleOf(handle.node),
      };
      return;
    }

    const wantsCreate = this.tool === 'node' && !event.shiftKey;
    const node = this.hitNode(world);
    if (node && !(wantsCreate && this.isFrameBackground(node, world))) {
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
        scales: new Map([...this.selection].map((n) => [n, this.expansionLayer.scaleOf(n)])),
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
      this.hoverNode = this.hoverNodeAt(world);
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
        this.dispatchNodePress(gesture, world, event.detail);
      }
    } else if (gesture.type === 'resize') {
      this.actions.moveCommitted([gesture.node]);
    } else if (gesture.type === 'edge') {
      const rawTarget = this.hitNode(world);
      const drop = this.resolveEdgeDrop(gesture.from, rawTarget);
      this.actions.completeEdge(gesture.from, drop.targetNode, world, {
        droppedOnSource: rawTarget === gesture.from,
        ghostTarget: this.expansionLayer.isEmbedded(gesture.from) ? null : this.hitGhost(world),
        innerName: drop.innerDrop?.innerName,
        outerSource: drop.outerDrop ?? undefined,
        emptyDrop: this.emptyEdgeDropFor(gesture.from, rawTarget, drop.targetNode, world) ?? undefined,
      });
    } else if (gesture.type === 'create') {
      this.completeCreateGesture(gesture, world);
    } else if (gesture.type === 'marquee' && gesture.rect) {
      this.selectNodesInMarquee(gesture.rect);
    }
    this.requestRender();
  }

  // An unfolded frame answers hit-tests over its whole interior, so its empty space reads as
  // a press on the host. With the node tool that space is the subgraph's drawing surface
  // instead — otherwise a frame could never be drawn into, only dragged around.
  private isFrameBackground(node: FlowNode, world: Point): boolean {
    return this.expansionLayer.frameAt(world)?.host === node;
  }

  // A drawn rectangle belongs to the graph its drag started in. Crossing a frame boundary
  // makes the intended graph ambiguous — and would silently create a node whose drawn size
  // means something else in the graph it lands in — so such a drag creates nothing.
  private completeCreateGesture(gesture: Extract<Gesture, { type: 'create' }>, world: Point): void {
    if (!gesture.rect || !this.isBigEnoughToCreate(gesture.rect)) return;
    const startFrame = this.expansionLayer.frameAt(gesture.startWorld);
    const endFrame = this.expansionLayer.frameAt(world);
    if ((startFrame?.host ?? null) !== (endFrame?.host ?? null)) return;
    const rect = startFrame ? inverseTransformRect(gesture.rect, startFrame.transform) : gesture.rect;
    this.actions.createNode(this.snapCreateRect(rect), startFrame?.host ?? null);
  }

  private isBigEnoughToCreate(rect: Rect): boolean {
    return rect.w * this.view.scale > CREATE_MIN_SCREEN_WIDTH && rect.h * this.view.scale > CREATE_MIN_SCREEN_HEIGHT;
  }

  private inSameModel(nodeA: FlowNode | null, nodeB: FlowNode | null): boolean {
    if (!nodeA || !nodeB) return false;
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
    if (this.expansionLayer.isEmbedded(from)) {
      // §5.8: an edge dragged out of a frame lands on a sibling of the frame's host and
      // becomes an `{Inner Source}` edge declared on the host. Single-level: the host must
      // share a graph with the drop target.
      const host = this.expansionLayer.hostOf(from);
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
    const host = this.expansionLayer.hostOf(rawTarget);
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

  // A frame's empty interior hit-tests as its host, so "released on empty canvas" means no
  // node under the cursor *or* only the frame the cursor is drawing inside. Releasing on a
  // node the edge cannot legally reach stays a no-op rather than creating one beneath it.
  private emptyEdgeDropFor(
    from: FlowNode,
    rawTarget: FlowNode | null,
    resolvedTarget: FlowNode | null,
    world: Point,
  ): EmptyEdgeDrop | null {
    if (resolvedTarget) return null;
    if (rawTarget && !this.isFrameBackground(rawTarget, world)) return null;
    return this.resolveEmptyEdgeDrop(from, world);
  }

  // An edge released on empty canvas from inside an unfolded frame. Landing in the frame it
  // left creates a sibling in that subgraph; landing in the graph that owns the frame creates
  // a node there, joined to the subgraph by an `{Inner Source}` edge on the host (§5.8).
  // Anything further out has no single-level form to express, so it creates nothing.
  private resolveEmptyEdgeDrop(from: FlowNode, world: Point): EmptyEdgeDrop | null {
    const host = this.expansionLayer.hostOf(from);
    if (!host) return null;
    const dropFrame = this.expansionLayer.frameAt(world);
    const dropHost = dropFrame?.host ?? null;
    const point = dropFrame ? inverseTransformPoint(world, dropFrame.transform) : world;
    if (dropHost === host) return { kind: 'inner', host, point };
    if (dropHost === this.expansionLayer.hostOf(host)) {
      return { kind: 'outer', host, innerName: from.name, point };
    }
    return null;
  }

  // Marquee reaches into unfolded frames, but a node is skipped when one of its host
  // frames is also caught — dragging a frame already carries its contents.
  private selectNodesInMarquee(rect: Rect): void {
    const candidates = this.expansionLayer.locus ? [...this.expansionLayer.locus.keys()] : this.model.nodes;
    for (const node of candidates) {
      if (rectsIntersect(rect, this.rect(node))) this.selection.add(node);
    }
    for (const node of [...this.selection]) {
      if (this.hasSelectedAncestorFrame(node)) this.selection.delete(node);
    }
  }

  private hasSelectedAncestorFrame(node: FlowNode): boolean {
    let host = this.expansionLayer.hostOf(node);
    while (host) {
      if (this.selection.has(host)) return true;
      host = this.expansionLayer.hostOf(host);
    }
    return false;
  }

  // The second press of a double-click must not reopen the node editor panel that the
  // inline title editor is about to replace.
  private dispatchNodePress(gesture: Extract<Gesture, { type: 'move' }>, world: Point, clickCount: number): void {
    const badge = this.hitBadge(world);
    const pressedBadge = gesture.pressedBadge;
    if (badge && pressedBadge && badge.node === pressedBadge.node && badge.kind === pressedBadge.kind) {
      if (badge.kind === 'open') this.actions.openExpand(badge.node);
      else this.actions.toggleExpand(badge.node);
      return;
    }
    if (clickCount < 2) this.actions.nodeClicked(gesture.pressedNode);
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
    const titledNode = this.hitNodeTitle(world);
    if (titledNode) {
      this.select(titledNode);
      this.actions.editNodeTitle(titledNode);
      return;
    }
    const subgraph = this.subgraphToOpenAt(world);
    if (subgraph) {
      this.select(subgraph);
      this.actions.openExpand(subgraph);
      return;
    }
    if (this.hitNode(world) || this.hitGhost(world)) return;
    const target = this.creationTargetAt(world);
    this.actions.quickCreateNode(target.point, target.frameHost);
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
      if (rectContains(displayRectOf(model, node), world)) return node;
    }
    return null;
  }

  // Narrows a node hit to the node's title text, so double-clicking the description or the
  // empty part of a node keeps its existing meaning. Ghosts are a separate list and so are
  // never titled.
  private hitNodeTitle(world: Point): FlowNode | null {
    const node = this.hitNode(world);
    if (!node) return null;
    const placement = this.titlePlacementOf(node);
    return placement && rectContains(placement.rect, world) ? node : null;
  }

  // The node a double-click should dive into. The `expand` trait is read from the model that
  // owns the node rather than the top-level one, so a node sitting inside an unfolded frame
  // opens just as a top-level one does.
  subgraphToOpenAt(world: Point): FlowNode | null {
    if (!this.doubleClickOpensSubgraph) return null;
    const node = this.hitNode(world);
    if (!node) return null;
    const owningModel = this.expansionLayer.modelOf(node) ?? this.model;
    return owningModel.traits.get(node)?.expand ? node : null;
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

  private portOfNodeNear(node: FlowNode, world: Point): Point | null {
    const hitRadius = PORT_HIT_RADIUS / this.view.scale;
    for (const port of this.portPositions(node)) {
      if (Math.hypot(world.x - port.x, world.y - port.y) <= hitRadius) return port;
    }
    return null;
  }

  private hitPort(world: Point): { node: FlowNode; port: Point } | null {
    const candidates = new Set([...this.selection]);
    if (this.hoverNode) candidates.add(this.hoverNode);
    for (const node of candidates) {
      const port = this.portOfNodeNear(node, world);
      if (port) return { node, port };
    }
    return null;
  }

  // Ports straddle the node's border, so aiming at one takes the cursor outside the node's
  // rectangle. Hover has to outlive that crossing or the port disappears as it is reached for.
  private hoverNodeAt(world: Point): FlowNode | null {
    const hit = this.hitNode(world);
    if (hit) return hit;
    const held = this.hoverNode;
    return held && this.portOfNodeNear(held, world) ? held : null;
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

  private hitBadge(world: Point): BadgeHit | null {
    return this.hitBadgeIn(this.model, world, this.view.scale);
  }

  private hitBadgeIn(model: FlowModel, world: Point, effectiveScale: number): BadgeHit | null {
    const hitRadius = BADGE_HIT_RADIUS / Math.min(effectiveScale, 1);
    for (let index = model.nodes.length - 1; index >= 0; index -= 1) {
      const node = model.nodes[index];
      for (const badge of nodeBadges(model, node, this.expansionLayer.isOpen(node.id))) {
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
      const geometry = this.edgeGeometryOf(edge);
      if (!geometry) continue;
      if (geometry.labelRect && rectContains(geometry.labelRect, world)) return edge;
      if (distanceToEdgePath(world, geometry.path) <= hitDistance) return edge;
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

  private scenePainter(hiddenTitleNodeId: string | null): ScenePainter {
    return new ScenePainter({
      ctx: this.ctx,
      rough: this.rough,
      baseRoughness: this.baseRoughness,
      selectedEdge: this.selectedEdge,
      hiddenTitleNodeId,
      edgeGeometry: this.edgeGeometry,
      expansions: this.expansionLayer,
    });
  }

  private render(): void {
    const { ctx } = this;
    this.edgeGeometry.clear();
    const painter = this.scenePainter(this.titleEditingNodeId);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.sceneTransition) {
      this.renderSceneTransition(this.sceneTransition, painter);
      return;
    }

    const expansionState = this.expansionLayer.layout(this.model, performance.now());
    this.expansionLayer.collectLoci(this.model);
    const dpr = this.devicePixelRatio;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawGridIfVisible(this.view);

    const { x, y, scale } = this.view;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);

    painter.drawScene(this.model);
    this.drawSelectionDecorations();
    this.drawPorts();
    this.drawGestureOverlay(painter);

    this.actions.afterRender?.();
    if (expansionState.animating) this.requestRender();
  }

  private renderSceneTransition(transition: SceneTransition, painter: ScenePainter): void {
    const { ctx } = this;
    const dpr = this.devicePixelRatio;
    const now = performance.now();

    if (transition.phase === 'hold') {
      this.expansionLayer.layout(transition.outgoing.model, now);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawGridIfVisible(transition.outgoing.view);
      this.drawWorldScene(painter, transition.outgoing.model, transition.outgoing.view, 1);
      return;
    }

    const t = Math.min(1, (now - transition.startTime) / transition.duration);
    const eased = easeInOutCubic(t);
    const parentView = interpolateView(transition.parentFrom, transition.parentTo, eased, transition.bounds);
    const childView = childViewLinkedTo(parentView, transition.link);
    const parentIsIncoming = transition.mode === 'out';

    const parentModel = parentIsIncoming ? transition.incoming.model : transition.outgoing.model;
    const childModel = parentIsIncoming ? transition.outgoing.model : transition.incoming.model;
    if (!transition.inlineAnchor) this.expansionLayer.layout(parentModel, now);
    this.expansionLayer.layout(childModel, now);

    this.view = { ...(parentIsIncoming ? parentView : childView) };
    const parentAlpha = parentIsIncoming ? eased : 1 - eased;
    const childAlpha = transition.childDrawnByParent ? 1 : (parentIsIncoming ? 1 - eased : eased);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawGridIfVisible(this.view);
    this.drawWorldScene(painter, parentModel, parentView, parentAlpha);

    // The child scene is clipped to the node's on-screen rectangle so the subgraph reads
    // as living inside the node; by the end of the dive that rectangle exceeds the
    // viewport and the clip becomes a no-op.
    const nodeScreen = {
      x: transition.nodeRect.x * parentView.scale + parentView.x,
      y: transition.nodeRect.y * parentView.scale + parentView.y,
      w: transition.nodeRect.w * parentView.scale,
      h: transition.nodeRect.h * parentView.scale,
    };
    this.drawWorldScene(painter, childModel, childView, childAlpha, nodeScreen);

    this.actions.viewChanged?.();
    this.actions.afterRender?.();
    if (t >= 1) this.finishSceneTransition();
    else this.requestRender();
  }

  private drawWorldScene(
    painter: ScenePainter,
    model: FlowModel,
    view: View,
    alpha: number,
    clipScreenRect: Rect | null = null,
  ): void {
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
    painter.drawScene(model);
    ctx.restore();
  }

  // Only the live canvas honours the preference; an export draws whatever its own grid
  // checkbox asked for, so renderSnapshot calls drawGrid directly.
  private drawGridIfVisible(view: View): void {
    if (this.gridIsVisible) this.drawGrid(view);
  }

  private drawGrid(view: View): void {
    const { ctx } = this;
    const spacing = 32 * view.scale;
    if (spacing < 9) return;
    const bounds = this.viewport;
    ctx.fillStyle = canvasPalette.grid;
    const offsetX = ((view.x % spacing) + spacing) % spacing;
    const offsetY = ((view.y % spacing) + spacing) % spacing;
    for (let gridX = offsetX; gridX < bounds.width; gridX += spacing) {
      for (let gridY = offsetY; gridY < bounds.height; gridY += spacing) {
        ctx.fillRect(gridX - 0.75, gridY - 0.75, 1.5, 1.5);
      }
    }
  }

  private layOutNodeText(model: FlowModel, node: FlowNode, rect: Rect): NodeTextLayout {
    return layOutNodeText(this.ctx, node, rect, this.expansionLayer.descriptionFor(node, model.sourcePath));
  }

  // World-space rect and typography of a node's title as drawn, or null when the node is
  // not currently visible. Unfolded frames title their host differently from a plain node,
  // so callers get the variant's font, alignment and colour alongside the band.
  titlePlacementOf(node: FlowNode): TitlePlacement | null {
    const locus = this.expansionLayer.locusOf(node);
    if (this.expansionLayer.hasLoci() && !locus) return null;
    const model = locus?.model ?? this.model;
    const expansion = model.display?.expansions.get(node);
    const localRect = displayRectOf(model, node);
    const band = expansion
      ? frameTitleBand(this.ctx, node, expansion.frame)
      : titleBandOf(localRect, this.layOutNodeText(model, node, localRect));

    return {
      rect: locus ? transformRect(band, locus.transform) : band,
      fontPx: expansion ? FRAME_TITLE_FONT_PX : TITLE_FONT_PX,
      align: expansion ? 'left' : 'center',
      color: expansion ? canvasPalette.expandStroke : canvasPalette.ink,
      screenScale: this.view.scale * this.expansionLayer.scaleOf(node),
    };
  }

  private drawSelectionDecorations(): void {
    const { ctx } = this;
    const inflate = 5;
    ctx.save();
    ctx.strokeStyle = canvasPalette.select;
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
      ctx.fillStyle = canvasPalette.select;
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
        ctx.fillStyle = canvasPalette.portFill;
        ctx.fill();
        ctx.strokeStyle = canvasPalette.select;
        ctx.lineWidth = 1.4 / this.view.scale;
        ctx.stroke();
      }
    }
  }

  private drawGestureOverlay(painter: ScenePainter): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const { ctx } = this;

    if (gesture.type === 'create' && gesture.rect) {
      ctx.save();
      ctx.strokeStyle = canvasPalette.select;
      ctx.setLineDash([7 / this.view.scale, 5 / this.view.scale]);
      ctx.lineWidth = 1.4 / this.view.scale;
      ctx.strokeRect(gesture.rect.x, gesture.rect.y, gesture.rect.w, gesture.rect.h);
      ctx.restore();
    } else if (gesture.type === 'marquee' && gesture.rect) {
      ctx.fillStyle = canvasPalette.marqueeFill;
      ctx.fillRect(gesture.rect.x, gesture.rect.y, gesture.rect.w, gesture.rect.h);
      ctx.strokeStyle = canvasPalette.select;
      ctx.lineWidth = 1 / this.view.scale;
      ctx.strokeRect(gesture.rect.x, gesture.rect.y, gesture.rect.w, gesture.rect.h);
    } else if (gesture.type === 'edge') {
      const start = rectBorderPointToward(this.rect(gesture.from), gesture.toWorld);
      const end = gesture.hoverTarget
        ? rectBorderPointToward(this.rect(gesture.hoverTarget), rectCenter(this.rect(gesture.from)))
        : gesture.toWorld;
      ctx.save();
      ctx.strokeStyle = canvasPalette.select;
      ctx.setLineDash([7 / this.view.scale, 5 / this.view.scale]);
      ctx.lineWidth = 1.6 / this.view.scale;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.restore();
      painter.drawArrowhead(start, end, canvasPalette.select);
      if (gesture.hoverTarget) {
        const { x, y, w, h } = this.rect(gesture.hoverTarget);
        ctx.strokeStyle = canvasPalette.select;
        ctx.lineWidth = 2 / this.view.scale;
        ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
      }
    }
  }
}

function isTypingTarget(element: EventTarget | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

