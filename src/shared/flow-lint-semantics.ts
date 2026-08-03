// Semantic rules: everything that needs a name resolved against something else. Edge targets,
// `on_error` targets, `expand` references, the `{Inner}` refinements of §5.7/§5.8, context
// declarations, and `references` entries.
//
// Expansions are resolved through an ExpansionLookup rather than directly, because a local
// `graph:` block can be answered from this file alone while an external `[Label](path.flow)`
// needs the whole workspace. Single-file linting passes a lookup that reports external targets
// as `unknown` and stays quiet about them; the workspace pass answers them for real.

import { error, warning, type Diagnostic } from './flow-diagnostics.js';
import { isLegalNodeName, parseEdgeExpression, parseExpandLink, parseListValue, parsePos, type Rect } from './flow-format.js';
import { parseReferenceLineRange } from './reference-target.js';
import { autoLayout, type LayoutEdge, type LayoutNode } from './auto-layout.js';
import { rectContainsRect, regionRectFrom } from './rect-math.js';
import type {
  ScannedContext,
  ScannedEdge,
  ScannedFile,
  ScannedNode,
  ScannedProperty,
  ScannedReference,
  ScannedScope,
} from './flow-scan.js';
import { allScannedNodes, findProperty, rootScope, scopeByName } from './flow-scan.js';

export type ExpansionResult =
  | { kind: 'resolved'; entryNames: string[] }
  | { kind: 'missing' }
  | { kind: 'unknown' };

export type ExpansionLookup = (expandValue: string) => ExpansionResult;

export function localExpansionLookup(file: ScannedFile): ExpansionLookup {
  return (expandValue) => {
    if (parseExpandLink(expandValue)) return { kind: 'unknown' };
    const block = scopeByName(file, expandValue);
    return block ? { kind: 'resolved', entryNames: block.nodes.map((node) => node.name) } : { kind: 'missing' };
  };
}

export function lintSemantics(file: ScannedFile, lookup: ExpansionLookup): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // A file that names no provider at all — no block, no `inherits` — never said what it reads, so
  // an `updates` there is evidence of an older file rather than of a mistake.
  const readable = declaresSomeContext(file) ? readableContextsByNode(file) : null;
  for (const scope of file.scopes) {
    reportScope(scope, readable, lookup, diagnostics);
  }
  reportGraphBlockUsage(file, diagnostics);
  reportContextBlocks(file, diagnostics);
  reportPreamble(file, diagnostics);
  return diagnostics;
}

// The preamble is the graph's own node definition, so its `on_error` resolves against the
// file body — the graph's top-level scope (spec §7.3).
function reportPreamble(file: ScannedFile, diagnostics: Diagnostic[]): void {
  if (!file.preamble) return;
  reportReferences(file.preamble.references, diagnostics);
  const body = rootScope(file);
  if (!body) return;
  const onError = file.preamble.fields.find((field) => field.key === 'on_error') ?? null;
  reportOnErrorProperty(onError, new Map(body.nodes.map((node) => [node.name, node])), diagnostics);
}

function expandValueOf(node: ScannedNode): string | null {
  const property = findProperty(node, 'expand');
  return property && property.value !== '' ? property.value : null;
}

/** Which providers each node may read, or null while the file has said nothing about what it reads. */
type ReadableContexts = Map<ScannedNode, Set<string>> | null;

export function declaresSomeContext(file: ScannedFile): boolean {
  return file.contexts.length > 0 || inheritedContextNames(file).length > 0;
}

export function inheritedContextNames(file: ScannedFile): string[] {
  return (file.preamble?.fields ?? [])
    .filter((field) => field.key === 'inherits')
    .flatMap((field) => parseListValue(field.value));
}

