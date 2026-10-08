// A workspace's canvas layer: everything about how a graph looks that is not layout. Each
// `<file>.flow` may have a `<file>.flow.canvas.json` beside it holding per-node and per-edge
// visuals and the free drawings made over it. It is editor-owned and purely cosmetic: losing it costs
// decoration, never meaning or layout, which is why it may live outside the .flow file when
// `id` and `pos` may not (FLOW-SPEC.md §2.1).
//
// Node visuals are keyed by the node's `id`. Edges have no id, so an edge is keyed by what it
// says — its source's id, its target (by id when the target resolves in its scope, so renaming
// the target never breaks the key), its `{Inner}` refinements and its label. The editor moves
// entries when its own edits change a key; an edit made outside the editor orphans them.
// Drawings are filed by the graph scope they were drawn in (canvas-drawings.ts), and groups hold
// things that are picked up as one (canvas-groups.ts).

import {
  serializeEdgeExpression,
  type EdgeSpec,
  type FlowDocument,
  type FlowItem,
  type FlowNode,
  type GraphItem,
} from './flow-format.js';
import { pruneGroups, type Group } from './canvas-groups.js';

export const CANVAS_LAYER_FORMAT = 'grafd-canvas/1';
export const CANVAS_LAYER_SUFFIX = '.canvas.json';

export const NODE_SHAPES = ['rectangle', 'rounded', 'ellipse', 'diamond', 'hexagon', 'parallelogram', 'cylinder'] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];
export const DEFAULT_NODE_SHAPE: NodeShape = 'rectangle';

// Named slots rather than colours: each theme defines what a slot looks like, so a coloured
// edge or drawing stays legible in every theme. A `#rrggbb` value is accepted as an escape hatch.
export const LAYER_COLOR_SLOTS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray'] as const;
export type LayerColorSlot = (typeof LAYER_COLOR_SLOTS)[number];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Entries keep every field they were read with, known or not, so a layer written by a newer
// editor survives a save by an older one. The typed readers below validate what they read.
export type NodeVisual = { shape?: unknown } & Record<string, unknown>;
export type EdgeVisual = { color?: unknown } & Record<string, unknown>;
// One entry of the `drawings` list, kept whole; canvas-drawings.ts reads the kinds it knows.
export type Drawing = { id?: unknown; kind?: unknown; graph?: unknown } & Record<string, unknown>;

export interface CanvasLayer {
  nodes: Record<string, NodeVisual>;
  edges: Record<string, EdgeVisual>;
  drawings: Drawing[];
  groups: Group[];
  // Top-level keys this editor does not interpret, carried through verbatim — among them a
  // `drawings` or `groups` value that is not a list, which is kept for a hand fix rather than
  // discarded.
  extras: Record<string, unknown>;
}

const KNOWN_TOP_LEVEL_KEYS = new Set(['format', 'nodes', 'edges']);
// Lists of objects, written one entry per line after everything else, in this order.
const ENTRY_LIST_KEYS = ['groups', 'drawings'] as const;
type EntryListKey = (typeof ENTRY_LIST_KEYS)[number];

export function emptyCanvasLayer(): CanvasLayer {
  return { nodes: {}, edges: {}, drawings: [], groups: [], extras: {} };
}

export function canvasLayerPathOf(flowPath: string): string {
  return flowPath + CANVAS_LAYER_SUFFIX;
}

export function isFlowPath(path: string): boolean {
  return path.endsWith('.flow');
}

// The layer that moves and is deleted with `path`, which only a .flow has. Every backend
// applies this one rule, so a layer never outlives its graph to be picked up by whatever file
// is next created at that path.
export function companionLayerOf(path: string): string | null {
  return isFlowPath(path) ? canvasLayerPathOf(path) : null;
}

export function isCanvasLayerPath(path: string): boolean {
  return path.endsWith('.flow' + CANVAS_LAYER_SUFFIX);
}

export function flowPathOfCanvasLayer(layerPath: string): string {
  return layerPath.slice(0, -CANVAS_LAYER_SUFFIX.length);
}

export function isNodeShape(value: unknown): value is NodeShape {
  return (NODE_SHAPES as readonly unknown[]).includes(value);
}

export function isLayerColorSlot(value: unknown): value is LayerColorSlot {
  return (LAYER_COLOR_SLOTS as readonly unknown[]).includes(value);
}

