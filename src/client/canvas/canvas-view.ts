// The canvas as an interactive surface: the pan/zoom transform, the active tool, hover and
// selection state, in-flight pointer gestures, hit-testing, and the camera animations for
// subgraph navigation. Every document mutation is delegated to the `actions` callbacks
// supplied by main.ts.
//
// Drawing the scene itself belongs to ScenePainter, which this builds fresh for each render
// pass; what stays here is the editing chrome the painter must not know about — selection
// outlines, ports, the marquee, the in-flight edge and the stroke under the pen.
//
// The ExpansionLayer decorates each model with per-frame display geometry (`model.display`).
// Read a node's rect through `displayRectOf`, never its authored `pos`, or an unfolded frame
// measures at its collapsed size and warp offsets are ignored.

// Resolved by the import map in index.html to the served copy of rough.esm.js.
import rough from 'roughjs';
import type { ContextBlock, FlowDocument, FlowNode, Rect } from '../../shared/flow-format.js';
import { DEFAULT_ROUGHNESS } from '../../shared/manifest.js';
import {
  DEFAULT_STROKE_WIDTH,
  STROKE_LINE_WIDTHS,
  drawingBounds,
  drawingGeometryBox,
  transformedDrawing,
  type CanvasDrawing,
  type StrokeWidth,
} from '../../shared/canvas-drawings.js';
import {
  IDENTITY_TRANSFORM,
  isIdentityTransform,
  translationBy,
  type DrawingTransform,
} from '../../shared/drawing-geometry.js';
import { TEXT_KIND, type TextDrawing } from '../../shared/canvas-text.js';
import { canvasLineMeasurer, drawingAsCarried, type LineMeasurer } from './text-drawing-layout.js';
import {
  displayRectOf,
  displayRects,
  findNodeById,
  isSameEdge,
  keepEmptiedRegionsInPlace,
  membersAfterChanges,
  membershipChangesForCombinedMove,
  membershipChangesForRegion,
  regionRectOf,
  type FlowModel,
  type GhostNode,
  type MembershipChange,
  type ModelContext,
  type ModelEdge,
} from '../flow-doc.js';
import {
  distanceBetween,
  easeInOutCubic,
  normalizedRect,
  rectCenter,
  rectContains,
  rectsIntersect,
  type Point,
} from '../geometry.js';
import { boundsOfRects, padRect, rectContainsRect } from '../../shared/rect-math.js';
import { distanceToEdgePath, type EdgeGeometry } from './edge-path.js';
import { drawnShapeOf, edgePathBounds, type EdgeBendOverrides, type EdgeGeometryMap } from './edge-layout.js';
import {
  beginEdgeBend,
  bendOverridesOf,
  extendEdgeBend,
  gripContains,
  type EdgeBendGesture,
} from './edge-bend-gesture.js';
import { canBendAlong } from './edge-bend.js';
import type { EdgeBend } from '../../shared/canvas-edge-style.js';
import { shapeBorderPointToward, shapeTextBox } from './node-shapes.js';
import { BADGE_HIT_RADIUS, nodeBadges, type BadgeHit } from './node-badges.js';
import { ScenePainter } from './scene-painter.js';
import {
  FRAME_TITLE_FONT_PX,
  TITLE_FONT_PX,
  frameTitleBand,
  layOutNodeText,
  regionLabelBand,
  titleBandOf,
  type NodeTextLayout,
} from './node-metrics.js';
import {
  applyCombinedMove,
  applyRegionResize,
  movingRegionGroupFor,
  regionRectDuringResize,
  regionRectsWithDrawnMove,
  regionRectsWithDrawnResize,
  rollbackCombinedMove,
  rollbackRegionResize,
  type CombinedMoveSnapshot,
  type MoveReference,
  type RegionResizeSnapshot,
} from './region-gestures.js';
import { hitRegionAt } from './region-hit-test.js';
import { hitDrawingAt, drawingsInsideRect, worldBoundsOf, type DrawingSurface } from './drawing-hit-test.js';
import {
  sameDrawingSelection,
  storedDrawingKey,
  type DrawingMove,
  type DrawingSelection,
  type StoredDrawing,
} from './drawing-selection.js';
import {
  beginStrokeGesture,
  extendStrokeGesture,
  finishedStrokePoints,
  resizedDrawingTransform,
  type StrokeGesture,
} from './stroke-gesture.js';
import { drawingInkColor, inkStroke } from './stroke-painter.js';
import {
  HANDLE_HIT_RADIUS_PX,
  axesOf,
  hitResizeHandle,
  resizeHandlePointsOf,
  selectionHandleOrigins,
  type ResizeHandle,
} from './resize-handles.js';
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
  pinchCenter,
  pinchDistance,
  viewForPinch,
  type PinchAnchor,
} from './pinch-gesture.js';
import { WheelIntentReader, ZOOM_STEP_FACTOR } from './wheel-intent.js';
import {
  inverseTransformPoint,
  modelsOnScreen,
  inverseTransformRect,
  transformPoint,
  transformRect,
  type ExpansionLayer,
  type FrameExpansion,
  type FrameTransform,
} from './expansion.js';

export type { CameraLink, View, ViewportSize } from './camera-transition.js';
export { childViewLinkedTo, interpolateView, parentViewLinkedTo } from './camera-transition.js';

export type Tool = 'select' | 'node' | 'context' | 'draw' | 'text';

// What the pen draws with: a colour slot or `#rrggbb` (null for the theme's ink) and a width.
export interface DrawStyle {
  color: string | null;
  width: StrokeWidth;
}

// A selected drawing, remembered with the surface it was selected on so it can be found again in
// the rebuilt models after an edit — a frame's model is rebuilt whenever its document changes.
interface HeldDrawing extends DrawingSelection {
  surfaceKey: string;
}

// The drawings on screen as the view lays them out: a model, where it sits in the world, and the
// frame host it is unfolded under (null for the top-level graph).
interface ViewDrawingSurface extends DrawingSurface {
  host: FlowNode | null;
}

// A text as the view has laid it out: in its graph's units, with the transform to world units.
export interface LaidOutText {
  text: TextDrawing;
  transform: FrameTransform;
  selection: DrawingSelection;
}

// The selection when it is exactly one thing (soleSelection).
type SoleSelection =
  | { kind: 'node'; node: FlowNode }
  | { kind: 'region'; context: ModelContext }
  | { kind: 'edge'; edge: ModelEdge }
  | { kind: 'drawings'; resizable: ResizableDrawings };

// What a drawing's handles resize: a lone drawing, or exactly one whole group.
interface ResizableDrawings {
  surface: ViewDrawingSurface;
  drawings: DrawingSelection[];
  members: CanvasDrawing[];
}

// A drawing a move gesture carries, once per stored drawing however many frames show it.
interface MovingDrawing {
  drawing: DrawingSelection;
  storedKey: string;
  scale: number;
}

// Every gesture that drags something starts out as a press, and becomes a drag only once the
// pointer has travelled DRAG_THRESHOLD_PX (`hasBecomeDrag`). Until then nothing moves, resizes or
// is written, and letting go is a click on whatever was pressed.
interface DragStart {
  startScreen: Point;
  moved: boolean;
}

type MoveGesture = CombinedMoveSnapshot & DragStart & {
  type: 'move';
  pressed:
    | { kind: 'node'; node: FlowNode }
    | { kind: 'region'; context: ModelContext }
    | { kind: 'drawing'; drawing: DrawingSelection };
  pressedBadge: BadgeHit | null;
  // Shift added the pressed thing to the selection, so a click that ends here keeps the rest.
  additive: boolean;
  // The explicitly selected nodes — what membership measures as "free" nodes — as distinct
  // from the members a moving region carries along.
  selectedNodes: FlowNode[];
  regionRects: Map<ContextBlock, Rect>;
  movingDrawings: MovingDrawing[];
  // How far each carried drawing has travelled so far, in its own model's units, keyed by its
  // stored key. Painted as an offset; the layer is written only when the drag lands.
  drawingOffsets: Map<string, Point>;
  startWorld: Point;
};

type Gesture =
  | { type: 'pan'; startView: View; startScreen: Point }
  | ({ type: 'edge'; from: FlowNode; toWorld: Point; hoverTarget: FlowNode | null; additive: boolean } & DragStart)
  | ({ type: 'resize'; node: FlowNode; handle: ResizeHandle; startRect: Rect; startWorld: Point; scale: number } & DragStart)
  | MoveGesture
  | (RegionResizeSnapshot & DragStart & {
      type: 'region-resize';
      frozenRegionRects: Map<ContextBlock, Rect>;
    })
  | { type: 'create'; tool: Tool; startWorld: Point; startScreen: Point; rect: Rect | null }
  | { type: 'marquee'; startWorld: Point; rect: Rect | null }
  | StrokeGesture
  | (DragStart & {
      type: 'drawing-resize';
      // A lone drawing, or every member of one group — all on one surface, all stretched alike.
      drawings: DrawingSelection[];
      storedKeys: string[];
      handle: ResizeHandle;
      // The drawings' combined geometry when the drag began, in their own model's units.
      startBox: Rect;
      // Any text among them keeps its proportions, and so does everything resized with it.
      keepAspect: boolean;
      // How far a sideways stretch may narrow them: no text among them narrower than one letter.
      smallestScaleX: number;
      startWorld: Point;
      scale: number;
      transform: DrawingTransform;
    })
  | EdgeBendGesture
  // A ghost is made real by a click, so a press that is dragged away, or abandoned, makes nothing.
  | ({ type: 'ghost-press'; ghost: GhostNode } & DragStart)
  | { type: 'pinch'; pointers: [number, number]; start: PinchAnchor };

// What a press at a point lands on, in the order a press settles it: the affordances of what is
// already selected, then what is drawn on the canvas, then the canvas itself. The press, the hover
// cursor and the context menu all read this one answer (`pressTargetAt`), so the cursor cannot
// promise what a press would not do, and a kind of thing added here reaches every reader at once.
type PressTarget =
  | { kind: 'port'; node: FlowNode; port: Point }
  | { kind: 'drawing-handle'; resizable: ResizableDrawings; handle: ResizeHandle }
  | { kind: 'selected-edge-grip'; edge: ModelEdge }
  | { kind: 'node-handle'; node: FlowNode; handle: ResizeHandle }
  | { kind: 'region-handle'; context: ModelContext; handle: ResizeHandle }
  | { kind: 'node'; node: FlowNode; badge: BadgeHit | null }
  | { kind: 'ghost'; ghost: GhostNode }
  | { kind: 'edge'; edge: ModelEdge; atGrip: boolean }
  | { kind: 'region'; context: ModelContext }
  | { kind: 'drawing'; drawing: DrawingSelection }
  | { kind: 'canvas' };

export type PressTargetKind = PressTarget['kind'];

// The handles a sole selection resizes by (R52) — its corners, and the whole length of each side —
// and the rectangle they sit on. Drawing them, pressing them and listing them (`affordances`) all
// ask `cornerHandles`.
type CornerHandles =
  | { kind: 'node-handle'; node: FlowNode; rect: Rect }
  | { kind: 'region-handle'; context: ModelContext; rect: Rect }
  | { kind: 'drawing-handle'; resizable: ResizableDrawings; rect: Rect };

// Something the selection, or the node under the pointer, offers a press beyond the object
// itself: a port, a corner or side handle, a bend grip.
export interface Affordance {
  kind: Extract<PressTargetKind, 'port' | CornerHandles['kind'] | 'selected-edge-grip'>;
  point: Point;
  // Which corner or side, for a resize handle.
  handle?: ResizeHandle;
}

export type CanvasCursor =
  | 'default'
  | 'crosshair'
  | 'pointer'
  | 'move'
  | 'nwse-resize'
  | 'nesw-resize'
  | 'ew-resize'
  | 'ns-resize'
  | 'grab'
  | 'text';

// Whether a cursor promises that a drag starting under it carries what is there — moves,
// resizes or bends it — rather than clicking, creating, sweeping a marquee or panning. The session
// tests hold every cursor to this, so a cursor added above has to say which it is.
export const CURSOR_GRABS: Record<CanvasCursor, boolean> = {
  default: false,
  crosshair: false,
  pointer: false,
  move: true,
  'nwse-resize': true,
  'nesw-resize': true,
  'ew-resize': true,
  'ns-resize': true,
  grab: false,
  text: false,
};

