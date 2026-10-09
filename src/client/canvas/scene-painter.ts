// Draws a FlowModel onto a canvas in that model's own coordinates. The caller establishes the
// transform first, so nothing here knows about the camera, the viewport, the selection
// rectangle or any in-flight gesture — those are editing chrome and stay with the view.
//
// One painter is built per render pass from the values that pass should use, which is what
// lets an export draw the same scene with different settings (no hidden title, its own edge
// geometry) without the view mutating itself and putting it back.

// Resolved by the import map in index.html to the served copy of rough.esm.js.
import rough from 'roughjs';
import type { Options as RoughOptions } from 'roughjs/bin/core';
import type { ContextBlock, EdgeDataField, FlowNode, Rect } from '../../shared/flow-format.js';
import {
  displayRectOf,
  regionRectOf,
  type FlowModel,
  type GhostNode,
  type ModelEdge,
  type NodeTraits,
} from '../flow-doc.js';
import type { Point } from '../geometry.js';
import { unionRect } from '../../shared/rect-math.js';
import { canvasPalette, resolveLayerColor } from '../theme.js';
import type { HiddenCanvasTitles } from './canvas-view.js';
import type { Arrowhead, EdgeStyle, LineStyle } from '../../shared/canvas-edge-style.js';
import { edgeStyleIn } from '../model-visuals.js';
import { arrowheadIsFilled, arrowheadOutline, type ArrowheadOutline } from './arrowheads.js';
import { edgeEnd, edgePathApproach, edgePathDeparture, edgeStart, type EdgeGeometry } from './edge-path.js';
import {
  drawnShapeOf,
  edgeReachesInsideOpenFrame,
  layOutModelEdges,
  type EdgeBendOverrides,
  type EdgeGeometryMap,
} from './edge-layout.js';
import { STROKE_KIND, STROKE_LINE_WIDTHS, type CanvasDrawing } from '../../shared/canvas-drawings.js';
import type { DrawingTransform } from '../../shared/drawing-geometry.js';
import { storedDrawingKey } from './drawing-selection.js';
import type { ExpansionLayer, FrameExpansion } from './expansion.js';
import { drawingInkColor, inkStroke } from './stroke-painter.js';
import { inkText } from './text-painter.js';
import { canvasLineMeasurer, drawingAsCarried } from './text-drawing-layout.js';
import { BADGE_DIAMETER, BADGE_SYMBOLS, nodeBadges } from './node-badges.js';
import { outlinePathData, shapeOutline, shapeTextBox, type ShapeOutline } from './node-shapes.js';
import {
  DESCRIPTION_FIRST_LINE_NUDGE,
  DESCRIPTION_LINE_HEIGHT,
  FRAME_TITLE_LEFT,
  FRAME_TITLE_MIDDLE_Y,
  FRAME_TITLE_RIGHT_INSET,
  TITLE_LINE_HEIGHT,
  descriptionFont,
  frameTitleFont,
  handFontAt,
  layOutNodeText,
  regionLabelBand,
  titleFont,
} from './node-metrics.js';

type RoughCanvas = ReturnType<typeof rough.canvas>;

// How sketchy each element is relative to the workspace's base roughness, so one setting moves
// the whole canvas without flattening the differences between them.
const NODE_ROUGHNESS = 1.4;
const FRAME_ROUGHNESS = 1.1;
const EDGE_ROUGHNESS = 0.6;
const BADGE_ROUGHNESS = 0.9;
const REGION_ROUGHNESS = 0.7;

const REGION_DASH = [11, 7];
const REGION_HACHURE_GAP = 11;
// Hatch angle and dash phase are picked from the region's name, so two overlapping regions differ
// in a channel that is not colour and a region keeps its look across sessions and themes.
const REGION_HACHURE_ANGLES = [-70, -35, 20, 55];
const REGION_DASH_PHASES = 12;

function regionHachureAngle(seed: number): number {
  return REGION_HACHURE_ANGLES[seed % REGION_HACHURE_ANGLES.length];
}

const ARROWHEAD_TANGENT_BACKOFF = 12;
const ARROWHEAD_LINE_WIDTH = 1.6;
const EDGE_LINE_WIDTH = 1.5;
const EDGE_SELECTION_HALO_WIDTH = 9;
const EDGE_SELECTION_HALO_ALPHA = 0.32;

