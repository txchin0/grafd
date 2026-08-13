// Document-level operations on a parsed .flow AST: scope resolution for `graph:` blocks,
// building the canvas view-model (nodes, resolved edges, ghost targets, inferred traits),
// deterministic auto-layout for nodes that have no `pos` yet, and all editor mutations.

import {
  collapseToSingleLine,
  emptyContextBlock,
  formatListValue,
  emptyNode,
  getPreambleField,
  getProp,
  setPreambleField,
  setProp,
  newUuid,
  parseEdgeExpression,
  serializeEdgeExpression,
  parseExpandLink,
  parseListValue,
  resolveLinkPath,
  sanitizeDataKey,
  sanitizeName,
  uniqueName,
  writeDescriptionForNode,
  writeReferencesForNode,
  type EdgeDataField,
  type EdgeSpec,
  type FlowDocument,
  type ContextBlock,
  type ContextItem,
  type FlowItem,
  type FlowNode,
  type GraphItem,
  type Rect,
  type Reference,
} from '../shared/flow-format.js';
import type { DisplayGeometry } from './canvas/expansion.js';
import type { Point } from './geometry.js';
import { DEFAULT_NODE_SIZE, autoLayout } from '../shared/auto-layout.js';
import { rectContainsRect, regionRectFrom } from '../shared/rect-math.js';

export interface GhostNode {
  name: string;
  ghost: true;
  pos: Rect;
}

export type EdgeKind = 'flow' | 'error';

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
}

export interface NodeTraits {
  entry: boolean;
  decision: boolean;
  expand: string | null;
  updates: string[];
  hasErrorHandler: boolean;
  /** Names of the regions listing this node, so membership shows on the node and not only by containment. */
  contexts: string[];
  /** Whether the file grants every node context from above, which a member's expansion inherits. */
  inheritsContexts: boolean;
}

/** One `context:` block with its membership resolved against the nodes actually in the model. */
export interface ModelContext {
  block: ContextBlock;
  members: FlowNode[];
}

export interface FlowModel {
  nodes: FlowNode[];
  edges: ModelEdge[];
  ghosts: GhostNode[];
  // Empty for a `graph:` block: a block has no body of its own, so it declares no regions.
  contexts: ModelContext[];
  nodesByName: Map<string, FlowNode>;
  traits: Map<FlowNode, NodeTraits>;
  sourceDoc: FlowDocument;
  sourcePath: string | null;
  // The `graph:` block this model was built from, or null for a document body. Together with
  // sourceDoc it names the item list new nodes drawn into this model must be appended to.
  sourceScope: string | null;
  display?: DisplayGeometry;
  embedded?: boolean;
}

// The rects a model currently occupies on screen: each node's display rect once a geometry
// pass has attached one (an unfolded frame measures at its frame, not its collapsed `pos`),
// otherwise its authored `pos`. Nodes still awaiting auto-layout have neither and drop out.
export function displayRects(model: FlowModel): Rect[] {
  return [
    ...model.nodes.map((node) => displayRectOf(model, node)),
    ...model.ghosts.map((ghost) => ghost.pos),
    // A region the user drew before populating it occupies space no node accounts for, so it has
    // to be measured here or it would be cropped out of fit-to-content and out of exports.
    ...model.contexts.map((context) => regionRectOf(model, context)),
  ].filter((rect): rect is Rect => rect != null);
}

// Where a region draws: the shared derivation of a block's drawn area with its members' padded
// bounds. Shared with the linter, which must flag against exactly what the canvas paints.
export function regionRectOf(model: FlowModel, context: ModelContext): Rect | null {
  const memberRects = context.members
    .map((member) => displayRectOf(model, member))
    .filter((rect): rect is Rect => rect != null);
  return regionRectFrom(context.block.pos, memberRects);
}

