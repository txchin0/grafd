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
import type { EdgeDataField, FlowNode, Rect } from '../../shared/flow-format.js';
import { displayRectOf, type FlowModel, type GhostNode, type ModelEdge, type NodeTraits } from '../flow-doc.js';
import { unionRect, type Point } from '../geometry.js';
import { canvasPalette } from '../theme.js';
import { edgeEnd, edgePathApproach, edgePathMidpoint } from './edge-path.js';
import { edgeReachesInsideOpenFrame, layOutModelEdges, type EdgeGeometryMap } from './edge-layout.js';
import type { ExpansionLayer, FrameExpansion } from './expansion.js';
import { BADGE_DIAMETER, BADGE_SYMBOLS, nodeBadges } from './node-badges.js';
import {
  DESCRIPTION_FIRST_LINE_NUDGE,
  DESCRIPTION_FONT,
  DESCRIPTION_LINE_HEIGHT,
  FRAME_TITLE_FONT,
  FRAME_TITLE_LEFT,
  FRAME_TITLE_MIDDLE_Y,
  FRAME_TITLE_RIGHT_INSET,
  HAND_FONT,
  TITLE_FONT,
  TITLE_LINE_HEIGHT,
  layOutNodeText,
} from './node-metrics.js';

type RoughCanvas = ReturnType<typeof rough.canvas>;

// How sketchy each element is relative to the workspace's base roughness, so one setting moves
// the whole canvas without flattening the differences between them.
const NODE_ROUGHNESS = 1.4;
const FRAME_ROUGHNESS = 1.1;
const EDGE_ROUGHNESS = 1.1;
const BADGE_ROUGHNESS = 0.9;

const ARROWHEAD_TANGENT_BACKOFF = 12;
const EDGE_DATA_LINE_HEIGHT = 13;
const EDGE_DATA_GAP = 2;
// Below this the unfolded subgraph is not yet worth drawing, and the clip plus alpha cost more
// than the frame shows.
const MIN_SUBGRAPH_ALPHA = 0.02;

export interface ScenePainterOptions {
  ctx: CanvasRenderingContext2D;
  rough: RoughCanvas;
  baseRoughness: number;
  selectedEdge: ModelEdge | null;
  // The node whose title the inline editor is painting itself; drawing it again underneath
  // would show through the overlay's background. An export passes null — it has no overlay,
  // and its output must always include every title.
  hiddenTitleNodeId: string | null;
  edgeGeometry: EdgeGeometryMap;
  expansions: ExpansionLayer;
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
  private readonly selectedEdge: ModelEdge | null;
  private readonly hiddenTitleNodeId: string | null;
  private readonly edgeGeometry: EdgeGeometryMap;
  private readonly expansions: ExpansionLayer;

  constructor(options: ScenePainterOptions) {
    this.ctx = options.ctx;
    this.rough = options.rough;
    this.baseRoughness = options.baseRoughness;
    this.selectedEdge = options.selectedEdge;
    this.hiddenTitleNodeId = options.hiddenTitleNodeId;
    this.edgeGeometry = options.edgeGeometry;
    this.expansions = options.expansions;
  }

  // Labels get their own pass after nodes so they stay readable even where an edge dives under
  // a node or an expanded frame. Edges that reach inside an open frame are drawn after nodes so
  // the frame fill does not occlude them (spec §5.7 expanded display).
  drawScene(model: FlowModel): void {
    layOutModelEdges(model, this.edgeGeometry);
    const redirected: ModelEdge[] = [];
    for (const edge of model.edges) {
      if (edgeReachesInsideOpenFrame(model, edge)) redirected.push(edge);
      else this.drawEdge(edge);
    }
    for (const node of model.nodes) this.drawNode(model, node);
    for (const edge of redirected) this.drawEdge(edge);
    for (const edge of model.edges) this.drawEdgeLabel(edge);
    for (const ghost of model.ghosts) this.drawGhost(ghost, { clickable: !model.embedded });
  }