interface ArrowheadPlacement {
  kind: Arrowhead;
  fromPoint: Point;
  tip: Point;
}

function arrowheadPlacements(geometry: EdgeGeometry, style: EdgeStyle): ArrowheadPlacement[] {
  return [
    { kind: style.endHead, fromPoint: edgePathApproach(geometry.path, ARROWHEAD_TANGENT_BACKOFF), tip: edgeEnd(geometry) },
    { kind: style.startHead, fromPoint: edgePathDeparture(geometry.path, ARROWHEAD_TANGENT_BACKOFF), tip: edgeStart(geometry) },
  ];
}

// How each line style is stroked. Rough draws a line twice, and its two passes drift apart: that
// reads as sketchiness on a solid or dashed line, but smears dots, so a dotted line is drawn once.
// Edges are stroked with round caps, which is what makes a zero-length dash a true dot.
interface LineStroke {
  dash: number[];
  singlePass: boolean;
}

const EDGE_LINE_CAP: CanvasLineCap = 'round';
const LINE_STROKES: Record<LineStyle, LineStroke> = {
  solid: { dash: [], singlePass: false },
  dashed: { dash: [7, 5], singlePass: false },
  dotted: { dash: [0, 5], singlePass: true },
};
const EDGE_DATA_LINE_HEIGHT = 13;
const EDGE_DATA_GAP = 2;
// Below this the unfolded subgraph is not yet worth drawing, and the clip plus alpha cost more
// than the frame shows.
const MIN_SUBGRAPH_ALPHA = 0.02;

export interface ScenePainterOptions {
  ctx: CanvasRenderingContext2D;
  rough: RoughCanvas;
  baseRoughness: number;
  selectedEdges: readonly ModelEdge[];
  // The inline editors paint over these; drawing them again underneath would show through.
  hiddenTitles: HiddenCanvasTitles;
  edgeGeometry: EdgeGeometryMap;
  expansions: ExpansionLayer;
  // Where each region draws, when the caller has settled that itself. A node drag freezes every
  // region's frame at its start so dragging a member does not stretch the frame under the cursor
  // (R18); a resize in progress paints the drawn rectangle being dragged, not the union with
  // members that would otherwise stick the frame at their bounds. Everything else derives per pass.
  regionRects?: ReadonlyMap<ContextBlock, Rect>;
  // How each drawing a gesture is moving or resizing has been carried so far, in its own model's
  // units, keyed by `storedDrawingKey`. The layer is written only when the drag lands.
  drawingTransforms?: ReadonlyMap<string, DrawingTransform> | null;
  // The bend an edge being dragged would take, painted before anything is written.
  edgeBends?: EdgeBendOverrides | null;
}

function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0) % 2147483646 + 1;
}

export class ScenePainter {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rough: RoughCanvas;
  private readonly baseRoughness: number;
  private readonly selectedEdges: readonly ModelEdge[];
  private readonly hiddenTitles: HiddenCanvasTitles;
  private readonly edgeGeometry: EdgeGeometryMap;
  private readonly expansions: ExpansionLayer;
  private readonly regionRects: ReadonlyMap<ContextBlock, Rect> | null;
  private readonly drawingTransforms: ReadonlyMap<string, DrawingTransform> | null;
  private readonly edgeBends: EdgeBendOverrides | null;

  constructor(options: ScenePainterOptions) {
    this.ctx = options.ctx;
    this.rough = options.rough;
    this.baseRoughness = options.baseRoughness;
    this.selectedEdges = options.selectedEdges;
    this.hiddenTitles = options.hiddenTitles;
    this.edgeGeometry = options.edgeGeometry;
    this.expansions = options.expansions;
    this.regionRects = options.regionRects ?? null;
    this.drawingTransforms = options.drawingTransforms ?? null;
    this.edgeBends = options.edgeBends ?? null;
  }

