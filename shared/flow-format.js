// Parser and serializer for the .flow format (FLOW-SPEC.md), with one deviation from the
// spec: there is no companion .flow.meta file. Each node instead carries two editor-owned
// properties — `id` (a UUID) and `pos: x, y, w, h` (its canvas rectangle).
//
// Serialization is canonical: 2-space indentation, one blank line between top-level items,
// and per-node ordering of id, pos, authored properties, then edges. Comments are preserved
// at the position they appeared between nodes; blank lines carry no meaning and are
// normalized. The format has no escape sequences, so double quotes are not allowed inside
// labels and quoted values (see quoteValue).

const PROPERTY_LINE = /^([A-Za-z_][\w-]*):\s?(.*)$/;
const EDGE_LINE = /^->\s+(.+?)(?:\s+:\s+"(.*)")?$/;
const GRAPH_HEADER = /^graph:\s+(.+)$/;
const EXTERNAL_EXPAND_LINK = /^\[(.*)\]\((.*)\)$/;

export function parseFlow(text) {
  const lines = text.split(/\r?\n/);
  const doc = { leading: [], preamble: null, items: [] };
  let index = skipBlankLines(lines, 0);

  while (lines[index]?.trim().startsWith('#')) {
    doc.leading.push(stripCommentMarker(lines[index]));
    index = skipBlankLines(lines, index + 1);
  }

  if (lines[index]?.trim() === '---') {
    const preamble = parsePreamble(lines, index + 1);
    doc.preamble = { fields: preamble.fields };
    index = preamble.next;
  }

  doc.items = parseItems(lines, index, 0).items;
  return doc;
}

function skipBlankLines(lines, index) {
  while (index < lines.length && lines[index].trim() === '') index += 1;
  return index;
}

function parsePreamble(lines, start) {
  const fields = [];
  let index = start;
  while (index < lines.length && lines[index].trim() !== '---') {
    const match = lines[index].trim().match(PROPERTY_LINE);
    if (match) fields.push({ key: match[1], value: match[2].trim() });
    index += 1;
  }
  return { fields, next: index + 1 };
}

function parseItems(lines, start, baseIndent) {
  const items = [];
  let currentNode = null;
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
        index = graphBody.next;
        continue;
      }
      currentNode = emptyNode(trimmed);
      items.push({ kind: 'node', node: currentNode });
      index += 1;
      continue;
    }

    if (!currentNode) {
      index += 1;
      continue;
    }

    if (indent >= 4) {
      attachEdgeData(currentNode, trimmed);
    } else if (trimmed.startsWith('->')) {
      currentNode.edges.push(parseEdgeExpression(trimmed));
    } else {
      const match = trimmed.match(PROPERTY_LINE);
      if (match) assignNodeProperty(currentNode, match[1], match[2].trim());
    }
    index += 1;
  }

  return { items, next: index };
}

