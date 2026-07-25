// Document-level operations on a parsed .flow AST: scope resolution for `graph:` blocks,
// building the canvas view-model (nodes, resolved edges, ghost targets, inferred traits),
// deterministic auto-layout for nodes that have no `pos` yet, and all editor mutations.

import {
  emptyNode,
  getProp,
  setProp,
  newUuid,
  parseEdgeExpression,
  serializeEdgeExpression,
  parseExpandLink,
  parseListValue,
  resolveLinkPath,
  sanitizeName,
  uniqueName,
  writeDescriptionForNode,
  type EdgeSpec,
  type FlowDocument,
  type FlowItem,
  type FlowNode,
  type GraphItem,
  type Rect,
} from '../shared/flow-format.js';
import type { DisplayGeometry } from './expansion.js';

export interface Point {
  x: number;
  y: number;
}

export interface GhostNode {
  name: string;
  ghost: true;
  pos: Rect;
}

export type EdgeKind = 'flow' | 'error';

export interface EdgeGeometry {
  a: Point;
  b: Point;
  mid: Point;
  labelRect: Rect | null;
  selfLoop?: boolean;
}

/** Identity of a subgraph expansion that `{Inner}` names resolve against (spec §5.7). */
export type ExpandIdentity =
  | { kind: 'graph-block'; name: string }
  | { kind: 'external-path'; path: string };

export interface DocPath {
  doc: FlowDocument;
  path: string | null;
}

export interface ModelEdge {
  from: FlowNode;
  spec: EdgeSpec;
  kind: EdgeKind;
  to?: FlowNode | GhostNode;
  geometry?: EdgeGeometry | null;
}

export interface NodeTraits {
  entry: boolean;
  decision: boolean;
  expand: string | null;
  updates: string[];
  hasErrorHandler: boolean;
}

export interface FlowModel {
  nodes: FlowNode[];
  edges: ModelEdge[];
  ghosts: GhostNode[];
  nodesByName: Map<string, FlowNode>;
  traits: Map<FlowNode, NodeTraits>;
  sourceDoc: FlowDocument;
  sourcePath: string | null;
  display?: DisplayGeometry;
  embedded?: boolean;
}

export const DEFAULT_NODE_SIZE = { w: 200, h: 88 };
const EXTRACTED_SUBGRAPH_NAME = 'Subgraph';
const LAYOUT_COLUMN_WIDTH = 280;
const LAYOUT_ROW_HEIGHT = 140;
const LAYOUT_ORIGIN = { x: 80, y: 80 };

export function assignMissingIds(doc: FlowDocument): void {
  for (const node of allNodes(doc)) {
    if (!node.id) node.id = newUuid();
  }
}

export function allNodes(doc: FlowDocument): FlowNode[] {
  const nodes: FlowNode[] = [];
  for (const item of doc.items) {
    if (item.kind === 'node') nodes.push(item.node);
    if (item.kind === 'graph') {
      for (const inner of item.items) {
        if (inner.kind === 'node') nodes.push(inner.node);
      }
    }
  }
  return nodes;
}

export function graphBlockNames(doc: FlowDocument): string[] {
  return doc.items.filter((item): item is GraphItem => item.kind === 'graph').map((item) => item.name);
}

export function scopeItems(doc: FlowDocument, scopeName: string | null): FlowItem[] {
  if (!scopeName) return doc.items;
  const graph = doc.items.find((item): item is GraphItem => item.kind === 'graph' && item.name === scopeName);
  return graph ? graph.items : doc.items;
}

export function nodesIn(items: FlowItem[]): FlowNode[] {
  return items.filter((item): item is { kind: 'node'; node: FlowNode } => item.kind === 'node').map((item) => item.node);
}

export function findNodeById(doc: FlowDocument, nodeId: string | null): FlowNode | null {
  return allNodes(doc).find((node) => node.id === nodeId) ?? null;
}

export function containingItems(doc: FlowDocument, node: FlowNode): FlowItem[] {
  for (const item of doc.items) {
    if (item.kind === 'node' && item.node === node) return doc.items;
    if (item.kind === 'graph' && item.items.some((inner) => inner.kind === 'node' && inner.node === node)) {
      return item.items;
    }
  }
  return doc.items;
}