  // Labels get their own pass after nodes so they stay readable even where an edge dives under
  // a node or an expanded frame. Edges that reach inside an open frame are drawn after nodes so
  // the frame fill does not occlude them (spec §5.7 expanded display).
  drawScene(model: FlowModel): void {
    // First, so a region sits behind everything in its own graph (R20). Recursing into drawScene
    // for an unfolded frame therefore places that file's regions above the host frame and below
    // the inner nodes (R20a) with no special casing.
    this.drawRegions(model);
    layOutModelEdges(model, this.edgeGeometry, this.edgeBends);
    const redirected: ModelEdge[] = [];
    for (const edge of model.edges) {
      if (edgeReachesInsideOpenFrame(model, edge)) redirected.push(edge);
      else this.drawEdge(model, edge);
    }
    for (const node of model.nodes) this.drawNode(model, node);
    for (const edge of redirected) this.drawEdge(model, edge);
    for (const edge of model.edges) this.drawEdgeLabel(edge);
    for (const ghost of model.ghosts) this.drawGhost(ghost, { clickable: !model.embedded });
    // Last, over the solid node fills: a circle or underline drawn around a node must stay as
    // visible once committed as it was under the pen.
    this.drawDrawings(model);
  }

  private drawDrawings(model: FlowModel): void {
    for (const stored of model.visuals?.drawings() ?? []) {
      const transform = this.drawingTransforms?.get(storedDrawingKey(model, stored.id));
      this.drawDrawing(transform ? drawingAsCarried(stored, transform, canvasLineMeasurer(this.ctx)) : stored);
    }
  }

  private drawDrawing(drawing: CanvasDrawing): void {
    const color = drawingInkColor(drawing.color);
    if (drawing.kind === STROKE_KIND) inkStroke(this.ctx, drawing.points, color, STROKE_LINE_WIDTHS[drawing.width]);
    else if (drawing.id !== this.hiddenTitles.drawingId) inkText(this.ctx, drawing, color);
  }

  // A region is an enclosure, not a container: hachure fill and a dashed outline, so it reads as
  // an area rather than as the solid-filled surface an expansion frame is (R47). Two regions
  // overlapping stay legible because each keeps its own hatch angle and dash phase (R24, R26) —
  // channels that survive one hue and a viewer who cannot separate colours.
  private drawRegions(model: FlowModel): void {
    for (const context of model.contexts) {
      const rect = this.regionRects?.get(context.block) ?? regionRectOf(model, context);
      // A block with neither an area nor members has no geometry, and the editor invents none (R23).
      if (!rect) continue;
      const seed = seedFrom(context.block.name);
      this.rough.rectangle(rect.x, rect.y, rect.w, rect.h, {
        seed,
        roughness: this.roughnessFor(REGION_ROUGHNESS),
        bowing: 0.6,
        stroke: canvasPalette.regionStroke,
        strokeWidth: 1.4,
        strokeLineDash: REGION_DASH,
        strokeLineDashOffset: seed % REGION_DASH_PHASES,
        fill: canvasPalette.regionFill,
        fillStyle: 'hachure',
        hachureAngle: regionHachureAngle(seed),
        hachureGap: REGION_HACHURE_GAP,
        fillWeight: 1,
      });
      this.drawRegionLabel(context.block.name, rect);
    }
  }

