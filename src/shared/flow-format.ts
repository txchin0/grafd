// Parser and serializer for the .flow format (FLOW-SPEC.md), with one deviation from the
// spec: there is no companion .flow.meta file. Each node instead carries two editor-owned
// properties — `id` (a UUID) and `pos: x, y, w, h` (its canvas rectangle).
//
// Serialization is canonical: 2-space indentation, one blank line between top-level items,
// and per-node ordering of id, pos, authored properties, the references block, then edges.
// Block-valued properties (an edge's `data:`, a node's `references:`) are indented one level
// under the line that owns them. Comments are preserved
// at the position they appeared between nodes; blank lines carry no meaning and are
// normalized. The format has no escape sequences, so double quotes are not allowed inside
// labels and quoted values (see quoteValue).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface KeyValue {
  key: string;
  value: string;
}

export interface EdgeDataField {
  key: string;
  type: string;
}

export interface Reference {
  label: string | null;
  target: string;
}

export interface EdgeSpec {
  target: string;
  innerSource: string | null;
  innerTarget: string | null;
  label: string | null;
  data: EdgeDataField[] | null;
}

export interface FlowNode {
  name: string;
  id: string | null;
  pos: Rect | null;
  props: KeyValue[];
  references: Reference[];
  edges: EdgeSpec[];
}

export interface CommentItem {
  kind: 'comment';
  text: string;
}

export interface NodeItem {
  kind: 'node';
  node: FlowNode;
}

export interface GraphItem {
  kind: 'graph';
  name: string;
  items: FlowItem[];
}

export type FlowItem = CommentItem | NodeItem | GraphItem;

export interface Preamble {
  fields: KeyValue[];
  references: Reference[];
}

export interface FlowDocument {
  leading: string[];
  preamble: Preamble | null;
  items: FlowItem[];
}

export interface ExpandLink {
  label: string;
  path: string;
}

const PROPERTY_LINE = /^([A-Za-z_][\w-]*):\s?(.*)$/;
const EDGE_LINE = /^(?:\{([^}]*)\}\s+)?->\s+([^{]+?)(?:\s*\{([^}]*)\})?(?:\s+:\s+"(.*)")?$/;
const GRAPH_HEADER = /^graph:\s+(.+)$/;
const MARKDOWN_LINK = /^\[(.*)\]\((.*)\)$/;
const REFERENCE_ENTRY = /^-\s+(.*)$/;

// An indented block belongs to the line directly above it: `data:` under an edge, `- entry`
// lines under a `references:` key. The parser tracks which one is open as it walks a node.
type OpenBlock = 'edge-data' | 'references' | null;

export function parseFlow(text: string): FlowDocument {
  const lines = text.split(/\r?\n/);
  const doc: FlowDocument = { leading: [], preamble: null, items: [] };
  let index = skipBlankLines(lines, 0);

  while (lines[index]?.trim().startsWith('#')) {
    doc.leading.push(stripCommentMarker(lines[index]));
    index = skipBlankLines(lines, index + 1);
  }

  if (lines[index]?.trim() === '---') {
    const preamble = parsePreamble(lines, index + 1);
    doc.preamble = { fields: preamble.fields, references: preamble.references };
    index = preamble.next;
  }

  doc.items = parseItems(lines, index, 0).items;
  return doc;
}

function skipBlankLines(lines: string[], index: number): number {
  while (index < lines.length && lines[index].trim() === '') index += 1;
  return index;
}

function parsePreamble(
  lines: string[],
  start: number,
): { fields: KeyValue[]; references: Reference[]; next: number } {
  const fields: KeyValue[] = [];
  const references: Reference[] = [];
  let referenceBlockIsOpen = false;
  let index = start;

  while (index < lines.length && lines[index].trim() !== '---') {
    const trimmed = lines[index].trim();
    const entry = trimmed.match(REFERENCE_ENTRY);
    if (referenceBlockIsOpen && entry) {
      pushReference(references, entry[1]);
      index += 1;
      continue;
    }
    const match = trimmed.match(PROPERTY_LINE);
    if (match) {
      const value = match[2].trim();
      referenceBlockIsOpen = match[1] === 'references';
      if (referenceBlockIsOpen) pushReference(references, value);
      else fields.push({ key: match[1], value });
    }
    index += 1;
  }
  return { fields, references, next: index + 1 };
}

