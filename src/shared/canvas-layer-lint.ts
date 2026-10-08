// Lints a .flow's canvas layer (`<file>.flow.canvas.json`). A layer is decoration, so nothing
// in it can be an error: a broken layer loads as an empty one and costs only looks. Warnings
// flag what was probably a mistake; entries whose node, edge or graph block no longer exists are
// reported as info, since any edit to the .flow made outside the editor leaves some behind.

import {
  documentIdentities,
  isLayerColor,
  isNodeShape,
  parseCanvasLayer,
  parseJsonObject,
  LAYER_COLOR_SLOTS,
  NODE_SHAPES,
} from './canvas-layer.js';
import {
  ARROWHEADS,
  LINE_STYLES,
  defaultEdgeStyle,
  isArrowhead,
  isLineStyle,
  readEdgeBend,
  type Arrowhead,
} from './canvas-edge-style.js';
import { STROKE_KIND, STROKE_WIDTHS, isStrokeWidth, strokePointsOf } from './canvas-drawings.js';
import { DRAWING_MEMBER_KIND, groupMembersOf, type Group } from './canvas-groups.js';
import { byLine, info, warning, type Diagnostic } from './flow-diagnostics.js';
import { parseFlow, type FlowDocument } from './flow-format.js';

const FIRST_LINE = 1;

const ARROWHEAD_DESCRIPTIONS: Record<Arrowhead, string> = {
  none: 'no head',
  arrow: 'an arrow',
  triangle: 'a triangle',
  diamond: 'a diamond',
  dot: 'a dot',
  bar: 'a bar',
};

// `flowText` is the paired .flow's text, or null when no .flow sits beside the layer.
export function lintCanvasLayer(layerText: string, flowText: string | null): Diagnostic[] {
  if (!parseJsonObject(layerText)) {
    return [warning('canvas-layer-unreadable', FIRST_LINE, 'The canvas layer is not a JSON object, so the editor ignores it and draws every node and edge in its default look.')];
  }
  const diagnostics: Diagnostic[] = [];
  if (flowText == null) {
    diagnostics.push(warning('canvas-layer-without-flow', FIRST_LINE, 'No .flow file sits beside this canvas layer, so nothing uses it. Delete it, or rename it with the .flow it belonged to.'));
  }
  const layer = parseCanvasLayer(layerText);
  const lineOf = (key: string) => lineOfKey(layerText, key);

  for (const [nodeId, visual] of Object.entries(layer.nodes)) {
    if (visual.shape !== undefined && !isNodeShape(visual.shape)) {
      diagnostics.push(warning('unknown-node-shape', lineOf(nodeId), `Unknown shape ${JSON.stringify(visual.shape)}; the node is drawn as a rectangle. Shapes: ${NODE_SHAPES.join(', ')}.`));
    }
  }
  for (const [edgeKey, visual] of Object.entries(layer.edges)) {
    diagnostics.push(...edgeVisualDiagnostics(visual, lineOf(edgeKey)));
  }

  const flow = flowText != null ? parseFlow(flowText) : null;
  diagnostics.push(...drawingDiagnostics(layerText, flow));
  diagnostics.push(...groupDiagnostics(layerText));
  if (flow) diagnostics.push(...staleEntries(layer.nodes, layer.edges, flow, lineOf));
  return diagnostics.sort(byLine);
}

function edgeVisualDiagnostics(visual: Record<string, unknown>, line: number): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (visual.color !== undefined && !isLayerColor(visual.color)) {
    diagnostics.push(warning('invalid-edge-color', line, `Invalid colour ${JSON.stringify(visual.color)}; the edge keeps its default colour. Use one of ${LAYER_COLOR_SLOTS.join(', ')}, or #rrggbb.`));
  }
  if (visual.line !== undefined && !isLineStyle(visual.line)) {
    diagnostics.push(warning('unknown-edge-line', line, `Unknown line ${JSON.stringify(visual.line)}; the edge keeps its default line. Lines: ${LINE_STYLES.join(', ')}.`));
  }
  const defaults = defaultEdgeStyle('flow');
  for (const [field, end] of [['startHead', 'start'], ['endHead', 'end']] as const) {
    if (visual[field] !== undefined && !isArrowhead(visual[field])) {
      const drawnAs = ARROWHEAD_DESCRIPTIONS[defaults[field]];
      diagnostics.push(warning('unknown-arrowhead', line, `Unknown ${end} head ${JSON.stringify(visual[field])}; the edge is drawn with ${drawnAs} there. Heads: ${ARROWHEADS.join(', ')}.`));
    }
  }
  if (visual.bend !== undefined && !readEdgeBend(visual.bend)) {
    diagnostics.push(warning('invalid-edge-bend', line, `Invalid bend ${JSON.stringify(visual.bend)}; the edge is drawn unbent. A bend is a pair of numbers, [along, across].`));
  }
  return diagnostics;
}