// The other contexts a dragged region carries: every one whose whole frame lies inside its
// frame. Measured against the frames as they stand at gesture start, via the same regionRectOf
// the painter draws and the hit-test reads, so what moves is exactly what the user sees enclosed.
export function contextsContainedIn(model: FlowModel, context: ModelContext): ModelContext[] {
  const frame = regionRectOf(model, context);
  if (!frame) return [];
  return model.contexts.filter((other) => {
    if (other === context) return false;
    const rect = regionRectOf(model, other);
    return rect != null && rectContainsRect(frame, rect);
  });
}

// Which providers a node may read (spec §8.5). A top-level node reads the blocks listing it plus
// everything the file inherits. A node inside a `graph:` block is a member of nothing (§8.2
// rule 6) and reads what the node expanding that block reads (§8.4). The linter answers the
// same question over its own scan (`readableContextsByNode`); the two must agree, since this
// is what generates the `inherits` the linter then checks and what `removeUnreadableUpdates`
// uses to strip claims.
export function contextNamesReadableBy(doc: FlowDocument, nodeName: string): string[] {
  const inherited = inheritedContextNames(doc);
  return [...(readableContextNamesByNode(doc).get(nodeName) ?? new Set(inherited))];
}

export function inheritedContextNames(doc: FlowDocument): string[] {
  return parseListValue(getPreambleField(doc, 'inherits'));
}

function readableContextNamesByNode(doc: FlowDocument): Map<string, Set<string>> {
  const inherited = inheritedContextNames(doc);
  const readable = new Map<string, Set<string>>();
  for (const node of nodesIn(doc.items)) {
    const fromBlocks = contextBlocksIn(doc.items)
      .filter((block) => block.members.includes(node.name))
      .map((block) => block.name);
    readable.set(node.name, new Set([...inherited, ...fromBlocks]));
  }
  const hostsByBlockName = localExpansionHostsByBlockName(doc);
  const graphs = doc.items.filter((item): item is GraphItem => item.kind === 'graph');
  let changed = true;
  while (changed) {
    changed = false;
    for (const graph of graphs) {
      const hosts = hostsByBlockName.get(graph.name) ?? [];
      const throughHosts = hosts.flatMap((host) => [...(readable.get(host.name) ?? inherited)]);
      const scopeWide = new Set([...inherited, ...throughHosts]);
      for (const inner of nodesIn(graph.items)) {
        const current = readable.get(inner.name);
        if (current && sameStringSet(current, scopeWide)) continue;
        readable.set(inner.name, scopeWide);
        changed = true;
      }
    }
  }
  return readable;
}

function localExpansionHostsByBlockName(doc: FlowDocument): Map<string, FlowNode[]> {
  const hostsByBlockName = new Map<string, FlowNode[]>();
  for (const node of allNodes(doc)) {
    const expandValue = getProp(node, 'expand');
    if (!expandValue || parseExpandLink(expandValue)) continue;
    const hosts = hostsByBlockName.get(expandValue) ?? [];
    hosts.push(node);
    hostsByBlockName.set(expandValue, hosts);
  }
  return hostsByBlockName;
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((name) => right.has(name));
}

// The editor's cleanup counterpart to the linter's `updates-undeclared-context`: an edit that
// can shrink what a node reads strips every name the node can no longer read from `updates:`,
// so no editor gesture leaves behind a claim the file cannot back (spec §8.6). A state that
// arrived through the file is repaired the moment the editor touches the document it lives in.
export function removeUnreadableUpdates(doc: FlowDocument, nodes: FlowNode[] = allNodes(doc)): FlowNode[] {
  const readableByName = readableContextNamesByNode(doc);
  const inherited = inheritedContextNames(doc);
  const changed: FlowNode[] = [];
  for (const node of nodes) {
    const readable = [...(readableByName.get(node.name) ?? new Set(inherited))];
    const kept = parseListValue(getProp(node, 'updates')).filter((name) => readable.includes(name));
    const current = parseListValue(getProp(node, 'updates'));
    if (kept.length === current.length && kept.every((name, index) => name === current[index])) continue;
    setProp(node, 'updates', kept.length > 0 ? formatListValue(kept) : null);
    changed.push(node);
  }
  return changed;
}

