// Inline expansion of subgraphs: a node whose `expand` points at a graph block or another
// .flow file can unfold that subgraph inside its own frame on the current canvas. This
// layer owns which nodes are unfolded, the open/close animation clock, fetching of
// external .flow documents, and the per-frame geometry pass: expanded frame rects, the
// transform that maps subgraph coordinates into a frame's interior, and the gravity-style
// displacement that pushes surrounding nodes clear of a growing frame.
//
// The open-set can be saved and restored via `openVisibleNodeIds` / `restoreOpen` (the
// app shell persists it in graf.manifest.json). All derived geometry lives in
// `model.display`, which the canvas view prefers over a node's authored `pos`, so
// committed positions never change.

import {
  getProp,
  parseExpandLink,
  parseFlow,
  resolveLinkPath,
  resolvedExpandPath,
  type FlowDocument,
  type FlowNode,
  type Rect,
} from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import type { EdgeSpec } from '../shared/flow-format.js';
import type { FlowModel, ModelEdge, Point } from './flow-doc.js';

export interface FrameTransform {
  scale: number;
  tx: number;
  ty: number;
}

export function transformPoint(point: Point, transform: FrameTransform): Point {
  return { x: point.x * transform.scale + transform.tx, y: point.y * transform.scale + transform.ty };
}

export function transformRect(rect: Rect, transform: FrameTransform): Rect {
  return {
    x: rect.x * transform.scale + transform.tx,
    y: rect.y * transform.scale + transform.ty,
    w: rect.w * transform.scale,
    h: rect.h * transform.scale,
  };
}

export interface InlineDiveAnchor {
  frame: Rect;
  transform: FrameTransform;
}

export function inlineDiveAnchor(model: FlowModel, node: FlowNode): InlineDiveAnchor | null {
  const expansion = model.display?.expansions.get(node);
  if (!expansion) return null;
  const warpedFrame = model.display!.rects.get(node);
  return {
    frame: { ...(warpedFrame ?? expansion.frame) },
    transform: { ...expansion.transform },
  };
}

export interface FrameExpansion {
  subModel: FlowModel;
  frame: Rect;
  frameBase: Point;
  inner: Rect;
  transform: FrameTransform;
  alpha: number;
}

export interface DisplayGeometry {
  rects: Map<FlowNode, Rect>;
  expansions: Map<FlowNode, FrameExpansion>;
}

export interface NodeLocus {
  model: FlowModel;
  transform: FrameTransform;
  host: FlowNode | null;
}

export interface DocumentOwner {
  doc: FlowDocument;
  path: string;
}

interface ToggleEntry {
  targetOpen: boolean;
  startTime: number;
  startProgress: number;
}

interface ExternalDocEntry {
  doc?: FlowDocument;
  loading?: boolean;
  missing?: boolean;
  loadPromise?: Promise<FlowDocument | null>;
}

const TOGGLE_DURATION_MS = 380;
const FRAME_HEADER_HEIGHT = 30;
const FRAME_PADDING = 16;
const CONTENT_MARGIN = 36;
const MAX_INNER_SIZE = { w: 680, h: 500 };
const EMPTY_CONTENT_SIZE = { w: 320, h: 180 };
const WARP_CLEARANCE = 28;
const WARP_RIPPLE_RANGE = 300;
const WARP_RIPPLE_STRENGTH = 0.5;
// Generous margin so edges between a frame and its neighbors keep room for their labels.
const SEPARATION_MARGIN = 64;
const SEPARATION_ITERATIONS = 10;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

// Half-extent of an axis-aligned rect along a unit direction (its support function), used
// to measure clearance between rects without treating them as circles.
function halfExtentAlong(rect: Rect, direction: Point): number {
  return (Math.abs(direction.x) * rect.w + Math.abs(direction.y) * rect.h) / 2;
}

export class ExpansionLayer {
  private readonly entries = new Map<string, ToggleEntry>();
  private readonly subModels = new Map<string, FlowModel>();
  private readonly externalDocs = new Map<string, ExternalDocEntry>();
  private readonly onNeedsRender: () => void;
  private readonly readExternalFile: (path: string) => Promise<string | null>;
  private topModel: FlowModel | null = null;
  locus: Map<FlowNode, NodeLocus> | null = null;

  constructor({
    onNeedsRender,
    readExternalFile,
  }: {
    onNeedsRender: () => void;
    readExternalFile: (path: string) => Promise<string | null>;
  }) {
    this.onNeedsRender = onNeedsRender;
    this.readExternalFile = readExternalFile;
  }