export function containingGraphBlockName(doc: FlowDocument, node: FlowNode): string | null {
  for (const item of doc.items) {
    if (item.kind === 'graph' && item.items.some((inner) => inner.kind === 'node' && inner.node === node)) {
      return item.name;
    }
  }
  return null;
}

export function buildModel(doc: FlowDocument, scopeName: string | null): FlowModel {
  const nodes = nodesIn(scopeItems(doc, scopeName));
  const nodesByName = new Map(nodes.map((node) => [node.name, node]));

  const edges: ModelEdge[] = [];
  for (const node of nodes) {
    for (const spec of node.edges) edges.push({ from: node, spec, kind: 'flow' });
    const onError = getProp(node, 'on_error');
    if (onError?.startsWith('->')) {
      edges.push({ from: node, spec: parseEdgeExpression(onError), kind: 'error' });
    }
  }

  autoLayout(nodes, edges);

  const ghosts = resolveEdgeTargets(edges, nodesByName);
  const traits = inferTraits(nodes, edges);
  return { nodes, edges, ghosts, nodesByName, traits, sourceDoc: doc, sourcePath: null };
}

function resolveEdgeTargets(edges: ModelEdge[], nodesByName: Map<string, FlowNode>): GhostNode[] {
  const ghosts: GhostNode[] = [];
  const ghostsByName = new Map<string, GhostNode>();
  for (const edge of edges) {
    let target = nodesByName.get(edge.spec.target) ?? ghostsByName.get(edge.spec.target);
    if (!target) {
      const ghost = makeGhost(edge, ghosts.length);
      ghosts.push(ghost);
      ghostsByName.set(ghost.name, ghost);
      target = ghost;
    }
    edge.to = target;
  }
  return ghosts;
}

function makeGhost(edge: ModelEdge, ghostIndex: number): GhostNode {
  const source = edge.from.pos ?? { x: 0, y: 0, w: DEFAULT_NODE_SIZE.w, h: DEFAULT_NODE_SIZE.h };
  return {
    name: edge.spec.target,
    ghost: true,
    pos: {
      x: source.x + source.w + 140,
      y: source.y + ghostIndex * 70,
      w: DEFAULT_NODE_SIZE.w,
      h: 64,
    },
  };
}

function inferTraits(nodes: FlowNode[], edges: ModelEdge[]): Map<FlowNode, NodeTraits> {
  const namesWithIncoming = new Set(
    edges.filter((edge) => edge.kind === 'flow').map((edge) => edge.spec.target),
  );
  const traits = new Map<FlowNode, NodeTraits>();
  for (const node of nodes) {
    const labeledOutgoing = node.edges.filter((edge) => edge.label).length;
    traits.set(node, {
      entry: getProp(node, 'entrypoint') === 'true' || !namesWithIncoming.has(node.name),
      decision: labeledOutgoing >= 2,
      expand: getProp(node, 'expand'),
      updates: parseListValue(getProp(node, 'updates')),
      hasErrorHandler: getProp(node, 'on_error') != null,
    });
  }
  return traits;
}

export function autoLayout(nodes: FlowNode[], edges: ModelEdge[]): void {
  const unplaced = nodes.filter((node) => !node.pos);
  if (unplaced.length === 0) return;

  const depths = computeFlowDepths(nodes, edges);
  const startY = bottomOfPlacedNodes(nodes) ?? LAYOUT_ORIGIN.y;
  const rowsUsedPerColumn = new Map<number, number>();

  for (const node of unplaced) {
    const column = depths.get(node.name) ?? 0;
    const row = rowsUsedPerColumn.get(column) ?? 0;
    rowsUsedPerColumn.set(column, row + 1);
    node.pos = {
      x: LAYOUT_ORIGIN.x + column * LAYOUT_COLUMN_WIDTH,
      y: startY + row * LAYOUT_ROW_HEIGHT,
      w: DEFAULT_NODE_SIZE.w,
      h: DEFAULT_NODE_SIZE.h,
    };
  }
}

function bottomOfPlacedNodes(nodes: FlowNode[]): number | null {
  const placed = nodes.filter((node) => node.pos);
  if (placed.length === 0) return null;
  return Math.max(...placed.map((node) => node.pos!.y + node.pos!.h)) + 90;
}

