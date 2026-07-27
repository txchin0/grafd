// Syntax and structure rules: everything that can be decided from one file's own text,
// without resolving a name to anything. These are the rules that catch content the parser
// would silently drop or misread — see the module comment in flow-scan.ts.

import { error, warning, type Diagnostic } from './flow-diagnostics.js';
import { GRAPH_HEADER, parsePos } from './flow-format.js';
import type {
  DropReason,
  ScannedEdge,
  ScannedFile,
  ScannedNode,
  ScannedProperty,
  ScannedReference,
  ScannedScope,
} from './flow-scan.js';
import { allScannedNodes } from './flow-scan.js';

const PREAMBLE_KEYS = ['name', 'description', 'on_error', 'updates', 'entrypoint', 'context', 'inherits', 'references'];
const NODE_KEYS = ['id', 'pos', 'description', 'expand', 'on_error', 'updates', 'entrypoint', 'context', 'inherits', 'references'];
const LIST_VALUED_KEYS = ['context', 'inherits', 'updates'];
const BOOLEAN_VALUE = /^(true|false)$/;
const LIST_VALUE = /^\[\s*([^[\],]+(\s*,\s*[^[\],]+)*)?\s*\]$/;
const NAME_WITH_COLON = /:(\s|$)/;

const DROP_MESSAGES: Record<DropReason, string> = {
  'property-before-node':
    'Indented line appears before any node is declared, so the parser discards it. Declare a node at column 0 first.',
  'orphan-block-entry':
    'Line is indented as a block entry but no `data:` or `references:` block is open above it, so the parser discards it.',
  'malformed-reference-entry':
    'Entry under `references:` must start with `- `, otherwise the parser discards it.',
  'edge-data-field-without-data-key':
    'Edge data field appears without a `data:` line opening the block, so the parser discards it.',
  'unparsable-property':
    'Line is neither a `key: value` property nor an `-> Target` edge, so the parser discards it.',
  'unparsable-preamble-line':
    'Preamble line is not a `key: value` field, so the parser discards it.',
};

export function lintSyntax(file: ScannedFile): Diagnostic[] {
  // Nothing else in the file is worth reporting while the preamble swallows it: every body
  // line would be flagged as an unparsable preamble field.
  const unterminated = unterminatedPreamble(file);
  if (unterminated) return [unterminated];

  const diagnostics: Diagnostic[] = [];
  reportIndentation(file, diagnostics);
  reportDroppedLines(file, diagnostics);
  reportPreamble(file, diagnostics);
  reportDuplicateGraphBlockNames(file, diagnostics);
  reportDuplicateNodeIds(file, diagnostics);
  for (const scope of file.scopes) reportScope(scope, diagnostics);
  return diagnostics;
}

function reportIndentation(file: ScannedFile, diagnostics: Diagnostic[]): void {
  file.lines.forEach((text, index) => {
    if (text.trim() === '') return;
    const indentation = text.slice(0, text.search(/\S/));
    if (indentation.includes('\t')) {
      diagnostics.push(error('tab-indentation', index + 1, 'Tabs are forbidden as indentation; use 2 spaces per level.'));
    } else if (indentation.length % 2 !== 0) {
      diagnostics.push(
        warning('odd-indentation', index + 1, `Indented by ${indentation.length} spaces; the format uses 2 spaces per level.`),
      );
    }
  });
}

function reportDroppedLines(file: ScannedFile, diagnostics: Diagnostic[]): void {
  for (const dropped of file.droppedLines) {
    diagnostics.push(error(dropped.reason, dropped.line, DROP_MESSAGES[dropped.reason]));
  }
}

function unterminatedPreamble(file: ScannedFile): Diagnostic | null {
  if (!file.preamble || file.preamble.closeLine != null) return null;
  return error(
    'unterminated-preamble',
    file.preamble.openLine,
    'Preamble is never closed with `---`; the parser reads the rest of the file as preamble and discards the entire body.',
  );
}

function reportPreamble(file: ScannedFile, diagnostics: Diagnostic[]): void {
  const preamble = file.preamble;
  if (!preamble) {
    diagnostics.push(
      error('missing-preamble', 1, 'File has no `---` preamble; every .flow file needs one, carrying at least `name`.'),
    );
    return;
  }
  if (!preamble.fields.some((field) => field.key === 'name')) {
    diagnostics.push(error('missing-preamble-name', preamble.openLine, 'Preamble is missing the required `name` field.'));
  }
  reportProperties(preamble.fields, PREAMBLE_KEYS, 'preamble', diagnostics);
  reportReferenceBlock(preamble.referencesLine, preamble.references, diagnostics);
}