  // Forgets everything session-local — open frames, cached documents and sub-models — when
  // the app switches to another workspace, where the same paths mean different files.
  reset(): void {
    this.entries.clear();
    this.subModels.clear();
    this.externalDocs.clear();
    this.topModel = null;
    this.locus = null;
  }

  isOpen(nodeId: string | null): boolean {
    if (nodeId == null) return false;
    return this.entries.get(nodeId)?.targetOpen ?? false;
  }

  // Open node ids currently visible in the active flow's rendered hierarchy (top-level and
  // inside open frames at any depth). Scoped via the loci map, not the global entries map.
  openVisibleNodeIds(): string[] {
    if (!this.locus) return [];
    const ids: string[] = [];
    for (const node of this.locus.keys()) {
      if (node.id && this.entries.get(node.id)?.targetOpen) ids.push(node.id);
    }
    return ids;
  }

  // Seed ids as fully open (progress 1) with no animation. The next layout pass realizes
  // frames; nested/external entries activate as their sub-models become available.
  restoreOpen(nodeIds: string[]): void {
    const now = performance.now();
    for (const id of nodeIds) {
      this.entries.set(id, { targetOpen: true, startTime: now, startProgress: 1 });
    }
    this.onNeedsRender();
  }

  // Loci map every node visible on the canvas — top-level and inside unfolded frames, at
  // any depth — to its owning model, the composed local→world transform, and the frame
  // host it lives under. Rebuilt by the canvas after each geometry pass, it is what lets
  // pointer interaction and editing treat embedded subgraph nodes like ordinary nodes.
  collectLoci(topModel: FlowModel): void {
    this.topModel = topModel;
    this.locus = new Map();
    this.addLoci(topModel, { scale: 1, tx: 0, ty: 0 }, null);
  }

  private addLoci(model: FlowModel, transform: FrameTransform, host: FlowNode | null): void {
    for (const node of model.nodes) this.locus!.set(node, { model, transform, host });
    if (!model.display) return;
    for (const [frameHost, expansion] of model.display.expansions) {
      const inner = expansion.transform;
      const composed = {
        scale: transform.scale * inner.scale,
        tx: inner.tx * transform.scale + transform.tx,
        ty: inner.ty * transform.scale + transform.ty,
      };
      this.addLoci(expansion.subModel, composed, frameHost);
    }
  }

  locusOf(node: FlowNode): NodeLocus | null {
    return this.locus?.get(node) ?? null;
  }

  modelOf(node: FlowNode): FlowModel | null {
    return this.locusOf(node)?.model ?? null;
  }

  scaleOf(node: FlowNode): number {
    return this.locusOf(node)?.transform.scale ?? 1;
  }

  hostOf(node: FlowNode): FlowNode | null {
    return this.locusOf(node)?.host ?? null;
  }

  isEmbedded(node: FlowNode): boolean {
    const locus = this.locusOf(node);
    return locus != null && locus.model !== this.topModel;
  }

  ownerOf(node: FlowNode): DocumentOwner | null {
    for (const [path, entry] of this.externalDocs) {
      if (entry.doc && FlowDoc.allNodes(entry.doc).includes(node)) return { doc: entry.doc, path };
    }
    return null;
  }

  findNodeById(nodeId: string): FlowNode | null {
    for (const entry of this.externalDocs.values()) {
      if (!entry.doc) continue;
      const node = FlowDoc.findNodeById(entry.doc, nodeId);
      if (node) return node;
    }
    return null;
  }

  findEdgeBySpec(spec: EdgeSpec): ModelEdge | null {
    for (const model of this.subModels.values()) {
      const edge = model.edges?.find((candidate) => candidate.spec === spec);
      if (edge) return edge;
    }
    return null;
  }

  toggle(node: FlowNode): void {
    if (!node.id) return;
    const now = performance.now();
    const existing = this.entries.get(node.id);
    if (existing) {
      existing.startProgress = this.progressOf(existing, now);
      existing.startTime = now;
      existing.targetOpen = !existing.targetOpen;
    } else {
      this.entries.set(node.id, { targetOpen: true, startTime: now, startProgress: 0 });
    }
    this.onNeedsRender();
  }

  invalidateSubModels(): void {
    this.subModels.clear();
  }

  watchesPath(path: string): boolean {
    return this.externalDocs.has(path);
  }