// Read access, resolved once for the whole file (spec §8.5). A top-level node reads what the blocks
// listing it provide, plus everything the file inherits. A node inside a `graph:` block is a member
// of nothing (§8.2 rule 6) and reads what the node expanding that block reads (§8.4).
//
// Shared with the workspace pass, which asks the same question of a node with an `expand` link to
// decide what its expansion must inherit — so both answer it the same way or the two disagree.
export function readableContextsByNode(file: ScannedFile): Map<ScannedNode, Set<string>> {
  const inherited = inheritedContextNames(file);
  const providersByMemberName = providersByMember(file);
  const readable = new Map<ScannedNode, Set<string>>();

  for (const node of rootScope(file)?.nodes ?? []) {
    readable.set(node, new Set([...inherited, ...(providersByMemberName.get(node.name) ?? [])]));
  }

  const hostsByBlockName = localExpansionHostsByBlockName(file);
  for (const scope of file.scopes) {
    if (scope.name == null) continue;
    const hosts = hostsByBlockName.get(scope.name) ?? [];
    const throughHosts = hosts.flatMap((host) => [...(readable.get(host) ?? [])]);
    const scopeWide = new Set([...inherited, ...throughHosts]);
    for (const node of scope.nodes) readable.set(node, scopeWide);
  }
  return readable;
}

function providersByMember(file: ScannedFile): Map<string, Set<string>> {
  const providersByMemberName = new Map<string, Set<string>>();
  for (const block of file.contexts) {
    for (const member of block.members) {
      const providers = providersByMemberName.get(member.name) ?? new Set<string>();
      providers.add(block.name);
      providersByMemberName.set(member.name, providers);
    }
  }
  return providersByMemberName;
}

function reportScope(
  scope: ScannedScope,
  readableContexts: ReadableContexts,
  lookup: ExpansionLookup,
  diagnostics: Diagnostic[],
): void {
  const nodesByName = new Map(scope.nodes.map((node) => [node.name, node]));
  for (const node of scope.nodes) {
    reportExpand(node, lookup, diagnostics);
    reportOnErrorProperty(findProperty(node, 'on_error'), nodesByName, diagnostics);
    reportUpdatedContexts(node, readableContexts, diagnostics);
    reportReferences(node.references, diagnostics);
    reportDuplicateEdges(node, diagnostics);
    for (const edge of node.edges) {
      reportEdgeTarget(edge, nodesByName, diagnostics);
      reportInnerTarget(edge, nodesByName, lookup, diagnostics);
      reportInnerSource(edge, node, lookup, diagnostics);
    }
  }
}

function reportExpand(node: ScannedNode, lookup: ExpansionLookup, diagnostics: Diagnostic[]): void {
  const property = findProperty(node, 'expand');
  if (!property || property.value === '') return;
  const link = parseExpandLink(property.value);
  if (link && !link.path.endsWith('.flow')) {
    diagnostics.push(
      warning('expand-path-not-flow', property.line, `An \`expand\` link must point at a .flow file, not "${link.path}".`),
    );
    return;
  }
  if (lookup(property.value).kind !== 'missing') return;
  diagnostics.push(
    link
      ? error('expand-file-not-found', property.line, `No .flow file at "${link.path}", resolved relative to this file.`)
      : error('unresolved-local-expand', property.line, `No \`graph: ${property.value}\` block in this file.`),
  );
}

function reportOnErrorProperty(
  property: ScannedProperty | null,
  nodesByName: Map<string, ScannedNode>,
  diagnostics: Diagnostic[],
): void {
  if (!property || property.value === '') return;
  if (parseExpandLink(property.value)) return;
  if (!property.value.startsWith('->')) {
    diagnostics.push(
      warning(
        'malformed-on-error',
        property.line,
        '`on_error` takes `-> Target Node` or `[Label](handler.flow)`; this value is never read as a handler.',
      ),
    );
    return;
  }
  const target = parseEdgeExpression(property.value).target;
  if (isLegalNodeName(target) && !nodesByName.has(target)) {
    diagnostics.push(
      warning('unresolved-on-error-target', property.line, `No node named "${target}" in this graph.`),
    );
  }
}

