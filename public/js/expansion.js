// Session-local inline expansion of subgraphs: a node whose `expand` points at a graph
// block or another .flow file can unfold that subgraph inside its own frame on the current
// canvas. This layer owns which nodes are unfolded, the open/close animation clock,
// fetching of external .flow documents, and the per-frame geometry pass: expanded frame
// rects, the transform that maps subgraph coordinates into a frame's interior, and the
// gravity-style displacement that pushes surrounding nodes clear of a growing frame.
//
// Nothing here is persisted. All derived geometry lives in `model.display`, which the
// canvas view prefers over a node's authored `pos`, so committed positions never change.

import { getProp, parseExpandLink, parseFlow, resolveLinkPath } from '/shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';

const TOGGLE_DURATION_MS = 380;
const FRAME_HEADER_HEIGHT = 30;
const FRAME_PADDING = 16;
const CONTENT_MARGIN = 36;
const MAX_INNER_SIZE = { w: 680, h: 500 };
const EMPTY_CONTENT_SIZE = { w: 320, h: 180 };
const WARP_CLEARANCE = 28;
const WARP_RIPPLE_RANGE = 300;
const WARP_RIPPLE_STRENGTH = 0.5;
const SEPARATION_MARGIN = 24;
const SEPARATION_ITERATIONS = 10;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(from, to, t) {
  return from + (to - from) * t;
}

function rectCenter(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

// Half-extent of an axis-aligned rect along a unit direction (its support function), used
// to measure clearance between rects without treating them as circles.
function halfExtentAlong(rect, direction) {
  return (Math.abs(direction.x) * rect.w + Math.abs(direction.y) * rect.h) / 2;
}

export class ExpansionLayer {
  constructor({ onNeedsRender }) {
    this.entries = new Map();
    this.subModels = new Map();
    this.externalDocs = new Map();
    this.onNeedsRender = onNeedsRender;
  }

  isOpen(nodeId) {
    return this.entries.get(nodeId)?.targetOpen ?? false;
  }

  toggle(node) {
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

  invalidateSubModels() {
    this.subModels.clear();
  }

  watchesPath(path) {
    return this.externalDocs.has(path);
  }

  adoptExternalText(path, text) {
    const doc = parseFlow(text);
    FlowDoc.assignMissingIds(doc);
    this.externalDocs.set(path, { doc });
    this.subModels.clear();
    this.onNeedsRender();
  }

  progressOf(entry, now) {
    const elapsed = Math.min(1, (now - entry.startTime) / TOGGLE_DURATION_MS);
    const target = entry.targetOpen ? 1 : 0;
    return entry.startProgress + (target - entry.startProgress) * elapsed;
  }

  // Called from the canvas render loop each frame. Attaches `display` geometry to the model
  // (recursing into unfolded subgraphs) and reports whether any animation is still running.
  layout(model, now) {
    const display = { rects: new Map(), expansions: new Map() };
    model.display = display;
    let animating = false;

    for (const node of model.nodes) {
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

  expansionGeometry(node, subModel, eased) {
    const content = subModelBounds(subModel);
    const contentScale = Math.min(1, MAX_INNER_SIZE.w / content.w, MAX_INNER_SIZE.h / content.h);
    const targetW = Math.max(node.pos.w, content.w * contentScale + FRAME_PADDING * 2);
    const targetH = Math.max(node.pos.h, content.h * contentScale + FRAME_HEADER_HEIGHT + FRAME_PADDING);
    const center = rectCenter(node.pos);
    const frame = {
      w: lerp(node.pos.w, targetW, eased),
      h: lerp(node.pos.h, targetH, eased),
    };
    frame.x = center.x - frame.w / 2;
    frame.y = center.y - frame.h / 2;

    const inner = {
      x: frame.x + FRAME_PADDING,
      y: frame.y + FRAME_HEADER_HEIGHT,
      w: Math.max(1, frame.w - FRAME_PADDING * 2),
      h: Math.max(1, frame.h - FRAME_HEADER_HEIGHT - FRAME_PADDING),
    };
    const scale = Math.min(inner.w / content.w, inner.h / content.h);
    const transform = {
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
  applyWarp(model, display) {
    if (display.expansions.size === 0) return;
    for (const node of model.nodes) {
      if (!display.rects.has(node)) display.rects.set(node, { ...node.pos });
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

  applyRipple(model, display) {
    for (const [host, expansion] of display.expansions) {
      for (const node of model.nodes) {
        if (node === host || display.expansions.has(node)) continue;
        const rect = display.rects.get(node);
        const push = ripplePush(host.pos, expansion.frame, rect);
        rect.x += push.dx;
        rect.y += push.dy;
      }
    }
  }

  resolveSubModel(model, node) {
    const cached = this.subModels.get(node.id);
    if (cached) return cached;
    const expandValue = getProp(node, 'expand');
    const subModel = this.buildSubModel(model, expandValue);
    if (!subModel) return null;
    subModel.embedded = true;
    this.subModels.set(node.id, subModel);
    return subModel;
  }

  buildSubModel(model, expandValue) {
    const link = parseExpandLink(expandValue);
    if (!link) {
      if (!FlowDoc.graphBlockNames(model.sourceDoc).includes(expandValue)) {
        return withSource(emptyModel(), model.sourceDoc, model.sourcePath);
      }
      return withSource(FlowDoc.buildModel(model.sourceDoc, expandValue), model.sourceDoc, model.sourcePath);
    }
    const path = resolveLinkPath(model.sourcePath, link.path);
    const doc = this.externalDoc(path);
    if (!doc) return null;
    return withSource(FlowDoc.buildModel(doc, null), doc, path);
  }

  externalDoc(path) {
    const cached = this.externalDocs.get(path);
    if (cached) return cached.doc ?? null;
    this.externalDocs.set(path, { loading: true });
    fetch(`/api/file?path=${encodeURIComponent(path)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('not found');
        const { text } = await response.json();
        this.adoptExternalText(path, text);
      })
      .catch(() => this.externalDocs.set(path, { missing: true }));
    return null;
  }
}

function withSource(model, doc, path) {
  model.sourceDoc = doc;
  model.sourcePath = path;
  return model;
}

function emptyModel() {
  return { nodes: [], edges: [], ghosts: [], traits: new Map() };
}

function subModelBounds(subModel) {
  const rects = [
    ...subModel.nodes.map((node) => subModel.display?.rects.get(node) ?? node.pos),
    ...subModel.ghosts.map((ghost) => ghost.pos),
  ].filter(Boolean);
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
function ripplePush(hostBaseRect, frame, otherRect) {
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
function separateOverlaps(model, display) {
  const nodes = model.nodes;
  const isFrame = (node) => display.expansions.has(node);
  for (let iteration = 0; iteration < SEPARATION_ITERATIONS; iteration += 1) {
    let moved = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = display.rects.get(nodes[i]);
        const b = display.rects.get(nodes[j]);
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

function separationVector(a, b, margin) {
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

function pairMobility(aIsFrame, bIsFrame) {
  if (aIsFrame && bIsFrame) return [0.5, 0.5];
  if (aIsFrame) return [0, 1];
  if (bIsFrame) return [1, 0];
  return [0.5, 0.5];
}