function computeFlowDepths(nodes: FlowNode[], edges: ModelEdge[]): Map<string, number> {
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.name, []]));
  const namesWithIncoming = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== 'flow') continue;
    outgoing.get(edge.from.name)?.push(edge.spec.target);
    namesWithIncoming.add(edge.spec.target);
  }

  const depths = new Map<string, number>();
  const queue = nodes
    .filter((node) => !namesWithIncoming.has(node.name))
    .map((node) => ({ name: node.name, depth: 0 }));

  while (queue.length > 0) {
    const { name, depth } = queue.shift()!;
    if (depths.has(name)) continue;
    depths.set(name, depth);
    for (const targetName of outgoing.get(name) ?? []) {
      queue.push({ name: targetName, depth: depth + 1 });
    }
  }
  return depths;
}

export function ensureLayoutEverywhere(doc: FlowDocument): void {
  buildModel(doc, null);
  for (const graphName of graphBlockNames(doc)) buildModel(doc, graphName);
}

export function addNode(items: FlowItem[], rect: Rect, requestedName = 'Untitled'): FlowNode {
  const takenNames = new Set(nodesIn(items).map((node) => node.name));
  const node = emptyNode(uniqueName(takenNames, sanitizeName(requestedName) || 'Untitled'));
  node.id = newUuid();
  node.pos = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  };
  items.push({ kind: 'node', node });
  return node;
}

// Detached deep copies for the clipboard: they keep their original names and positions and
// survive later edits to the source nodes. duplicateNodes assigns fresh identities on paste.
export function cloneNodesDetached(sources: FlowNode[]): FlowNode[] {
  return sources.map((source) => structuredClone(source));
}

// Inserts independent copies of `sources` into `items`, each with a fresh id, a name made
// unique within `items`, and its position shifted by `offset`. Edges (and on_error targets)
// that point at another node in the copied set are rewired to that node's new name, so a
// duplicated cluster keeps its internal wiring while edges to untouched nodes are preserved.
export function duplicateNodes(items: FlowItem[], sources: FlowNode[], offset: Point): FlowNode[] {
  const takenNames = new Set(nodesIn(items).map((node) => node.name));
  const newNameByOriginal = new Map<string, string>();
  const copies = sources.map((source) => {
    const copy = structuredClone(source);
    copy.id = newUuid();
    copy.name = uniqueName(takenNames, source.name);
    takenNames.add(copy.name);
    newNameByOriginal.set(source.name, copy.name);
    if (copy.pos) copy.pos = { ...copy.pos, x: copy.pos.x + offset.x, y: copy.pos.y + offset.y };
    return copy;
  });

  for (const copy of copies) {
    for (const edge of copy.edges) {
      const renamed = newNameByOriginal.get(edge.target);
      if (renamed) edge.target = renamed;
    }
    const onError = getProp(copy, 'on_error');
    if (onError?.startsWith('->')) {
      const parsed = parseEdgeExpression(onError);
      const renamed = newNameByOriginal.get(parsed.target);
      if (renamed) {
        parsed.target = renamed;
        setProp(copy, 'on_error', serializeEdgeExpression(parsed));
      }
    }
  }

  for (const copy of copies) items.push({ kind: 'node', node: copy });
  return copies;
}