  // The gesture overlay draws its own in-flight edge, so this primitive is shared with the view.
  drawArrowhead(fromPoint: Point, tip: Point, color: string): void {
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

  private roughnessFor(elementRoughness: number): number {
    return elementRoughness * this.baseRoughness;
  }

  private titleIsHidden(node: FlowNode): boolean {
    return node.id != null && node.id === this.hiddenTitleNodeId;
  }

  private edgeColor(edge: ModelEdge): string {
    if (edge === this.selectedEdge) return canvasPalette.select;
    return edge.kind === 'error' ? canvasPalette.error : canvasPalette.edge;
  }

  private drawEdge(edge: ModelEdge): void {
    const geometry = this.edgeGeometry.get(edge);
    if (!geometry) return;
    const color = this.edgeColor(edge);
    const options: RoughOptions = {
      seed: seedFrom(`${edge.from.name}->${edge.spec.target}:${edge.spec.label ?? ''}`),
      stroke: color,
      strokeWidth: edge === this.selectedEdge ? 2.2 : 1.5,
      roughness: this.roughnessFor(EDGE_ROUGHNESS),
      bowing: 0.4,
    };
    if (edge.kind === 'error') options.strokeLineDash = [7, 5];

    this.rough.curve(geometry.through.map((point) => [point.x, point.y] as [number, number]), options);
    this.drawArrowhead(edgePathApproach(geometry.path, ARROWHEAD_TANGENT_BACKOFF), edgeEnd(geometry), color);
  }

  private drawEdgeLabel(edge: ModelEdge): void {
    const geometry = this.edgeGeometry.get(edge);
    if (!geometry) return;
    const labelText = edge.spec.label ?? (edge.kind === 'error' ? 'on error' : null);
    const anchor = edgePathMidpoint(geometry.path);
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
    ctx.font = `12px ${HAND_FONT}`;
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
    ctx.font = `10.5px ${HAND_FONT}`;
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

    this.rough.rectangle(rect.x, rect.y, rect.w, rect.h, {
      seed: seedFrom(node.id ?? node.name),
      roughness: this.roughnessFor(NODE_ROUGHNESS),
      bowing: 0.7,
      stroke: this.nodeStrokeColor(traits),
      strokeWidth: 1.6,
      fill: canvasPalette.nodeFill,
      fillStyle: 'solid',
    });

    this.drawNodeText(model, node, rect);
    this.drawTraitBadges(traits, rect);
    this.drawExpandBadges(model, node);
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
      ctx.font = FRAME_TITLE_FONT;
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
    ctx.font = `13px ${HAND_FONT}`;
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
      ctx.font = TITLE_FONT;
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
      ctx.font = DESCRIPTION_FONT;
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
      ctx.font = `11px ${HAND_FONT}`;
      ctx.fillStyle = canvasPalette.entryStroke;
      ctx.textAlign = 'left';
      ctx.fillText('▶', x + 8, y + 14);
    }
    if (traits?.hasErrorHandler) {
      ctx.font = `12px ${HAND_FONT}`;
      ctx.fillStyle = canvasPalette.error;
      ctx.textAlign = 'right';
      ctx.fillText('⚠', x + w - 8, y + h - 12);
    }
    if (traits?.updates.length) {
      ctx.font = `10.5px ${HAND_FONT}`;
      ctx.fillStyle = canvasPalette.updates;
      ctx.textAlign = 'left';
      ctx.fillText(`↺ ${traits.updates.join(', ')}`, x + 8, y + h - 12, w - 30);
    }
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
      ctx.font = `12px ${HAND_FONT}`;
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
    ctx.font = `600 14px ${HAND_FONT}`;
    ctx.fillStyle = canvasPalette.ghost;
    ctx.fillText(ghost.name, x + w / 2, y + h / 2 - 8, w - 20);
    if (clickable) {
      ctx.font = `10.5px ${HAND_FONT}`;
      ctx.fillText('click to create', x + w / 2, y + h / 2 + 14, w - 20);
    }
  }
}