// Read from the raw JSON rather than the parsed layer, which already dropped what is broken.
function drawingDiagnostics(layerText: string, flow: FlowDocument | null): Diagnostic[] {
  const drawings = parseJsonObject(layerText)?.drawings;
  if (drawings === undefined) return [];
  const drawingsLine = lineOfKey(layerText, 'drawings');
  if (!Array.isArray(drawings)) {
    return [warning('invalid-drawings', drawingsLine, '`drawings` is not a list, so no drawing in it is shown. The editor keeps it as it is, and makes no drawing edits, until it is fixed.')];
  }
  const blockNames = flow ? graphBlockNamesOf(flow) : null;
  const seenIds = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  drawings.forEach((drawing: unknown, index) => {
    const line = lineOfDrawing(layerText, drawingsLine, index, drawing);
    if (typeof drawing !== 'object' || drawing == null || Array.isArray(drawing)) {
      diagnostics.push(warning('invalid-drawings', line, `Drawing ${index + 1} is not an object; the editor drops it on its next save.`));
      return;
    }
    const entry = drawing as Record<string, unknown>;
    if (typeof entry.id === 'string') {
      if (seenIds.has(entry.id)) diagnostics.push(warning('duplicate-drawing-id', line, `Another drawing already has id ${entry.id}; editing one of them edits both.`));
      seenIds.add(entry.id);
    }
    if (entry.kind === STROKE_KIND) diagnostics.push(...strokeDiagnostics(entry, line, blockNames));
  });
  return diagnostics;
}

// A group names its members by id, so it is checked against the drawings the layer holds.
function groupDiagnostics(layerText: string): Diagnostic[] {
  const raw = parseJsonObject(layerText);
  const groups = raw?.groups;
  if (groups === undefined) return [];
  const groupsLine = lineOfKey(layerText, 'groups');
  if (!Array.isArray(groups)) {
    return [warning('invalid-groups', groupsLine, '`groups` is not a list, so no group in it holds anything together. The editor keeps it as it is, and makes no drawing edits, until it is fixed.')];
  }
  const drawingIds = new Set(
    (Array.isArray(raw?.drawings) ? raw.drawings : []).flatMap((drawing: unknown) => {
      const id = typeof drawing === 'object' && drawing != null ? (drawing as Record<string, unknown>).id : undefined;
      return typeof id === 'string' ? [id] : [];
    }),
  );
  const diagnostics: Diagnostic[] = [];
  groups.forEach((group: unknown, index) => {
    const line = groupsLine + 1 + index;
    if (typeof group !== 'object' || group == null || Array.isArray(group)) {
      diagnostics.push(warning('invalid-groups', line, `Group ${index + 1} is not an object; the editor drops it on its next save.`));
      return;
    }
    if (!Array.isArray((group as Group).members)) {
      diagnostics.push(warning('invalid-groups', line, `Group ${index + 1} has no \`members\` list, so it holds nothing together. The editor keeps it as written.`));
      return;
    }
    const missing = groupMembersOf(group as Group)
      .filter((member) => member.kind === DRAWING_MEMBER_KIND && !drawingIds.has(member.id));
    for (const member of missing) {
      diagnostics.push(info('stale-group-member', line, `No drawing has id ${member.id} any more; the group no longer holds it.`));
    }
  });
  return diagnostics;
}