  documentAt(path: string): FlowDocument | null {
    return this.externalDocs.get(path)?.doc ?? null;
  }

  loadedDocuments(): DocumentOwner[] {
    const loaded: DocumentOwner[] = [];
    for (const [path, entry] of this.externalDocs) {
      if (entry.doc) loaded.push({ doc: entry.doc, path });
    }
    return loaded;
  }

  ensureDocument(path: string): Promise<FlowDocument | null> {
    const cached = this.externalDocs.get(path);
    if (cached?.doc) return Promise.resolve(cached.doc);
    if (cached?.missing) return Promise.resolve(null);
    if (cached?.loadPromise) return cached.loadPromise;
    this.externalDoc(path);
    return this.externalDocs.get(path)?.loadPromise ?? Promise.resolve(null);
  }

  expandDocumentFor(node: FlowNode, containingPath: string | null): FlowDocument | null {
    const path = resolvedExpandPath(getProp(node, 'expand'), containingPath);
    return path ? this.documentAt(path) : null;
  }

  adoptExternalText(path: string, text: string): void {
    const doc = parseFlow(text);
    FlowDoc.assignMissingIds(doc);
    this.externalDocs.set(path, { doc });
    this.subModels.clear();
    this.onNeedsRender();
  }

  // Cache an already-parsed document by identity so an open file's `state.doc` and the
  // expand-target cache stay the same object — edits remain visible through documentAt
  // after navigation, and description writes never serialize a stale prefetch snapshot.
  adoptDocument(path: string, doc: FlowDocument): void {
    this.externalDocs.set(path, { doc });
    this.subModels.clear();
  }

  private progressOf(entry: ToggleEntry, now: number): number {
    const elapsed = Math.min(1, (now - entry.startTime) / TOGGLE_DURATION_MS);
    const target = entry.targetOpen ? 1 : 0;
    return entry.startProgress + (target - entry.startProgress) * elapsed;
  }

  // Called from the canvas render loop each frame. Attaches `display` geometry to the model
  // (recursing into unfolded subgraphs) and reports whether any animation is still running.
  layout(model: FlowModel, now: number): { animating: boolean } {
    const display: DisplayGeometry = { rects: new Map(), expansions: new Map() };
    model.display = display;
    let animating = false;

    // Prefetch every visible external expand so preamble fields (e.g. description) can paint
    // on collapsed nodes without waiting for the user to unfold the frame.
    this.prefetchExternalExpands(model);

    for (const node of model.nodes) {
      if (!node.id) continue;
      const entry = this.entries.get(node.id);
      if (!entry) continue;
      if (!getProp(node, 'expand')) {
        this.entries.delete(node.id);
        continue;
      }
      const progress = this.progressOf(entry, now);
      if (!entry.targetOpen && progress <= 0.001) {
        this.entries.delete(node.id);
        this.subModels.delete(node.id);
        continue;
      }
      if (progress !== (entry.targetOpen ? 1 : 0)) animating = true;

      const subModel = this.resolveSubModel(model, node);
      if (!subModel) continue;
      if (this.layout(subModel, now).animating) animating = true;

      const expansion = this.expansionGeometry(node, subModel, easeInOutCubic(progress));
      display.expansions.set(node, expansion);
      display.rects.set(node, expansion.frame);
    }

    this.applyWarp(model, display);
    return { animating };
  }

  private expansionGeometry(node: FlowNode, subModel: FlowModel, eased: number): FrameExpansion {
    const pos = node.pos!;
    const content = subModelBounds(subModel);
    const contentScale = Math.min(1, MAX_INNER_SIZE.w / content.w, MAX_INNER_SIZE.h / content.h);
    const targetW = Math.max(pos.w, content.w * contentScale + FRAME_PADDING * 2);
    const targetH = Math.max(pos.h, content.h * contentScale + FRAME_HEADER_HEIGHT + FRAME_PADDING);
    const center = rectCenter(pos);
    const frameW = lerp(pos.w, targetW, eased);
    const frameH = lerp(pos.h, targetH, eased);
    const frame: Rect = {
      x: center.x - frameW / 2,
      y: center.y - frameH / 2,
      w: frameW,
      h: frameH,
    };

    const inner: Rect = {
      x: frame.x + FRAME_PADDING,
      y: frame.y + FRAME_HEADER_HEIGHT,
      w: Math.max(1, frame.w - FRAME_PADDING * 2),
      h: Math.max(1, frame.h - FRAME_HEADER_HEIGHT - FRAME_PADDING),
    };
    const scale = Math.min(inner.w / content.w, inner.h / content.h);
    const transform: FrameTransform = {
      scale,
      tx: inner.x + (inner.w - content.w * scale) / 2 - content.x * scale,
      ty: inner.y + (inner.h - content.h * scale) / 2 - content.y * scale,
    };
    return { subModel, frame, frameBase: { x: frame.x, y: frame.y }, inner, transform, alpha: eased };
  }