// A node may only update a provider it can read, and the fix is always the membership list —
// `updates` never widens scope by itself (spec §8.6).
function reportUpdatedContexts(
  node: ScannedNode,
  readableContexts: ReadableContexts,
  diagnostics: Diagnostic[],
): void {
  const updates = findProperty(node, 'updates');
  if (!updates || !readableContexts) return;
  const readable = readableContexts.get(node) ?? new Set<string>();
  for (const name of parseListValue(updates.value)) {
    if (readable.has(name)) continue;
    diagnostics.push(
      warning(
        'updates-undeclared-context',
        updates.line,
        `"${node.name}" cannot read context "${name}": no \`context: ${name}\` block in this file lists it under \`nodes:\`, and the file does not inherit it.`,
      ),
    );
  }
}

function reportContextBlocks(file: ScannedFile, diagnostics: Diagnostic[]): void {
  const topLevelNames = new Set((rootScope(file)?.nodes ?? []).map((node) => node.name));
  const nestedNames = new Set(
    file.scopes.filter((scope) => scope.name != null).flatMap((scope) => scope.nodes.map((node) => node.name)),
  );
  const inherited = new Set(inheritedContextNames(file));
  const placedRects = file.contexts.length > 0 ? placedTopLevelRects(file) : new Map<ScannedNode, Rect>();

  for (const block of file.contexts) {
    if (inherited.has(block.name)) {
      diagnostics.push(
        warning(
          'context-redeclares-inherited',
          block.line,
          `"${block.name}" is already inherited, which makes it readable by every node in this file; a block cannot narrow it, and the scoping decision belongs to the graph that declared it.`,
        ),
      );
    }
    reportContextMembers(block, topLevelNames, nestedNames, diagnostics);
    reportContextGeometry(block, diagnostics);
    // A redeclared inherited context is inert — the declaring graph owns its membership — so a
    // region drawn on the redeclaration cannot recruit nodes; flagging them would contradict the
    // redeclaration warning above.
    if (!inherited.has(block.name)) reportUnassignedRegionMembers(block, placedRects, diagnostics);
    reportReferences(block.references, diagnostics);
  }
}

function reportContextMembers(
  block: ScannedContext,
  topLevelNames: Set<string>,
  nestedNames: Set<string>,
  diagnostics: Diagnostic[],
): void {
  for (const member of block.members) {
    if (topLevelNames.has(member.name)) continue;
    diagnostics.push(
      nestedNames.has(member.name)
        ? warning(
            'context-member-in-graph-block',
            member.line,
            `"${member.name}" is declared inside a \`graph:\` block, so it cannot be a member; a node there reaches a provider through the node that expands the block.`,
          )
        : warning(
            'context-member-not-found',
            member.line,
            `No node named "${member.name}" is declared at column 0 in this file, so this entry grants access to nothing.`,
          ),
    );
  }
}

// A block with no members and no area the user drew is a provider nobody can read and nothing
// draws. The canvas stays silent about it, so the linter is where it surfaces.
function reportContextGeometry(block: ScannedContext, diagnostics: Diagnostic[]): void {
  if (block.members.length > 0 || block.properties.some((property) => property.key === 'pos')) return;
  diagnostics.push(
    warning(
      'context-region-has-no-geometry',
      block.line,
      `Context "${block.name}" lists no nodes and reserves no area, so nothing can read it and no region is drawn.`,
    ),
  );
}

// A region draws the area the user drew plus its members' padded bounds, and a node the canvas
// would show fully inside that area is a member in all but name: the editor auto-assigns it on
// the next drag through the region, while anyone reading the file sees the node as part of the
// provider. Placement is the canvas's own — auto-layout for nodes without `pos` — so the linter
// judges the same rects the painter would.
function reportUnassignedRegionMembers(
  block: ScannedContext,
  placedRects: Map<ScannedNode, Rect>,
  diagnostics: Diagnostic[],
): void {
  const blockPosProperty = findProperty(block, 'pos');
  const blockPos = blockPosProperty ? parsePos(blockPosProperty.value) : null;
  const memberRects = block.members
    .map((member) => [...placedRects].find(([node]) => node.name === member.name)?.[1])
    .filter((rect): rect is Rect => rect != null);
  const region = regionRectFrom(blockPos, memberRects);
  if (!region) return;

  const memberNames = new Set(block.members.map((member) => member.name));
  for (const [node, rect] of placedRects) {
    if (memberNames.has(node.name) || !rectContainsRect(region, rect)) continue;
    diagnostics.push(
      warning(
        'node-inside-unassigned-region',
        node.line,
        `"${node.name}" lies fully inside the region of context "${block.name}" but is not listed under its \`nodes:\`; drag it into the region or move it out.`,
      ),
    );
  }
}