  private drawRegionLabel(name: string, rect: Rect): void {
    if (name === this.hiddenTitles.regionName) return;
    const { ctx } = this;
    const band = regionLabelBand(ctx, name, rect);
    ctx.font = frameTitleFont();
    ctx.fillStyle = canvasPalette.regionStroke;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, rect.x + FRAME_TITLE_LEFT, rect.y + FRAME_TITLE_MIDDLE_Y, band.w);
  }

  // The gesture overlay draws its own in-flight edge, so this primitive is shared with the view.
  // A head is always drawn solid, whatever dash its line has.
  drawArrowhead(kind: Arrowhead, fromPoint: Point, tip: Point, color: string): void {
    const outline = arrowheadOutline(kind, fromPoint, tip);
    if (!outline) return;
    const { ctx } = this;
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = ARROWHEAD_LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.traceArrowhead(outline);
    if (arrowheadIsFilled(outline)) ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private traceArrowhead(outline: ArrowheadOutline): void {
    this.ctx.beginPath();
    this.appendArrowheadOutline(outline);
  }

  private appendArrowheadOutline(outline: ArrowheadOutline): void {
    const { ctx } = this;
    if (outline.kind === 'circle') {
      // A fresh subpath, or the arc would be joined to wherever the path last ended.
      ctx.moveTo(outline.center.x + outline.radius, outline.center.y);
      ctx.arc(outline.center.x, outline.center.y, outline.radius, 0, Math.PI * 2);
      return;
    }
    const polylines = outline.kind === 'lines' ? outline.strokes : [outline.points];
    for (const points of polylines) {
      points.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
    }
    if (outline.kind === 'polygon') ctx.closePath();
  }

  private roughnessFor(elementRoughness: number): number {
    return elementRoughness * this.baseRoughness;
  }

  private titleIsHidden(node: FlowNode): boolean {
    return node.id != null && node.id === this.hiddenTitles.nodeId;
  }

  // The canvas layer's colour outranks the edge kind's default.
  private edgeColor(edge: ModelEdge, style: EdgeStyle): string {
    if (style.color) return resolveLayerColor(style.color);
    return edge.kind === 'error' ? canvasPalette.error : canvasPalette.edge;
  }

  private drawEdge(model: FlowModel, edge: ModelEdge): void {
    const geometry = this.edgeGeometry.get(edge);
    if (!geometry) return;
    const style = edgeStyleIn(model, edge);
    if (this.selectedEdges.includes(edge)) this.drawEdgeSelectionHalo(geometry, style);
    const color = this.edgeColor(edge, style);
    const lineStroke = LINE_STROKES[style.line];
    const options: RoughOptions = {
      seed: seedFrom(`${edge.from.name}->${edge.spec.target}:${edge.spec.label ?? ''}`),
      stroke: color,
      strokeWidth: EDGE_LINE_WIDTH,
      roughness: this.roughnessFor(EDGE_ROUGHNESS),
      bowing: 0.4,
      disableMultiStroke: lineStroke.singlePass,
    };
    if (lineStroke.dash.length > 0) options.strokeLineDash = lineStroke.dash;

    this.ctx.save();
    this.ctx.lineCap = EDGE_LINE_CAP;
    this.rough.curve(geometry.through.map((point) => [point.x, point.y] as [number, number]), options);
    this.ctx.restore();
    for (const head of arrowheadPlacements(geometry, style)) this.drawArrowhead(head.kind, head.fromPoint, head.tip, color);
  }

  // Painted under the edge rather than over it, so a selected edge still shows the colour, line
  // and heads it will be saved with. Smooth rather than rough: it marks where the edge is, not ink.
  private drawEdgeSelectionHalo(geometry: EdgeGeometry, style: EdgeStyle): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = EDGE_SELECTION_HALO_ALPHA;
    ctx.strokeStyle = canvasPalette.select;
    ctx.fillStyle = canvasPalette.select;
    ctx.lineWidth = EDGE_SELECTION_HALO_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    geometry.path.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
    for (const head of arrowheadPlacements(geometry, style)) {
      const outline = arrowheadOutline(head.kind, head.fromPoint, head.tip);
      if (outline) this.appendArrowheadOutline(outline);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawEdgeLabel(edge: ModelEdge): void {
    const geometry = this.edgeGeometry.get(edge);
    if (!geometry) return;
    const labelText = edge.spec.label ?? (edge.kind === 'error' ? 'on error' : null);
    const anchor = geometry.grip;
    const fields = edge.spec.data ?? [];

    const labelRect = labelText ? this.drawEdgeLabelPill(labelText, anchor, edge.kind === 'error') : null;
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
    ctx.font = handFontAt(12);
    const paddingX = 7;
    const rect = {
      x: anchor.x - ctx.measureText(text).width / 2 - paddingX,
      y: anchor.y - 11,
      w: ctx.measureText(text).width + paddingX * 2,
      h: 21,
    };
    ctx.fillStyle = canvasPalette.edgeLabelBg;
    this.roundedRect(rect, 7);
    ctx.fill();
    ctx.fillStyle = isError ? canvasPalette.error : canvasPalette.edgeLabel;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, anchor.x, anchor.y + 1);
    return rect;
  }

  // Each field paints as `key: type`, the key in label ink and the type muted, so the schema is
  // readable on the canvas without opening the edge editor.
  private drawEdgeDataFields(fields: EdgeDataField[], centerX: number, top: number): Rect {
    const { ctx } = this;
    ctx.font = handFontAt(10.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const keyTexts = fields.map((field) => (field.type ? `${field.key}:` : field.key));
    const lineWidths = fields.map((field, index) => ctx.measureText(`${keyTexts[index]} ${field.type}`).width);
    const paddingX = 6;
    const paddingY = 3;
    const rect = {
      x: centerX - Math.max(...lineWidths) / 2 - paddingX,
      y: top - paddingY,
      w: Math.max(...lineWidths) + paddingX * 2,
      h: fields.length * EDGE_DATA_LINE_HEIGHT + paddingY * 2,
    };
    ctx.fillStyle = canvasPalette.edgeLabelBg;
    this.roundedRect(rect, 6);
    ctx.fill();

    fields.forEach((field, index) => {
      const lineLeft = centerX - lineWidths[index] / 2;
      const lineMiddle = top + index * EDGE_DATA_LINE_HEIGHT + EDGE_DATA_LINE_HEIGHT / 2;
      ctx.fillStyle = canvasPalette.edgeLabel;
      ctx.fillText(keyTexts[index], lineLeft, lineMiddle);
      ctx.fillStyle = canvasPalette.muted;
      ctx.fillText(field.type, lineLeft + ctx.measureText(`${keyTexts[index]} `).width, lineMiddle);
    });
    return rect;
  }

  private roundedRect(rect: Rect, radius: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
  }

  private nodeStrokeColor(traits: NodeTraits | undefined): string {
    if (traits?.expand) return canvasPalette.expandStroke;
    if (traits?.decision) return canvasPalette.decisionStroke;
    if (traits?.entry) return canvasPalette.entryStroke;
    return canvasPalette.nodeStroke;
  }

  private drawNode(model: FlowModel, node: FlowNode): void {
    const expansion = model.display?.expansions.get(node);
    if (expansion) {
      this.drawExpandedNode(model, node, expansion);
      return;
    }

    const traits = model.traits.get(node);
    const rect = displayRectOf(model, node);
    const shape = drawnShapeOf(model, node);

    this.drawOutline(shapeOutline(shape, rect), {
      seed: seedFrom(node.id ?? node.name),
      roughness: this.roughnessFor(NODE_ROUGHNESS),
      bowing: 0.7,
      stroke: this.nodeStrokeColor(traits),
      strokeWidth: 1.6,
      fill: canvasPalette.nodeFill,
      fillStyle: 'solid',
    });

    const textBox = shapeTextBox(shape, rect);
    this.drawNodeText(model, node, textBox);
    this.drawTraitBadges(traits, textBox);
    this.drawExpandBadges(model, node);
  }

  // rough.js's own primitives where it has one; the rounded rectangle and the cylinder go
  // through their SVG path data.
  private drawOutline(outline: ShapeOutline, options: RoughOptions): void {
    if (outline.kind === 'ellipse') {
      this.rough.ellipse(outline.center.x, outline.center.y, outline.width, outline.height, options);
    } else if (outline.kind === 'polygon') {
      this.rough.polygon(outline.points.map((point) => [point.x, point.y] as [number, number]), options);
    } else if (outline.kind === 'rect' && outline.radius === 0) {
      this.rough.rectangle(outline.rect.x, outline.rect.y, outline.rect.w, outline.rect.h, options);
    } else {
      for (const path of outlinePathData(outline)) this.rough.path(path, options);
    }
  }

  private drawExpandedNode(model: FlowModel, node: FlowNode, expansion: FrameExpansion): void {
    const { ctx } = this;
    const { frame, inner, transform, subModel } = expansion;

    this.rough.rectangle(frame.x, frame.y, frame.w, frame.h, {
      seed: seedFrom(node.id ?? node.name),
      roughness: this.roughnessFor(FRAME_ROUGHNESS),
      bowing: 0.5,
      stroke: canvasPalette.expandStroke,
      strokeWidth: 1.6,
      fill: canvasPalette.nodeFill,
      fillStyle: 'solid',
    });

    if (!this.titleIsHidden(node)) {
      ctx.font = frameTitleFont();
      ctx.fillStyle = canvasPalette.expandStroke;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.name, frame.x + FRAME_TITLE_LEFT, frame.y + FRAME_TITLE_MIDDLE_Y, frame.w - FRAME_TITLE_RIGHT_INSET);
    }

    if (expansion.alpha > MIN_SUBGRAPH_ALPHA) {
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
    ctx.font = handFontAt(13);
    ctx.fillStyle = canvasPalette.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('empty subgraph', 160, 90);
  }

  private drawNodeText(model: FlowModel, node: FlowNode, rect: Rect): void {
    const { ctx } = this;
    const layout = layOutNodeText(ctx, node, rect, this.expansions.descriptionFor(node, model.sourcePath));
    const centerX = rect.x + rect.w / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    let lineY = layout.firstLineMiddleY;
    if (!this.titleIsHidden(node)) {
      ctx.font = titleFont();
      ctx.fillStyle = canvasPalette.ink;
      for (const line of layout.titleLines) {
        ctx.fillText(line, centerX, lineY, layout.maxWidth);
        lineY += TITLE_LINE_HEIGHT;
      }
    } else {
      lineY += layout.titleLines.length * TITLE_LINE_HEIGHT;
    }

    if (layout.descriptionLines.length) {
      lineY += DESCRIPTION_FIRST_LINE_NUDGE;
      ctx.font = descriptionFont();
      ctx.fillStyle = canvasPalette.muted;
      for (const line of layout.descriptionLines) {
        ctx.fillText(line, centerX, lineY, layout.maxWidth);
        lineY += DESCRIPTION_LINE_HEIGHT;
      }
    }
  }

  private drawTraitBadges(traits: NodeTraits | undefined, rect: Rect): void {
    const { ctx } = this;
    const { x, y, w, h } = rect;
    ctx.textBaseline = 'middle';

    if (traits?.entry) {
      ctx.font = handFontAt(11);
      ctx.fillStyle = canvasPalette.entryStroke;
      ctx.textAlign = 'left';
      ctx.fillText('▶', x + 8, y + 14);
    }
    if (traits?.hasErrorHandler) {
      ctx.font = handFontAt(12);
      ctx.fillStyle = canvasPalette.error;
      ctx.textAlign = 'right';
      ctx.fillText('⚠', x + w - 8, y + h - 12);
    }
    if (traits?.updates.length) {
      ctx.font = handFontAt(10.5);
      ctx.fillStyle = canvasPalette.updates;
      ctx.textAlign = 'left';
      ctx.fillText(`↺ ${traits.updates.join(', ')}`, x + 8, y + h - 12, w - 30);
    }
    this.drawContextMark(traits, rect);
  }

  // Membership is carried by the node itself, because containment cannot say it: a non-member may
  // overlap a region and a member of two regions can only sit inside one of them (R21, R24). The
  // suffix marks a member whose expansion inherits what it reads, which is otherwise invisible (R39).
  private drawContextMark(traits: NodeTraits | undefined, rect: Rect): void {
    if (!traits?.contexts.length) return;
    const { ctx } = this;
    const passesDown = traits.expand != null;
    ctx.font = handFontAt(10.5);
    ctx.fillStyle = canvasPalette.regionStroke;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `${traits.contexts.join(', ')} ◇${passesDown ? '↓' : ''}`,
      rect.x + rect.w - 8,
      rect.y + 14,
      rect.w - 30,
    );
  }

  private drawExpandBadges(model: FlowModel, node: FlowNode): void {
    const { ctx } = this;
    for (const badge of nodeBadges(model, node, this.expansions.isOpen(node.id))) {
      this.rough.circle(badge.x, badge.y, BADGE_DIAMETER, {
        seed: seedFrom(`${node.id}-${badge.kind}`),
        stroke: canvasPalette.expandStroke,
        strokeWidth: 1.3,
        roughness: this.roughnessFor(BADGE_ROUGHNESS),
      });
      ctx.font = handFontAt(12);
      ctx.fillStyle = canvasPalette.expandStroke;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(BADGE_SYMBOLS[badge.kind], badge.x, badge.y + 1);
    }
  }

  private drawGhost(ghost: GhostNode, { clickable = true }: { clickable?: boolean } = {}): void {
    const { ctx } = this;
    const { x, y, w, h } = ghost.pos;
    ctx.save();
    ctx.strokeStyle = canvasPalette.ghost;
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.3;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = handFontAt(14, 600);
    ctx.fillStyle = canvasPalette.ghost;
    ctx.fillText(ghost.name, x + w / 2, y + h / 2 - 8, w - 20);
    if (clickable) {
      ctx.font = handFontAt(10.5);
      ctx.fillText('click to create', x + w / 2, y + h / 2 + 14, w - 20);
    }
  }
}