// A move is measured on what was pressed, so that is what lands on the grid.
function moveReferenceOf(pressed: MoveGesture['pressed']): MoveReference {
  if (pressed.kind === 'node') return { node: pressed.node };
  if (pressed.kind === 'region') return { block: pressed.context.block };
  return null;
}

// What pressing the target does, shown before the press: a grab cursor drags what is under it, a
// pointer is a click with a meaning of its own, and bare canvas shows the tool. Exhaustive, so a
// new kind of target does not compile until it has a cursor.
function cursorFor(target: PressTarget, canvasCursor: CanvasCursor): CanvasCursor {
  switch (target.kind) {
    case 'port':
      return 'crosshair';
    case 'drawing-handle':
    case 'node-handle':
    case 'region-handle':
      return resizeCursorOf(target.handle);
    case 'selected-edge-grip':
    case 'region':
    case 'drawing':
      return 'move';
    case 'node':
      return target.badge ? 'pointer' : 'move';
    case 'ghost':
      return 'pointer';
    case 'edge':
      return target.atGrip ? 'move' : 'default';
    case 'canvas':
      return canvasCursor;
  }
}

// The cursor that shows which way a handle resizes.
function resizeCursorOf(handle: ResizeHandle): CanvasCursor {
  const axes = axesOf(handle);
  if (axes.y === 0) return 'ew-resize';
  if (axes.x === 0) return 'ns-resize';
  return axes.x === axes.y ? 'nwse-resize' : 'nesw-resize';
}

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

// What a released port-drag meant. The view classifies the release; main.ts turns the
// classification into document edits. Several members describe an edge that is not the one the
// pointer drew: a drag between a frame and the graph around it resolves to a single-level
// subgraph refinement declared on the frame's host.
//
// Points travel in the coordinate space of the graph that will own the new node — world space
// at the top level, frame-local whenever a host comes with them.
export type EdgeDrop =
  // Released back on the node the drag started from.
  | { kind: 'source' }
  // No single-level edge can express this release, so it creates nothing.
  | { kind: 'rejected' }
  // Both ends share a graph: an ordinary edge.
  | { kind: 'node'; target: FlowNode }
  // §5.7 target-side: declared on `target`, the frame's host, naming a node inside it.
  | { kind: 'into-frame'; target: FlowNode; innerName: string }
  // §5.8 source-side: declared on `host`, which owns the frame the drag left, naming the inner
  // node it started from. The edge lives in the parent graph, not inside the subgraph.
  | { kind: 'out-of-frame'; target: FlowNode; host: FlowNode; innerName: string }
  // Released on an unresolved edge target: materialize that ghost and join it.
  | { kind: 'ghost'; ghost: GhostNode }
  // Empty canvas at the top level: create a node where it landed and join it.
  | { kind: 'empty'; point: Point }
  // Empty canvas inside the frame the drag left: a sibling in that subgraph.
  | { kind: 'empty-inner'; host: FlowNode; point: Point }
  // Empty canvas one level out, in the graph that owns the frame (§5.8).
  | { kind: 'empty-outer'; host: FlowNode; innerName: string; point: Point };

// The three releases that attach to a node already on the canvas, and so light it up under the
// cursor while the drag is live.
function dropAttachesToNode(drop: EdgeDrop): boolean {
  return drop.kind === 'node' || drop.kind === 'into-frame' || drop.kind === 'out-of-frame';
}

// Rects and points reaching these callbacks are expressed in the coordinate space of the
// graph that will own the new node — world space at the top level, frame-local space
// whenever a frame host comes with them.
export interface CanvasActions {
  createNode(rect: Rect, frameHost: FlowNode | null): void;
  quickCreateNode(point: Point, frameHost: FlowNode | null): void;
  nodeClicked(node: FlowNode): void;
  canvasClicked(): void;
  // Membership changes and the drawings dragged along travel with the move so the whole drag
  // lands as one undo step (R19). A resize reports neither: it changes a node's size, never which
  // region it was dropped into. A drag of drawings alone reports no nodes.
  moveCommitted(nodes: FlowNode[], membershipChanges?: MembershipChange[], drawingMoves?: DrawingMove[]): void;
  // A region gesture writes the blocks' own rectangles in place, the positions of the members
  // they carried, the drawings dragged along and whatever membership they swept up — one action,
  // so one undo step. A mixed selection move reports every moved region, not only the one that
  // was pressed.
  regionMoved(
    regions: RegionTarget[],
    movedNodes: FlowNode[],
    membershipChanges: MembershipChange[],
    drawingMoves: DrawingMove[],
  ): void;
  // Points are in the coordinate space of the graph that will own the stroke.
  createStroke(points: Point[], frameHost: FlowNode | null, style: DrawStyle): void;
  // One transform for every drawing, in their own model's units.
  resizeDrawings(drawings: DrawingSelection[], transform: DrawingTransform): void;
  regionResized(region: RegionTarget, membershipChanges: MembershipChange[]): void;
  deleteRegion(region: RegionTarget): void;
  createRegion(rect: Rect, frameHost: FlowNode | null, memberNames: string[]): void;
  regionClicked(region: RegionTarget): void;
  completeEdge(fromNode: FlowNode, drop: EdgeDrop): void;
  editEdge(edge: ModelEdge): void;
  // Null takes the bend away, returning the edge to its automatic route.
  bendEdge(edge: ModelEdge, bend: EdgeBend | null): void;
  editNodeTitle(node: FlowNode): void;
  // The text tool pressed bare canvas here, in the coordinate space of the graph that will own
  // the text. Nothing is written until the text is typed.
  placeText(point: Point, frameHost: FlowNode | null): void;
  editText(drawing: DrawingSelection): void;
  editRegionTitle(region: RegionTarget): void;
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

export interface HiddenCanvasTitles {
  nodeId: string | null;
  regionName: string | null;
  // A text drawing open in the inline text editor.
  drawingId: string | null;
}

export const NO_HIDDEN_TITLES: HiddenCanvasTitles = { nodeId: null, regionName: null, drawingId: null };

export type ContextTarget =
  | { kind: 'node'; node: FlowNode }
  | { kind: 'edge'; edge: ModelEdge }
  | { kind: 'region'; region: RegionTarget }
  | { kind: 'drawing' }
  | { kind: 'canvas'; world: Point };

// A region names the document it lives in rather than a node, because it has no id and nothing
// else identifies it: a provider is addressed by name within the file that declares it.
export interface RegionTarget {
  block: ContextBlock;
  doc: FlowDocument;
  path: string | null;
}


const MIN_SCALE = 0.12;
const MAX_SCALE = 5;
const MAX_FIT_SCALE = 1.4;
const MIN_NODE_WIDTH = 120;
const MIN_NODE_HEIGHT = 64;
const DRAG_THRESHOLD_PX = 4;
// Below this the drawn rectangle reads as a stray click rather than a deliberate node.
const CREATE_MIN_SCREEN_WIDTH = 14;
const CREATE_MIN_SCREEN_HEIGHT = 10;
const SNAP = 8;
const PORT_RADIUS = 5;
const PORT_HIT_RADIUS = 14;
// Wider than the drawn stroke because rough.js jitters the ink a few pixels off the ideal curve.
const EDGE_HIT_DISTANCE = 10;
// Screen pixels: how large the grip is drawn on a selected, unlabelled edge.
const EDGE_GRIP_DRAWN_RADIUS_PX = 4.5;
// Screen pixels: the width of the selection outlines and the grip's ring.
const SELECTION_LINE_WIDTH_PX = 1.4;
const FIT_PADDING = 80;
// Where the origin sits relative to the viewport centre when there is nothing to frame.
const EMPTY_CANVAS_ORIGIN = { x: 200, y: 150 };
const EMPTY_SNAPSHOT_SIZE = { w: 400, h: 300 };
// How far, in world units, the selection outline sits outside a node or drawing, and a group's
// outline outside its members' combined ink.
const SELECTION_OUTLINE_INFLATE = 5;
const GROUP_OUTLINE_INFLATE = 10;
const NOTICE_MS = 2400;
const NOTICE_FONT = '13px system-ui, sans-serif';
const NOTICE_PADDING_PX = 8;
const NOTICE_OFFSET_PX = 14;
const TOP_LEVEL_TRANSFORM: FrameTransform = { scale: 1, tx: 0, ty: 0 };
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
  // Edges join the selection like everything else. What only one edge at a time can have — the
  // bend grip, the editor a new edge opens in — belongs to a lone selected edge (`selectedEdge`).
  selectedEdges: ModelEdge[] = [];
  // Regions share the selection with nodes — a mixed selection moves, deletes and copies as one
  // gesture — but the single-region accessor below stays for the callers that address one
  // region as an edit target.
  selectedRegions = new Set<ModelContext>();
  // Strokes share the selection too. Kept as last laid out; read through `selectedDrawings`.
  private heldDrawings: HeldDrawing[] = [];
  // Strokes to select once laid out: written by an edit whose models are rebuilt before the next
  // render. Tried once, at that render.
  private drawingsToHold: StoredDrawing[] = [];
  drawStyle: DrawStyle = { color: null, width: DEFAULT_STROKE_WIDTH };
  readonly expansionLayer: ExpansionLayer;
  gridIsVisible = true;
  doubleClickOpensSubgraph = true;
  baseRoughness = DEFAULT_ROUGHNESS;
  readonly hiddenTitles: HiddenCanvasTitles = { ...NO_HIDDEN_TITLES };

  private hoverNode: FlowNode | null = null;
  private hoverPoint: Point | null = null;
  private gesture: Gesture | null = null;
  private tool: Tool = 'select';
  private sceneTransition: SceneTransition | null = null;
  private spaceDown = false;
  private renderQueued = false;
  private readonly wheelIntents = new WheelIntentReader();
  private notice: { text: string; world: Point; until: number } | null = null;

  // Every pointer currently down, at its latest position on the canvas. A second entry turns
  // whatever one finger had started into a pinch, so this is kept for mouse pointers too.
  private activePointers = new Map<number, Point>();
  // Fingers still resting on the glass after a pinch ended. They must not become a fresh drag
  // or read as a tap, so they are ignored until the last one lifts.
  private awaitingPointerRelease = false;

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
      contexts: [],
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
    this.canvas.addEventListener('pointercancel', (event) => this.onPointerCancel(event));
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
      this.abandonGesture();
      this.activePointers.clear();
      this.awaitingPointerRelease = false;
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

  get selectedEdge(): ModelEdge | null {
    return this.selectedEdges.length === 1 ? this.selectedEdges[0] : null;
  }

  set selectedEdge(edge: ModelEdge | null) {
    this.selectedEdges = edge ? [edge] : [];
  }

  setModel(model: FlowModel): void {
    this.model = model;
    // Every node is re-resolved by id — a top-level one in the new model, one inside an unfolded
    // frame in whichever loaded document holds it — so a node that an edit, an undo or a file
    // change has removed or replaced never lingers in the selection.
    this.selection = new Set(
      [...this.selection]
        .map((node) => model.nodes.find((candidate) => candidate.id === node.id) ?? this.embeddedNodeNow(model, node))
        .filter((node): node is FlowNode => node != null),
    );
    // An embedded edge's frame may not be laid out against the new model yet; the next render
    // resolves it to its rebuilt counterpart, or drops it.
    this.selectedEdges = this.selectedEdges
      .map((edge) => this.currentEdgeMatching(edge) ?? (this.expansionLayer.isEmbedded(edge.from) ? edge : null))
      .filter((edge): edge is ModelEdge => edge != null);
    // By name, not by identity: a region has no id, and rebuilding the model makes a fresh
    // ModelContext for the same block.
    const selectedRegionNames = [...this.selectedRegions].map((context) => context.block.name);
    this.selectedRegions = new Set(selectedRegionNames
      .map((name) => model.contexts.find((context) => context.block.name === name))
      .filter((context): context is ModelContext => context != null));
    if (this.hoverNode) {
      const previousHoverId = this.hoverNode.id;
      this.hoverNode = model.nodes.find((node) => node.id === previousHoverId) ?? this.embeddedNodeNow(model, this.hoverNode);
    }
    this.requestRender();
  }