function pushReference(references: Reference[], entryText: string): void {
  const reference = parseReference(entryText);
  if (reference) references.push(reference);
}

function parseItems(lines: string[], start: number, baseIndent: number): { items: FlowItem[]; next: number } {
  const items: FlowItem[] = [];
  let currentNode: FlowNode | null = null;
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

    if (trimmed.startsWith('#')) {
      items.push({ kind: 'comment', text: stripCommentMarker(trimmed) });
      index += 1;
      continue;
    }

    if (indent === 0) {
      const graphMatch = baseIndent === 0 ? line.match(GRAPH_HEADER) : null;
      if (graphMatch) {
        const graphBody = parseItems(lines, index + 1, baseIndent + 2);
        items.push({ kind: 'graph', name: graphMatch[1].trim(), items: graphBody.items });
        currentNode = null;
        openBlock = null;
        index = graphBody.next;
        continue;
      }
      currentNode = emptyNode(trimmed);
      openBlock = null;
      items.push({ kind: 'node', node: currentNode });
      index += 1;
      continue;
    }

    if (!currentNode) {
      index += 1;
      continue;
    }

    if (indent >= 4) {
      if (openBlock === 'references') attachReference(currentNode, trimmed);
      else if (openBlock === 'edge-data') attachEdgeData(currentNode, trimmed);
    } else if (isEdgeLine(trimmed)) {
      currentNode.edges.push(parseEdgeExpression(trimmed));
      openBlock = 'edge-data';
    } else {
      const match = trimmed.match(PROPERTY_LINE);
      if (match) openBlock = assignNodeProperty(currentNode, match[1], match[2].trim());
    }
    index += 1;
  }

  return { items, next: index };
}

function stripCommentMarker(line: string): string {
  return line.trim().replace(/^#\s?/, '');
}

export function emptyNode(name: string): FlowNode {
  return { name, id: null, pos: null, props: [], references: [], edges: [] };
}

// Returns the block this property opens, so the caller knows where the lines indented
// beneath it belong. `references:` normally carries no value, but a hand-written one-line
// form is kept rather than dropped.
function assignNodeProperty(node: FlowNode, key: string, value: string): OpenBlock {
  if (key === 'id') {
    node.id = value;
  } else if (key === 'pos') {
    node.pos = parsePos(value);
  } else if (key === 'references') {
    pushReference(node.references, value);
    return 'references';
  } else {
    node.props.push({ key, value });
  }
  return null;
}

function attachReference(node: FlowNode, trimmed: string): void {
  const entry = trimmed.match(REFERENCE_ENTRY);
  if (entry) pushReference(node.references, entry[1]);
}

export function parseReference(entryText: string): Reference | null {
  const text = entryText.trim();
  if (text === '') return null;
  const link = text.match(MARKDOWN_LINK);
  if (!link) return { label: null, target: text };
  const target = link[2].trim();
  return target === '' ? null : { label: link[1].trim() || null, target };
}

export function formatReference(reference: Reference): string {
  return reference.label ? `[${reference.label}](${reference.target})` : reference.target;
}

function attachEdgeData(node: FlowNode, trimmed: string): void {
  const lastEdge = node.edges[node.edges.length - 1];
  if (!lastEdge) return;
  if (trimmed === 'data:') {
    lastEdge.data = [];
    return;
  }
  const match = trimmed.match(PROPERTY_LINE);
  if (match && lastEdge.data) lastEdge.data.push({ key: match[1], type: match[2].trim() });
}

// An edge line is `-> Target` or, with a §5.8 inner-source prefix, `{Inner Source} -> Target`.
// The leading brace group is what distinguishes it from a `key: value` property line.
export function isEdgeLine(trimmed: string): boolean {
  return trimmed.startsWith('->') || /^\{[^}]*\}\s+->/.test(trimmed);
}