export function boundsOfNodes(nodes: FlowNode[]): Rect {
  const placed = nodes.filter((node) => node.pos);
  if (placed.length === 0) {
    return { x: 0, y: 0, w: DEFAULT_NODE_SIZE.w, h: DEFAULT_NODE_SIZE.h };
  }
  const minX = Math.min(...placed.map((node) => node.pos!.x));
  const minY = Math.min(...placed.map((node) => node.pos!.y));
  const maxX = Math.max(...placed.map((node) => node.pos!.x + node.pos!.w));
  const maxY = Math.max(...placed.map((node) => node.pos!.y + node.pos!.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function extractSubgraph(
  items: FlowItem[],
  nodesToExtract: FlowNode[],
  doc: FlowDocument,
  requestedName?: string,
): { host: FlowNode; blockName: string; innerNodes: FlowNode[] } {
  const extractedSet = new Set(nodesToExtract);
  const extractedNames = new Set(nodesToExtract.map((node) => node.name));
  const blockName = nameForExtraction(doc, items, requestedName);
  const block: GraphItem = { kind: 'graph', name: blockName, items: [] };
  doc.items.push(block);

  const firstRemovedIndex = moveNodeItemsInto(items, extractedSet, block);
  const host = emptyNode(blockName);
  host.id = newUuid();
  host.pos = hostRectFor(nodesToExtract);
  setProp(host, 'expand', blockName);
  items.splice(firstRemovedIndex, 0, { kind: 'node', node: host });

  redirectEdgesIntoHost(items, host, extractedSet, extractedNames);
  liftEscapingEdgesOntoHost(nodesToExtract, host, extractedNames);
  copyEntrypointToHost(nodesToExtract, host);

  return { host, blockName, innerNodes: nodesToExtract };
}

function nameForExtraction(doc: FlowDocument, items: FlowItem[], requestedName?: string): string {
  const takenNames = new Set([
    ...graphBlockNames(doc),
    ...nodesIn(items).map((node) => node.name),
  ]);
  return uniqueName(takenNames, (requestedName ? sanitizeName(requestedName) : '') || EXTRACTED_SUBGRAPH_NAME);
}

function hostRectFor(nodes: FlowNode[]): Rect {
  const bbox = boundsOfNodes(nodes);
  const centerX = bbox.x + bbox.w / 2;
  const centerY = bbox.y + bbox.h / 2;
  return {
    x: Math.round(centerX - DEFAULT_NODE_SIZE.w / 2),
    y: Math.round(centerY - DEFAULT_NODE_SIZE.h / 2),
    w: DEFAULT_NODE_SIZE.w,
    h: DEFAULT_NODE_SIZE.h,
  };
}

function moveNodeItemsInto(
  items: FlowItem[],
  extractedSet: Set<FlowNode>,
  block: GraphItem,
): number {
  let firstRemovedIndex = -1;
  const toMove: FlowItem[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'node' && extractedSet.has(item.node)) {
      if (firstRemovedIndex === -1 || index < firstRemovedIndex) firstRemovedIndex = index;
      toMove.unshift(item);
      items.splice(index, 1);
    }
  }
  for (const item of toMove) block.items.push(item);
  return firstRemovedIndex;
}

function entersExtraction(edge: EdgeSpec, extractedNames: Set<string>): boolean {
  return extractedNames.has(edge.target);
}

function escapesExtraction(edge: EdgeSpec, extractedNames: Set<string>): boolean {
  return !extractedNames.has(edge.target);
}

function redirectEdgesIntoHost(
  items: FlowItem[],
  host: FlowNode,
  extractedSet: Set<FlowNode>,
  extractedNames: Set<string>,
): void {
  for (const node of nodesIn(items)) {
    if (extractedSet.has(node)) continue;
    for (const edge of node.edges) {
      if (!entersExtraction(edge, extractedNames)) continue;
      const innerName = edge.target;
      edge.target = host.name;
      edge.innerTarget = innerName;
    }
    const onError = getProp(node, 'on_error');
    if (!onError?.startsWith('->')) continue;
    const parsed = parseEdgeExpression(onError);
    if (!extractedNames.has(parsed.target)) continue;
    parsed.target = host.name;
    parsed.innerTarget = null;
    setProp(node, 'on_error', serializeEdgeExpression(parsed));
  }
}

function liftEscapingEdgesOntoHost(
  nodesToExtract: FlowNode[],
  host: FlowNode,
  extractedNames: Set<string>,
): void {
  for (const node of nodesToExtract) {
    const edgesToLift: EdgeSpec[] = [];
    node.edges = node.edges.filter((edge) => {
      if (!escapesExtraction(edge, extractedNames)) return true;
      edgesToLift.push(edge);
      return false;
    });
    for (const edge of edgesToLift) {
      edge.innerSource = node.name;
      host.edges.push(edge);
    }
  }
}

function copyEntrypointToHost(nodesToExtract: FlowNode[], host: FlowNode): void {
  if (nodesToExtract.some((node) => getProp(node, 'entrypoint') === 'true')) {
    setProp(host, 'entrypoint', 'true');
  }
}

// Promotes a local `graph:` block into a standalone document: the block's items become the
// new document's body, `graphName` its preamble `name` and link label, and every node that
// expanded the block is relinked to `linkPath` (spec §6.2's external form). Local blocks
// reachable only from inside the extracted content travel with it; one still reachable from
// the parent's own top-level nodes is copied instead, with fresh ids so identities stay
// unique across files. `linkPath` is written verbatim, so callers must make it relative to
// the parent file.
export function extractGraphBlockToDocument(
  doc: FlowDocument,
  blockName: string,
  linkPath: string,
  graphName = blockName,
): FlowDocument {
  const extracted: FlowDocument = {
    leading: [],
    preamble: { fields: [{ key: 'name', value: graphName }] },
    items: [],
  };
  moveDescriptionOfSoleHost(doc, blockName, extracted);
  relinkExpandsToPath(doc, blockName, linkPath, graphName);

  const movedNames = reachableBlockNames(doc, [blockName]);
  const retainedNames = reachableBlockNames(doc, localExpandTargets(nodesIn(doc.items)));

  for (const name of movedNames) {
    const block = graphBlockByName(doc, name);
    const items = block ? takeBlockItems(doc, block, retainedNames.has(name)) : [];
    if (name === blockName) extracted.items.push(...items);
    else extracted.items.push({ kind: 'graph', name, items });
  }
  return extracted;
}

function graphBlockByName(doc: FlowDocument, name: string): GraphItem | null {
  return doc.items.find((item): item is GraphItem => item.kind === 'graph' && item.name === name) ?? null;
}

function localExpandTargets(nodes: FlowNode[]): string[] {
  const targets: string[] = [];
  for (const node of nodes) {
    const expandValue = getProp(node, 'expand');
    if (expandValue && !parseExpandLink(expandValue)) targets.push(expandValue);
  }
  return targets;
}

/** Blocks reachable from `startNames` by following local `expand` references. */
function reachableBlockNames(doc: FlowDocument, startNames: string[]): Set<string> {
  const reached = new Set<string>();
  const pending = [...startNames];
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (reached.has(name)) continue;
    reached.add(name);
    const block = graphBlockByName(doc, name);
    if (block) pending.push(...localExpandTargets(nodesIn(block.items)));
  }
  return reached;
}

// Items for the extracted document: copies (with fresh ids) when the block must also stay
// behind, otherwise the originals, with the block spliced out of the parent.
function takeBlockItems(doc: FlowDocument, block: GraphItem, keepInParent: boolean): FlowItem[] {
  if (keepInParent) return block.items.map(copyItemWithNewIds);
  doc.items.splice(doc.items.indexOf(block), 1);
  return block.items;
}

function copyItemWithNewIds(item: FlowItem): FlowItem {
  const copy = structuredClone(item);
  if (copy.kind === 'node') copy.node.id = newUuid();
  return copy;
}

function relinkExpandsToPath(
  doc: FlowDocument,
  blockName: string,
  linkPath: string,
  graphName: string,
): void {
  for (const node of allNodes(doc)) {
    if (getProp(node, 'expand') === blockName) setProp(node, 'expand', `[${graphName}](${linkPath})`);
  }
}

// With the block in its own file its preamble becomes the node definition, so a lone host's
// description belongs there. Several hosts each keep their own — there is no single owner.
function moveDescriptionOfSoleHost(doc: FlowDocument, blockName: string, extracted: FlowDocument): void {
  const hosts = allNodes(doc).filter((node) => getProp(node, 'expand') === blockName);
  if (hosts.length !== 1) return;
  const description = getProp(hosts[0], 'description');
  if (description == null) return;
  writeDescriptionForNode(hosts[0], extracted, description);
}

export function deleteNodes(
  items: FlowItem[],
  nodesToDelete: FlowNode[],
  doc: FlowDocument,
  options?: { path?: string | null; relatedDocs?: DocPath[] },
): void {
  retargetInnerRefsForNodes(nodesToDelete, doc, null, options);

  const deletedNames = new Set(nodesToDelete.map((node) => node.name));
  const deletedSet = new Set(nodesToDelete);

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'node' && deletedSet.has(item.node)) items.splice(index, 1);
  }

  for (const node of nodesIn(items)) {
    node.edges = node.edges.filter((edge) => !deletedNames.has(edge.target));
    const onError = getProp(node, 'on_error');
    if (onError?.startsWith('->') && deletedNames.has(parseEdgeExpression(onError).target)) {
      setProp(node, 'on_error', null);
    }
  }
}