  // The warp runs in two passes over mutable display-rect copies: a decaying ripple gives
  // the gravity look (near neighbors swing wide, distant ones barely drift), then an
  // iterative pairwise separation guarantees nothing is left overlapping — including two
  // expanded frames shoving each other apart. Frames may end up displaced, so their inner
  // geometry is shifted by the same delta to keep drawing, hit-testing, and selection in
  // agreement.
  private applyWarp(model: FlowModel, display: DisplayGeometry): void {
    if (display.expansions.size === 0) return;
    for (const node of model.nodes) {
      if (!display.rects.has(node)) display.rects.set(node, { ...node.pos! });
    }
    this.applyRipple(model, display);
    separateOverlaps(model, display);
    for (const expansion of display.expansions.values()) {
      const dx = expansion.frame.x - expansion.frameBase.x;
      const dy = expansion.frame.y - expansion.frameBase.y;
      if (dx === 0 && dy === 0) continue;
      expansion.inner.x += dx;
      expansion.inner.y += dy;
      expansion.transform.tx += dx;
      expansion.transform.ty += dy;
    }
  }

  private applyRipple(model: FlowModel, display: DisplayGeometry): void {
    for (const [host, expansion] of display.expansions) {
      for (const node of model.nodes) {
        if (node === host || display.expansions.has(node)) continue;
        const rect = display.rects.get(node)!;
        const push = ripplePush(host.pos!, expansion.frame, rect);
        rect.x += push.dx;
        rect.y += push.dy;
      }
    }
  }

  private resolveSubModel(model: FlowModel, node: FlowNode): FlowModel | null {
    const cached = this.subModels.get(node.id!);
    if (cached) return cached;
    const expandValue = getProp(node, 'expand');
    const subModel = this.buildSubModel(model, expandValue!);
    if (!subModel) return null;
    subModel.embedded = true;
    this.subModels.set(node.id!, subModel);
    return subModel;
  }

  private buildSubModel(model: FlowModel, expandValue: string): FlowModel | null {
    const link = parseExpandLink(expandValue);
    if (!link) {
      if (!FlowDoc.graphBlockNames(model.sourceDoc).includes(expandValue)) {
        return withSource(emptyModel(model.sourceDoc), model.sourceDoc, model.sourcePath);
      }
      return withSource(FlowDoc.buildModel(model.sourceDoc, expandValue), model.sourceDoc, model.sourcePath);
    }
    const path = resolveLinkPath(model.sourcePath, link.path);
    const doc = this.externalDoc(path);
    if (!doc) return null;
    return withSource(FlowDoc.buildModel(doc, null), doc, path);
  }

  private prefetchExternalExpands(model: FlowModel): void {
    for (const node of model.nodes) {
      const path = resolvedExpandPath(getProp(node, 'expand'), model.sourcePath);
      if (path) this.externalDoc(path);
    }
  }

  private externalDoc(path: string): FlowDocument | null {
    const cached = this.externalDocs.get(path);
    if (cached) return cached.doc ?? null;
    const entry: ExternalDocEntry = { loading: true };
    entry.loadPromise = this.readExternalFile(path)
      .then((text) => {
        if (text == null) throw new Error('not found');
        // A later adoptDocument (open file) or adoptExternalText (watcher) may have replaced
        // this entry; do not clobber that live document with the late fetch.
        const current = this.externalDocs.get(path);
        if (current?.doc && current !== entry) return current.doc;
        this.adoptExternalText(path, text);
        return this.documentAt(path);
      })
      .catch(() => {
        if (this.externalDocs.get(path) !== entry) return null;
        this.externalDocs.set(path, { missing: true });
        return null;
      });
    this.externalDocs.set(path, entry);
    return null;
  }
}

function withSource(model: FlowModel, doc: FlowDocument, path: string | null): FlowModel {
  model.sourceDoc = doc;
  model.sourcePath = path;
  return model;
}