  // A node shown inside an unfolded frame lives in one of the open document's own `graph:` blocks
  // or in an external file the expansion layer holds; either way its id finds what it is now.
  private embeddedNodeNow(model: FlowModel, node: FlowNode): FlowNode | null {
    if (!node.id || !this.expansionLayer.isEmbedded(node)) return null;
    return findNodeById(model.sourceDoc, node.id) ?? this.expansionLayer.findNodeById(node.id);
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
    const mid = geometry ? geometry.grip : rectCenter(this.rect(edge.from));
    const locus = this.expansionLayer.locusOf(edge.from);
    if (!locus) return mid;
    return transformPoint(mid, locus.transform);
  }

  // What a press at `world` would land on, by kind: the one answer the press, the hover cursor
  // and the context menu share.
  pressTargetKindAt(world: Point, shiftKey = false): PressTargetKind {
    return this.pressTargetAt(world, { creating: this.createsOnPress(shiftKey) }).kind;
  }

  // Where every affordance on screen sits, from the geometry its press is tested against: the
  // corner and side handles of a sole selection, a lone edge's bend grip, then the ports of the
  // selected and hovered nodes.
  affordances(): Affordance[] {
    const handles = this.cornerHandles();
    const corners = handles
      ? resizeHandlePointsOf(handles.rect, this.handleReach()).map(({ handle, x, y }) => ({ kind: handles.kind, point: { x, y }, handle }))
      : [];
    const loneEdge = this.edgeSelectedAlone();
    const grip = loneEdge ? this.edgeAnchor(loneEdge) : null;
    const grips = loneEdge && grip && this.edgeGripContains(loneEdge, grip) ? [{ kind: 'selected-edge-grip' as const, point: grip }] : [];
    const ports = [...this.nodesShowingPorts()].flatMap((node) => this.portPositions(node).map((point) => ({ kind: 'port' as const, point })));
    return [...corners, ...grips, ...ports];
  }

  select(node: FlowNode): void {
    this.selection = new Set([node]);
    this.selectedEdge = null;
    this.selectedRegions.clear();
    this.heldDrawings = [];
    this.requestRender();
  }

  setSelection(nodes: FlowNode[], regions: ModelContext[] = [], drawings: StoredDrawing[] = []): void {
    this.selection = new Set(nodes);
    this.selectedRegions = new Set(regions);
    this.selectedEdge = null;
    this.heldDrawings = [];
    this.drawingsToHold = drawings;
    this.requestRender();
  }

  clearSelection(): void {
    this.selection.clear();
    this.selectedEdge = null;
    this.selectedRegions.clear();
    this.heldDrawings = [];
    this.requestRender();
  }

  /** The selected drawings, one entry per place a drawing is shown. */
  get selectedDrawings(): DrawingSelection[] {
    return this.heldDrawings.map(({ model, id }) => ({ model, id }));
  }

  /** Selects a region of the open graph by name — the only handle a region has. */
  selectRegion(name: string): void {
    this.selection.clear();
    this.selectedEdge = null;
    this.heldDrawings = [];
    const context = this.model.contexts.find((candidate) => candidate.block.name === name);
    this.selectedRegions = context ? new Set([context]) : new Set();
    this.requestRender();
  }

  /** The single selected region, or null when none or several are selected. */
  get selectedRegion(): ModelContext | null {
    return this.selectedRegions.size === 1 ? [...this.selectedRegions][0] : null;
  }

  regionRectOfBlock(block: ContextBlock): Rect | null {
    const context = this.model.contexts.find((candidate) => candidate.block === block);
    return context ? this.regionRectOfContext(context) : null;
  }

  /** The selected regions as the document addresses a mutation needs. */
  selectedRegionTargets(): RegionTarget[] {
    return [...this.selectedRegions].map((context) => this.regionTargetOf(context));
  }

