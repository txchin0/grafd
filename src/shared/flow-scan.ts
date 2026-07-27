// A positioned scan of a .flow file, for the linter.
//
// parseFlow is deliberately tolerant: it never reports an error and silently discards every
// line it does not recognize, which is exactly the failure the linter has to surface. This
// scanner walks the same line grammar with the same branch structure as parseItems, but keeps
// the line number of everything it accepts and records every line the parser would drop.
//
// The two must classify lines identically — the patterns come from flow-format.ts for that
// reason, and tests/flow-scan.test.ts asserts a scan and a parse of the same text agree.

import {
  EDGE_LINE,
  GRAPH_HEADER,
  PROPERTY_LINE,
  REFERENCE_ENTRY,
  isEdgeLine,
  parseEdgeExpression,
  parseReference,
  type EdgeSpec,
  type Reference,
} from './flow-format.js';

export type DropReason =
  | 'property-before-node'
  | 'orphan-block-entry'
  | 'malformed-reference-entry'
  | 'edge-data-field-without-data-key'
  | 'unparsable-property'
  | 'unparsable-preamble-line';

export interface DroppedLine {
  line: number;
  reason: DropReason;
  text: string;
}

export interface ScannedProperty {
  key: string;
  value: string;
  line: number;
}

export interface ScannedReference {
  text: string;
  reference: Reference | null;
  line: number;
}

export interface ScannedDataField {
  key: string;
  type: string;
  line: number;
}

export interface ScannedEdge {
  text: string;
  line: number;
  spec: EdgeSpec;
  /** Whether the line matches the edge grammar, rather than falling back to a bare target. */
  wellFormed: boolean;
  dataLine: number | null;
  data: ScannedDataField[];
}

export interface ScannedNode {
  name: string;
  line: number;
  properties: ScannedProperty[];
  referencesLine: number | null;
  references: ScannedReference[];
  edges: ScannedEdge[];
}

/** A graph scope: the file body itself (name null) or one local `graph:` block. */
export interface ScannedScope {
  name: string | null;
  line: number | null;
  nodes: ScannedNode[];
}

export interface ScannedPreamble {
  openLine: number;
  closeLine: number | null;
  fields: ScannedProperty[];
  referencesLine: number | null;
  references: ScannedReference[];
}

export interface ScannedFile {
  lines: string[];
  preamble: ScannedPreamble | null;
  scopes: ScannedScope[];
  droppedLines: DroppedLine[];
}

type OpenBlock = 'edge-data' | 'references' | null;

export function scanFlow(text: string): ScannedFile {
  const lines = text.split(/\r?\n/);
  const file: ScannedFile = { lines, preamble: null, scopes: [], droppedLines: [] };
  let index = skipBlankLines(lines, 0);

  while (lines[index]?.trim().startsWith('#')) {
    index = skipBlankLines(lines, index + 1);
  }

  if (lines[index]?.trim() === '---') {
    const preamble = scanPreamble(lines, index, file);
    file.preamble = preamble.preamble;
    index = preamble.next;
  }

  // An unclosed preamble swallows the rest of the file; there is no body left to scan.
  if (file.preamble && file.preamble.closeLine == null) return file;

  const rootScope: ScannedScope = { name: null, line: null, nodes: [] };
  file.scopes.push(rootScope);
  scanItems(lines, index, 0, rootScope, file);
  return file;
}

export function allScannedNodes(file: ScannedFile): ScannedNode[] {
  return file.scopes.flatMap((scope) => scope.nodes);
}

export function scopeByName(file: ScannedFile, name: string): ScannedScope | null {
  return file.scopes.find((scope) => scope.name === name) ?? null;
}

export function rootScope(file: ScannedFile): ScannedScope | null {
  return file.scopes.find((scope) => scope.name == null) ?? null;
}

export function findProperty(node: ScannedNode, key: string): ScannedProperty | null {
  return node.properties.find((property) => property.key === key) ?? null;
}

function skipBlankLines(lines: string[], index: number): number {
  while (index < lines.length && lines[index].trim() === '') index += 1;
  return index;
}

function drop(file: ScannedFile, line: number, reason: DropReason, text: string): void {
  file.droppedLines.push({ line, reason, text });
}