function reportScope(scope: ScannedScope, diagnostics: Diagnostic[]): void {
  reportDuplicateNames(scope, diagnostics);
  for (const node of scope.nodes) reportNode(node, diagnostics);
}

function reportDuplicateNames(scope: ScannedScope, diagnostics: Diagnostic[]): void {
  const firstLineByName = new Map<string, number>();
  for (const node of scope.nodes) {
    const firstLine = firstLineByName.get(node.name);
    if (firstLine == null) {
      firstLineByName.set(node.name, node.line);
      continue;
    }
    diagnostics.push(
      error(
        'duplicate-node-name',
        node.line,
        `Node name "${node.name}" is already used on line ${firstLine}; names must be unique within a graph.`,
      ),
    );
  }
}

function reportDuplicateGraphBlockNames(file: ScannedFile, diagnostics: Diagnostic[]): void {
  const firstLineByName = new Map<string, number>();
  for (const scope of file.scopes) {
    if (scope.name == null || scope.line == null) continue;
    const firstLine = firstLineByName.get(scope.name);
    if (firstLine == null) {
      firstLineByName.set(scope.name, scope.line);
      continue;
    }
    diagnostics.push(
      error(
        'duplicate-graph-block',
        scope.line,
        `Graph block "${scope.name}" is already defined on line ${firstLine}; only the first is ever resolved.`,
      ),
    );
  }
}

function reportDuplicateNodeIds(file: ScannedFile, diagnostics: Diagnostic[]): void {
  const firstLineById = new Map<string, number>();
  for (const node of allScannedNodes(file)) {
    for (const property of node.properties) {
      if (property.key !== 'id' || property.value === '') continue;
      const firstLine = firstLineById.get(property.value);
      if (firstLine == null) {
        firstLineById.set(property.value, property.line);
        continue;
      }
      diagnostics.push(
        error(
          'duplicate-node-id',
          property.line,
          `Node id is already used on line ${firstLine}; ids identify nodes across edits and must be unique within a file.`,
        ),
      );
    }
  }
}

function reportNode(node: ScannedNode, diagnostics: Diagnostic[]): void {
  reportNodeName(node, diagnostics);
  reportProperties(node.properties, NODE_KEYS, 'node', diagnostics);
  reportReferenceBlock(node.referencesLine, node.references, diagnostics);
  for (const edge of node.edges) reportEdge(edge, diagnostics);
}

function reportNodeName(node: ScannedNode, diagnostics: Diagnostic[]): void {
  if (GRAPH_HEADER.test(node.name)) {
    diagnostics.push(
      error(
        'nested-graph-block',
        node.line,
        'A `graph:` block cannot be nested inside another; the parser reads this as a node literally named "' +
          node.name +
          '" and discards its body.',
      ),
    );
    return;
  }
  if (/[{}]/.test(node.name)) {
    diagnostics.push(
      error('node-name-contains-braces', node.line, 'Node names cannot contain `{` or `}`; braces appear only on edges.'),
    );
  }
  if (NAME_WITH_COLON.test(node.name)) {
    diagnostics.push(
      error(
        'node-name-contains-colon',
        node.line,
        'Node names cannot contain a colon followed by a space or end of line — this line reads as a node, not a property.',
      ),
    );
  }
}

function reportProperties(
  properties: ScannedProperty[],
  allowedKeys: string[],
  context: 'preamble' | 'node',
  diagnostics: Diagnostic[],
): void {
  const firstLineByKey = new Map<string, number>();
  for (const property of properties) {
    const firstLine = firstLineByKey.get(property.key);
    if (firstLine == null) firstLineByKey.set(property.key, property.line);
    else {
      diagnostics.push(
        warning(
          context === 'preamble' ? 'duplicate-preamble-field' : 'duplicate-property',
          property.line,
          `\`${property.key}\` is already set on line ${firstLine}; only the first is read.`,
        ),
      );
    }
    reportPropertyValue(property, allowedKeys, context, diagnostics);
  }
}