  private regionTargetOf(context: ModelContext): RegionTarget {
    return { block: context.block, doc: this.model.sourceDoc, path: this.model.sourcePath };
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

  // View offsets are already in screen pixels, so a wheel pan is a straight subtraction.
  private panBy(dx: number, dy: number): void {
    this.view.x -= dx;
    this.view.y -= dy;
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

  // Only the top-level edges are measured: an edge inside an unfolded frame is clipped to it.
  private contentBounds(): Rect | null {
    return boundsOfRects([...displayRects(this.model), ...edgePathBounds(this.model)]);
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
      this.scenePainter(NO_HIDDEN_TITLES).drawScene(this.model);
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
    if (event.deltaX === 0 && event.deltaY === 0) return;
    const intent = this.wheelIntents.read(event, event.timeStamp);
    if (intent.kind === 'pan') this.panBy(intent.dx, intent.dy);
    else this.zoomAt(this.eventPoint(event), intent.factor);
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.sceneTransition) {
      this.finishSceneTransition();
      return;
    }
    const screen = this.eventPoint(event);
    const world = this.screenToWorld(screen);
    this.canvas.setPointerCapture(event.pointerId);
    this.activePointers.set(event.pointerId, screen);
    if (this.activePointers.size > 1) {
      this.beginPinch();
      return;
    }

    const wantsPan = event.button === 1 || (event.button === 0 && this.spaceDown);
    if (wantsPan) {
      this.gesture = { type: 'pan', startView: { ...this.view }, startScreen: screen };
      this.updateCursor();
      return;
    }
    if (event.button !== 0) return;

    if (this.tool === 'draw') {
      this.actions.canvasClicked();
      this.gesture = beginStrokeGesture(this.expansionLayer.frameAt(world), world, screen);
      this.requestRender();
      return;
    }

    const creating = this.createsOnPress(event.shiftKey);
    const target = this.pressTargetAt(world, { creating });
    switch (target.kind) {
      case 'port':
        this.gesture = { type: 'edge', from: target.node, toWorld: world, hoverTarget: null, startScreen: screen, moved: false, additive: event.shiftKey };
        return;
      case 'drawing-handle':
        this.gesture = this.beginDrawingResize(target.resizable, target.handle, world, screen);
        return;
      case 'selected-edge-grip':
        if (event.shiftKey) this.pressEdge(target.edge, world, screen, true);
        else this.gesture = this.edgeBendGrabbedAt(target.edge, world, screen);
        return;
      case 'node-handle':
        this.gesture = {
          type: 'resize',
          node: target.node,
          handle: target.handle,
          startRect: { ...target.node.pos! },
          startWorld: world,
          scale: this.expansionLayer.scaleOf(target.node),
          startScreen: screen,
          moved: false,
        };
        return;
      case 'region-handle':
        this.gesture = this.beginRegionResize(target.context, target.handle, world, screen);
        return;
      case 'node':
        this.pressNode(target.node, target.badge, world, screen, event.shiftKey);
        return;
      case 'ghost':
        this.gesture = { type: 'ghost-press', ghost: target.ghost, startScreen: screen, moved: false };
        return;
      case 'edge':
        this.pressEdge(target.edge, world, screen, event.shiftKey);
        return;
      case 'region':
        this.pressRegion(target.context, world, screen, event.shiftKey);
        return;
      case 'drawing':
        this.pressDrawing(target.drawing, world, screen, event.shiftKey);
        return;
      case 'canvas':
        this.pressCanvas(world, screen, event.shiftKey, creating);
        return;
    }
  }

  // The node, region and text tools make something on a press, unless shift turns it back into
  // selecting.
  private createsOnPress(shiftKey: boolean): boolean {
    return (this.tool === 'node' || this.tool === 'context' || this.tool === 'text') && !shiftKey;
  }

  // What a press at `world` lands on (PressTarget). `creating` hands an unfolded frame's empty
  // interior to the subgraph being drawn into rather than to the frame's host; it never hides
  // anything already drawn there, so every tool can grab whatever the select tool can.
  private pressTargetAt(world: Point, { creating }: { creating: boolean }): PressTarget {
    const port = this.hitPort(world);
    if (port) return { kind: 'port', ...port };
    const cornerHandle = this.hitCornerHandle(world);
    if (cornerHandle) return cornerHandle;
    // A label is drawn over the nodes, so the selected edge's grip answers before they do.
    const loneEdge = this.edgeSelectedAlone();
    if (loneEdge && this.edgeGripContains(loneEdge, world)) {
      return { kind: 'selected-edge-grip', edge: loneEdge };
    }
    const node = this.hitNode(world);
    const drawing = this.hitDrawingAbove(node, world);
    const pressedNode = drawing ? null : this.nodeAnsweringPress(node, world, creating);
    if (pressedNode) return { kind: 'node', node: pressedNode, badge: this.hitBadge(world) };
    const ghost = this.hitGhost(world);
    if (ghost) return { kind: 'ghost', ghost };
    const edge = this.hitEdge(world);
    if (edge) return { kind: 'edge', edge, atGrip: this.edgeGripContains(edge, world) };
    const region = this.hitRegion(world);
    if (region) return { kind: 'region', context: region };
    return drawing ? { kind: 'drawing', drawing } : { kind: 'canvas' };
  }

  // While creating, an unfolded frame's empty interior is the subgraph's drawing surface rather
  // than a press on the frame's host (isFrameBackground).
  private nodeAnsweringPress(node: FlowNode | null, world: Point, creating: boolean): FlowNode | null {
    if (!node || (creating && this.isFrameBackground(node, world))) return null;
    return node;
  }

  // Text scales evenly by a corner, its top or its bottom; a side gives it a width to wrap to
  // instead, and strokes resized with it stretch.
  private beginDrawingResize(resizable: ResizableDrawings, handle: ResizeHandle, world: Point, screen: Point): Gesture {
    const texts = resizable.members.filter((drawing): drawing is TextDrawing => drawing.kind === TEXT_KIND);
    return {
      type: 'drawing-resize',
      drawings: resizable.drawings,
      storedKeys: resizable.drawings.map((drawing) => storedDrawingKey(drawing.model, drawing.id)),
      handle,
      startBox: boundsOfRects(resizable.members.map(drawingGeometryBox))!,
      keepAspect: texts.length > 0 && axesOf(handle).y !== 0,
      smallestScaleX: Math.min(1, Math.max(0, ...texts.map((text) => text.size / text.box.w))),
      startWorld: world,
      scale: resizable.surface.transform.scale,
      transform: IDENTITY_TRANSFORM,
      startScreen: screen,
      moved: false,
    };
  }

  private beginRegionResize(context: ModelContext, handle: ResizeHandle, world: Point, screen: Point): Gesture {
    return {
      type: 'region-resize',
      context,
      handle,
      startRect: { ...this.regionRectOfContext(context)! },
      startWorld: world,
      hadDrawnArea: context.block.pos !== null,
      frozenRegionRects: this.freezeRegionRects(),
      startScreen: screen,
      moved: false,
    };
  }

  private pressNode(node: FlowNode, badge: BadgeHit | null, world: Point, screen: Point, shiftKey: boolean): void {
    if (shiftKey && this.selection.has(node)) {
      this.selection.delete(node);
      this.requestRender();
      return;
    }
    if (!this.selection.has(node)) {
      if (!shiftKey) this.clearSelection();
      this.selection.add(node);
    }
    this.gesture = this.beginMoveGesture(world, screen, { kind: 'node', node }, badge, shiftKey);
    this.requestRender();
  }

  private pressEdge(edge: ModelEdge, world: Point, screen: Point, shiftKey: boolean): void {
    // Closing an editor can commit its edit, which rebuilds the model under the edge just hit.
    this.actions.canvasClicked();
    const pressed = this.currentEdgeMatching(edge) ?? edge;
    if (shiftKey) {
      this.toggleSelectedEdge(pressed);
      this.requestRender();
      return;
    }
    this.clearSelection();
    this.selectedEdge = pressed;
    this.gesture = this.edgeBendGrabbedAt(pressed, world, screen);
    this.requestRender();
  }

  // The bend grip, like a node's or a region's corner handles (R52), belongs to an edge that is the
  // whole selection: in a mixed one, a press there is a press on the edge like any other.
  private edgeSelectedAlone(): ModelEdge | null {
    const sole = this.soleSelection();
    return sole?.kind === 'edge' ? sole.edge : null;
  }

  // The selection when it is exactly one thing — one node, one region, one edge, or one drawing or
  // group — which is all that ever gets corner handles or a bend grip (R52). Drawing those
  // affordances and answering a press on them both ask here, so a handle is never drawn that a
  // press would not answer, and a kind added to the selection is counted by every one of them.
  private soleSelection(): SoleSelection | null {
    const kindsSelected = [this.selection.size, this.selectedRegions.size, this.selectedEdges.length, this.heldDrawings.length]
      .filter((count) => count > 0).length;
    if (kindsSelected !== 1) return null;
    if (this.selection.size === 1) return { kind: 'node', node: [...this.selection][0] };
    if (this.selectedRegions.size === 1) return { kind: 'region', context: [...this.selectedRegions][0] };
    if (this.selectedEdges.length === 1) return { kind: 'edge', edge: this.selectedEdges[0] };
    const resizable = this.heldDrawings.length > 0 ? this.resizableDrawingSelection() : null;
    return resizable ? { kind: 'drawings', resizable } : null;
  }

  private toggleSelectedEdge(edge: ModelEdge): void {
    const wasSelected = this.selectedEdges.some((candidate) => isSameEdge(candidate, edge));
    this.selectedEdges = wasSelected
      ? this.selectedEdges.filter((candidate) => !isSameEdge(candidate, edge))
      : [...this.selectedEdges, edge];
  }

  private pressRegion(region: ModelContext, world: Point, screen: Point, shiftKey: boolean): void {
    // A press on a region closes open editors at press time, whether or not it becomes a drag
    // — the same contract a node press has.
    this.actions.canvasClicked();
    if (shiftKey && this.selectedRegions.has(region)) {
      this.selectedRegions.delete(region);
      this.requestRender();
      return;
    }
    if (!this.selectedRegions.has(region)) {
      if (!shiftKey) this.clearSelection();
      this.selectedRegions.add(region);
    }
    this.gesture = this.beginMoveGesture(world, screen, { kind: 'region', context: region }, null, shiftKey);
    this.requestRender();
  }

  private pressCanvas(world: Point, screen: Point, shiftKey: boolean, creating: boolean): void {
    if (!shiftKey) {
      this.selection.clear();
      this.selectedEdge = null;
      this.selectedRegions.clear();
      this.heldDrawings = [];
      this.actions.canvasClicked();
    }
    this.gesture = creating
      ? { type: 'create', tool: this.tool, startWorld: world, startScreen: screen, rect: null }
      : { type: 'marquee', startWorld: world, rect: null };
    this.requestRender();
  }

  // The one snapshot a move in either domain takes. Moving regions are the selected ones plus
  // the R28a group: every region whose whole frame lay inside a selected frame at gesture start
  // is carried with it, its members travelling too. Moving nodes are the selection plus every
  // member a moving region carries, deduped — a node both selected and carried moves once.
  // Region rects freeze at gesture start so the frame the user drops into is the one they
  // aimed at (R13, R18).
  private beginMoveGesture(
    world: Point,
    screen: Point,
    pressed: MoveGesture['pressed'],
    pressedBadge: BadgeHit | null,
    additive: boolean,
  ): MoveGesture {
    const movingRegions = movingRegionGroupFor(this.model, [...this.selectedRegions]);
    const selectedNodes = [...this.selection];
    const carriedNodes = [...new Set(movingRegions.flatMap((context) => context.members))];
    const nodes = [...new Set([...selectedNodes, ...carriedNodes])];
    const startRects = new Map<ContextBlock, Rect>();
    for (const context of movingRegions) {
      if (context.block.pos) startRects.set(context.block, { ...context.block.pos });
    }
    return {
      type: 'move',
      pressed,
      pressedBadge,
      additive,
      movingDrawings: this.movingDrawingsFor(nodes, movingRegions),
      drawingOffsets: new Map(),
      selectedNodes,
      startPositions: new Map(nodes.map((entry) => [entry, { x: entry.pos!.x, y: entry.pos!.y }])),
      // World-space drag deltas are divided by each node's locus scale so nodes inside
      // scaled-down frames track the cursor instead of racing ahead of it.
      scales: new Map(nodes.map((entry) => [entry, this.expansionLayer.scaleOf(entry)])),
      movingRegions,
      startRects,
      regionRects: this.freezeRegionRects(),
      startWorld: world,
      startScreen: screen,
      moved: false,
    };
  }

  // The selected drawings a move carries, once per stored drawing. A drawing inside a frame whose
  // host is itself moving already travels with the frame, as a node inside it does.
  private movingDrawingsFor(movingNodes: readonly FlowNode[], movingRegions: readonly ModelContext[]): MovingDrawing[] {
    const moving = new Set(movingNodes);
    const surfaces = this.drawingSurfaces();
    const carried: MovingDrawing[] = [];
    const seen = new Set<string>();
    for (const drawing of [...this.heldDrawings, ...this.drawingsInsideRegions(movingRegions)]) {
      const surface = surfaces.find((candidate) => candidate.model === drawing.model);
      const storedKey = storedDrawingKey(drawing.model, drawing.id);
      if (!surface || seen.has(storedKey) || this.isInsideMovingFrame(surface.host, moving)) continue;
      seen.add(storedKey);
      carried.push({ drawing: { model: drawing.model, id: drawing.id }, storedKey, scale: surface.transform.scale });
    }
    return carried;
  }

  // R28b: a moving region carries the drawings lying wholly inside its frame when the drag
  // begins, as it carries its members — an annotation travels with the box it annotates. A group
  // moves as one, so it goes only when every drawing in it is inside.
  private drawingsInsideRegions(regions: readonly ModelContext[]): DrawingSelection[] {
    const frames = regions
      .map((context) => regionRectOf(this.model, context))
      .filter((frame): frame is Rect => frame != null);
    if (frames.length === 0) return [];
    const drawings = this.model.visuals?.drawings() ?? [];
    const enclosedIds = new Set(drawings
      .filter((drawing) => frames.some((frame) => rectContainsRect(frame, drawingBounds(drawing))))
      .map((drawing) => drawing.id));
    return [...enclosedIds]
      .map((id) => ({ model: this.model, id }))
      .filter((drawing) => this.groupOfDrawing(drawing).every((member) => enclosedIds.has(member)));
  }

  private isInsideMovingFrame(host: FlowNode | null, moving: ReadonlySet<FlowNode>): boolean {
    for (let frameHost = host; frameHost; frameHost = this.expansionLayer.hostOf(frameHost)) {
      if (moving.has(frameHost)) return true;
    }
    return false;
  }

  // Drawings travel the distance everything else did, so they stay with what they annotate.
  private moveCarriedDrawings(gesture: MoveGesture, delta: Point): void {
    for (const carried of gesture.movingDrawings) {
      gesture.drawingOffsets.set(carried.storedKey, { x: delta.x / carried.scale, y: delta.y / carried.scale });
    }
  }

  private drawingMovesOf(gesture: MoveGesture): DrawingMove[] {
    return gesture.movingDrawings
      .map((carried) => ({ ...carried.drawing, offset: gesture.drawingOffsets.get(carried.storedKey) ?? { x: 0, y: 0 } }))
      .filter((move) => move.offset.x !== 0 || move.offset.y !== 0);
  }

  // A second pointer replaces the single-pointer gesture with a pinch. Nothing the abandoned
  // gesture had begun may survive it: a move that already nudged its nodes is rolled back to
  // the positions it recorded, and no gesture reaches its commit callbacks.
  private beginPinch(): void {
    this.abandonGesture();
    const [first, second] = [...this.activePointers.keys()].slice(0, 2) as [number, number];
    const firstPoint = this.activePointers.get(first)!;
    const secondPoint = this.activePointers.get(second)!;
    this.gesture = {
      type: 'pinch',
      pointers: [first, second],
      start: {
        view: { ...this.view },
        center: pinchCenter(firstPoint, secondPoint),
        distance: pinchDistance(firstPoint, secondPoint),
      },
    };
    this.awaitingPointerRelease = false;
    this.updateCursor();
    this.requestRender();
  }

  private applyPinch(gesture: Extract<Gesture, { type: 'pinch' }>): void {
    const [first, second] = gesture.pointers;
    const firstPoint = this.activePointers.get(first);
    const secondPoint = this.activePointers.get(second);
    if (!firstPoint || !secondPoint) return;
    this.setViewNow(viewForPinch(
      gesture.start,
      { center: pinchCenter(firstPoint, secondPoint), distance: pinchDistance(firstPoint, secondPoint) },
      { min: MIN_SCALE, max: MAX_SCALE },
    ));
  }

  // Regions in an unfolded external frame belong to that file's model and are measured in its
  // coordinates, the same ones its nodes are dragged in, so every model on screen contributes.
  private freezeRegionRects(): Map<ContextBlock, Rect> {
    const frozen = new Map<ContextBlock, Rect>();
    for (const model of modelsOnScreen(this.model)) {
      for (const context of model.contexts) {
        const rect = regionRectOf(model, context);
        if (rect) frozen.set(context.block, rect);
      }
    }
    return frozen;
  }

  private regionRectsForPainting(): ReadonlyMap<ContextBlock, Rect> | undefined {
    const gesture = this.gesture;
    if (gesture?.type === 'move') {
      // A pure node drag paints every frame frozen, as it has always done (R13, R18). A pure
      // region drag paints everything live, so a pos-free region follows the members it carries.
      if (gesture.movingRegions.length === 0) return gesture.regionRects;
      if (gesture.selectedNodes.length === 0) return undefined;
      // A mixed drag freezes the stationary frames the free nodes are measured against, while
      // the moving frames paint live so their outlines track the drag.
      return regionRectsWithDrawnMove(gesture.movingRegions, this.model, gesture.regionRects);
    }
    if (gesture?.type === 'region-resize' && gesture.context.block.pos) {
      return regionRectsWithDrawnResize(gesture.context, gesture.frozenRegionRects);
    }
    return undefined;
  }

  private membershipChangesFor(gesture: MoveGesture): MembershipChange[] {
    return modelsOnScreen(this.model).flatMap((model) =>
      membershipChangesForCombinedMove(model, gesture.movingRegions, gesture.selectedNodes, gesture.regionRects),
    );
  }

  // Escape while a gesture is under way abandons it: a move or resize goes back to where it
  // started, anything else ends without writing, and the pointer is ignored until it is let go.
  // A pan is only a view change, so it is not something to cancel. True when one was abandoned.
  cancelGesture(): boolean {
    if (!this.gesture || this.gesture.type === 'pan' || this.gesture.type === 'pinch') return false;
    this.abandonGesture();
    this.awaitingPointerRelease = this.activePointers.size > 0;
    this.updateCursor();
    this.requestRender();
    return true;
  }

  private abandonGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture?.type === 'move') {
      rollbackCombinedMove(gesture);
    } else if (gesture?.type === 'resize') {
      Object.assign(gesture.node.pos!, gesture.startRect);
    } else if (gesture?.type === 'region-resize') {
      rollbackRegionResize(gesture);
    }
  }

  // Whether this pointer belonged to a multi-touch interaction rather than to a gesture the
  // single-pointer path started — the pinch itself, and every finger left over from it.
  private releaseMultiTouch(): boolean {
    const wasPinching = this.gesture?.type === 'pinch';
    if (wasPinching) this.gesture = null;
    if (!wasPinching && !this.awaitingPointerRelease) return false;
    this.awaitingPointerRelease = this.activePointers.size > 0;
    this.updateCursor();
    this.requestRender();
    return true;
  }

  private onPointerMove(event: PointerEvent): void {
    const screen = this.eventPoint(event);
    if (this.activePointers.has(event.pointerId)) this.activePointers.set(event.pointerId, screen);
    if (this.gesture?.type === 'pinch') {
      this.applyPinch(this.gesture);
      return;
    }
    if (this.awaitingPointerRelease) return;

    const world = this.screenToWorld(screen);
    this.hoverPoint = world;

    if (!this.gesture) {
      const previousHover = this.hoverNode;
      this.hoverNode = this.hoverNodeAt(world);
      if (previousHover !== this.hoverNode) this.requestRender();
      this.updateCursor(world, event.shiftKey);
      return;
    }

    const gesture = this.gesture;
    if (gesture.type === 'pan') {
      this.view.x = gesture.startView.x + (screen.x - gesture.startScreen.x);
      this.view.y = gesture.startView.y + (screen.y - gesture.startScreen.y);
      this.requestRender();
      this.actions.viewChanged?.();
    } else if (gesture.type === 'move') {
      if (!hasBecomeDrag(gesture, screen)) return;
      this.moveCarriedDrawings(gesture, applyCombinedMove(gesture, world, snap, moveReferenceOf(gesture.pressed)));
      this.requestRender();
      this.actions.viewChanged?.();
    } else if (gesture.type === 'resize') {
      if (!hasBecomeDrag(gesture, screen)) return;
      this.applyResize(gesture, world);
      this.requestRender();
      this.actions.viewChanged?.();
    } else if (gesture.type === 'region-resize') {
      if (!hasBecomeDrag(gesture, screen)) return;
      applyRegionResize(gesture, world, snap);
      this.requestRender();
      this.actions.viewChanged?.();
    } else if (gesture.type === 'edge') {
      if (!hasBecomeDrag(gesture, screen)) return;
      gesture.toWorld = world;
      const rawTarget = this.hitNode(world);
      const drop = this.resolveEdgeDrop(gesture.from, rawTarget, world);
      gesture.hoverTarget = dropAttachesToNode(drop) ? rawTarget : null;
      this.requestRender();
    } else if (gesture.type === 'create' && gesture.tool === 'text') {
      return;
    } else if (gesture.type === 'create' || gesture.type === 'marquee') {
      gesture.rect = normalizedRect(gesture.startWorld, world);
      this.requestRender();
    } else if (gesture.type === 'draw') {
      if (extendStrokeGesture(gesture, world, screen)) this.requestRender();
    } else if (gesture.type === 'edge-bend') {
      const { edge } = gesture;
      const local = this.pointInEdgeModel(edge, world);
      if (extendEdgeBend(gesture, local, this.screenScaleOf(edge.from), screen, DRAG_THRESHOLD_PX)) this.requestRender();
    } else if (gesture.type === 'ghost-press') {
      hasBecomeDrag(gesture, screen);
    } else if (gesture.type === 'drawing-resize') {
      if (!hasBecomeDrag(gesture, screen)) return;
      const localDelta = {
        x: (world.x - gesture.startWorld.x) / gesture.scale,
        y: (world.y - gesture.startWorld.y) / gesture.scale,
      };
      gesture.transform = resizedDrawingTransform(gesture.startBox, gesture.handle, localDelta, gesture);
      this.requestRender();
    }
  }

  private applyResize(gesture: Extract<Gesture, { type: 'resize' }>, world: Point): void {
    const dx = (world.x - gesture.startWorld.x) / (gesture.scale ?? 1);
    const dy = (world.y - gesture.startWorld.y) / (gesture.scale ?? 1);
    const start = gesture.startRect;
    const rect = gesture.node.pos!;
    const axes = axesOf(gesture.handle);

    if (axes.x === 1) rect.w = Math.max(MIN_NODE_WIDTH, snap(start.w + dx));
    if (axes.y === 1) rect.h = Math.max(MIN_NODE_HEIGHT, snap(start.h + dy));
    if (axes.x === -1) {
      const width = Math.max(MIN_NODE_WIDTH, snap(start.w - dx));
      rect.x = start.x + start.w - width;
      rect.w = width;
    }
    if (axes.y === -1) {
      const height = Math.max(MIN_NODE_HEIGHT, snap(start.h - dy));
      rect.y = start.y + start.h - height;
      rect.h = height;
    }
  }

  private onPointerCancel(event: PointerEvent): void {
    this.activePointers.delete(event.pointerId);
    if (this.releaseMultiTouch()) return;
    this.abandonGesture();
    this.updateCursor();
    this.requestRender();
  }

  private onPointerUp(event: PointerEvent): void {
    this.activePointers.delete(event.pointerId);
    if (this.releaseMultiTouch()) return;

    const gesture = this.gesture;
    this.gesture = null;
    this.updateCursor();
    if (!gesture) return;

    const screen = this.eventPoint(event);
    const world = this.screenToWorld(screen);

    if (gesture.type === 'move') {
      if (gesture.moved) {
        const movedNodes = [...gesture.startPositions.keys()];
        const membershipChanges = this.membershipChangesFor(gesture);
        // Written with the move, which writes the block's file in the same step (R18a).
        keepEmptiedRegionsInPlace(gesture.regionRects, (block) => membersAfterChanges(block, membershipChanges));
        if (gesture.movingRegions.length > 0) {
          this.actions.regionMoved(
            gesture.movingRegions.map((context) => this.regionTargetOf(context)),
            movedNodes,
            membershipChanges,
            this.drawingMovesOf(gesture),
          );
        } else {
          this.actions.moveCommitted(movedNodes, membershipChanges, this.drawingMovesOf(gesture));
        }
      } else {
        if (!gesture.additive) this.narrowSelectionTo(gesture.pressed);
        this.dispatchPress(gesture, world, event.detail);
      }
    } else if (gesture.type === 'resize') {
      if (gesture.moved) this.actions.moveCommitted([gesture.node]);
      else this.clickPressed({ kind: 'node', node: gesture.node }, event.detail);
    } else if (gesture.type === 'region-resize') {
      if (gesture.moved) this.commitRegionResize(gesture);
      else this.clickPressed({ kind: 'region', context: gesture.context }, event.detail);
    } else if (gesture.type === 'edge') {
      if (gesture.moved) this.actions.completeEdge(gesture.from, this.resolveEdgeDrop(gesture.from, this.hitNode(world), world));
      else this.clickNodeOfPort(gesture.from, gesture.additive);
    } else if (gesture.type === 'create') {
      this.completeCreateGesture(gesture, world);
    } else if (gesture.type === 'marquee' && gesture.rect) {
      this.selectInMarquee(gesture.rect);
    } else if (gesture.type === 'draw') {
      this.actions.createStroke(finishedStrokePoints(gesture, this.view.scale), gesture.frameHost, { ...this.drawStyle });
    } else if (gesture.type === 'drawing-resize' && gesture.moved && !isIdentityTransform(gesture.transform)) {
      this.actions.resizeDrawings(gesture.drawings, gesture.transform);
    } else if (gesture.type === 'edge-bend' && gesture.moved) {
      this.actions.bendEdge(gesture.edge, gesture.bend);
    } else if (gesture.type === 'ghost-press' && !gesture.moved) {
      this.actions.materializeGhost(gesture.ghost);
    }
    this.requestRender();
  }

  // A port is part of its node, so a port pressed and let go without dragging is a click on the
  // node: shift toggles it, a plain click makes it the selection and opens its editor.
  private clickNodeOfPort(node: FlowNode, additive: boolean): void {
    if (!additive) {
      this.select(node);
      this.actions.nodeClicked(node);
      return;
    }
    if (this.selection.has(node)) this.selection.delete(node);
    else this.selection.add(node);
    this.requestRender();
  }

  // A plain click on one item of a multi-selection makes that item the selection. The press
  // could not narrow it — it might have been the start of a drag of everything selected — so the
  // release does, once it is clear there was no drag.
  private narrowSelectionTo(pressed: MoveGesture['pressed']): void {
    if (pressed.kind === 'node') this.select(pressed.node);
    else if (pressed.kind === 'region') this.selectRegion(pressed.context.block.name);
    else this.selectOnlyDrawing(pressed.drawing);
  }

  // A press that selected something without dragging it has nothing to write; it was a click,
  // and a click opens the editor of whatever it landed on.
  private dispatchPress(gesture: MoveGesture, world: Point, clickCount: number): void {
    if (this.releasedOnPressedBadge(gesture, world)) return;
    this.clickPressed(gesture.pressed, clickCount);
  }

  // A badge answers a press and release on the same badge — the expand or collapse it shows.
  private releasedOnPressedBadge(gesture: MoveGesture, world: Point): boolean {
    const pressedBadge = gesture.pressedBadge;
    const badge = pressedBadge ? this.hitBadge(world) : null;
    if (!pressedBadge || badge?.node !== pressedBadge.node || badge.kind !== pressedBadge.kind) return false;
    if (badge.kind === 'open') this.actions.openExpand(badge.node);
    else this.actions.toggleExpand(badge.node);
    return true;
  }

  // Also what a handle let go without dragging is: a handle is part of what it resizes, so the
  // click is on its owner. The second click of a double-click is the double-click's own.
  private clickPressed(pressed: MoveGesture['pressed'], clickCount: number): void {
    if (clickCount >= 2 || pressed.kind === 'drawing') return;
    if (pressed.kind === 'region') this.actions.regionClicked(this.regionTargetOf(pressed.context));
    else this.actions.nodeClicked(pressed.node);
  }

  private commitRegionResize(gesture: Extract<Gesture, { type: 'region-resize' }>): void {
    // Measured against the rectangle the user dragged rather than the drawn union, so shrinking
    // past a member is what shuts it out even though the region still encloses it.
    const changes = membershipChangesForRegion(
      this.model,
      gesture.context,
      gesture.context.block.pos!,
      { canRemove: true },
    );
    this.actions.regionResized(this.regionTargetOf(gesture.context), changes);
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
    if (gesture.tool === 'text') {
      this.placeTextAt(gesture.startWorld);
      return;
    }
    if (!gesture.rect || !this.isBigEnoughToCreate(gesture.rect)) return;
    const startFrame = this.expansionLayer.frameAt(gesture.startWorld);
    const endFrame = this.expansionLayer.frameAt(world);
    if ((startFrame?.host ?? null) !== (endFrame?.host ?? null)) return;
    const rect = this.snapCreateRect(startFrame ? inverseTransformRect(gesture.rect, startFrame.transform) : gesture.rect);
    if (gesture.tool !== 'context') {
      this.actions.createNode(rect, startFrame?.host ?? null);
      return;
    }
    // Membership is what the drawing meant: every node the rectangle encloses joins, measured in
    // the coordinates of the graph that will own the block (R9).
    const model = startFrame?.model ?? this.model;
    const enclosed = model.nodes.filter((node) => rectContainsRect(rect, displayRectOf(model, node)));
    this.actions.createRegion(rect, startFrame?.host ?? null, enclosed.map((node) => node.name));
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
  private resolveEdgeDrop(from: FlowNode, rawTarget: FlowNode | null, world: Point): EdgeDrop {
    if (rawTarget === from) return { kind: 'source' };
    const ontoNode = rawTarget ? this.dropOntoNode(from, rawTarget) : null;
    return ontoNode ?? this.dropOntoEmptyCanvas(from, rawTarget, world);
  }

  // Null when the two nodes are in different graphs and no single-level form joins them.
  private dropOntoNode(from: FlowNode, rawTarget: FlowNode): EdgeDrop | null {
    if (this.inSameModel(from, rawTarget)) return { kind: 'node', target: rawTarget };
    if (this.expansionLayer.isEmbedded(from)) {
      // §5.8: an edge dragged out of a frame lands on a sibling of the frame's host.
      // Single-level: the host must share a graph with the drop target.
      const host = this.expansionLayer.hostOf(from);
      if (!host || host === rawTarget || !this.inSameModel(host, rawTarget)) return null;
      return { kind: 'out-of-frame', target: rawTarget, host, innerName: from.name };
    }
    const host = this.expansionLayer.hostOf(rawTarget);
    // Dropping from a host onto a node inside its own frame would be a self-edge; reject it.
    if (!host || host === from || !this.inSameModel(from, host)) return null;
    return { kind: 'into-frame', target: host, innerName: rawTarget.name };
  }

  // A frame's empty interior hit-tests as its host, so "released on empty canvas" means no node
  // under the cursor *or* only the frame the cursor is drawing inside.
  //
  // A drag that started at the top level always creates something where it landed. One that
  // left a frame can only express two single-level forms — a sibling in the frame it left, or a
  // node one level out joined by an `{Inner Source}` edge on the host (§5.8) — and releasing it
  // anywhere else, including on a node it cannot legally reach, creates nothing.
  private dropOntoEmptyCanvas(from: FlowNode, rawTarget: FlowNode | null, world: Point): EdgeDrop {
    const host = this.expansionLayer.hostOf(from);
    if (!host) {
      const ghost = this.hitGhost(world);
      return ghost ? { kind: 'ghost', ghost } : { kind: 'empty', point: world };
    }
    if (rawTarget && !this.isFrameBackground(rawTarget, world)) return { kind: 'rejected' };

    const dropFrame = this.expansionLayer.frameAt(world);
    const dropHost = dropFrame?.host ?? null;
    const point = dropFrame ? inverseTransformPoint(world, dropFrame.transform) : world;
    if (dropHost === host) return { kind: 'empty-inner', host, point };
    if (dropHost === this.expansionLayer.hostOf(host)) {
      return { kind: 'empty-outer', host, innerName: from.name, point };
    }
    return { kind: 'rejected' };
  }

  // Marquee reaches into unfolded frames, but a node is skipped when one of its host
  // frames is also caught — dragging a frame already carries its contents. Regions join only
  // when the marquee encloses their whole frame: a region is a large mostly-empty area, and a
  // grazing drag must not claim it (R50).
  private selectInMarquee(rect: Rect): void {
    const candidates = this.expansionLayer.locus ? [...this.expansionLayer.locus.keys()] : this.model.nodes;
    for (const node of candidates) {
      if (rectsIntersect(rect, this.rect(node))) this.selection.add(node);
    }
    for (const node of [...this.selection]) {
      if (this.hasSelectedAncestorFrame(node)) this.selection.delete(node);
    }
    for (const context of this.model.contexts) {
      const frame = regionRectOf(this.model, context);
      if (frame && rectContainsRect(rect, frame)) this.selectedRegions.add(context);
    }
    const surfaces = this.drawingSurfaces();
    for (const drawing of drawingsInsideRect(surfaces, rect)) {
      const surface = surfaces.find((candidate) => candidate.model === drawing.model)!;
      if (this.isInsideMovingFrame(surface.host, this.selection)) continue;
      this.holdDrawing(drawing, surface);
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

  private snapCreateRect(rect: Rect): Rect {
    return {
      x: snap(rect.x),
      y: snap(rect.y),
      w: Math.max(MIN_NODE_WIDTH, snap(rect.w)),
      h: Math.max(MIN_NODE_HEIGHT, snap(rect.h)),
    };
  }

  private onDoubleClick(event: MouseEvent): void {
    // A pen tapped twice is drawing dots, not asking for a node.
    if (this.sceneTransition || this.tool === 'draw') return;
    const world = this.screenToWorld(this.eventPoint(event));
    // Edges win over nodes so edges inside unfolded frames stay editable — a frame always
    // contains its subgraph's edges.
    const edge = this.hitEdge(world);
    if (edge) {
      this.clearSelection();
      this.selectedEdge = edge;
      this.actions.editEdge(edge);
      this.requestRender();
      return;
    }
    const text = this.hitTextAbove(world);
    if (text) {
      this.selectOnlyDrawing(text);
      this.actions.editText(text);
      return;
    }
    const titledNode = this.hitNodeTitle(world);
    if (titledNode) {
      this.select(titledNode);
      this.actions.editNodeTitle(titledNode);
      return;
    }
    const titledRegion = this.hitRegionTitle(world);
    if (titledRegion) {
      this.selectRegion(titledRegion.block.name);
      this.actions.editRegionTitle(this.regionTargetOf(titledRegion));
      return;
    }
    const subgraph = this.subgraphToOpenAt(world);
    if (subgraph) {
      this.select(subgraph);
      this.actions.openExpand(subgraph);
      return;
    }
    if (this.hitNode(world) || this.hitGhost(world) || this.hitDrawingAbove(null, world)) return;
    const target = this.creationTargetAt(world);
    this.actions.quickCreateNode(target.point, target.frameHost);
  }

  // Right-click reads the same target a press would land on and hands it to the app to build a
  // menu; an affordance stands for the thing it belongs to, a port or handle for its node. It never
  // creates, so it reads the target as the select tool does. A node that is not already part of
  // the selection becomes the sole selection first, so the menu acts on it; an existing
  // multi-selection is left intact.
  private onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const world = this.screenToWorld(this.eventPoint(event));
    const screenPoint = { x: event.clientX, y: event.clientY };
    const target = this.pressTargetAt(world, { creating: false });
    switch (target.kind) {
      case 'port':
      case 'node-handle':
      case 'node':
        this.openNodeMenu(target.node, screenPoint);
        return;
      case 'selected-edge-grip':
      case 'edge':
        this.openEdgeMenu(target.edge, screenPoint);
        return;
      case 'region-handle':
      case 'region':
        this.openRegionMenu(target.context, screenPoint);
        return;
      case 'drawing':
        if (!this.isDrawingHeld(target.drawing)) this.selectOnlyDrawing(target.drawing);
        this.actions.contextMenu({ kind: 'drawing' }, screenPoint);
        return;
      case 'drawing-handle':
        this.actions.contextMenu({ kind: 'drawing' }, screenPoint);
        return;
      case 'ghost':
      case 'canvas':
        this.actions.contextMenu({ kind: 'canvas', world }, screenPoint);
        return;
    }
  }

  private openNodeMenu(node: FlowNode, screenPoint: Point): void {
    if (!this.selection.has(node)) this.select(node);
    this.actions.contextMenu({ kind: 'node', node }, screenPoint);
  }

  private openEdgeMenu(edge: ModelEdge, screenPoint: Point): void {
    this.clearSelection();
    this.selectedEdge = edge;
    this.actions.contextMenu({ kind: 'edge', edge }, screenPoint);
  }

  private openRegionMenu(region: ModelContext, screenPoint: Point): void {
    if (!this.selectedRegions.has(region)) {
      this.selection.clear();
      this.selectedEdge = null;
      this.selectedRegions = new Set([region]);
      this.requestRender();
    }
    this.actions.contextMenu({ kind: 'region', region: this.regionTargetOf(region) }, screenPoint);
  }

  // The scale a node is actually drawn at: the camera's, times the frame nesting it sits in.
  // Hit tolerances divide by this so a target stays equally easy to hit however deeply it is
  // nested — and it has to be the product, because the clamps applied to it are not linear.
  private screenScaleOf(node: FlowNode): number {
    return this.view.scale * this.expansionLayer.scaleOf(node);
  }

  // Descending into an unfolded frame: the point in the subgraph's own coordinates, or null
  // when it falls outside the frame's interior. The one place the frame transform is inverted.
  private pointInsideFrame(expansion: FrameExpansion, local: Point): Point | null {
    if (!rectContains(expansion.inner, local)) return null;
    return inverseTransformPoint(local, expansion.transform);
  }

  private hitNode(world: Point): FlowNode | null {
    return this.hitNodeIn(this.model, world);
  }

  private hitNodeIn(model: FlowModel, world: Point): FlowNode | null {
    for (let index = model.nodes.length - 1; index >= 0; index -= 1) {
      const node = model.nodes[index];
      const expansion = model.display?.expansions.get(node);
      const inside = expansion ? this.pointInsideFrame(expansion, world) : null;
      // A frame answers for its whole interior, so a miss inside it is a hit on the host.
      if (expansion && inside) return this.hitNodeIn(expansion.subModel, inside) ?? node;
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

  // Ports sit where the node's outline crosses the lines from its centre to the midpoints of
  // its sides, so on a slanted or pointed shape they stay on the ink. Their hit radius is the
  // same as on a rectangle; only where they are drawn moves.
  private portPositions(node: FlowNode): Point[] {
    const { x, y, w, h } = this.rect(node);
    const sideMidpoints = [
      { x: x + w / 2, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w / 2, y: y + h },
      { x, y: y + h / 2 },
    ];
    return sideMidpoints.map((midpoint) => this.outlinePointToward(node, midpoint));
  }

  private outlinePointToward(node: FlowNode, toward: Point): Point {
    return shapeBorderPointToward(this.drawnShapeOf(node), this.rect(node), toward);
  }

  private drawnShapeOf(node: FlowNode): ReturnType<typeof drawnShapeOf> {
    return drawnShapeOf(this.expansionLayer.modelOf(node) ?? this.model, node);
  }

  private portOfNodeNear(node: FlowNode, world: Point): Point | null {
    const hitRadius = PORT_HIT_RADIUS / this.view.scale;
    for (const port of this.portPositions(node)) {
      if (Math.hypot(world.x - port.x, world.y - port.y) <= hitRadius) return port;
    }
    return null;
  }

  private nodesShowingPorts(): Set<FlowNode> {
    const nodes = new Set([...this.selection]);
    if (this.hoverNode) nodes.add(this.hoverNode);
    return nodes;
  }

  private hitPort(world: Point): { node: FlowNode; port: Point } | null {
    for (const node of this.nodesShowingPorts()) {
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

  private cornerHandles(): CornerHandles | null {
    const sole = this.soleSelection();
    if (sole?.kind === 'node') return { kind: 'node-handle', node: sole.node, rect: this.rect(sole.node) };
    if (sole?.kind === 'drawings') return { kind: 'drawing-handle', resizable: sole.resizable, rect: this.drawingHandleRect(sole.resizable) };
    if (sole?.kind !== 'region') return null;
    const rect = this.regionRectOfContext(sole.context);
    return rect ? { kind: 'region-handle', context: sole.context, rect } : null;
  }

  private hitCornerHandle(world: Point): PressTarget | null {
    const handles = this.cornerHandles();
    const handle = handles && hitResizeHandle(handles.rect, world, this.handleReach());
    if (!handles || !handle) return null;
    switch (handles.kind) {
      case 'node-handle':
        return { kind: 'node-handle', node: handles.node, handle };
      case 'region-handle':
        return { kind: 'region-handle', context: handles.context, handle };
      case 'drawing-handle':
        return { kind: 'drawing-handle', resizable: handles.resizable, handle };
    }
  }

  // How far a handle reaches, in world units: the same on screen at every zoom.
  private handleReach(): number {
    return HANDLE_HIT_RADIUS_PX / this.view.scale;
  }

  // Regions answer gestures only in the graph the canvas is showing: one inside an unfolded
  // frame belongs to that file's own picture, and is edited by opening it.
  private regionRectOfContext(context: ModelContext): Rect | null {
    return regionRectOf(this.model, context);
  }

  private selectedRegionDisplayRectOf(context: ModelContext): Rect | null {
    const resizing = this.gesture?.type === 'region-resize' ? this.gesture : null;
    return (
      regionRectDuringResize(context, resizing)
      ?? this.regionRectOfContext(context)
    );
  }

  // The frame and the name label, never the interior: a region encloses nodes it does not own, so
  // a press inside it has to fall through to the marquee (R27). Topmost first, so the region drawn
  // last wins where two frames overlap.
  private hitRegion(world: Point): ModelContext | null {
    return hitRegionAt(
      this.model,
      world,
      this.view.scale,
      (name, rect) => regionLabelBand(this.ctx, name, rect),
    );
  }

  // Narrows a region hit to its name label, so double-clicking the border keeps its existing
  // meaning and only the painted title opens inline rename.
  private hitRegionTitle(world: Point): ModelContext | null {
    const region = this.hitRegion(world);
    if (!region) return null;
    const placement = this.regionTitlePlacementOf(region);
    return placement && rectContains(placement.rect, world) ? region : null;
  }

  private hitBadge(world: Point): BadgeHit | null {
    return this.hitBadgeIn(this.model, world);
  }

  private hitBadgeIn(model: FlowModel, world: Point): BadgeHit | null {
    for (let index = model.nodes.length - 1; index >= 0; index -= 1) {
      const node = model.nodes[index];
      const hitRadius = BADGE_HIT_RADIUS / Math.min(this.screenScaleOf(node), 1);
      for (const badge of nodeBadges(model, node, this.expansionLayer.isOpen(node.id))) {
        if (Math.hypot(world.x - badge.x, world.y - badge.y) <= hitRadius) {
          return { kind: badge.kind, node };
        }
      }
      const expansion = model.display?.expansions.get(node);
      const inside = expansion ? this.pointInsideFrame(expansion, world) : null;
      if (expansion && inside) {
        const hit = this.hitBadgeIn(expansion.subModel, inside);
        if (hit) return hit;
      }
    }
    return null;
  }

  private hitEdge(world: Point): ModelEdge | null {
    return this.hitEdgeIn(this.model, world);
  }

  // Unlike nodes and badges, every containing frame is searched before this model's own edges:
  // an edge inside a frame is drawn over the frame's fill, so it wins wherever they overlap.
  private hitEdgeIn(model: FlowModel, world: Point): ModelEdge | null {
    for (const expansion of model.display?.expansions.values() ?? []) {
      const inside = this.pointInsideFrame(expansion, world);
      if (!inside) continue;
      const hit = this.hitEdgeIn(expansion.subModel, inside);
      if (hit) return hit;
    }
    for (const edge of model.edges) {
      const geometry = this.edgeGeometryOf(edge);
      if (!geometry) continue;
      if (geometry.labelRect && rectContains(geometry.labelRect, world)) return edge;
      if (distanceToEdgePath(world, geometry.path) <= EDGE_HIT_DISTANCE / this.screenScaleOf(edge.from)) return edge;
    }
    return null;
  }

  // A model rebuild makes fresh ModelEdge objects: the open flow's on every setModel, a frame's
  // subgraph whenever its file is edited. Null once the edge is gone or no longer drawn.
  private currentEdgeMatching(edge: ModelEdge): ModelEdge | null {
    const matches = (candidate: ModelEdge): boolean => isSameEdge(candidate, edge);
    return this.model.edges.find(matches) ?? this.expansionLayer.findEdgeWhere(matches);
  }

  // An edit to a frame's file rebuilds only that frame's subgraph, lazily, during layout; nothing
  // tells the view, so the selection is carried over to the rebuilt edge here.
  private resolveSelectedEdges(): void {
    this.selectedEdges = this.selectedEdges
      .map((edge) => this.currentEdgeMatching(edge))
      .filter((edge): edge is ModelEdge => edge != null);
  }

  // The bend drag a press at `world` would start on `edge`, or null when it misses the edge's grip.
  private edgeBendGrabbedAt(edge: ModelEdge, world: Point, screen: Point): EdgeBendGesture | null {
    const geometry = this.edgeGeometryOf(edge);
    const local = this.pointInEdgeModel(edge, world);
    if (!geometry || !gripContains(geometry, local, this.screenScaleOf(edge.from))) return null;
    return beginEdgeBend(edge, geometry, local, screen);
  }

  private edgeGripContains(edge: ModelEdge, world: Point): boolean {
    const geometry = this.edgeGeometryOf(edge);
    return geometry != null && gripContains(geometry, this.pointInEdgeModel(edge, world), this.screenScaleOf(edge.from));
  }

  // An edge's geometry is in the coordinates of the model that draws it, which for an edge inside
  // an unfolded frame is the frame's subgraph. That model's locus already composes every frame
  // above it, so the point is mapped in one step rather than descended into frame by frame.
  private pointInEdgeModel(edge: ModelEdge, world: Point): Point {
    const locus = this.expansionLayer.locusOf(edge.from);
    return locus ? inverseTransformPoint(world, locus.transform) : world;
  }

  private edgeBendsInFlight(): EdgeBendOverrides | null {
    return this.gesture?.type === 'edge-bend' ? bendOverridesOf(this.gesture) : null;
  }

  // What bare canvas shows under each tool: where a press will make something, and what.
  private canvasCursorOfTool(): CanvasCursor {
    if (this.tool === 'node' || this.tool === 'draw') return 'crosshair';
    return this.tool === 'text' ? 'text' : 'default';
  }

  private updateCursor(world?: Point, shiftKey = false): void {
    this.canvas.style.cursor = this.cursorAt(world, shiftKey);
  }

  private cursorAt(world: Point | undefined, shiftKey: boolean): CanvasCursor {
    if (this.spaceDown || this.gesture?.type === 'pan') return 'grab';
    const canvasCursor = this.canvasCursorOfTool();
    if (!world || this.tool === 'draw') return canvasCursor;
    return cursorFor(this.pressTargetAt(world, { creating: this.createsOnPress(shiftKey) }), canvasCursor);
  }

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private scenePainter(hiddenTitles: HiddenCanvasTitles): ScenePainter {
    return new ScenePainter({
      regionRects: this.regionRectsForPainting(),
      drawingTransforms: this.drawingTransformsInFlight(),
      edgeBends: this.edgeBendsInFlight(),
      ctx: this.ctx,
      rough: this.rough,
      baseRoughness: this.baseRoughness,
      selectedEdges: this.selectedEdges,
      hiddenTitles,
      edgeGeometry: this.edgeGeometry,
      expansions: this.expansionLayer,
    });
  }

  private render(): void {
    const { ctx } = this;
    this.edgeGeometry.clear();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.sceneTransition) {
      this.renderSceneTransition(this.sceneTransition, this.scenePainter(this.hiddenTitles));
      return;
    }

    const expansionState = this.expansionLayer.layout(this.model, performance.now());
    this.expansionLayer.collectLoci(this.model);
    this.resolveHeldDrawings();
    this.resolveSelectedEdges();
    const painter = this.scenePainter(this.hiddenTitles);
    const dpr = this.devicePixelRatio;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawGridIfVisible(this.view);

    const { x, y, scale } = this.view;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);

    painter.drawScene(this.model);
    this.drawSelectionDecorations();
    this.drawPorts();
    this.drawGestureOverlay(painter);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawNotice();

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
    // The painter lays the title out in the shape's text box; the overlay has to use the same.
    const textBox = shapeTextBox(drawnShapeOf(model, node), localRect);
    const band = expansion
      ? frameTitleBand(this.ctx, node, expansion.frame)
      : titleBandOf(textBox, this.layOutNodeText(model, node, textBox));

    return {
      rect: locus ? transformRect(band, locus.transform) : band,
      fontPx: expansion ? FRAME_TITLE_FONT_PX : TITLE_FONT_PX,
      align: expansion ? 'left' : 'center',
      color: expansion ? canvasPalette.expandStroke : canvasPalette.ink,
      screenScale: this.screenScaleOf(node),
    };
  }

  // World-space rect and typography of a region's name label as drawn, or null when the region
  // has no geometry on the canvas.
  regionTitlePlacementOf(context: ModelContext): TitlePlacement | null {
    const rect = this.regionRectOfContext(context);
    if (!rect) return null;
    return {
      rect: regionLabelBand(this.ctx, context.block.name, rect),
      fontPx: FRAME_TITLE_FONT_PX,
      align: 'left',
      color: canvasPalette.regionStroke,
      screenScale: this.view.scale,
    };
  }

  regionTitlePlacementOfTarget(region: RegionTarget): TitlePlacement | null {
    const context = this.model.contexts.find((candidate) => candidate.block === region.block);
    return context ? this.regionTitlePlacementOf(context) : null;
  }

  private drawSelectionDecorations(): void {
    this.drawSelectedRegionDecorations();
    const { ctx } = this;
    const inflate = SELECTION_OUTLINE_INFLATE;
    ctx.save();
    ctx.strokeStyle = canvasPalette.select;
    ctx.lineWidth = SELECTION_LINE_WIDTH_PX / this.view.scale;
    ctx.setLineDash([6 / this.view.scale, 4 / this.view.scale]);
    for (const node of this.selection) {
      if (!this.isNodeVisible(node)) continue;
      const { x, y, w, h } = this.rect(node);
      ctx.strokeRect(x - inflate, y - inflate, w + inflate * 2, h + inflate * 2);
    }
    for (const { x, y, w, h } of this.selectedDrawingOutlines()) {
      ctx.strokeRect(x - inflate, y - inflate, w + inflate * 2, h + inflate * 2);
    }
    ctx.setLineDash([]);
    for (const { x, y, w, h } of this.selectedGroupOutlines().map((union) => padRect(union, GROUP_OUTLINE_INFLATE))) {
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();

    this.drawSelectedEdgeGrip();

    const handleRect = this.resizeHandleRect();
    if (!handleRect) return;
    const handleSize = 8 / this.view.scale;
    ctx.fillStyle = canvasPalette.select;
    for (const origin of selectionHandleOrigins(handleRect, handleSize)) {
      ctx.fillRect(origin.x, origin.y, handleSize, handleSize);
    }
  }

  // A labelled edge is grabbed by its label, so only an unlabelled one gets a drawn grip; a
  // self-loop, which cannot be bent, gets none.
  private drawSelectedEdgeGrip(): void {
    const edge = this.edgeSelectedAlone();
    const geometry = edge ? this.edgeGeometryOf(edge) : null;
    if (!edge || !geometry?.chord || !canBendAlong(geometry.chord) || geometry.labelRect) return;
    const center = this.edgeAnchor(edge);
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.arc(center.x, center.y, EDGE_GRIP_DRAWN_RADIUS_PX / this.view.scale, 0, Math.PI * 2);
    ctx.fillStyle = canvasPalette.portFill;
    ctx.fill();
    ctx.strokeStyle = canvasPalette.select;
    ctx.lineWidth = SELECTION_LINE_WIDTH_PX / this.view.scale;
    ctx.stroke();
    ctx.restore();
  }

  // Corner handles belong to a selection of exactly one node, one drawing or one group; any other
  // selection is not resizable, and handles it would not answer would lie about what a press does.
  private resizeHandleRect(): Rect | null {
    const handles = this.cornerHandles();
    if (handles?.kind === 'node-handle') return this.isNodeVisible(handles.node) ? handles.rect : null;
    return handles?.kind === 'drawing-handle' ? handles.rect : null;
  }

  // Every selected region gets the same dashed outline a node does, drawn on its frame rather
  // than inside it, so the thing under the pointer is the thing that will move. Corner handles
  // appear only when the region is the sole selection — a mixed selection is not resizable, and
  // drawing handles it would not answer would lie about what a press can do.
  private drawSelectedRegionDecorations(): void {
    const { ctx } = this;
    for (const context of this.selectedRegions) {
      const rect = this.selectedRegionDisplayRectOf(context);
      if (!rect) continue;
      ctx.save();
      ctx.strokeStyle = canvasPalette.select;
      ctx.lineWidth = SELECTION_LINE_WIDTH_PX / this.view.scale;
      ctx.setLineDash([6 / this.view.scale, 4 / this.view.scale]);
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
    }

    const sole = this.soleSelection();
    if (sole?.kind !== 'region') return;
    const rect = this.selectedRegionDisplayRectOf(sole.context);
    if (!rect) return;
    const handleSize = 8 / this.view.scale;
    ctx.fillStyle = canvasPalette.select;
    for (const origin of selectionHandleOrigins(rect, handleSize)) {
      ctx.fillRect(origin.x, origin.y, handleSize, handleSize);
    }
  }

  private drawPorts(): void {
    if (this.tool === 'draw' || (this.gesture && this.gesture.type !== 'edge')) return;
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
        ctx.lineWidth = SELECTION_LINE_WIDTH_PX / this.view.scale;
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
      ctx.lineWidth = SELECTION_LINE_WIDTH_PX / this.view.scale;
      ctx.strokeRect(gesture.rect.x, gesture.rect.y, gesture.rect.w, gesture.rect.h);
      ctx.restore();
    } else if (gesture.type === 'marquee' && gesture.rect) {
      ctx.fillStyle = canvasPalette.marqueeFill;
      ctx.fillRect(gesture.rect.x, gesture.rect.y, gesture.rect.w, gesture.rect.h);
      ctx.strokeStyle = canvasPalette.select;
      ctx.lineWidth = 1 / this.view.scale;
      ctx.strokeRect(gesture.rect.x, gesture.rect.y, gesture.rect.w, gesture.rect.h);
    } else if (gesture.type === 'edge') {
      const start = this.outlinePointToward(gesture.from, gesture.toWorld);
      const end = gesture.hoverTarget
        ? this.outlinePointToward(gesture.hoverTarget, rectCenter(this.rect(gesture.from)))
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
      painter.drawArrowhead('arrow', start, end, canvasPalette.select);
      if (gesture.hoverTarget) {
        const { x, y, w, h } = this.rect(gesture.hoverTarget);
        ctx.strokeStyle = canvasPalette.select;
        ctx.lineWidth = 2 / this.view.scale;
        ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
      }
    } else if (gesture.type === 'draw') {
      const { scale, tx, ty } = gesture.transform;
      ctx.save();
      ctx.transform(scale, 0, 0, scale, tx, ty);
      inkStroke(ctx, gesture.points, drawingInkColor(this.drawStyle.color), STROKE_LINE_WIDTHS[this.drawStyle.width]);
      ctx.restore();
    }
  }

  // A short message beside the pointer — for an edit the canvas could not make, shown where the
  // user is looking rather than somewhere they are not.
  flashNotice(text: string): void {
    const viewportCenter = { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    const world = this.hoverPoint ?? this.screenToWorld(viewportCenter);
    this.notice = { text, world, until: performance.now() + NOTICE_MS };
    this.requestRender();
    setTimeout(() => this.requestRender(), NOTICE_MS);
  }

  // Drawn in screen pixels, so it reads the same at every zoom.
  private drawNotice(): void {
    if (this.notice && performance.now() >= this.notice.until) this.notice = null;
    if (!this.notice) return;
    const { ctx } = this;
    const anchor = this.worldToScreen(this.notice.world);
    ctx.save();
    ctx.font = NOTICE_FONT;
    const width = ctx.measureText(this.notice.text).width + NOTICE_PADDING_PX * 2;
    const height = 13 + NOTICE_PADDING_PX * 2;
    const left = Math.max(0, Math.min(anchor.x + NOTICE_OFFSET_PX, this.viewport.width - width));
    const top = Math.max(0, Math.min(anchor.y + NOTICE_OFFSET_PX, this.viewport.height - height));
    ctx.fillStyle = canvasPalette.edgeLabelBg;
    ctx.strokeStyle = canvasPalette.error;
    ctx.lineWidth = 1;
    ctx.fillRect(left, top, width, height);
    ctx.strokeRect(left, top, width, height);
    ctx.fillStyle = canvasPalette.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.notice.text, left + NOTICE_PADDING_PX, top + height / 2);
    ctx.restore();
  }

  // Every model on screen that drawings can be made in, outermost first.
  private drawingSurfaces(): ViewDrawingSurface[] {
    return [
      { model: this.model, transform: TOP_LEVEL_TRANSFORM, clip: null, host: null },
      ...this.expansionLayer.openFrames().map((frame) => ({
        model: frame.model,
        transform: frame.transform,
        clip: frame.interior,
        host: frame.host,
      })),
    ];
  }

  // A drawing under the point, unless something of the graph is there: drawings are painted over
  // everything but never stand in the way of a node. An unfolded frame's empty interior counts as
  // nothing, so the drawings made inside a frame can be picked up.
  // A text under the point, as a press would find it — the one thing a double-click edits in place
  // among the drawings.
  private hitTextAbove(world: Point): DrawingSelection | null {
    const hit = this.hitDrawingAbove(this.hitNode(world), world);
    const drawing = hit && hit.model.visuals?.drawings().find((candidate) => candidate.id === hit.id);
    return drawing?.kind === TEXT_KIND ? hit : null;
  }

  // Text goes where the press was: the top-left of its first line, in the graph under the point.
  private placeTextAt(world: Point): void {
    const target = this.creationTargetAt(world);
    this.actions.placeText(target.point, target.frameHost);
  }

  // A stored text as laid out now — found by where it is stored, since every edit rebuilds the
  // models — with the transform from its graph's units to the world's. Null when it is not text
  // or no longer shown.
  laidOutText(stored: StoredDrawing): LaidOutText | null {
    const surface = this.drawingSurfaces().find((candidate) => isSurfaceStoring(candidate, stored));
    const drawing = surface?.model.visuals?.drawings().find((candidate) => candidate.id === stored.id);
    if (!surface || drawing?.kind !== TEXT_KIND) return null;
    return { text: drawing, transform: surface.transform, selection: { model: surface.model, id: stored.id } };
  }

  // Where the graph under `frameHost` sits in the world, or null when its frame is not unfolded.
  graphTransformUnder(frameHost: FlowNode | null): FrameTransform | null {
    return this.drawingSurfaces().find((surface) => surface.host === frameHost)?.transform ?? null;
  }

  // Measures text in the canvas's own font machinery, so a box measured here is the box the
  // painter fills.
  lineMeasurer(): LineMeasurer {
    return canvasLineMeasurer(this.ctx);
  }

  private hitDrawingAbove(node: FlowNode | null, world: Point): DrawingSelection | null {
    if (node && !this.isFrameBackground(node, world)) return null;
    return hitDrawingAt(this.drawingSurfaces(), world, EDGE_HIT_DISTANCE / this.view.scale);
  }

  private pressDrawing(pressed: DrawingSelection, world: Point, screen: Point, shiftKey: boolean): void {
    this.actions.canvasClicked();
    const held = this.isDrawingHeld(pressed);
    if (shiftKey && held) {
      const group = new Set(this.groupOfDrawing(pressed));
      this.heldDrawings = this.heldDrawings.filter((drawing) => drawing.model !== pressed.model || !group.has(drawing.id));
      this.requestRender();
      return;
    }
    if (!held) {
      if (shiftKey) this.holdDrawing(pressed, this.surfaceOfModel(pressed.model));
      else this.selectOnlyDrawing(pressed);
    }
    this.gesture = this.beginMoveGesture(world, screen, { kind: 'drawing', drawing: pressed }, null, shiftKey);
    this.requestRender();
  }

  private selectOnlyDrawing(drawing: DrawingSelection): void {
    this.selection.clear();
    this.selectedRegions.clear();
    this.selectedEdge = null;
    this.heldDrawings = [];
    this.holdDrawing(drawing, this.surfaceOfModel(drawing.model));
    this.requestRender();
  }

  private isDrawingHeld(drawing: DrawingSelection): boolean {
    return this.heldDrawings.some((held) => sameDrawingSelection(held, drawing));
  }

  // A grouped drawing is never held alone: its whole group comes with it, which is what makes the
  // group move, recolour and delete as one.
  private holdDrawing(drawing: DrawingSelection, surface: ViewDrawingSurface | null): void {
    if (!surface) return;
    for (const id of this.groupOfDrawing(drawing)) {
      const member = { model: drawing.model, id };
      if (!this.isDrawingHeld(member)) this.heldDrawings.push({ ...member, surfaceKey: surfaceKeyOf(surface) });
    }
  }

  private groupOfDrawing(drawing: DrawingSelection): string[] {
    return drawing.model.visuals?.drawingGroupOf(drawing.id) ?? [drawing.id];
  }

  // Selects every drawing grouped with one already selected — after a grouping changes what
  // belongs together, the selection follows it.
  // Everything a selection can hold in the graph on screen: its nodes (an unfolded frame brings
  // what is inside it along), its regions, and every drawing not already riding in a selected
  // frame. Edges are left to the nodes they belong to, which every edit of a selection follows.
  selectAll(): void {
    this.clearSelection();
    this.selection = new Set(this.model.nodes);
    this.selectedRegions = new Set(this.model.contexts);
    for (const surface of this.drawingSurfaces()) {
      if (this.isInsideMovingFrame(surface.host, this.selection)) continue;
      for (const drawing of surface.model.visuals?.drawings() ?? []) {
        this.holdDrawing({ model: surface.model, id: drawing.id }, surface);
      }
    }
    this.requestRender();
  }

  holdWholeGroups(): void {
    const surfaces = this.drawingSurfaces();
    for (const held of [...this.heldDrawings]) {
      this.holdDrawing(held, surfaces.find((surface) => surface.model === held.model) ?? null);
    }
    this.requestRender();
  }

  private surfaceOfModel(model: FlowModel): ViewDrawingSurface | null {
    return this.drawingSurfaces().find((surface) => surface.model === model) ?? null;
  }

  // Edits rebuild models, so a held drawing is found again on the surface it was selected on —
  // the same model when it survived, otherwise the one now laid out in its place. A drawing that is
  // gone, or whose frame closed, leaves the selection.
  private resolveHeldDrawings(): void {
    this.holdLaidOutDrawings();
    const surfaces = this.drawingSurfaces();
    const resolved: HeldDrawing[] = [];
    for (const held of this.heldDrawings) {
      const surface = surfaces.find((candidate) => candidate.model === held.model)
        ?? surfaces.find((candidate) => surfaceKeyOf(candidate) === held.surfaceKey);
      const laidOut = surface?.model.visuals?.drawings().find((candidate) => candidate.id === held.id);
      if (!surface || !laidOut) continue;
      const drawing = { model: surface.model, id: held.id };
      if (!resolved.some((entry) => sameDrawingSelection(entry, drawing))) {
        resolved.push({ ...drawing, surfaceKey: held.surfaceKey });
      }
    }
    this.heldDrawings = resolved;
  }

  // Each drawing is held where it is first laid out: the open graph before any frame showing it.
  private holdLaidOutDrawings(): void {
    if (this.drawingsToHold.length === 0) return;
    const surfaces = this.drawingSurfaces();
    for (const stored of this.drawingsToHold) {
      const surface = surfaces.find((candidate) => isSurfaceStoring(candidate, stored));
      if (surface) this.holdDrawing({ model: surface.model, id: stored.id }, surface);
    }
    this.drawingsToHold = [];
  }

  // World rects of the selected drawings, following any drag in progress.
  private selectedDrawingOutlines(): Rect[] {
    const surfaces = this.drawingSurfaces();
    return this.heldDrawings.flatMap((held) => {
      const surface = surfaces.find((candidate) => candidate.model === held.model);
      const laidOut = surface?.model.visuals?.drawings().find((candidate) => candidate.id === held.id);
      return surface && laidOut ? [worldBoundsOf(this.drawingAsShown(held, laidOut), surface)] : [];
    });
  }

  // One solid outline around each selected group, around the dashed ones of its members.
  private selectedGroupOutlines(): Rect[] {
    const surfaces = this.drawingSurfaces();
    const outlined = new Set<string>();
    return this.heldDrawings.flatMap((held) => {
      const group = this.groupOfDrawing(held);
      const groupKey = storedDrawingKey(held.model, [...group].sort().join(' '));
      const surface = surfaces.find((candidate) => candidate.model === held.model);
      if (group.length < 2 || !surface || outlined.has(groupKey)) return [];
      outlined.add(groupKey);
      const members = new Set(group);
      const memberBounds = (surface.model.visuals?.drawings() ?? [])
        .filter((drawing) => members.has(drawing.id))
        .map((drawing) => worldBoundsOf(this.drawingAsShown(held, drawing), surface));
      const union = boundsOfRects(memberBounds);
      return union ? [union] : [];
    });
  }

  // How far each drawing a gesture is carrying has been moved or stretched so far, keyed by its
  // stored key. Painted over the stored drawing; the layer is written only when the drag lands.
  private drawingTransformsInFlight(): ReadonlyMap<string, DrawingTransform> | null {
    const gesture = this.gesture;
    if (gesture?.type === 'drawing-resize') return new Map(gesture.storedKeys.map((key) => [key, gesture.transform]));
    if (gesture?.type !== 'move') return null;
    return new Map([...gesture.drawingOffsets].map(([key, offset]) => [key, translationBy(offset)]));
  }

  private drawingAsShown(selection: DrawingSelection, drawing: CanvasDrawing): CanvasDrawing {
    const transform = this.drawingTransformsInFlight()?.get(storedDrawingKey(selection.model, selection.id));
    return transform ? drawingAsCarried(drawing, transform, this.lineMeasurer()) : drawing;
  }

  // The selection is a lone drawing, or exactly the members of one group (a grouped drawing is never
  // held alone, so a single group selected means every held drawing shares the first one's group)
  // — the drawings a corner can resize.
  private resizableDrawingSelection(): ResizableDrawings | null {
    const [first] = this.heldDrawings;
    const group = new Set(this.groupOfDrawing(first));
    const isOneWholeGroup = this.heldDrawings.length === group.size
      && this.heldDrawings.every((held) => held.model === first.model && group.has(held.id));
    if (!isOneWholeGroup) return null;
    const surface = this.surfaceOfModel(first.model);
    const members = (surface?.model.visuals?.drawings() ?? []).filter((drawing) => group.has(drawing.id));
    if (!surface || members.length !== group.size) return null;
    return { surface, drawings: members.map((drawing) => ({ model: first.model, id: drawing.id })), members };
  }

  // On the drawing's ink for a lone drawing, on the group's outline for a group — where the eye
  // already sees the edge of the thing being resized.
  private drawingHandleRect(resizable: ResizableDrawings): Rect {
    const shownBounds = resizable.members.map((drawing) =>
      worldBoundsOf(this.drawingAsShown({ model: resizable.surface.model, id: drawing.id }, drawing), resizable.surface));
    const bounds = boundsOfRects(shownBounds)!;
    return resizable.members.length > 1 ? padRect(bounds, GROUP_OUTLINE_INFLATE) : bounds;
  }
}

function hasBecomeDrag(gesture: DragStart, screen: Point): boolean {
  if (!gesture.moved && distanceBetween(screen, gesture.startScreen) < DRAG_THRESHOLD_PX) return false;
  gesture.moved = true;
  return true;
}

function isSurfaceStoring(surface: ViewDrawingSurface, stored: StoredDrawing): boolean {
  const { model } = surface;
  return model.sourcePath === stored.path
    && model.sourceScope === stored.scope
    && (model.visuals?.drawings().some((drawing) => drawing.id === stored.id) ?? false);
}

function surfaceKeyOf(surface: ViewDrawingSurface): string {
  return [surface.host?.id ?? '', surface.model.sourcePath ?? '', surface.model.sourceScope ?? ''].join('\n');
}

function isTypingTarget(element: EventTarget | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