function emptyModel(doc: FlowDocument): FlowModel {
  return {
    nodes: [],
    edges: [],
    ghosts: [],
    nodesByName: new Map(),
    traits: new Map(),
    sourceDoc: doc,
    sourcePath: null,
  };
}

export function subModelBounds(subModel: FlowModel): Rect {
  const rects = [
    ...subModel.nodes.map((node) => subModel.display?.rects.get(node) ?? node.pos),
    ...subModel.ghosts.map((ghost) => ghost.pos),
  ].filter((rect): rect is Rect => rect != null);
  if (rects.length === 0) return { x: 0, y: 0, ...EMPTY_CONTENT_SIZE };
  const minX = Math.min(...rects.map((rect) => rect.x)) - CONTENT_MARGIN;
  const minY = Math.min(...rects.map((rect) => rect.y)) - CONTENT_MARGIN;
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w)) + CONTENT_MARGIN;
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h)) + CONTENT_MARGIN;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Soft far-field displacement from a growing frame: strength proportional to how much the
// frame has grown along the node's direction, decaying exponentially with the gap. Exact
// clearance is left to separateOverlaps.
export function ripplePush(hostBaseRect: Rect, frame: Rect, otherRect: Rect): { dx: number; dy: number } {
  const frameCenter = rectCenter(frame);
  const otherCenter = rectCenter(otherRect);
  const offset = { x: otherCenter.x - frameCenter.x, y: otherCenter.y - frameCenter.y };
  const distance = Math.hypot(offset.x, offset.y);
  const direction = distance < 1 ? { x: 1, y: 0 } : { x: offset.x / distance, y: offset.y / distance };

  const clearedDistance = halfExtentAlong(frame, direction) + halfExtentAlong(otherRect, direction) + WARP_CLEARANCE;
  const restingDistance = halfExtentAlong(hostBaseRect, direction) + halfExtentAlong(otherRect, direction) + WARP_CLEARANCE;
  const growth = Math.max(0, clearedDistance - restingDistance);
  if (growth === 0) return { dx: 0, dy: 0 };

  const gap = Math.max(0, distance - clearedDistance);
  const push = growth * WARP_RIPPLE_STRENGTH * Math.exp(-gap / WARP_RIPPLE_RANGE);
  return { dx: direction.x * push, dy: direction.y * push };
}

// Relaxation solve over the display rects: any two rects closer than the margin get pushed
// apart along the axis of least penetration. Expanded frames are immovable against plain
// nodes (the unfolded subgraph is the focus) but yield half-and-half to each other, so
// several open expansions negotiate space instead of stacking.
function separateOverlaps(model: FlowModel, display: DisplayGeometry): void {
  const nodes = model.nodes;
  const isFrame = (node: FlowNode) => display.expansions.has(node);
  for (let iteration = 0; iteration < SEPARATION_ITERATIONS; iteration += 1) {
    let moved = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = display.rects.get(nodes[i])!;
        const b = display.rects.get(nodes[j])!;
        const push = separationVector(a, b, SEPARATION_MARGIN);
        if (!push) continue;
        const [mobilityA, mobilityB] = pairMobility(isFrame(nodes[i]), isFrame(nodes[j]));
        a.x -= push.dx * mobilityA;
        a.y -= push.dy * mobilityA;
        b.x += push.dx * mobilityB;
        b.y += push.dy * mobilityB;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

export function separationVector(a: Rect, b: Rect, margin: number): { dx: number; dy: number } | null {
  const deltaX = (b.x + b.w / 2) - (a.x + a.w / 2);
  const deltaY = (b.y + b.h / 2) - (a.y + a.h / 2);
  const penetrationX = (a.w + b.w) / 2 + margin - Math.abs(deltaX);
  const penetrationY = (a.h + b.h) / 2 + margin - Math.abs(deltaY);
  if (penetrationX <= 0 || penetrationY <= 0) return null;
  if (penetrationX < penetrationY) {
    return { dx: (deltaX >= 0 ? 1 : -1) * penetrationX, dy: 0 };
  }
  return { dx: 0, dy: (deltaY >= 0 ? 1 : -1) * penetrationY };
}

export function pairMobility(aIsFrame: boolean, bIsFrame: boolean): [number, number] {
  if (aIsFrame && bIsFrame) return [0.5, 0.5];
  if (aIsFrame) return [0, 1];
  if (bIsFrame) return [1, 0];
  return [0.5, 0.5];
}