/** One node joining or leaving one region, as a drag resolved it. */
export interface MembershipChange {
  block: ContextBlock;
  node: FlowNode;
  joins: boolean;
}

// What a finished node drag did to membership (R13). Containment is measured against the frame
// each region had when the drag began, not its live one: a region with no `pos` is the bounds of
// its members, so a live frame would follow the node being dragged and no member could ever leave
// it. Every moved node is tested against every region, so a multi-node drag carries all of them
// and a node inside overlapping regions joins or leaves each independently (R15, R16).
export function membershipChangesForMove(
  model: FlowModel,
  movedNodes: FlowNode[],
  frozenRegionRects: ReadonlyMap<ContextBlock, Rect>,
): MembershipChange[] {
  const changes: MembershipChange[] = [];
  const nodesHere = movedNodes.filter((node) => model.nodes.includes(node));
  for (const context of model.contexts) {
    const frame = frozenRegionRects.get(context.block);
    if (!frame) continue;
    for (const node of nodesHere) {
      const inside = rectContainsRect(frame, displayRectOf(model, node));
      const isMember = context.members.includes(node);
      if (inside !== isMember) changes.push({ block: context.block, node, joins: inside });
    }
  }
  return changes;
}

// What a region's own gesture did to its membership. Every node in the graph is tested against
// the frame the gesture left behind: a move sweeps non-members in but can never drop one, since
// its members travelled with it (R29), while a resize measures against the rectangle the user
// dragged and so can shut a member out (R31).
export function membershipChangesForRegion(
  model: FlowModel,
  context: ModelContext,
  frame: Rect,
  { canRemove }: { canRemove: boolean },
): MembershipChange[] {
  const changes: MembershipChange[] = [];
  for (const node of model.nodes) {
    const inside = rectContainsRect(frame, displayRectOf(model, node));
    const isMember = context.members.includes(node);
    if (inside && !isMember) changes.push({ block: context.block, node, joins: true });
    else if (!inside && isMember && canRemove) changes.push({ block: context.block, node, joins: false });
  }
  return changes;
}

// What a region-move gesture did to membership. The group that travelled sweeps the non-members
// each frame comes to rest over into its own membership (R28a, R29), and the carried nodes —
// every member of the group, deduped — join any stationary region whose frame fully contains
// them where they landed. A move can only ever add: every member travelled with its own frame,
// so none can be shut out, and a stationary region never sweeps or drops anything else.
export function membershipChangesForRegionMove(
  model: FlowModel,
  group: readonly ModelContext[],
): MembershipChange[] {
  const groupBlocks = new Set(group.map((entry) => entry.block));
  const carriedNodes = [...new Set(group.flatMap((entry) => entry.members))].filter((node) =>
    model.nodes.includes(node),
  );
  const changes: MembershipChange[] = [];
  for (const context of model.contexts) {
    const frame = regionRectOf(model, context);
    if (!frame) continue;
    if (groupBlocks.has(context.block)) {
      changes.push(...membershipChangesForRegion(model, context, frame, { canRemove: false }));
      continue;
    }
    for (const node of carriedNodes) {
      if (context.members.includes(node)) continue;
      if (rectContainsRect(frame, displayRectOf(model, node))) {
        changes.push({ block: context.block, node, joins: true });
      }
    }
  }
  return changes;
}

// Regions a freshly created top-level node joins when its rectangle is fully inside their
// frame — the inverse of drawing a region over existing nodes (R9a). Each overlapping region is
// evaluated independently (R15). Subgraph nodes are excluded because they are absent from a
// root-scoped model (R5).
export function membershipChangesForNewNode(model: FlowModel, node: FlowNode): MembershipChange[] {
  const regionRects = new Map<ContextBlock, Rect>();
  for (const context of model.contexts) {
    const frame = regionRectOf(model, context);
    if (frame) regionRects.set(context.block, frame);
  }
  return membershipChangesForMove(model, [node], regionRects);
}