export function isLayerColor(value: unknown): value is string {
  return isLayerColorSlot(value) || (typeof value === 'string' && HEX_COLOR.test(value));
}

// Tolerant: unparseable text, or text that is not a JSON object, reads as an empty layer — the
// layer is decoration, and a broken one must never stop a graph from opening. The linter is
// what reports it.
export function parseCanvasLayer(text: string | null | undefined): CanvasLayer {
  const raw = parseJsonObject(text);
  if (!raw) return emptyCanvasLayer();
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (KNOWN_TOP_LEVEL_KEYS.has(key) || (isEntryListKey(key) && Array.isArray(value))) continue;
    extras[key] = value;
  }
  return {
    nodes: readEntries(raw.nodes),
    edges: readEntries(raw.edges),
    drawings: readEntryList(raw.drawings),
    groups: readEntryList(raw.groups),
    extras,
  };
}

// A `drawings` or `groups` value that is not a list is carried in `extras` and written back as
// it was; any drawing edit would write a list over it, so none is made until it is fixed.
export function drawingListsAreEditable(layer: CanvasLayer): boolean {
  return ENTRY_LIST_KEYS.every((key) => !(key in layer.extras));
}

function isEntryListKey(key: string): key is EntryListKey {
  return (ENTRY_LIST_KEYS as readonly string[]).includes(key);
}

// Text that is there but says nothing this editor can read. Unlike a missing file, it must not
// be treated as an empty layer by anything that writes: the next edit would replace the file
// with that one edit, discarding everything a hand fix of the JSON would have recovered.
export function canvasLayerIsUnreadable(text: string | null | undefined): boolean {
  return text != null && text.trim() !== '' && parseJsonObject(text) == null;
}

export function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const raw: unknown = JSON.parse(text);
    return isPlainObject(raw) ? raw : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function readEntryList(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlainObject).map((entry) => ({ ...entry }));
}

function readEntries(raw: unknown): Record<string, Record<string, unknown>> {
  if (!isPlainObject(raw)) return {};
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isPlainObject(value) && Object.keys(value).length > 0) entries[key] = { ...value };
  }
  return entries;
}

// Null when the layer holds nothing: a sidecar exists only while it says something, so an
// emptied layer means deleting the file rather than writing an empty one.
export function serializeCanvasLayer(layer: CanvasLayer): string | null {
  if (canvasLayerIsEmpty(layer)) return null;
  const document: Record<string, unknown> = { format: CANVAS_LAYER_FORMAT };
  if (Object.keys(layer.nodes).length > 0) document.nodes = sortedEntries(layer.nodes);
  if (Object.keys(layer.edges).length > 0) document.edges = sortedEntries(layer.edges);
  Object.assign(document, layer.extras);
  const lists = ENTRY_LIST_KEYS
    .map((key): [EntryListKey, Record<string, unknown>[]] => [key, layer[key]])
    .filter(([, entries]) => entries.length > 0);
  for (const [key] of lists) delete document[key];
  const objectText = JSON.stringify(document, null, 2);
  return (lists.length === 0 ? objectText : withEntryListsAppended(objectText, lists)) + '\n';
}

// A stroke is hundreds of coordinates, and pretty-printing would give each its own line. Each
// entry of a list is written on one line instead, the lists last so they can be appended.
function withEntryListsAppended(objectText: string, lists: [EntryListKey, Record<string, unknown>[]][]): string {
  const listTexts = lists.map(([key, entries]) => {
    const entryLines = entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n');
    return `  ${JSON.stringify(key)}: [\n${entryLines}\n  ]`;
  });
  const body = objectText.slice(0, objectText.lastIndexOf('}')).trimEnd();
  return `${body},\n${listTexts.join(',\n')}\n}`;
}

export function canvasLayerIsEmpty(layer: CanvasLayer): boolean {
  return Object.keys(layer.nodes).length === 0
    && Object.keys(layer.edges).length === 0
    && layer.drawings.length === 0
    && layer.groups.length === 0
    && Object.keys(layer.extras).length === 0;
}

function sortedEntries<T>(entries: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key];
  return sorted;
}

export function nodeShapeOf(layer: CanvasLayer | null, nodeId: string | null): NodeShape {
  if (!layer || nodeId == null) return DEFAULT_NODE_SHAPE;
  const shape = layer.nodes[nodeId]?.shape;
  return isNodeShape(shape) ? shape : DEFAULT_NODE_SHAPE;
}

