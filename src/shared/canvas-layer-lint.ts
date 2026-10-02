// Lints a .flow's canvas layer (`<file>.flow.canvas.json`). A layer is decoration, so nothing
// in it can be an error: a broken layer loads as an empty one and costs only looks. Warnings
// flag what was probably a mistake; entries whose node or edge no longer exists are reported as
// info, since any edit to the .flow made outside the editor leaves some behind.

import {
  documentIdentities,
  isEdgeColor,
  isNodeShape,
  parseCanvasLayer,
  parseJsonObject,
  EDGE_COLOR_SLOTS,
  NODE_SHAPES,
} from './canvas-layer.js';
import { byLine, info, warning, type Diagnostic } from './flow-diagnostics.js';
import { parseFlow } from './flow-format.js';

const FIRST_LINE = 1;

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
    if (visual.color !== undefined && !isEdgeColor(visual.color)) {
      diagnostics.push(warning('invalid-edge-color', lineOf(edgeKey), `Invalid colour ${JSON.stringify(visual.color)}; the edge keeps its default colour. Use one of ${EDGE_COLOR_SLOTS.join(', ')}, or #rrggbb.`));
    }
  }

  if (flowText != null) diagnostics.push(...staleEntries(layer.nodes, layer.edges, flowText, lineOf));
  return diagnostics.sort(byLine);
}

function staleEntries(
  nodes: Record<string, unknown>,
  edges: Record<string, unknown>,
  flowText: string,
  lineOf: (key: string) => number,
): Diagnostic[] {
  const identities = documentIdentities(parseFlow(flowText));
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
  return text.slice(0, index).split('\n').length;
}