function scanPreamble(
  lines: string[],
  openIndex: number,
  file: ScannedFile,
): { preamble: ScannedPreamble; next: number } {
  const preamble: ScannedPreamble = {
    openLine: openIndex + 1,
    closeLine: null,
    fields: [],
    referencesLine: null,
    references: [],
  };
  let referenceBlockIsOpen = false;
  let index = openIndex + 1;

  while (index < lines.length && lines[index].trim() !== '---') {
    const trimmed = lines[index].trim();
    const lineNumber = index + 1;
    index += 1;

    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const entry = trimmed.match(REFERENCE_ENTRY);
    if (referenceBlockIsOpen && entry) {
      preamble.references.push(scannedReference(entry[1], lineNumber));
      continue;
    }
    const match = trimmed.match(PROPERTY_LINE);
    if (!match) {
      drop(file, lineNumber, 'unparsable-preamble-line', trimmed);
      continue;
    }
    const value = match[2].trim();
    referenceBlockIsOpen = match[1] === 'references';
    if (!referenceBlockIsOpen) {
      preamble.fields.push({ key: match[1], value, line: lineNumber });
      continue;
    }
    preamble.referencesLine = lineNumber;
    if (value !== '') preamble.references.push(scannedReference(value, lineNumber));
  }

  if (index < lines.length) preamble.closeLine = index + 1;
  return { preamble, next: index + 1 };
}

function scanItems(
  lines: string[],
  start: number,
  baseIndent: number,
  scope: ScannedScope,
  file: ScannedFile,
): number {
  let currentNode: ScannedNode | null = null;
  let openBlock: OpenBlock = null;
  let index = start;

  while (index < lines.length) {
    const rawLine = lines[index];
    if (rawLine.trim() === '') {
      index += 1;
      continue;
    }
    const rawIndent = rawLine.search(/\S/);
    if (rawIndent < baseIndent) break;

    const line = rawLine.slice(baseIndent);
    const indent = rawIndent - baseIndent;
    const trimmed = line.trim();
    const lineNumber = index + 1;

    if (trimmed.startsWith('#')) {
      index += 1;
      continue;
    }

    if (indent === 0) {
      const graphMatch = baseIndent === 0 ? line.match(GRAPH_HEADER) : null;
      if (graphMatch) {
        const block: ScannedScope = { name: graphMatch[1].trim(), line: lineNumber, nodes: [] };
        file.scopes.push(block);
        index = scanItems(lines, index + 1, baseIndent + 2, block, file);
        currentNode = null;
        openBlock = null;
        continue;
      }
      currentNode = emptyScannedNode(trimmed, lineNumber);
      openBlock = null;
      scope.nodes.push(currentNode);
      index += 1;
      continue;
    }

    if (!currentNode) {
      drop(file, lineNumber, 'property-before-node', trimmed);
      index += 1;
      continue;
    }

    if (indent >= 4) {
      if (openBlock === 'references') attachReference(currentNode, trimmed, lineNumber, file);
      else if (openBlock === 'edge-data') attachDataField(currentNode, trimmed, lineNumber, file);
      else drop(file, lineNumber, 'orphan-block-entry', trimmed);
    } else if (isEdgeLine(trimmed)) {
      currentNode.edges.push(scanEdge(trimmed, lineNumber));
      openBlock = 'edge-data';
    } else {
      const match = trimmed.match(PROPERTY_LINE);
      if (!match) drop(file, lineNumber, 'unparsable-property', trimmed);
      else openBlock = assignProperty(currentNode, match[1], match[2].trim(), lineNumber);
    }
    index += 1;
  }

  return index;
}

function emptyScannedNode(name: string, line: number): ScannedNode {
  return { name, line, properties: [], referencesLine: null, references: [], edges: [] };
}

function scannedReference(text: string, line: number): ScannedReference {
  return { text, reference: parseReference(text), line };
}

function assignProperty(node: ScannedNode, key: string, value: string, line: number): OpenBlock {
  if (key !== 'references') {
    node.properties.push({ key, value, line });
    return null;
  }
  node.referencesLine = line;
  if (value !== '') node.references.push(scannedReference(value, line));
  return 'references';
}

function attachReference(node: ScannedNode, trimmed: string, line: number, file: ScannedFile): void {
  const entry = trimmed.match(REFERENCE_ENTRY);
  if (!entry) {
    drop(file, line, 'malformed-reference-entry', trimmed);
    return;
  }
  node.references.push(scannedReference(entry[1], line));
}

function attachDataField(node: ScannedNode, trimmed: string, line: number, file: ScannedFile): void {
  const lastEdge = node.edges[node.edges.length - 1];
  if (!lastEdge) {
    drop(file, line, 'orphan-block-entry', trimmed);
    return;
  }
  if (trimmed === 'data:') {
    lastEdge.dataLine = line;
    return;
  }
  const match = trimmed.match(PROPERTY_LINE);
  if (!match) {
    drop(file, line, 'unparsable-property', trimmed);
    return;
  }
  if (lastEdge.dataLine == null) {
    drop(file, line, 'edge-data-field-without-data-key', trimmed);
    return;
  }
  lastEdge.data.push({ key: match[1], type: match[2].trim(), line });
}

function scanEdge(trimmed: string, line: number): ScannedEdge {
  return {
    text: trimmed,
    line,
    spec: parseEdgeExpression(trimmed),
    wellFormed: EDGE_LINE.test(trimmed),
    dataLine: null,
    data: [],
  };
}