// The canvas places every top-level node before painting (flow-doc.ts buildModel): an authored
// `pos` where the file has one, the auto-layout grid where it does not. Recomputing that here
// keeps the region check honest for files the editor has not touched yet.
function placedTopLevelRects(file: ScannedFile): Map<ScannedNode, Rect> {
  const root = rootScope(file);
  const nodes: LayoutNode[] = (root?.nodes ?? []).map((node) => ({
    name: node.name,
    pos: posOf(node),
  }));
  const nodesByName = new Map(nodes.map((node) => [node.name, node]));
  const edges: LayoutEdge[] = (root?.nodes ?? []).flatMap((node) =>
    node.edges.map((edge) => ({ from: nodesByName.get(node.name)!, spec: edge.spec, kind: 'flow' })),
  );
  autoLayout(nodes, edges);
  return new Map((root?.nodes ?? []).map((node, index) => [node, nodes[index].pos!]));
}

function posOf(node: ScannedNode): Rect | null {
  const property = findProperty(node, 'pos');
  return property ? parsePos(property.value) : null;
}

function reportEdgeTarget(
  edge: ScannedEdge,
  nodesByName: Map<string, ScannedNode>,
  diagnostics: Diagnostic[],
): void {
  // A target that is not even a legal node name has already been reported as malformed syntax;
  // saying it also fails to resolve adds nothing.
  if (!isLegalNodeName(edge.spec.target) || nodesByName.has(edge.spec.target)) return;
  diagnostics.push(
    warning(
      'unresolved-edge-target',
      edge.line,
      `No node named "${edge.spec.target}" in this graph; the editor draws it as a placeholder.`,
    ),
  );
}

function reportInnerTarget(
  edge: ScannedEdge,
  nodesByName: Map<string, ScannedNode>,
  lookup: ExpansionLookup,
  diagnostics: Diagnostic[],
): void {
  if (!edge.spec.innerTarget) return;
  const targetNode = nodesByName.get(edge.spec.target);
  if (!targetNode) return;
  const expandValue = expandValueOf(targetNode);
  if (!expandValue) {
    diagnostics.push(
      warning(
        'inner-target-on-non-subgraph',
        edge.line,
        `"${edge.spec.target}" has no \`expand\`, so the \`{${edge.spec.innerTarget}}\` refinement is ignored.`,
      ),
    );
    return;
  }
  const expansion = lookup(expandValue);
  if (expansion.kind !== 'resolved' || expansion.entryNames.includes(edge.spec.innerTarget)) return;
  diagnostics.push(
    warning(
      'inner-target-not-found',
      edge.line,
      `"${edge.spec.innerTarget}" is not a top-level node of the graph "${edge.spec.target}" expands; the refinement is ignored.`,
    ),
  );
}

function reportInnerSource(
  edge: ScannedEdge,
  owner: ScannedNode,
  lookup: ExpansionLookup,
  diagnostics: Diagnostic[],
): void {
  if (!edge.spec.innerSource) return;
  const expandValue = expandValueOf(owner);
  if (!expandValue) {
    diagnostics.push(
      warning(
        'inner-source-without-expand',
        edge.line,
        `"${owner.name}" has no \`expand\`, so the \`{${edge.spec.innerSource}}\` prefix names nothing.`,
      ),
    );
    return;
  }
  const expansion = lookup(expandValue);
  if (expansion.kind !== 'resolved' || expansion.entryNames.includes(edge.spec.innerSource)) return;
  diagnostics.push(
    warning(
      'inner-source-not-found',
      edge.line,
      `"${edge.spec.innerSource}" is not a top-level node of the graph "${owner.name}" expands; the prefix is ignored.`,
    ),
  );
}