// One node's rect in its own model's coordinates. Callers must prefer this over reading `pos`
// directly, or an unfolded frame measures at its collapsed size.
export function displayRectOf(model: FlowModel, node: FlowNode): Rect {
  return model.display?.rects.get(node) ?? node.pos!;
}

const EXTRACTED_SUBGRAPH_NAME = 'Subgraph';

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

// Like scopeItems, but materializes a `graph:` block that has been referenced by an `expand`
// without ever being written, so a subgraph can receive its first node.
export function ensureScopeItems(doc: FlowDocument, scopeName: string | null): FlowItem[] {
  if (!scopeName) return doc.items;
  const existing = doc.items.find((item): item is GraphItem => item.kind === 'graph' && item.name === scopeName);
  if (existing) return existing.items;
  const block: GraphItem = { kind: 'graph', name: scopeName, items: [] };
  doc.items.push(block);
  return block.items;
}

export function nodesIn(items: FlowItem[]): FlowNode[] {
  return items.filter((item): item is { kind: 'node'; node: FlowNode } => item.kind === 'node').map((item) => item.node);
}

// Context blocks are addressed by name, not by id: the same provider name appears in other files'
// `inherits` and `updates`, and nothing in the format carries an identifier for a provider.
export function contextBlocksIn(items: FlowItem[]): ContextBlock[] {
  return items.filter((item): item is ContextItem => item.kind === 'context').map((item) => item.block);
}

