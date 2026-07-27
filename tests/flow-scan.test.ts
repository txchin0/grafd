import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseFlow,
  parsePos,
  type FlowDocument,
  type FlowNode,
  type GraphItem,
} from '../src/shared/flow-format.js';
import { scanFlow, type ScannedFile, type ScannedNode } from '../src/shared/flow-scan.js';
import { nodesIn } from '../src/client/flow-doc.js';

// The linter trusts the scanner to see a file exactly as parseFlow does — everything it
// accepts, and nothing it silently drops. These projections put the two side by side.

function scanShape(file: ScannedFile) {
  return {
    preambleFields: file.preamble?.fields.map(({ key, value }) => ({ key, value })) ?? null,
    preambleReferences: file.preamble?.references.map((entry) => entry.reference).filter(Boolean) ?? null,
    scopes: file.scopes.map((scope) => ({ name: scope.name, nodes: scope.nodes.map(scannedNodeShape) })),
  };
}

function scannedNodeShape(node: ScannedNode) {
  const lastValueOf = (key: string) =>
    node.properties.filter((property) => property.key === key).at(-1)?.value ?? null;
  const pos = lastValueOf('pos');
  return {
    name: node.name,
    id: lastValueOf('id'),
    pos: pos == null ? null : parsePos(pos),
    props: node.properties
      .filter((property) => property.key !== 'id' && property.key !== 'pos')
      .map(({ key, value }) => ({ key, value })),
    references: node.references.map((entry) => entry.reference).filter(Boolean),
    edges: node.edges.map((edge) => ({
      ...edge.spec,
      data: edge.dataLine == null ? null : edge.data.map(({ key, type }) => ({ key, type })),
    })),
  };
}

function parseShape(doc: FlowDocument) {
  const blocks = doc.items.filter((item): item is GraphItem => item.kind === 'graph');
  return {
    preambleFields: doc.preamble?.fields ?? null,
    preambleReferences: doc.preamble?.references ?? null,
    scopes: [
      { name: null as string | null, nodes: nodesIn(doc.items).map(parsedNodeShape) },
      ...blocks.map((block) => ({ name: block.name, nodes: nodesIn(block.items).map(parsedNodeShape) })),
    ],
  };
}

function parsedNodeShape(node: FlowNode) {
  return {
    name: node.name,
    id: node.id,
    pos: node.pos,
    props: node.props,
    references: node.references,
    edges: node.edges,
  };
}

function expectScanToMatchParse(text: string): void {
  expect(scanShape(scanFlow(text))).toEqual(parseShape(parseFlow(text)));
}

const DISCARDED_LINES = `---
name: Messy
stray line without a colon
---

  orphan property before any node

Start
  description "no colon"
    deep line with no open block
  - reference without a block
  -> Finish
      another line with no open block

Finish
`;

// An unclosed preamble leaves the parser with an empty body and the scanner with no scopes at
// all; they agree that nothing survives, so this one is checked on its own below.
const UNTERMINATED_PREAMBLE = `---
name: Truncated

Start
  -> Finish
`;

const FIXTURES: Record<string, string> = {
  'a node with every property kind': `---
name: Everything
context: [Auth]
references:
  - [Service](src/auth.ts:1-9)
---

Start
  id: 11111111-1111-4111-8111-111111111111
  pos: 10, 20, 200, 88
  description: "begins"
  references:
    - https://example.com/spec
  -> Finish : "done"
    data:
      token: string

Finish
`,
  'a local graph block': `---
name: Blocks
---

Host
  expand: Inner

graph: Inner
  Child
    -> Sibling

  Sibling
`,
  'lines the parser discards': DISCARDED_LINES,
  'braces, inner names and odd spacing': `---
name: Refinements
---

Host
  expand: Inner
  {Leaf} -> Other : "out"

Other
  -> Host {Leaf}

graph: Inner
  Leaf
`,
};

describe('scanFlow agrees with parseFlow', () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`sees the same document for ${name}`, () => expectScanToMatchParse(text));
  }

  it('sees the same document for every .flow file in the sample workspace', () => {
    for (const file of sampleWorkspaceFiles()) expectScanToMatchParse(file);
  });
});

describe('scanFlow drop reporting', () => {
  it('records each line the parser would discard, with its position', () => {
    expect(scanFlow(DISCARDED_LINES).droppedLines).toEqual([
      { line: 3, reason: 'unparsable-preamble-line', text: 'stray line without a colon' },
      { line: 6, reason: 'property-before-node', text: 'orphan property before any node' },
      { line: 9, reason: 'unparsable-property', text: 'description "no colon"' },
      { line: 10, reason: 'orphan-block-entry', text: 'deep line with no open block' },
      { line: 11, reason: 'unparsable-property', text: '- reference without a block' },
      { line: 13, reason: 'unparsable-property', text: 'another line with no open block' },
    ]);
  });

  it('reports an unterminated preamble by leaving it unclosed and the body unscanned', () => {
    const scan = scanFlow(UNTERMINATED_PREAMBLE);
    expect(parseFlow(UNTERMINATED_PREAMBLE).items).toEqual([]);
    expect(scan.preamble?.closeLine).toBeNull();
    expect(scan.scopes).toEqual([]);
  });
});

function sampleWorkspaceFiles(): string[] {
  const root = path.resolve('flows');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.flow'))
    .map((entry) => readFileSync(path.join(root, entry), 'utf8'));
}