function reportDuplicateEdges(node: ScannedNode, diagnostics: Diagnostic[]): void {
  const firstLineByEdge = new Map<string, number>();
  for (const edge of node.edges) {
    const key = JSON.stringify([edge.spec.innerSource, edge.spec.target, edge.spec.innerTarget, edge.spec.label]);
    const firstLine = firstLineByEdge.get(key);
    if (firstLine == null) firstLineByEdge.set(key, edge.line);
    else {
      diagnostics.push(
        warning('duplicate-edge', edge.line, `An identical edge is already declared on line ${firstLine}.`),
      );
    }
  }
}

function reportGraphBlockUsage(file: ScannedFile, diagnostics: Diagnostic[]): void {
  const hostsByBlockName = localExpansionHostsByBlockName(file);
  for (const scope of file.scopes) {
    if (scope.name == null || scope.line == null) continue;
    if (scope.nodes.length === 0) {
      diagnostics.push(warning('empty-graph-block', scope.line, `Graph block "${scope.name}" contains no nodes.`));
    }
    const hosts = hostsByBlockName.get(scope.name) ?? [];
    if (hosts.length === 0) {
      diagnostics.push(
        warning('unused-graph-block', scope.line, `No node in this file has \`expand: ${scope.name}\`.`),
      );
      continue;
    }
    reportSoleHostNameMismatch(scope.name, scope.line, hosts, diagnostics);
  }
}

// A block only one node expands is that node's definition (spec §4.2), so the two names are
// two spellings of one thing and drift apart silently when either is edited alone. A block
// several nodes share has no single owner to be named after and is left alone.
function reportSoleHostNameMismatch(
  blockName: string,
  line: number,
  hosts: ScannedNode[],
  diagnostics: Diagnostic[],
): void {
  if (hosts.length !== 1 || hosts[0].name === blockName) return;
  diagnostics.push(
    warning(
      'sole-host-name-mismatch',
      line,
      `Only "${hosts[0].name}" expands this block, so the two name the same thing; consider renaming one to match the other.`,
    ),
  );
}

function localExpansionHostsByBlockName(file: ScannedFile): Map<string, ScannedNode[]> {
  const hostsByBlockName = new Map<string, ScannedNode[]>();
  for (const node of allScannedNodes(file)) {
    const expandValue = expandValueOf(node);
    if (expandValue == null || parseExpandLink(expandValue)) continue;
    const hosts = hostsByBlockName.get(expandValue) ?? [];
    hosts.push(node);
    hostsByBlockName.set(expandValue, hosts);
  }
  return hostsByBlockName;
}

function reportReferences(references: ScannedReference[], diagnostics: Diagnostic[]): void {
  for (const entry of references) {
    if (!entry.reference) {
      diagnostics.push(warning('empty-reference-entry', entry.line, 'Reference entry has no target and is discarded.'));
      continue;
    }
    if (/[()]/.test(entry.reference.target)) {
      diagnostics.push(
        warning(
          'reference-target-parentheses',
          entry.line,
          'The format has no escape sequences, so the editor strips `(` and `)` from a reference target.',
        ),
      );
    }
    if (entry.reference.label && /[[\]]/.test(entry.reference.label)) {
      diagnostics.push(
        warning(
          'reference-label-brackets',
          entry.line,
          'The format has no escape sequences, so the editor strips `[` and `]` from a reference label.',
        ),
      );
    }
    reportReferenceLineRange(entry, diagnostics);
  }
}

function reportReferenceLineRange(entry: ScannedReference, diagnostics: Diagnostic[]): void {
  const range = entry.reference ? parseReferenceLineRange(entry.reference.target) : null;
  if (!range) return;
  if (range.start >= 1 && range.end >= range.start) return;
  diagnostics.push(
    warning(
      'reference-invalid-line-range',
      entry.line,
      `Line range \`${range.start}-${range.end}\` is not a forward range starting at line 1 or later.`,
    ),
  );
}