function reportPropertyValue(
  property: ScannedProperty,
  allowedKeys: string[],
  context: 'preamble' | 'node',
  diagnostics: Diagnostic[],
): void {
  if (context === 'preamble' && property.key === 'expand') {
    diagnostics.push(
      warning('expand-in-preamble', property.line, 'A preamble has no `expand` — the file itself is the expansion.'),
    );
  } else if (!allowedKeys.includes(property.key)) {
    diagnostics.push(
      warning(
        'unknown-property',
        property.line,
        `\`${property.key}\` is not a ${context} property. Reserved keywords here: ${allowedKeys.join(', ')}.`,
      ),
    );
  }

  if (property.key === 'pos' && parsePos(property.value) == null) {
    diagnostics.push(
      warning('malformed-pos', property.line, '`pos` needs four comma-separated numbers (x, y, w, h); this one is discarded.'),
    );
  }
  if (property.key === 'entrypoint' && !BOOLEAN_VALUE.test(property.value)) {
    diagnostics.push(
      warning('entrypoint-not-boolean', property.line, '`entrypoint` reads as an entry point only when its value is exactly `true`.'),
    );
  }
  if (LIST_VALUED_KEYS.includes(property.key) && !LIST_VALUE.test(property.value)) {
    diagnostics.push(
      warning('malformed-list-value', property.line, `\`${property.key}\` takes a bracketed list, for example \`[Auth, Cart]\`.`),
    );
  }
  reportQuotedValue(property, diagnostics);
}

// The format has no escape sequences, so a quoted value ends at the first closing quote and a
// `"` can never appear inside one (flow-format.ts, quoteValue).
function reportQuotedValue(property: ScannedProperty, diagnostics: Diagnostic[]): void {
  if (!property.value.startsWith('"')) return;
  const closesProperly = property.value.length >= 2 && property.value.endsWith('"');
  const interior = closesProperly ? property.value.slice(1, -1) : property.value.slice(1);
  if (closesProperly && !interior.includes('"')) return;
  diagnostics.push(
    error(
      'quote-in-value',
      property.line,
      'The format has no escape sequences, so a quoted value cannot contain or omit a closing `"`.',
    ),
  );
}

function reportReferenceBlock(
  referencesLine: number | null,
  references: ScannedReference[],
  diagnostics: Diagnostic[],
): void {
  if (referencesLine == null || references.length > 0) return;
  diagnostics.push(
    warning('empty-references-block', referencesLine, 'A `references:` key with no entries is discarded; omit it instead.'),
  );
}

function reportEdge(edge: ScannedEdge, diagnostics: Diagnostic[]): void {
  if (edge.spec.target === '') {
    diagnostics.push(error('empty-edge-target', edge.line, 'Edge has no target node.'));
  } else if (NAME_WITH_COLON.test(edge.spec.target) || edge.spec.target.includes('"')) {
    diagnostics.push(
      error(
        'unquoted-edge-label',
        edge.line,
        `Edge label must be double-quoted (\`-> Target : "label"\`); as written the parser reads "${edge.spec.target}" as the whole target name.`,
      ),
    );
  } else if (!edge.wellFormed) {
    diagnostics.push(
      error(
        'malformed-edge',
        edge.line,
        'Edge does not match `{Inner Source} -> Target {Inner Target} : "label"`; the parser falls back to reading the rest of the line as the target name.',
      ),
    );
  }
  if (edge.spec.label?.includes('"')) {
    diagnostics.push(
      error('quote-in-label', edge.line, 'The format has no escape sequences, so an edge label cannot contain a `"`.'),
    );
  }
  reportEdgeData(edge, diagnostics);
}

function reportEdgeData(edge: ScannedEdge, diagnostics: Diagnostic[]): void {
  if (edge.dataLine != null && edge.data.length === 0) {
    diagnostics.push(warning('empty-edge-data-block', edge.dataLine, 'A `data:` block with no fields is discarded; omit it instead.'));
  }
  const firstLineByKey = new Map<string, number>();
  for (const field of edge.data) {
    const firstLine = firstLineByKey.get(field.key);
    if (firstLine == null) firstLineByKey.set(field.key, field.line);
    else {
      diagnostics.push(
        warning('duplicate-edge-data-field', field.line, `Data field \`${field.key}\` is already declared on line ${firstLine}.`),
      );
    }
  }
}