export function contextBlockNamed(doc: FlowDocument, name: string): ContextBlock | null {
  return contextBlocksIn(doc.items).find((block) => block.name === name) ?? null;
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

export interface ItemGroup {
  items: FlowItem[];
  nodes: FlowNode[];
}

export interface OwnedNodes<Owner> {
  owner: Owner;
  itemGroups: ItemGroup[];
}

// A selection can span documents (nodes inside an unfolded frame belong to another .flow file)
// and, within one document, several `graph:` blocks. Mutations are per item list, but writes
// are per document, so callers need both levels: this splits a flat node list into one entry
// per owning document, each carrying its nodes bucketed by the item list that holds them.
// Insertion order is preserved at both levels, so results follow the order nodes were given in.
//
// `byItems` is shared for the whole call, not per document — safe because each FlowDocument
// owns distinct item-list arrays. If callers ever share item lists across documents, scope a
// fresh map when creating each OwnedNodes entry instead.
export function groupNodesByOwner<Owner extends { doc: FlowDocument }>(
  nodes: FlowNode[],
  ownerOf: (node: FlowNode) => Owner,
): OwnedNodes<Owner>[] {
  const byDocument = new Map<FlowDocument, OwnedNodes<Owner>>();
  const byItems = new Map<FlowItem[], ItemGroup>();
  for (const node of nodes) {
    const owner = ownerOf(node);
    let owned = byDocument.get(owner.doc);
    if (!owned) {
      owned = { owner, itemGroups: [] };
      byDocument.set(owner.doc, owned);
    }
    const items = containingItems(owner.doc, node);
    let group = byItems.get(items);
    if (!group) {
      group = { items, nodes: [] };
      byItems.set(items, group);
      owned.itemGroups.push(group);
    }
    group.nodes.push(node);
  }
  return [...byDocument.values()];
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
  // Regions live in the document body (spec §8.2), so a model scoped to a `graph:` block has none.
  const contexts = scopeName == null ? modelContextsOf(doc, nodesByName) : [];
  const traits = inferTraits(doc, nodes, edges, contexts);
  return {
    nodes,
    edges,
    ghosts,
    contexts,
    nodesByName,
    traits,
    sourceDoc: doc,
    sourcePath: null,
    sourceScope: scopeName,
  };
}

// A member naming a node that is not here is simply absent from the model: the file is
// authoritative about membership, and no render pass repairs it (spec §8.3). The linter reports it.
function modelContextsOf(doc: FlowDocument, nodesByName: Map<string, FlowNode>): ModelContext[] {
  return contextBlocksIn(doc.items).map((block) => ({
    block,
    members: block.members
      .map((memberName) => nodesByName.get(memberName))
      .filter((member): member is FlowNode => member != null),
  }));
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

function inferTraits(
  doc: FlowDocument,
  nodes: FlowNode[],
  edges: ModelEdge[],
  contexts: ModelContext[],
): Map<FlowNode, NodeTraits> {
  const namesWithIncoming = new Set(
    edges.filter((edge) => edge.kind === 'flow').map((edge) => edge.spec.target),
  );
  const contextNamesByMember = contextNamesByNode(contexts);
  const inheritsContexts = parseListValue(getPreambleField(doc, 'inherits')).length > 0;
  const traits = new Map<FlowNode, NodeTraits>();
  for (const node of nodes) {
    const labeledOutgoing = node.edges.filter((edge) => edge.label).length;
    traits.set(node, {
      entry: getProp(node, 'entrypoint') === 'true' || !namesWithIncoming.has(node.name),
      decision: labeledOutgoing >= 2,
      expand: getProp(node, 'expand'),
      updates: parseListValue(getProp(node, 'updates')),
      hasErrorHandler: getProp(node, 'on_error') != null,
      contexts: contextNamesByMember.get(node) ?? [],
      inheritsContexts,
    });
  }
  return traits;
}

function contextNamesByNode(contexts: ModelContext[]): Map<FlowNode, string[]> {
  const namesByNode = new Map<FlowNode, string[]>();
  for (const context of contexts) {
    for (const member of context.members) {
      namesByNode.set(member, [...(namesByNode.get(member) ?? []), context.block.name]);
    }
  }
  return namesByNode;
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

// A region the user drew keeps its rectangle; one grouped from a selection has none, because the
// user expressed membership rather than an area (spec §8.3 — `pos` is a floor, never authored by
// anything but a deliberate draw).
export function addContextBlock(
  items: FlowItem[],
  requestedName: string,
  pos: Rect | null,
  memberNames: string[],
): ContextBlock {
  const takenNames = new Set(contextBlocksIn(items).map((block) => block.name));
  const block = emptyContextBlock(uniqueName(takenNames, sanitizeName(requestedName) || 'Region'));
  if (pos) {
    block.pos = { x: Math.round(pos.x), y: Math.round(pos.y), w: Math.round(pos.w), h: Math.round(pos.h) };
  }
  setContextMembers(block, memberNames);
  items.push({ kind: 'context', block });
  return block;
}

export function deleteContextBlock(items: FlowItem[], block: ContextBlock): void {
  const index = items.findIndex((item) => item.kind === 'context' && item.block === block);
  if (index >= 0) items.splice(index, 1);
}

// These four are the only writers of a block's membership list: membership is never inferred from
// geometry, and no editor field exposes it (spec §8.3).
export function setContextMembers(block: ContextBlock, memberNames: string[]): void {
  block.members = [...new Set(memberNames.map((name) => name.trim()).filter(Boolean))];
}

export function addContextMember(block: ContextBlock, memberName: string): void {
  setContextMembers(block, [...block.members, memberName]);
}

export function removeContextMember(block: ContextBlock, memberName: string): void {
  setContextMembers(block, block.members.filter((member) => member !== memberName));
}

// Renaming a provider renames every reference to it, because a provider is addressed by name and
// nothing else: `updates` in the declaring file (spec §8.6), and `inherits`/`updates` in the files
// its members expand into (§8.4). A name left behind would refer to a provider nobody declares.
export function renameContextBlock(doc: FlowDocument, block: ContextBlock, requestedName: string): string {
  const cleanName = sanitizeName(requestedName);
  if (!cleanName || cleanName === block.name) return block.name;
  const oldName = block.name;
  block.name = cleanName;
  renameUpdatedContext(doc, oldName, cleanName);
  return cleanName;
}

/** The downstream half: a file that reads a provider it does not declare. */
export function renameContextReferences(doc: FlowDocument, oldName: string, newName: string): boolean {
  const inherited = renamedListValue(getPreambleField(doc, 'inherits'), oldName, newName);
  if (inherited != null) setPreambleField(doc, 'inherits', inherited);
  const updated = renameUpdatedContext(doc, oldName, newName);
  return inherited != null || updated;
}

export function referencesContext(doc: FlowDocument, name: string): boolean {
  return inheritedContextNames(doc).includes(name)
    || allNodes(doc).some((node) => parseListValue(getProp(node, 'updates')).includes(name));
}

function renameUpdatedContext(doc: FlowDocument, oldName: string, newName: string): boolean {
  let changed = false;
  for (const node of allNodes(doc)) {
    const updates = renamedListValue(getProp(node, 'updates'), oldName, newName);
    if (updates == null) continue;
    setProp(node, 'updates', updates);
    changed = true;
  }
  return changed;
}

/** The rewritten list, or null when the name does not appear in it. */
function renamedListValue(value: string | null, oldName: string, newName: string): string | null {
  const names = parseListValue(value);
  if (!names.includes(oldName)) return null;
  return formatListValue([...new Set(names.map((name) => (name === oldName ? newName : name)))]);
}

export function renameMemberInContextBlocks(doc: FlowDocument, oldName: string, newName: string): void {
  for (const block of contextBlocksIn(doc.items)) {
    setContextMembers(block, block.members.map((member) => (member === oldName ? newName : member)));
  }
}

export function removeMemberFromContextBlocks(doc: FlowDocument, memberName: string): void {
  for (const block of contextBlocksIn(doc.items)) removeContextMember(block, memberName);
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
  if (isTopLevel(items, doc)) {
    transferRegionMembershipToHost(doc, nodesToExtract, host);
    // Inner nodes read through the host (§8.2 rule 6): a region the host still belongs to
    // stays readable, and `updates:` naming one it does not are stripped (R40c).
    removeUnreadableUpdates(doc, nodesToExtract);
  }

  return { host, blockName, innerNodes: nodesToExtract };
}

// A selection pulled into a subgraph carries its region membership along. Names that leave the
// body for the new `graph:` block would otherwise stay listed and grant nothing; a region that
// held the whole selection hands its members to the host that now stands in for them, while one
// that held only part keeps the host out — it stands in for the whole subgraph, not the region.
function transferRegionMembershipToHost(doc: FlowDocument, extractedNodes: FlowNode[], host: FlowNode): void {
  const extractedNames = new Set(extractedNodes.map((node) => node.name));
  for (const block of contextBlocksIn(doc.items)) {
    const namedHere = block.members.filter((name) => extractedNames.has(name));
    if (namedHere.length === 0) continue;
    const remaining = block.members.filter((name) => !extractedNames.has(name));
    if (namedHere.length === extractedNodes.length) remaining.push(host.name);
    setContextMembers(block, remaining);
  }
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
    preamble: { fields: [{ key: 'name', value: graphName }], references: [] },
    items: [],
  };
  moveDescriptionOfSoleHost(doc, blockName, extracted);
  moveReferencesOfSoleHost(doc, blockName, extracted);
  // The new file's nodes read through the hosts that expanded the block, so its `inherits` is
  // generated from them exactly as a membership change generates it in place (R40a). Computed
  // before the relink rewrites the hosts' `expand` values.
  const readable = unionOfHostReadableContexts(doc, blockName);
  if (readable.length > 0) setPreambleField(extracted, 'inherits', formatListValue(readable));
  relinkExpandsToPath(doc, blockName, linkPath, graphName);

  const movedNames = reachableBlockNames(doc, [blockName]);
  const retainedNames = reachableBlockNames(doc, localExpandTargets(nodesIn(doc.items)));

  for (const name of movedNames) {
    const block = graphBlockByName(doc, name);
    const items = block ? takeBlockItems(doc, block, retainedNames.has(name)) : [];
    if (name === blockName) extracted.items.push(...items);
    else extracted.items.push({ kind: 'graph', name, items });
  }
  // Anything the extracted nodes claimed to update but the generated `inherits` does not back
  // is stripped, so the new file starts clean of dangling `updates:` (R40c).
  removeUnreadableUpdates(extracted);
  return extracted;
}

function unionOfHostReadableContexts(doc: FlowDocument, blockName: string): string[] {
  const names = new Set<string>();
  for (const host of allNodes(doc).filter((node) => getProp(node, 'expand') === blockName)) {
    for (const name of contextNamesReadableBy(doc, host.name)) names.add(name);
  }
  return [...names];
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

// References follow description for the same reason: once the block owns a file, its preamble
// is the node definition, so a lone host's references belong there.
function moveReferencesOfSoleHost(doc: FlowDocument, blockName: string, extracted: FlowDocument): void {
  const hosts = allNodes(doc).filter((node) => getProp(node, 'expand') === blockName);
  if (hosts.length !== 1 || hosts[0].references.length === 0) return;
  writeReferencesForNode(hosts[0], extracted, hosts[0].references);
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

  if (isTopLevel(items, doc)) {
    for (const name of deletedNames) removeMemberFromContextBlocks(doc, name);
  }

  for (const node of nodesIn(items)) {
    node.edges = node.edges.filter((edge) => !deletedNames.has(edge.target));
    const onError = getProp(node, 'on_error');
    if (onError?.startsWith('->') && deletedNames.has(parseEdgeExpression(onError).target)) {
      setProp(node, 'on_error', null);
    }
  }
}

// A node and the local `graph:` block it solely expands are kept in step: renaming either side
// renames the other. The pairing is derived from the current names rather than stored, which
// makes a block the user deliberately named something else simply unpaired — an explicit name
// is never silently rewritten — and lets the rule survive the round-trip through the file,
// which has nowhere to record editor state on a block.
export function renameNode(
  items: FlowItem[],
  node: FlowNode,
  requestedName: string,
  doc: FlowDocument,
  options?: { path?: string | null; relatedDocs?: DocPath[] },
): string {
  const mirroredBlock = mirroredGraphBlockOfHost(doc, node);
  const finalName = applyNodeRename(items, node, requestedName, doc, options);
  if (mirroredBlock && finalName !== mirroredBlock.name) {
    applyGraphBlockRename(doc, mirroredBlock, finalName);
  }
  return finalName;
}

export function renameGraphBlock(
  doc: FlowDocument,
  graphItem: GraphItem,
  requestedName: string,
  options?: { path?: string | null; relatedDocs?: DocPath[] },
): string {
  const mirroredHost = mirroredHostOfGraphBlock(doc, graphItem);
  const finalName = applyGraphBlockRename(doc, graphItem, requestedName);
  if (mirroredHost && finalName !== mirroredHost.name) {
    applyNodeRename(containingItems(doc, mirroredHost), mirroredHost, finalName, doc, options);
  }
  return finalName;
}

function applyNodeRename(
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

  if (isTopLevel(items, doc)) renameMemberInContextBlocks(doc, oldName, node.name);

  const identity = expandIdentityForNode(doc, options?.path ?? null, node);
  if (identity) {
    retargetInnerRefs(docsForRetarget(doc, options), identity, oldName, node.name);
  }
  return node.name;
}

// Only nodes declared at column 0 can be context members (spec §8.2 rule 6), so a mutation inside
// a `graph:` block's item list never touches a membership list.
function isTopLevel(items: FlowItem[], doc: FlowDocument): boolean {
  return items === doc.items;
}

function applyGraphBlockRename(doc: FlowDocument, graphItem: GraphItem, requestedName: string): string {
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

// Error edges live inside the single-line `on_error` property, which has no room for the
// indented data block an edge data schema is written as.
export function edgeSupportsData(edge: ModelEdge): boolean {
  return edge.kind === 'flow';
}

export function normalizeEdgeDataFields(fields: EdgeDataField[]): EdgeDataField[] {
  return fields
    .map((field) => ({ key: sanitizeDataKey(field.key), type: collapseToSingleLine(field.type) }))
    .filter((field) => field.key !== '');
}

export function setEdgeData(edge: ModelEdge, fields: EdgeDataField[]): void {
  if (!edgeSupportsData(edge)) return;
  const normalized = normalizeEdgeDataFields(fields);
  edge.spec.data = normalized.length ? normalized : null;
}

// The format has no escape sequences, so the delimiters of the `[Label](target)` form cannot
// survive inside either part and are stripped rather than escaped. This does mean a URL
// containing parentheses loses them.
export function normalizeReferences(references: Reference[]): Reference[] {
  return references
    .map((reference) => ({
      label: collapseToSingleLine(reference.label ?? '').replace(/[[\]]/g, '') || null,
      target: collapseToSingleLine(reference.target).replace(/[()]/g, ''),
    }))
    .filter((reference) => reference.target !== '');
}

export function setNodeReferences(node: FlowNode, references: Reference[]): void {
  node.references = normalizeReferences(references);
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

// The reverse of an expansion reference: which nodes unfold this graph. Walked on demand
// rather than kept as an index, because every mutation, watcher push, undo and lazy external
// load would have to invalidate the index, and the walk over an in-memory document is cheap.
export function hostsOfExpansion(docs: Iterable<DocPath>, identity: ExpandIdentity): FlowNode[] {
  const hosts: FlowNode[] = [];
  for (const { doc, path } of docs) {
    for (const node of allNodes(doc)) {
      const expandValue = getProp(node, 'expand');
      if (expandValue && expandValueMatchesIdentity(expandValue, path, identity)) hosts.push(node);
    }
  }
  return hosts;
}

/** The local `graph:` block `node` expands and is the only host of, if there is one. */
export function graphBlockSolelyHostedBy(doc: FlowDocument, node: FlowNode): GraphItem | null {
  const block = graphBlockNamed(doc, getProp(node, 'expand'));
  if (!block) return null;
  const hosts = hostsOfExpansion([{ doc, path: null }], { kind: 'graph-block', name: block.name });
  return hosts.length === 1 && hosts[0] === node ? block : null;
}

/** The block of `graphBlockSolelyHostedBy` when the two already share a name (see renameNode). */
export function mirroredGraphBlockOfHost(doc: FlowDocument, node: FlowNode): GraphItem | null {
  const block = graphBlockSolelyHostedBy(doc, node);
  return block && block.name === node.name ? block : null;
}

export function mirroredHostOfGraphBlock(doc: FlowDocument, graphItem: GraphItem): FlowNode | null {
  const hosts = hostsOfExpansion([{ doc, path: null }], { kind: 'graph-block', name: graphItem.name });
  return hosts.length === 1 && hosts[0].name === graphItem.name ? hosts[0] : null;
}

export function graphBlockNamed(doc: FlowDocument, blockName: string | null): GraphItem | null {
  if (!blockName || parseExpandLink(blockName)) return null;
  return doc.items.find(
    (item): item is GraphItem => item.kind === 'graph' && item.name === blockName,
  ) ?? null;
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
  return expandValue != null && expandValueMatchesIdentity(expandValue, containingPath, identity);
}

// A local `expand: Block Name` can only ever name a block in its own file, so a graph-block
// identity never has to consider the containing path; an external link resolves against it.
function expandValueMatchesIdentity(
  expandValue: string,
  containingPath: string | null,
  identity: ExpandIdentity,
): boolean {
  if (identity.kind === 'graph-block') return expandValue === identity.name;
  const link = parseExpandLink(expandValue);
  return link != null && resolveLinkPath(containingPath, link.path) === identity.path;
}

function expandValueOfTarget(doc: FlowDocument, edgeSource: FlowNode, edge: EdgeSpec): string | null {
  const targetNode = nodesIn(containingItems(doc, edgeSource)).find((node) => node.name === edge.target);
  return targetNode ? getProp(targetNode, 'expand') : null;
}