export function renameNode(
  items: FlowItem[],
  node: FlowNode,
  requestedName: string,
  doc: FlowDocument,
  options?: { path?: string | null; relatedDocs?: DocPath[] },
): string {
  const cleanName = sanitizeName(requestedName);
  if (!cleanName || cleanName === node.name) return node.name;

  const takenNames = new Set(nodesIn(items).filter((other) => other !== node).map((other) => other.name));
  const oldName = node.name;
  node.name = uniqueName(takenNames, cleanName);

  for (const other of nodesIn(items)) {
    for (const edge of other.edges) {
      if (edge.target === oldName) edge.target = node.name;
    }
    const onError = getProp(other, 'on_error');
    if (onError?.startsWith('->')) {
      const parsed = parseEdgeExpression(onError);
      if (parsed.target === oldName) {
        parsed.target = node.name;
        setProp(other, 'on_error', serializeEdgeExpression(parsed));
      }
    }
  }

  const identity = expandIdentityForNode(doc, options?.path ?? null, node);
  if (identity) {
    retargetInnerRefs(docsForRetarget(doc, options), identity, oldName, node.name);
  }
  return node.name;
}

export function renameGraphBlock(doc: FlowDocument, graphItem: GraphItem, requestedName: string): string {
  const cleanName = sanitizeName(requestedName);
  if (!cleanName || cleanName === graphItem.name) return graphItem.name;

  const takenNames = new Set(graphBlockNames(doc).filter((name) => name !== graphItem.name));
  const oldName = graphItem.name;
  graphItem.name = uniqueName(takenNames, cleanName);

  for (const node of allNodes(doc)) {
    if (getProp(node, 'expand') === oldName) setProp(node, 'expand', graphItem.name);
  }
  return graphItem.name;
}

