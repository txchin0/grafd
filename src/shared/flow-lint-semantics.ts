// Semantic rules: everything that needs a name resolved against something else. Edge targets,
// `on_error` targets, `expand` references, the `{Inner}` refinements of §5.7/§5.8, context
// declarations, and `references` entries.
//
// Expansions are resolved through an ExpansionLookup rather than directly, because a local
// `graph:` block can be answered from this file alone while an external `[Label](path.flow)`
// needs the whole workspace. Single-file linting passes a lookup that reports external targets
// as `unknown` and stays quiet about them; the workspace pass answers them for real.

import { error, warning, type Diagnostic } from './flow-diagnostics.js';
import { isLegalNodeName, parseEdgeExpression, parseExpandLink, parseListValue } from './flow-format.js';
import { parseReferenceLineRange } from './reference-target.js';
import type {
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
  const declaredContexts = declaredContextNames(file);
  for (const scope of file.scopes) {
    reportScope(scope, declaredContexts, lookup, diagnostics);
  }
  reportGraphBlockUsage(file, diagnostics);
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

function declaredContextNames(file: ScannedFile): Set<string> | null {
  const fields = file.preamble?.fields ?? [];
  const declarations = fields.filter((field) => field.key === 'context' || field.key === 'inherits');
  if (declarations.length === 0) return null;
  return new Set(declarations.flatMap((field) => parseListValue(field.value)));
}

function reportScope(
  scope: ScannedScope,
  declaredContexts: Set<string> | null,
  lookup: ExpansionLookup,
  diagnostics: Diagnostic[],
): void {
  const nodesByName = new Map(scope.nodes.map((node) => [node.name, node]));
  for (const node of scope.nodes) {
    reportExpand(node, lookup, diagnostics);
    reportOnErrorProperty(findProperty(node, 'on_error'), nodesByName, diagnostics);
    reportContextProperties(node, declaredContexts, diagnostics);
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

function reportContextProperties(
  node: ScannedNode,
  declaredContexts: Set<string> | null,
  diagnostics: Diagnostic[],
): void {
  for (const key of ['context', 'inherits']) {
    const property = findProperty(node, key);
    if (property && !expandValueOf(node)) {
      diagnostics.push(
        warning(
          'context-on-non-graph-node',
          property.line,
          `\`${key}\` applies only to a node that is a graph; this node has no \`expand\`.`,
        ),
      );
    }
  }
  const updates = findProperty(node, 'updates');
  if (!updates || declaredContexts == null) return;
  for (const name of parseListValue(updates.value)) {
    if (declaredContexts.has(name)) continue;
    diagnostics.push(
      warning(
        'updates-undeclared-context',
        updates.line,
        `Context "${name}" is not declared in this graph's \`context\` or \`inherits\`.`,
      ),
    );
  }
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
  const expandedNames = new Set(
    allScannedNodes(file)
      .map((node) => expandValueOf(node))
      .filter((value): value is string => value != null && !parseExpandLink(value)),
  );
  for (const scope of file.scopes) {
    if (scope.name == null || scope.line == null) continue;
    if (scope.nodes.length === 0) {
      diagnostics.push(warning('empty-graph-block', scope.line, `Graph block "${scope.name}" contains no nodes.`));
    }
    if (!expandedNames.has(scope.name)) {
      diagnostics.push(
        warning('unused-graph-block', scope.line, `No node in this file has \`expand: ${scope.name}\`.`),
      );
    }
  }
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
