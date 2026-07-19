// Canvas rendering (rough.js) and pointer interaction for the flow editor. The view owns
// the pan/zoom transform, hover/selection state, and in-flight gestures; every document
// mutation is delegated to the `actions` callbacks supplied by main.js.

import rough from '/vendor/roughjs/rough.esm.js';

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
const MIN_NODE_WIDTH = 120;
const MIN_NODE_HEIGHT = 64;
const DRAG_THRESHOLD_PX = 4;
const SNAP = 8;
const PORT_RADIUS = 5;
const PORT_HIT_RADIUS = 11;
const EDGE_HIT_DISTANCE = 8;

function snap(value) {
  return Math.round(value / SNAP) * SNAP;
}

function seedFrom(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0) % 2147483646 + 1;
}

function rectCenter(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function rectContains(rect, point) {
  return (
    point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h
  );
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function normalizedRect(pointA, pointB) {
  return {
    x: Math.min(pointA.x, pointB.x),
    y: Math.min(pointA.y, pointB.y),
    w: Math.abs(pointA.x - pointB.x),
    h: Math.abs(pointA.y - pointB.y),
  };
}

function rectBorderPointToward(rect, towardPoint) {
  const center = rectCenter(rect);
  const dx = towardPoint.x - center.x;
  const dy = towardPoint.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const scaleX = dx === 0 ? Infinity : (rect.w / 2) / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : (rect.h / 2) / Math.abs(dy);
  const t = Math.min(scaleX, scaleY);
  return { x: center.x + dx * t, y: center.y + dy * t };
}

function distanceToSegment(point, a, b) {
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
  constructor(canvasElement, actions) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.rough = rough.canvas(canvasElement);
    this.actions = actions;

    this.view = { x: 0, y: 0, scale: 1 };
    this.model = { nodes: [], edges: [], ghosts: [], traits: new Map() };
    this.selection = new Set();
    this.selectedEdge = null;
    this.hoverNode = null;
    this.hoverPoint = null;
    this.gesture = null;
    this.spaceDown = false;
    this.devicePixelRatio = window.devicePixelRatio || 1;
    this.renderQueued = false;

    this.bindEvents();
    this.syncCanvasSize();
  }

  bindEvents() {
    const resizeObserver = new ResizeObserver(() => this.syncCanvasSize());
    resizeObserver.observe(this.canvas.parentElement);

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
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

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

  syncCanvasSize() {
    const bounds = this.canvas.getBoundingClientRect();
    this.devicePixelRatio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(bounds.width * this.devicePixelRatio));
    this.canvas.height = Math.max(1, Math.round(bounds.height * this.devicePixelRatio));
    this.requestRender();
  }

  setModel(model) {
    const selectedIds = new Set([...this.selection].map((node) => node.id));
    const selectedEdgeSpec = this.selectedEdge?.spec ?? null;

    this.model = model;
    this.selection = new Set(model.nodes.filter((node) => selectedIds.has(node.id)));
    this.selectedEdge = model.edges.find((edge) => edge.spec === selectedEdgeSpec) ?? null;
    if (this.hoverNode) {
      this.hoverNode = model.nodes.find((node) => node.id === this.hoverNode.id) ?? null;
    }
    this.requestRender();
  }

  select(node) {
    this.selection = new Set([node]);
    this.selectedEdge = null;
    this.requestRender();
  }

  clearSelection() {
    this.selection.clear();
    this.selectedEdge = null;
    this.requestRender();
  }

  worldToScreen(point) {
    return { x: point.x * this.view.scale + this.view.x, y: point.y * this.view.scale + this.view.y };
  }

  screenToWorld(point) {
    return { x: (point.x - this.view.x) / this.view.scale, y: (point.y - this.view.y) / this.view.scale };
  }

  worldRectToScreen(rect) {
    const topLeft = this.worldToScreen(rect);
    return { x: topLeft.x, y: topLeft.y, w: rect.w * this.view.scale, h: rect.h * this.view.scale };
  }

  eventPoint(event) {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  zoomAt(screenPoint, factor) {
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.view.scale * factor));
    const appliedFactor = newScale / this.view.scale;
    this.view.x = screenPoint.x - (screenPoint.x - this.view.x) * appliedFactor;
    this.view.y = screenPoint.y - (screenPoint.y - this.view.y) * appliedFactor;
    this.view.scale = newScale;
    this.requestRender();
    this.actions.viewChanged?.();
  }

  setZoom(scale) {
    const bounds = this.canvas.getBoundingClientRect();
    this.zoomAt({ x: bounds.width / 2, y: bounds.height / 2 }, scale / this.view.scale);
  }

  fitToContent(padding = 80) {
    const rects = [...this.model.nodes, ...this.model.ghosts]
      .map((node) => node.pos)
      .filter(Boolean);
    const bounds = this.canvas.getBoundingClientRect();
    if (rects.length === 0) {
      this.view = { x: bounds.width / 2 - 200, y: bounds.height / 2 - 150, scale: 1 };
      this.requestRender();
      this.actions.viewChanged?.();
      return;
    }
    const minX = Math.min(...rects.map((rect) => rect.x)) - padding;
    const minY = Math.min(...rects.map((rect) => rect.y)) - padding;
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.w)) + padding;
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.h)) + padding;
    const scale = Math.min(bounds.width / (maxX - minX), bounds.height / (maxY - minY), 1.4);
    this.view.scale = Math.max(MIN_SCALE, scale);
    this.view.x = (bounds.width - (maxX - minX) * this.view.scale) / 2 - minX * this.view.scale;
    this.view.y = (bounds.height - (maxY - minY) * this.view.scale) / 2 - minY * this.view.scale;
    this.requestRender();
    this.actions.viewChanged?.();
  }

  onWheel(event) {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.008 : 0.0016));
    this.zoomAt(this.eventPoint(event), factor);
  }

  onPointerDown(event) {
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
      this.gesture = { type: 'edge', from: port.node, toWorld: world, hoverTarget: null };
      return;
    }

    const handle = this.hitResizeHandle(world);
    if (handle) {
      this.gesture = {
        type: 'resize',
        node: handle.node,
        corner: handle.corner,
        startRect: { ...handle.node.pos },
        startWorld: world,
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
        startPositions: new Map([...this.selection].map((n) => [n, { x: n.pos.x, y: n.pos.y }])),
        startWorld: world,
        startScreen: screen,
        moved: false,
        pressedNode: node,
        pressedBadge: this.hitExpandBadge(node, world),
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
    this.gesture = event.shiftKey
      ? { type: 'marquee', startWorld: world, rect: null }
      : { type: 'create', startWorld: world, startScreen: screen, rect: null };
    this.requestRender();
  }

  onPointerMove(event) {
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
        const start = gesture.startPositions.get(node);
        node.pos.x = snap(start.x + dx);
        node.pos.y = snap(start.y + dy);
      }
      this.requestRender();
      this.actions.viewChanged?.();
    } else if (gesture.type === 'resize') {
      this.applyResize(gesture, world);
      this.requestRender();
      this.actions.viewChanged?.();
    } else if (gesture.type === 'edge') {
      gesture.toWorld = world;
      const target = this.hitNode(world);
      gesture.hoverTarget = target !== gesture.from ? target : null;
      this.requestRender();
    } else if (gesture.type === 'create' || gesture.type === 'marquee') {
      gesture.rect = normalizedRect(gesture.startWorld, world);
      this.requestRender();
    }
  }

  applyResize(gesture, world) {
    const dx = world.x - gesture.startWorld.x;
    const dy = world.y - gesture.startWorld.y;
    const start = gesture.startRect;
    const rect = gesture.node.pos;
    const [vertical, horizontal] = gesture.corner;

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

  onPointerUp(event) {
    const gesture = this.gesture;
    this.gesture = null;
    this.updateCursor();
    if (!gesture) return;

    const screen = this.eventPoint(event);
    const world = this.screenToWorld(screen);

    if (gesture.type === 'move') {
      if (gesture.moved) {
        this.actions.moveCommitted();
      } else if (gesture.pressedBadge && this.hitExpandBadge(gesture.pressedNode, world)) {
        this.actions.openExpand(gesture.pressedNode);
      } else {
        this.actions.nodeClicked(gesture.pressedNode);
      }
    } else if (gesture.type === 'resize') {
      this.actions.moveCommitted();
    } else if (gesture.type === 'edge') {
      const target = this.hitNode(world);
      this.actions.completeEdge(gesture.from, target !== gesture.from ? target : null, world, {
        droppedOnSource: target === gesture.from,
        ghostTarget: this.hitGhost(world),
      });
    } else if (gesture.type === 'create') {
      const bigEnoughOnScreen =
        gesture.rect &&
        gesture.rect.w * this.view.scale > 14 &&
        gesture.rect.h * this.view.scale > 10;
      if (bigEnoughOnScreen) {
        this.actions.createNode(this.snapCreateRect(gesture.rect));
      }
    } else if (gesture.type === 'marquee' && gesture.rect) {
      for (const node of this.model.nodes) {
        if (rectsIntersect(gesture.rect, node.pos)) this.selection.add(node);
      }
    }
    this.requestRender();
  }

  snapCreateRect(rect) {
    return {
      x: snap(rect.x),
      y: snap(rect.y),
      w: Math.max(MIN_NODE_WIDTH, snap(rect.w)),
      h: Math.max(MIN_NODE_HEIGHT, snap(rect.h)),
    };
  }

  onDoubleClick(event) {
    const world = this.screenToWorld(this.eventPoint(event));
    if (this.hitNode(world) || this.hitGhost(world)) return;
    const edge = this.hitEdge(world);
    if (edge) {
      this.selectedEdge = edge;
      this.actions.editEdge(edge);
      this.requestRender();
      return;
    }
    this.actions.quickCreateNode(world);
  }

  hitNode(world) {
    for (let index = this.model.nodes.length - 1; index >= 0; index -= 1) {
      const node = this.model.nodes[index];
      if (rectContains(node.pos, world)) return node;
    }
    return null;
  }

  hitGhost(world) {
    return this.model.ghosts.find((ghost) => rectContains(ghost.pos, world)) ?? null;
  }

  portPositions(node) {
    const { x, y, w, h } = node.pos;
    return [
      { x: x + w / 2, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w / 2, y: y + h },
      { x, y: y + h / 2 },
    ];
  }

  hitPort(world) {
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

  hitResizeHandle(world) {
    if (this.selection.size !== 1) return null;
    const [node] = this.selection;
    const hitRadius = 9 / this.view.scale;
    const { x, y, w, h } = node.pos;
    const corners = [
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

  expandBadgeCenter(node) {
    return { x: node.pos.x + node.pos.w - 16, y: node.pos.y + 15 };
  }

  hitExpandBadge(node, world) {
    if (!this.model.traits.get(node)?.expand) return false;
    const center = this.expandBadgeCenter(node);
    return Math.hypot(world.x - center.x, world.y - center.y) <= 12 / Math.min(this.view.scale, 1);
  }

  hitEdge(world) {
    const hitDistance = EDGE_HIT_DISTANCE / this.view.scale;
    for (const edge of this.model.edges) {
      const geometry = edge.geometry;
      if (!geometry) continue;
      if (geometry.labelRect && rectContains(geometry.labelRect, world)) return edge;
      if (distanceToSegment(world, geometry.a, geometry.b) <= hitDistance) return edge;
    }
    return null;
  }

  updateCursor(world) {
    let cursor = 'default';
    if (this.spaceDown || this.gesture?.type === 'pan') cursor = 'grab';
    else if (world) {
      if (this.hitPort(world)) cursor = 'crosshair';
      else if (this.hitResizeHandle(world)) cursor = 'nwse-resize';
      else if (this.hitNode(world) || this.hitGhost(world)) cursor = 'move';
    }
    this.canvas.style.cursor = cursor;
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  render() {
    const { ctx } = this;
    const dpr = this.devicePixelRatio;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawGrid();

    const { x, y, scale } = this.view;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);

    this.computeEdgeGeometry();
    for (const edge of this.model.edges) this.drawEdge(edge);
    for (const node of this.model.nodes) this.drawNode(node);
    for (const ghost of this.model.ghosts) this.drawGhost(ghost);
    this.drawSelectionDecorations();
    this.drawPorts();
    this.drawGestureOverlay();

    this.actions.afterRender?.();
  }

  drawGrid() {
    const { ctx } = this;
    const spacing = 32 * this.view.scale;
    if (spacing < 9) return;
    const bounds = this.canvas.getBoundingClientRect();
    ctx.fillStyle = COLORS.grid;
    const offsetX = ((this.view.x % spacing) + spacing) % spacing;
    const offsetY = ((this.view.y % spacing) + spacing) % spacing;
    for (let gridX = offsetX; gridX < bounds.width; gridX += spacing) {
      for (let gridY = offsetY; gridY < bounds.height; gridY += spacing) {
        ctx.fillRect(gridX - 0.75, gridY - 0.75, 1.5, 1.5);
      }
    }
  }

  computeEdgeGeometry() {
    const pairCounts = new Map();
    for (const edge of this.model.edges) {
      if (!edge.to?.pos || !edge.from?.pos) {
        edge.geometry = null;
        continue;
      }
      if (edge.to === edge.from) {
        edge.geometry = this.selfLoopGeometry(edge.from);
        continue;
      }
      const pairKey = [edge.from.name, edge.to.name].sort().join(' ');
      const occurrence = pairCounts.get(pairKey) ?? 0;
      pairCounts.set(pairKey, occurrence + 1);

      const a = rectBorderPointToward(edge.from.pos, rectCenter(edge.to.pos));
      const b = rectBorderPointToward(edge.to.pos, rectCenter(edge.from.pos));
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

  selfLoopGeometry(node) {
    const { x, y, w } = node.pos;
    const a = { x: x + w - 30, y };
    const b = { x: x + w, y: y + 24 };
    const mid = { x: x + w + 42, y: y - 40 };
    return { a, b, mid, labelRect: null, selfLoop: true };
  }

  edgeColor(edge) {
    if (edge === this.selectedEdge) return COLORS.select;
    return edge.kind === 'error' ? COLORS.error : COLORS.edge;
  }

  drawEdge(edge) {
    const geometry = edge.geometry;
    if (!geometry) return;
    const { ctx } = this;
    const color = this.edgeColor(edge);
    const seed = seedFrom(`${edge.from.name}->${edge.spec.target}:${edge.spec.label ?? ''}`);
    const options = {
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

    const labelText = edge.spec.label ?? (edge.kind === 'error' ? 'on error' : null);
    const labelAnchor = geometry.selfLoop
      ? { x: geometry.mid.x, y: geometry.mid.y }
      : { x: (geometry.a.x + geometry.b.x) / 2 + (geometry.mid.x - (geometry.a.x + geometry.b.x) / 2) * 0.85,
          y: (geometry.a.y + geometry.b.y) / 2 + (geometry.mid.y - (geometry.a.y + geometry.b.y) / 2) * 0.85 };

    if (labelText) {
      ctx.font = `12px ${HAND_FONT}`;
      const textWidth = ctx.measureText(labelText).width;
      const paddingX = 7;
      const labelRect = {
        x: labelAnchor.x - textWidth / 2 - paddingX,
        y: labelAnchor.y - 11,
        w: textWidth + paddingX * 2,
        h: 21,
      };
      ctx.fillStyle = COLORS.edgeLabelBg;
      this.roundedRect(labelRect, 7);
      ctx.fill();
      ctx.fillStyle = edge.kind === 'error' ? COLORS.error : COLORS.edgeLabel;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, labelAnchor.x, labelAnchor.y + 1);
      geometry.labelRect = labelRect;

      if (edge.spec.data?.length) {
        ctx.font = `10.5px ${HAND_FONT}`;
        ctx.fillStyle = COLORS.muted;
        ctx.fillText(`⧉ ${edge.spec.data.length} fields`, labelAnchor.x, labelAnchor.y + 20);
      }
    } else if (edge.spec.data?.length) {
      ctx.font = `10.5px ${HAND_FONT}`;
      ctx.fillStyle = COLORS.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`⧉ ${edge.spec.data.length} fields`, labelAnchor.x, labelAnchor.y);
    }
  }

  drawArrowhead(fromPoint, tip, color) {
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

  roundedRect(rect, radius) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
  }

  nodeStrokeColor(node, traits) {
    if (traits?.expand) return COLORS.expandStroke;
    if (traits?.decision) return COLORS.decisionStroke;
    if (traits?.entry) return COLORS.entryStroke;
    return COLORS.nodeStroke;
  }

  drawNode(node) {
    const traits = this.model.traits.get(node);
    const { x, y, w, h } = node.pos;
    const stroke = this.nodeStrokeColor(node, traits);

    this.rough.rectangle(x, y, w, h, {
      seed: seedFrom(node.id ?? node.name),
      roughness: 1.4,
      bowing: 0.7,
      stroke,
      strokeWidth: 1.6,
      fill: COLORS.nodeFill,
      fillStyle: 'solid',
    });

    this.drawNodeText(node);
    this.drawNodeBadges(node, traits, stroke);
  }

  drawNodeText(node) {
    const { ctx } = this;
    const { x, y, w, h } = node.pos;
    const maxWidth = w - 26;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = `600 15px ${HAND_FONT}`;
    const titleLines = this.wrapText(node.name, maxWidth, 2);
    const description = unquotedDescription(node);
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

  wrapText(text, maxWidth, maxLines) {
    if (maxLines <= 0) return [];
    const { ctx } = this;
    const words = text.split(' ');
    const lines = [];
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

  drawNodeBadges(node, traits, stroke) {
    const { ctx } = this;
    const { x, y, w, h } = node.pos;
    ctx.textBaseline = 'middle';

    if (traits?.entry) {
      ctx.font = `11px ${HAND_FONT}`;
      ctx.fillStyle = COLORS.entryStroke;
      ctx.textAlign = 'left';
      ctx.fillText('▶', x + 8, y + 14);
    }
    if (traits?.expand) {
      const center = this.expandBadgeCenter(node);
      this.rough.circle(center.x, center.y, 20, {
        seed: seedFrom(`${node.id}-expand`),
        stroke: COLORS.expandStroke,
        strokeWidth: 1.3,
        roughness: 0.9,
      });
      ctx.font = `12px ${HAND_FONT}`;
      ctx.fillStyle = COLORS.expandStroke;
      ctx.textAlign = 'center';
      ctx.fillText('⤢', center.x, center.y + 1);
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

  drawGhost(ghost) {
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
    ctx.font = `10.5px ${HAND_FONT}`;
    ctx.fillText('click to create', x + w / 2, y + h / 2 + 14, w - 20);
  }

  drawSelectionDecorations() {
    const { ctx } = this;
    const inflate = 5;
    ctx.save();
    ctx.strokeStyle = COLORS.select;
    ctx.lineWidth = 1.4 / this.view.scale;
    ctx.setLineDash([6 / this.view.scale, 4 / this.view.scale]);
    for (const node of this.selection) {
      const { x, y, w, h } = node.pos;
      ctx.strokeRect(x - inflate, y - inflate, w + inflate * 2, h + inflate * 2);
    }
    ctx.restore();

    if (this.selection.size === 1) {
      const [node] = this.selection;
      const handleSize = 8 / this.view.scale;
      const { x, y, w, h } = node.pos;
      ctx.fillStyle = COLORS.select;
      for (const corner of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
        ctx.fillRect(corner[0] - handleSize / 2, corner[1] - handleSize / 2, handleSize, handleSize);
      }
    }
  }

  drawPorts() {
    if (this.gesture && this.gesture.type !== 'edge') return;
    const { ctx } = this;
    const nodesWithPorts = new Set([...this.selection]);
    if (this.hoverNode) nodesWithPorts.add(this.hoverNode);
    const radius = PORT_RADIUS / Math.min(this.view.scale, 1.2);
    for (const node of nodesWithPorts) {
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

  drawGestureOverlay() {
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
      const start = rectBorderPointToward(gesture.from.pos, gesture.toWorld);
      const end = gesture.hoverTarget
        ? rectBorderPointToward(gesture.hoverTarget.pos, rectCenter(gesture.from.pos))
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
        const { x, y, w, h } = gesture.hoverTarget.pos;
        ctx.strokeStyle = COLORS.select;
        ctx.lineWidth = 2 / this.view.scale;
        ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
      }
    }
  }
}

function isTypingTarget(element) {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function unquotedDescription(node) {
  const raw = node.props.find((prop) => prop.key === 'description')?.value;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}
