// What a copy needs before it can be pasted into a graph other than the one it was copied from.
//
// A copied node names things relative to where it came from: its edges name nodes of its own
// graph, an `expand` link is spelled relative to its own file, and a local `expand` names a
// `graph:` block that only its own file declares. Pasted elsewhere, each of those would point at
// nothing — or worse, at an unrelated namesake — so the copy is adapted first. Every function
// here works on copies the clipboard can throw away; the clipboard's own content is reused by
// every later paste and is never touched.

import type { CapturedVisuals } from '../shared/canvas-layer.js';
import {
  formatListValue,
  getProp,
  parseEdgeExpression,
  parseExpandLink,
  parseListValue,
  resolveLinkPath,
  setProp,
  uniqueName,
  type FlowDocument,
  type FlowNode,
} from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import { folderOf, relativizePath } from './flow-paths.js';
import { diveTargetOf } from './canvas/dive-navigation.js';

// One graph: a file's top level (scope null) or one of its `graph:` blocks.
export interface GraphUnit {
  path: string;
  scope: string | null;
}

export function sameGraph(first: GraphUnit, second: GraphUnit): boolean {
  return first.path === second.path && first.scope === second.scope;
}

// An edge only means something between two nodes that both made the trip, so a copy pasted into
// another graph keeps its edges among the copied nodes and drops the rest — `on_error` too. The
// captured visuals pair with edges by index, so they are filtered in the same step.
export function keepEdgesWithinCopy(
  sources: readonly FlowNode[],
  visuals: CapturedVisuals | null,
): { nodes: FlowNode[]; visuals: CapturedVisuals | null } {
  const copiedNames = new Set(sources.map((node) => node.name));
  const nodes = sources.map((source) => structuredClone(source));
  const keptEdges = nodes.map((node) => node.edges.map((edge) => copiedNames.has(edge.target)));
  const keptOnError = nodes.map((node) => !onErrorLeavesCopy(node, copiedNames));
  nodes.forEach((node, index) => {
    node.edges = node.edges.filter((_edge, edgeIndex) => keptEdges[index][edgeIndex]);
    if (!keptOnError[index]) setProp(node, 'on_error', null);
  });
  const keptVisuals = visuals?.map((entry, index) => ({
    node: entry.node,
    edges: entry.edges.filter((_edge, edgeIndex) => keptEdges[index]?.[edgeIndex] ?? false),
    onError: keptOnError[index] ? entry.onError : null,
  })) ?? null;
  return { nodes, visuals: keptVisuals };
}

function onErrorLeavesCopy(node: FlowNode, copiedNames: ReadonlySet<string>): boolean {
  const onError = getProp(node, 'on_error');
  return onError?.startsWith('->') === true && !copiedNames.has(parseEdgeExpression(onError).target);
}

// An `expand` link is relative to the file that holds it, so a copy moving to another file is
// respelled to reach the same target from there.
export function rebaseExpandLinks(nodes: readonly FlowNode[], fromPath: string, toPath: string): void {
  if (fromPath === toPath) return;
  for (const node of nodes) {
    const link = parseExpandLink(getProp(node, 'expand'));
    if (!link) continue;
    const target = resolveLinkPath(fromPath, link.path);
    setProp(node, 'expand', `[${link.label}](${relativizePath(folderOf(toPath), target)})`);
  }
}

// The `graph:` blocks of `doc` that the nodes reach by local `expand`, directly or through the
// blocks they reach — everything a copy of them needs to keep its subgraphs in another file.
export function localSubgraphNames(doc: FlowDocument, nodes: FlowNode[]): string[] {
  return [...FlowDoc.reachableBlockNames(doc, FlowDoc.localExpandTargets(nodes))];
}

// A name for each carried block that no block of the destination already uses.
export function assignSubgraphNames(takenNames: Iterable<string>, names: Iterable<string>): Map<string, string> {
  const taken = new Set(takenNames);
  const assigned = new Map<string, string>();
  for (const name of names) {
    const newName = uniqueName(taken, name);
    taken.add(newName);
    assigned.set(name, newName);
  }
  return assigned;
}

export function renameLocalExpands(nodes: readonly FlowNode[], renames: ReadonlyMap<string, string>): void {
  for (const node of nodes) {
    const expandValue = getProp(node, 'expand');
    const renamed = expandValue && !parseExpandLink(expandValue) ? renames.get(expandValue) : undefined;
    if (renamed) setProp(node, 'expand', renamed);
  }
}

// A region pasted under a new name takes the `updates` of the nodes pasted beside it along.
export function renameUpdatedRegions(nodes: readonly FlowNode[], renames: ReadonlyMap<string, string>): void {
  for (const node of nodes) {
    const updates = parseListValue(getProp(node, 'updates'));
    if (!updates.some((name) => renames.has(name))) continue;
    setProp(node, 'updates', formatListValue(updates.map((name) => renames.get(name) ?? name)));
  }
}

// The graph a node unfolds into, or null for a node that expands nothing.
export function expansionOf(node: FlowNode, containingPath: string): GraphUnit | null {
  const target = diveTargetOf(node, containingPath);
  return target ? { path: target.path, scope: target.scope } : null;
}

// Whether unfolding `start`, and whatever unfolds inside it, ever arrives at `goal`. Only loaded
// documents can be walked, so an expansion into a file not loaded ends that branch: the answer is
// the best this session can give, and the linter's expansion-cycle warning covers the rest.
export function expansionReaches(
  start: GraphUnit,
  goal: GraphUnit,
  documentAt: (path: string) => FlowDocument | null,
): boolean {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const unit = pending.shift()!;
    if (sameGraph(unit, goal)) return true;
    // NUL separates the two halves so a path containing the scope's text cannot collide.
    const key = `${unit.path}\0${unit.scope ?? ''}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const node of nodesOfGraph(unit, documentAt)) {
      const next = expansionOf(node, unit.path);
      if (next) pending.push(next);
    }
  }
  return false;
}

function nodesOfGraph(unit: GraphUnit, documentAt: (path: string) => FlowDocument | null): FlowNode[] {
  const doc = documentAt(unit.path);
  if (!doc) return [];
  if (unit.scope != null && !FlowDoc.graphBlockNames(doc).includes(unit.scope)) return [];
  return FlowDoc.nodesIn(FlowDoc.scopeItems(doc, unit.scope));
}