function strokeDiagnostics(stroke: Record<string, unknown>, line: number, blockNames: Set<string> | null): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (typeof stroke.id !== 'string' || stroke.id === '') {
    diagnostics.push(warning('invalid-stroke', line, 'This stroke has no `id`, so it is not drawn.'));
  }
  if (!strokePointsOf(stroke.points)) {
    diagnostics.push(warning('invalid-stroke', line, 'This stroke\'s `points` must be a non-empty list of [x, y] number pairs; it is not drawn.'));
  }
  if (stroke.graph !== undefined && typeof stroke.graph !== 'string') {
    diagnostics.push(warning('invalid-stroke', line, 'This stroke\'s `graph` must name a `graph:` block; it is not drawn.'));
  } else if (typeof stroke.graph === 'string' && blockNames && !blockNames.has(stroke.graph)) {
    diagnostics.push(info('unknown-drawing-graph', line, `No \`graph: ${stroke.graph}\` block is in the .flow any more; this stroke is never shown.`));
  }
  if (stroke.color !== undefined && !isLayerColor(stroke.color)) {
    diagnostics.push(warning('invalid-stroke-color', line, `Invalid colour ${JSON.stringify(stroke.color)}; the stroke is drawn in the default ink. Use one of ${LAYER_COLOR_SLOTS.join(', ')}, or #rrggbb.`));
  }
  if (stroke.width !== undefined && !isStrokeWidth(stroke.width)) {
    diagnostics.push(warning('unknown-stroke-width', line, `Unknown width ${JSON.stringify(stroke.width)}; the stroke is drawn medium. Widths: ${STROKE_WIDTHS.join(', ')}.`));
  }
  return diagnostics;
}

function graphBlockNamesOf(flow: FlowDocument): Set<string> {
  return new Set(flow.items.flatMap((item) => (item.kind === 'graph' ? [item.name] : [])));
}

function staleEntries(
  nodes: Record<string, unknown>,
  edges: Record<string, unknown>,
  flow: FlowDocument,
  lineOf: (key: string) => number,
): Diagnostic[] {
  const identities = documentIdentities(flow);
  const nodeIds = new Set(identities.nodeIds.values());
  const edgeKeys = new Set(identities.edgeKeys.values());
  const stale: Diagnostic[] = [];
  for (const nodeId of Object.keys(nodes)) {
    if (!nodeIds.has(nodeId)) {
      stale.push(info('stale-canvas-entry', lineOf(nodeId), `No node with id ${nodeId} is in the .flow any more; its visuals are unused.`));
    }
  }
  for (const edgeKey of Object.keys(edges)) {
    if (!edgeKeys.has(edgeKey)) {
      stale.push(info('stale-canvas-entry', lineOf(edgeKey), `No edge matches ${JSON.stringify(edgeKey)} any more; its visuals are unused.`));
    }
  }
  return stale;
}

// The line a key is written on, found by its JSON spelling; the first line when the key's text
// also appears earlier (it is reported, just less precisely).
function lineOfKey(text: string, key: string): number {
  const index = text.indexOf(`${JSON.stringify(key)}:`);
  if (index === -1) return FIRST_LINE;
  return lineAtIndex(text, index);
}

// A drawing is a value, not a key, so it is found by position: the editor writes one drawing per
// line after the `drawings` key. A hand-formatted file is searched for the drawing's id instead,
// and failing that the `drawings` key's own line is reported.
function lineOfDrawing(text: string, drawingsLine: number, index: number, drawing: unknown): number {
  const id = typeof drawing === 'object' && drawing != null ? (drawing as Record<string, unknown>).id : undefined;
  const positionalLine = drawingsLine + 1 + index;
  const lineText = text.split('\n')[positionalLine - 1] ?? '';
  if (typeof id !== 'string' || lineText.includes(JSON.stringify(id))) {
    return lineText.trim() === '' ? drawingsLine : positionalLine;
  }
  for (const spelling of [`"id":${JSON.stringify(id)}`, `"id": ${JSON.stringify(id)}`]) {
    const found = text.indexOf(spelling);
    if (found !== -1) return lineAtIndex(text, found);
  }
  return drawingsLine;
}

function lineAtIndex(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}