// The default shape is never written; clearing the last field of an entry removes the entry.
export function setNodeShape(layer: CanvasLayer, nodeId: string, shape: NodeShape | null): void {
  setEntryField(layer.nodes, nodeId, 'shape', shape === DEFAULT_NODE_SHAPE ? null : shape);
}

// The one way an entry is edited, whichever module owns its fields: clearing its last field
// removes the entry, so the layer never holds an empty one.
export function setEntryField(entries: Record<string, Record<string, unknown>>, key: string, field: string, value: unknown): void {
  const entry = { ...(entries[key] ?? {}) };
  if (value == null) delete entry[field];
  else entry[field] = value;
  if (Object.keys(entry).length > 0) entries[key] = entry;
  else delete entries[key];
}

// A target that resolves to a node in the edge's scope is written as `#<id>`. Node names can
// never start with `#` (a column-0 `#` line is a comment), so the two forms cannot collide.
const RESOLVED_TARGET_PREFIX = '#';
// The nth identical edge from one node (n ≥ 2) gets ` : #n`. Node names cannot contain `: `
// and a label is always quoted, so an unquoted suffix after ` : ` is unambiguous.
const REPEAT_SEPARATOR = ' : #';

export function onErrorEdgeKey(sourceId: string): string {
  return `${sourceId} on_error`;
}

export function flowEdgeKey(sourceId: string, spec: EdgeSpec, targetId: string | null): string {
  const target = targetId != null ? RESOLVED_TARGET_PREFIX + targetId : spec.target;
  return `${sourceId} ${serializeEdgeExpression({ ...spec, target, data: null })}`;
}

// What the canvas layer keys a document's visuals by, captured from one state of the document.
// Comparing two captures of the same document object tells which entries an edit moved.
export interface DocumentIdentities {
  nodeIds: Map<FlowNode, string>;
  // The name of each `graph:` block, which is what drawings made inside it are filed under.
  graphNames: Map<GraphItem, string>;
  // A node's `on_error` edge is filed under the node itself: the property is re-parsed on every
  // read, so its EdgeSpec has no stable object to file it under.
  edgeKeys: Map<EdgeSpec | FlowNode, string>;
}

export function documentIdentities(doc: FlowDocument): DocumentIdentities {
  const identities: DocumentIdentities = { nodeIds: new Map(), graphNames: new Map(), edgeKeys: new Map() };
  for (const scopeNodes of graphScopesOf(doc)) collectScopeIdentities(scopeNodes, identities);
  for (const item of doc.items) {
    if (item.kind === 'graph') identities.graphNames.set(item, item.name);
  }
  return identities;
}

function graphScopesOf(doc: FlowDocument): FlowNode[][] {
  const scopes = [nodesOfItems(doc.items)];
  for (const item of doc.items) {
    if (item.kind === 'graph') scopes.push(nodesOfItems(item.items));
  }
  return scopes;
}

function nodesOfItems(items: FlowItem[]): FlowNode[] {
  return items.flatMap((item) => (item.kind === 'node' ? [item.node] : []));
}

function collectScopeIdentities(nodes: FlowNode[], identities: DocumentIdentities): void {
  const idsByName = new Map<string, string>();
  for (const node of nodes) {
    if (node.id && !idsByName.has(node.name)) idsByName.set(node.name, node.id);
  }
  for (const node of nodes) {
    if (!node.id) continue;
    identities.nodeIds.set(node, node.id);
    if (node.props.some((prop) => prop.key === 'on_error')) identities.edgeKeys.set(node, onErrorEdgeKey(node.id));
    const occurrences = new Map<string, number>();
    for (const spec of node.edges) {
      const baseKey = flowEdgeKey(node.id, spec, idsByName.get(spec.target) ?? null);
      const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
      occurrences.set(baseKey, occurrence);
      identities.edgeKeys.set(spec, occurrence === 1 ? baseKey : `${baseKey}${REPEAT_SEPARATOR}${occurrence}`);
    }
  }
}