export function parseEdgeExpression(text: string): EdgeSpec {
  const match = text.trim().match(EDGE_LINE);
  if (!match) {
    return {
      target: text.trim().replace(/^->\s*/, ''),
      innerSource: null,
      innerTarget: null,
      label: null,
      data: null,
    };
  }
  return {
    target: match[2].trim(),
    innerSource: match[1]?.trim() || null,
    innerTarget: match[3]?.trim() || null,
    label: match[4] ?? null,
    data: null,
  };
}

export function serializeEdgeExpression(edge: EdgeSpec): string {
  const source = edge.innerSource ? `{${edge.innerSource}} ` : '';
  const inner = edge.innerTarget ? ` {${edge.innerTarget}}` : '';
  const label = edge.label ? ` : "${edge.label}"` : '';
  return `${source}-> ${edge.target}${inner}${label}`;
}

function parsePos(value: string): Rect | null {
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function formatPos(pos: Rect): string {
  return [pos.x, pos.y, pos.w, pos.h].map(Math.round).join(', ');
}

export function serializeFlow(doc: FlowDocument): string {
  const blocks: string[] = [];
  if (doc.leading?.length) {
    blocks.push(doc.leading.map((text) => `# ${text}`.trimEnd()).join('\n'));
  }
  if (doc.preamble) {
    const fieldLines = doc.preamble.fields.map((field) => `${field.key}: ${field.value}`);
    const referenceLines = referenceBlockLines(doc.preamble.references, '');
    blocks.push(['---', ...fieldLines, ...referenceLines, '---'].join('\n'));
  }
  for (const item of doc.items) blocks.push(serializeItem(item, ''));
  return blocks.join('\n\n') + '\n';
}

function serializeItem(item: FlowItem, indent: string): string {
  if (item.kind === 'comment') return `${indent}# ${item.text}`.trimEnd();
  if (item.kind === 'graph') {
    const body = item.items.map((inner) => serializeItem(inner, indent + '  '));
    return `${indent}graph: ${item.name}\n` + body.join('\n\n');
  }
  return serializeNode(item.node, indent);
}

// Block-valued properties trail the single-line ones so those stay in one readable column,
// and an empty block is omitted entirely (SAVE-GUIDE "Writing .flow Files").
function referenceBlockLines(references: Reference[], indent: string): string[] {
  if (references.length === 0) return [];
  return [
    `${indent}references:`,
    ...references.map((reference) => `${indent}  - ${formatReference(reference)}`),
  ];
}

function serializeNode(node: FlowNode, indent: string): string {
  const lines = [`${indent}${node.name}`];
  const propIndent = indent + '  ';
  if (node.id) lines.push(`${propIndent}id: ${node.id}`);
  if (node.pos) lines.push(`${propIndent}pos: ${formatPos(node.pos)}`);
  for (const prop of node.props) lines.push(`${propIndent}${prop.key}: ${prop.value}`);
  lines.push(...referenceBlockLines(node.references, propIndent));
  for (const edge of node.edges) {
    lines.push(`${propIndent}${serializeEdgeExpression(edge)}`);
    if (edge.data?.length) {
      lines.push(`${propIndent}  data:`);
      for (const field of edge.data) lines.push(`${propIndent}    ${field.key}: ${field.type}`.trimEnd());
    }
  }
  return lines.join('\n');
}

export function getProp(node: FlowNode, key: string): string | null {
  return node.props.find((prop) => prop.key === key)?.value ?? null;
}

export function setProp(node: FlowNode, key: string, value: string | null): void {
  if (value == null || value === '') {
    node.props = node.props.filter((prop) => prop.key !== key);
    return;
  }
  const existing = node.props.find((prop) => prop.key === key);
  if (existing) existing.value = value;
  else node.props.push({ key, value });
}

export function getPreambleField(doc: FlowDocument, key: string): string | null {
  return doc.preamble?.fields.find((field) => field.key === key)?.value ?? null;
}

export function setPreambleField(doc: FlowDocument, key: string, value: string | null): void {
  if (!doc.preamble) doc.preamble = { fields: [], references: [] };
  const fields = doc.preamble.fields;
  if (value == null || value === '') {
    doc.preamble.fields = fields.filter((field) => field.key !== key);
    return;
  }
  const existing = fields.find((field) => field.key === key);
  if (existing) existing.value = value;
  else fields.push({ key, value });
}

export function unquote(value: string | null | undefined): string {
  if (value == null) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function quoteValue(text: string): string {
  return `"${text.replace(/"/g, '’')}"`;
}

export function parseListValue(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function formatListValue(entries: string[]): string {
  return `[${entries.join(', ')}]`;
}

export function parseExpandLink(value: string | null | undefined): ExpandLink | null {
  const match = value?.trim().match(MARKDOWN_LINK);
  if (!match) return null;
  return { label: match[1], path: match[2] };
}

// Expand-link paths are relative to the .flow file that contains them; resolves against the
// containing file's directory using forward-slash portable paths.
export function resolveLinkPath(containingFilePath: string | null, relativePath: string): string {
  const segments = containingFilePath ? containingFilePath.split('/').slice(0, -1) : [];
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

// Absolute workspace path of an external expand target, or null for local / missing expands.
export function resolvedExpandPath(
  expandValue: string | null | undefined,
  containingPath: string | null,
): string | null {
  const link = parseExpandLink(expandValue);
  if (!link) return null;
  return resolveLinkPath(containingPath, link.path);
}

// For `expand: [Label](file.flow)` the target file's preamble *is* the node definition
// (SAVE-GUIDE). Prefer its description; fall back to a legacy prop on the referencing node.
export function descriptionForNode(node: FlowNode, expandDoc: FlowDocument | null): string {
  if (expandDoc) {
    const fromPreamble = getPreambleField(expandDoc, 'description');
    if (fromPreamble != null && fromPreamble !== '') return unquote(fromPreamble);
  }
  return unquote(getProp(node, 'description'));
}

// Writes description to the expand target's preamble when one is supplied, clearing any
// duplicate on the referencing node so the definition stays in one place. Callers that
// span two documents must commit each side separately — this only mutates the ASTs.
export function writeDescriptionForNode(
  node: FlowNode,
  expandDoc: FlowDocument | null,
  quotedValue: string | null,
): void {
  if (expandDoc) {
    setPreambleField(expandDoc, 'description', quotedValue);
    setProp(node, 'description', null);
    return;
  }
  setProp(node, 'description', quotedValue);
}

export function setPreambleReferences(doc: FlowDocument, references: Reference[]): void {
  if (!doc.preamble) doc.preamble = { fields: [], references: [] };
  doc.preamble.references = references;
}

// References follow description across an `expand` link: the target file's preamble is the
// node definition, so that is where a referencing node's references live (SAVE-GUIDE
// "Cross-File Resolution").
export function referencesForNode(node: FlowNode, expandDoc: FlowDocument | null): Reference[] {
  const fromPreamble = expandDoc?.preamble?.references ?? [];
  return fromPreamble.length > 0 ? fromPreamble : node.references;
}

export function writeReferencesForNode(
  node: FlowNode,
  expandDoc: FlowDocument | null,
  references: Reference[],
): void {
  if (expandDoc) {
    setPreambleReferences(expandDoc, references);
    node.references = [];
    return;
  }
  node.references = references;
}

// Node names may not contain ": " or curly braces (spec §3.2); braces mark an inner
// subgraph target on edges. The format is line-based, so names are collapsed to one line.
export function sanitizeName(rawName: string): string {
  return rawName
    .replace(/\s+/g, ' ')
    .replace(/:(\s|$)/g, ' -$1')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Edge data keys are read back with PROPERTY_LINE, so a key that is not a single identifier
// token would be silently dropped on the next parse.
export function sanitizeDataKey(rawKey: string): string {
  const cleaned = rawKey.trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '');
  if (cleaned === '') return '';
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

export function collapseToSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function uniqueName(takenNames: Set<string>, baseName: string): string {
  const base = baseName || 'Untitled';
  if (!takenNames.has(base)) return base;
  let counter = 2;
  while (takenNames.has(`${base} ${counter}`)) counter += 1;
  return `${base} ${counter}`;
}

export function newUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}