export function addEdge(
  fromNode: FlowNode,
  targetName: string,
  label: string | null = null,
  innerTarget: string | null = null,
  innerSource: string | null = null,
): EdgeSpec {
  fromNode.edges.push({
    target: targetName,
    innerSource: innerSource?.trim() || null,
    innerTarget: innerTarget?.trim() || null,
    label,
    data: null,
  });
  return fromNode.edges[fromNode.edges.length - 1];
}

export function deleteEdge(edge: ModelEdge): void {
  if (edge.kind === 'error') {
    setProp(edge.from, 'on_error', null);
    return;
  }
  edge.from.edges = edge.from.edges.filter((spec) => spec !== edge.spec);
}

export function setEdgeLabel(edge: ModelEdge, label: string | null): void {
  const cleanLabel = label?.trim() || null;
  if (edge.kind === 'error') {
    edge.spec.label = cleanLabel;
    setProp(edge.from, 'on_error', serializeEdgeExpression(edge.spec));
    return;
  }
  edge.spec.label = cleanLabel;
}

export function setEdgeInnerTarget(edge: ModelEdge, name: string | null): void {
  if (edge.kind === 'error') return;
  edge.spec.innerTarget = name?.trim() || null;
}

export function setEdgeInnerSource(edge: ModelEdge, name: string | null): void {
  if (edge.kind === 'error') return;
  edge.spec.innerSource = name?.trim() || null;
}

/** Top-level node names in an expansion (local `graph:` block or external file body). */
export function expandEntryNames(
  expandValue: string,
  localDoc: FlowDocument,
  containingPath: string | null,
  resolveExternal: (path: string) => FlowDocument | null,
): string[] | null {
  const link = parseExpandLink(expandValue);
  if (link) {
    const path = resolveLinkPath(containingPath, link.path);
    const external = resolveExternal(path);
    if (!external) return null;
    return nodesIn(external.items).map((node) => node.name);
  }
  return nodesIn(scopeItems(localDoc, expandValue)).map((node) => node.name);
}

/** How a node participates as an `{Inner}` entry when its containing expand is targeted. */
export function expandIdentityForNode(
  doc: FlowDocument,
  path: string | null,
  node: FlowNode,
): ExpandIdentity | null {
  const blockName = containingGraphBlockName(doc, node);
  if (blockName) return { kind: 'graph-block', name: blockName };
  if (path != null && nodesIn(doc.items).includes(node)) {
    return { kind: 'external-path', path };
  }
  return null;
}

// The two refinements an edge can carry: an `{Inner Source}` prefix (spec §5.8, resolved
// against the owning node's expansion) and an `{Inner Target}` suffix (spec §5.7, resolved
// against the target node's expansion). Both are kept consistent as inner nodes change.
type RefinementSide = 'source' | 'target';
const REFINEMENT_SIDES: RefinementSide[] = ['source', 'target'];