// Moves every entry whose node or edge an edit re-keyed and drops those whose node or edge the
// edit removed, comparing two captures of the same document. Drawings follow the `graph:` block
// they were drawn in the same way: renamed with it, dropped with it, leaving their groups when they
// go. Entries the `before` capture
// does not account for — orphans of an edit made outside the editor — are left alone: they are
// not this edit's to discard. Returns whether the layer changed.
export function followIdentityChanges(layer: CanvasLayer, before: DocumentIdentities, after: DocumentIdentities): boolean {
  const nodes = rekeyEntries(layer.nodes, before.nodeIds, after.nodeIds);
  const edges = rekeyEntries(layer.edges, before.edgeKeys, after.edgeKeys);
  const drawings = refileDrawings(layer.drawings, before.graphNames, after.graphNames);
  const groupsBefore = layer.groups;
  const changed = !sameEntries(nodes, layer.nodes)
    || !sameEntries(edges, layer.edges)
    || !sameItems(drawings, layer.drawings);
  layer.nodes = nodes;
  layer.edges = edges;
  layer.drawings = drawings;
  pruneGroups(layer);
  return changed || layer.groups !== groupsBefore;
}

function refileDrawings(
  drawings: Drawing[],
  before: Map<GraphItem, string>,
  after: Map<GraphItem, string>,
): Drawing[] {
  const blockByNameBefore = new Map([...before].map(([block, name]) => [name, block]));
  return drawings.flatMap((drawing) => {
    const block = typeof drawing.graph === 'string' ? blockByNameBefore.get(drawing.graph) : undefined;
    if (!block) return [drawing];
    const nameAfter = after.get(block);
    if (nameAfter == null) return [];
    return [nameAfter === drawing.graph ? drawing : { ...drawing, graph: nameAfter }];
  });
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function rekeyEntries<Owner, Entry>(
  entries: Record<string, Entry>,
  before: Map<Owner, string>,
  after: Map<Owner, string>,
): Record<string, Entry> {
  const ownedBefore = new Set(before.values());
  const next: Record<string, Entry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!ownedBefore.has(key)) next[key] = entry;
  }
  for (const [owner, keyAfter] of after) {
    const keyBefore = before.get(owner);
    if (keyBefore != null && entries[keyBefore] !== undefined) next[keyAfter] = entries[keyBefore];
  }
  return next;
}

function sameEntries(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

// The visuals of one node about to be copied: its own entry, its edges' entries by position,
// and its on_error edge's. A copy gets a fresh id and possibly a new name, so nothing keyed can
// carry across — position is the one thing a copy shares with its source.
export interface CapturedNodeVisuals {
  node: NodeVisual | null;
  edges: (EdgeVisual | null)[];
  onError: EdgeVisual | null;
}

// One entry per captured source node, in the order the sources were given.
export type CapturedVisuals = CapturedNodeVisuals[];

export function captureVisuals(layer: CanvasLayer, identities: DocumentIdentities, sources: FlowNode[]): CapturedVisuals {
  return sources.map((node) => ({
    node: entryOrNull(layer.nodes, identities.nodeIds.get(node)),
    edges: node.edges.map((spec) => entryOrNull(layer.edges, identities.edgeKeys.get(spec))),
    onError: entryOrNull(layer.edges, identities.edgeKeys.get(node)),
  }));
}

export function capturedVisualsAreEmpty(captured: CapturedVisuals): boolean {
  return captured.every((entry) => entry.node == null && entry.onError == null && entry.edges.every((edge) => edge == null));
}

function entryOrNull<Entry>(entries: Record<string, Entry>, key: string | undefined): Entry | null {
  return key != null ? entries[key] ?? null : null;
}

// Puts captured visuals on `copies`, which pair with the captured sources by position; a copy
// whose edges no longer line up with its source's (fewer of them) simply takes fewer entries.
export function applyCapturedVisuals(
  layer: CanvasLayer,
  identities: DocumentIdentities,
  copies: FlowNode[],
  captured: CapturedVisuals,
): void {
  copies.forEach((copy, index) => {
    const visuals = captured[index];
    const id = identities.nodeIds.get(copy);
    if (!visuals || !id) return;
    if (visuals.node) layer.nodes[id] = { ...visuals.node };
    const onErrorKey = identities.edgeKeys.get(copy);
    if (visuals.onError && onErrorKey) layer.edges[onErrorKey] = { ...visuals.onError };
    copy.edges.forEach((spec, edgeIndex) => {
      const edgeEntry = visuals.edges[edgeIndex];
      const key = identities.edgeKeys.get(spec);
      if (edgeEntry && key) layer.edges[key] = { ...edgeEntry };
    });
  });
}