function stripCommentMarker(line) {
  return line.trim().replace(/^#\s?/, '');
}

export function emptyNode(name) {
  return { name, id: null, pos: null, props: [], edges: [] };
}

function assignNodeProperty(node, key, value) {
  if (key === 'id') {
    node.id = value;
  } else if (key === 'pos') {
    node.pos = parsePos(value);
  } else {
    node.props.push({ key, value });
  }
}

function attachEdgeData(node, trimmed) {
  const lastEdge = node.edges[node.edges.length - 1];
  if (!lastEdge) return;
  if (trimmed === 'data:') {
    lastEdge.data = [];
    return;
  }
  const match = trimmed.match(PROPERTY_LINE);
  if (match && lastEdge.data) lastEdge.data.push({ key: match[1], type: match[2].trim() });
}

export function parseEdgeExpression(text) {
  const match = text.trim().match(EDGE_LINE);
  if (!match) {
    return { target: text.trim().replace(/^->\s*/, ''), label: null, data: null };
  }
  return { target: match[1].trim(), label: match[2] ?? null, data: null };
}

export function serializeEdgeExpression(edge) {
  const label = edge.label ? ` : "${edge.label}"` : '';
  return `-> ${edge.target}${label}`;
}

function parsePos(value) {
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function formatPos(pos) {
  return [pos.x, pos.y, pos.w, pos.h].map(Math.round).join(', ');
}

export function serializeFlow(doc) {
  const blocks = [];
  if (doc.leading?.length) {
    blocks.push(doc.leading.map((text) => `# ${text}`.trimEnd()).join('\n'));
  }
  if (doc.preamble) {
    const fieldLines = doc.preamble.fields.map((field) => `${field.key}: ${field.value}`);
    blocks.push(['---', ...fieldLines, '---'].join('\n'));
  }
  for (const item of doc.items) blocks.push(serializeItem(item, ''));
  return blocks.join('\n\n') + '\n';
}

function serializeItem(item, indent) {
  if (item.kind === 'comment') return `${indent}# ${item.text}`.trimEnd();
  if (item.kind === 'graph') {
    const body = item.items.map((inner) => serializeItem(inner, indent + '  '));
    return `${indent}graph: ${item.name}\n` + body.join('\n\n');
  }
  return serializeNode(item.node, indent);
}

function serializeNode(node, indent) {
  const lines = [`${indent}${node.name}`];
  const propIndent = indent + '  ';
  if (node.id) lines.push(`${propIndent}id: ${node.id}`);
  if (node.pos) lines.push(`${propIndent}pos: ${formatPos(node.pos)}`);
  for (const prop of node.props) lines.push(`${propIndent}${prop.key}: ${prop.value}`);
  for (const edge of node.edges) {
    lines.push(`${propIndent}${serializeEdgeExpression(edge)}`);
    if (edge.data?.length) {
      lines.push(`${propIndent}  data:`);
      for (const field of edge.data) lines.push(`${propIndent}    ${field.key}: ${field.type}`);
    }
  }
  return lines.join('\n');
}

export function getProp(node, key) {
  return node.props.find((prop) => prop.key === key)?.value ?? null;
}

export function setProp(node, key, value) {
  if (value == null || value === '') {
    node.props = node.props.filter((prop) => prop.key !== key);
    return;
  }
  const existing = node.props.find((prop) => prop.key === key);
  if (existing) existing.value = value;
  else node.props.push({ key, value });
}

export function getPreambleField(doc, key) {
  return doc.preamble?.fields.find((field) => field.key === key)?.value ?? null;
}

export function setPreambleField(doc, key, value) {
  if (!doc.preamble) doc.preamble = { fields: [] };
  const fields = doc.preamble.fields;
  if (value == null || value === '') {
    doc.preamble.fields = fields.filter((field) => field.key !== key);
    return;
  }
  const existing = fields.find((field) => field.key === key);
  if (existing) existing.value = value;
  else fields.push({ key, value });
}

export function unquote(value) {
  if (value == null) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function quoteValue(text) {
  return `"${text.replace(/"/g, '’')}"`;
}

export function parseListValue(value) {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function formatListValue(entries) {
  return `[${entries.join(', ')}]`;
}

export function parseExpandLink(value) {
  const match = value?.trim().match(EXTERNAL_EXPAND_LINK);
  if (!match) return null;
  return { label: match[1], path: match[2] };
}

// Expand-link paths are relative to the .flow file that contains them; resolves against the
// containing file's directory using forward-slash portable paths.
export function resolveLinkPath(containingFilePath, relativePath) {
  const segments = containingFilePath ? containingFilePath.split('/').slice(0, -1) : [];
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

// Node names may not contain ": " (spec §3.2) and the format is line-based, so names are
// collapsed to a single line with that sequence rewritten.
export function sanitizeName(rawName) {
  return rawName.replace(/\s+/g, ' ').replace(/:(\s|$)/g, ' -$1').replace(/\s+/g, ' ').trim();
}

export function collapseToSingleLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function uniqueName(takenNames, baseName) {
  const base = baseName || 'Untitled';
  if (!takenNames.has(base)) return base;
  let counter = 2;
  while (takenNames.has(`${base} ${counter}`)) counter += 1;
  return `${base} ${counter}`;
}

export function newUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}