function edgeRefinementName(edge: EdgeSpec, side: RefinementSide): string | null {
  return side === 'source' ? edge.innerSource : edge.innerTarget;
}

function setEdgeRefinementName(edge: EdgeSpec, side: RefinementSide, name: string | null): void {
  if (side === 'source') edge.innerSource = name;
  else edge.innerTarget = name;
}

// Rewrite `{Inner Source}`/`{Inner Target}` on edges whose relevant side expands to
// `identity` (spec §5.7 / §5.8). Returns docs that had at least one edge updated.
export function retargetInnerRefs(
  docs: Iterable<DocPath>,
  identity: ExpandIdentity,
  oldName: string,
  newName: string | null,
): FlowDocument[] {
  const touched: FlowDocument[] = [];
  for (const { doc, path } of docs) {
    let changed = false;
    for (const node of allNodes(doc)) {
      for (const edge of node.edges) {
        for (const side of REFINEMENT_SIDES) {
          if (edgeRefinementName(edge, side) !== oldName) continue;
          if (!edgeExpandsTo(doc, path, node, edge, identity, side)) continue;
          setEdgeRefinementName(edge, side, newName);
          changed = true;
        }
      }
    }
    if (changed) touched.push(doc);
  }
  return touched;
}

export function hasInnerRefs(
  docs: Iterable<DocPath>,
  identity: ExpandIdentity,
  oldName: string,
): boolean {
  for (const { doc, path } of docs) {
    for (const node of allNodes(doc)) {
      for (const edge of node.edges) {
        for (const side of REFINEMENT_SIDES) {
          if (edgeRefinementName(edge, side) !== oldName) continue;
          if (edgeExpandsTo(doc, path, node, edge, identity, side)) return true;
        }
      }
    }
  }
  return false;
}

export function retargetInnerRefsForNodes(
  nodes: FlowNode[],
  doc: FlowDocument,
  newName: string | null,
  options?: { path?: string | null; relatedDocs?: DocPath[] },
): void {
  const docs = docsForRetarget(doc, options);
  const byIdentity = new Map<string, { identity: ExpandIdentity; names: Set<string> }>();
  for (const node of nodes) {
    const identity = expandIdentityForNode(doc, options?.path ?? null, node);
    if (!identity) continue;
    const key = expandIdentityKey(identity);
    let group = byIdentity.get(key);
    if (!group) {
      group = { identity, names: new Set() };
      byIdentity.set(key, group);
    }
    group.names.add(node.name);
  }
  for (const { identity, names } of byIdentity.values()) {
    for (const name of names) {
      retargetInnerRefs(docs, identity, name, newName);
    }
  }
}

function docsForRetarget(
  doc: FlowDocument,
  options?: { path?: string | null; relatedDocs?: DocPath[] },
): DocPath[] {
  if (options?.relatedDocs?.length) return options.relatedDocs;
  return [{ doc, path: options?.path ?? null }];
}

function expandIdentityKey(identity: ExpandIdentity): string {
  return identity.kind === 'graph-block'
    ? `graph:${identity.name}`
    : `path:${identity.path}`;
}

// Whether the edge's refined side unfolds `identity`. Source-side (§5.8) resolves against
// the owning node's own `expand`; target-side (§5.7) against the target node's `expand`.
function edgeExpandsTo(
  doc: FlowDocument,
  containingPath: string | null,
  edgeSource: FlowNode,
  edge: EdgeSpec,
  identity: ExpandIdentity,
  side: RefinementSide,
): boolean {
  const expandValue = side === 'source'
    ? getProp(edgeSource, 'expand')
    : expandValueOfTarget(doc, edgeSource, edge);
  if (!expandValue) return false;
  if (identity.kind === 'graph-block') return expandValue === identity.name;
  const link = parseExpandLink(expandValue);
  if (!link) return false;
  return resolveLinkPath(containingPath, link.path) === identity.path;
}

function expandValueOfTarget(doc: FlowDocument, edgeSource: FlowNode, edge: EdgeSpec): string | null {
  const targetNode = nodesIn(containingItems(doc, edgeSource)).find((node) => node.name === edge.target);
  return targetNode ? getProp(targetNode, 'expand') : null;
}
