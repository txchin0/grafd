import { describe, expect, it } from 'vitest';
import {
  parseFlow,
  serializeFlow,
  parseEdgeExpression,
  serializeEdgeExpression,
  emptyNode,
  getProp,
  setProp,
  getPreambleField,
  setPreambleField,
  unquote,
  quoteValue,
  parseListValue,
  formatListValue,
  parseExpandLink,
  resolveLinkPath,
  resolvedExpandPath,
  descriptionForNode,
  writeDescriptionForNode,
  sanitizeName,
  collapseToSingleLine,
  uniqueName,
  newUuid,
  type NodeItem,
  type GraphItem,
} from '../src/shared/flow-format.js';

const MESSY_DOCUMENT = `# Checkout flow
# second line


---
name: checkout
entrypoint: true
---


Start
  id: abc
  pos: 10, 20, 200, 88
  description: "Begin here"
  -> Validate : "ok"

# a comment between nodes


Validate
  -> Charge
    data:
      amount: number
      currency: string

graph: Details

  Inner
    -> Other
`;

const CANONICAL_DOCUMENT = `# Checkout flow
# second line

---
name: checkout
entrypoint: true
---

Start
  id: abc
  pos: 10, 20, 200, 88
  description: "Begin here"
  -> Validate : "ok"

# a comment between nodes

Validate
  -> Charge
    data:
      amount: number
      currency: string

graph: Details
  Inner
    -> Other
`;

describe('parseFlow', () => {
  const doc = parseFlow(MESSY_DOCUMENT);

  it('collects leading comments', () => {
    expect(doc.leading).toEqual(['Checkout flow', 'second line']);
  });

  it('parses preamble fields', () => {
    expect(doc.preamble?.fields).toEqual([
      { key: 'name', value: 'checkout' },
      { key: 'entrypoint', value: 'true' },
    ]);
  });

  it('parses nodes with editor-owned id and pos properties', () => {
    const start = (doc.items[0] as NodeItem).node;
    expect(start.name).toBe('Start');
    expect(start.id).toBe('abc');
    expect(start.pos).toEqual({ x: 10, y: 20, w: 200, h: 88 });
    expect(start.props).toEqual([{ key: 'description', value: '"Begin here"' }]);
  });

  it('parses labeled edges', () => {
    const start = (doc.items[0] as NodeItem).node;
    expect(start.edges).toEqual([{ target: 'Validate', label: 'ok', innerTarget: null, data: null }]);
  });

  it('preserves comments between nodes as items', () => {
    expect(doc.items[1]).toEqual({ kind: 'comment', text: 'a comment between nodes' });
  });

  it('parses edge data blocks', () => {
    const validate = (doc.items[2] as NodeItem).node;
    expect(validate.edges[0].data).toEqual([
      { key: 'amount', type: 'number' },
      { key: 'currency', type: 'string' },
    ]);
  });

  it('parses graph blocks with nested nodes', () => {
    const graph = doc.items[3] as GraphItem;
    expect(graph.kind).toBe('graph');
    expect(graph.name).toBe('Details');
    const inner = (graph.items[0] as NodeItem).node;
    expect(inner.name).toBe('Inner');
    expect(inner.edges).toEqual([{ target: 'Other', label: null, innerTarget: null, data: null }]);
  });

  it('treats a malformed pos as absent', () => {
    const malformed = parseFlow('Node\n  pos: 1, 2\n');
    expect((malformed.items[0] as NodeItem).node.pos).toBeNull();
  });
});

describe('serializeFlow', () => {
  it('normalizes a messy document into canonical form', () => {
    expect(serializeFlow(parseFlow(MESSY_DOCUMENT))).toBe(CANONICAL_DOCUMENT);
  });

  it('round-trips a canonical document unchanged', () => {
    expect(serializeFlow(parseFlow(CANONICAL_DOCUMENT))).toBe(CANONICAL_DOCUMENT);
  });

  it('rounds pos to integers', () => {
    const doc = parseFlow('Node\n  pos: 1.4, 2.6, 200.2, 88.5\n');
    expect(serializeFlow(doc)).toBe('Node\n  pos: 1, 3, 200, 89\n');
  });
});

describe('edge expressions', () => {
  it('parses a bare target', () => {
    expect(parseEdgeExpression('-> Target')).toEqual({
      target: 'Target',
      innerTarget: null,
      label: null,
      data: null,
    });
  });

  it('parses a labeled edge', () => {
    expect(parseEdgeExpression('-> Target : "on success"')).toEqual({
      target: 'Target',
      innerTarget: null,
      label: 'on success',
      data: null,
    });
  });

  it('parses an inner subgraph target', () => {
    expect(parseEdgeExpression('-> Process Payment {Charge Card}')).toEqual({
      target: 'Process Payment',
      innerTarget: 'Charge Card',
      label: null,
      data: null,
    });
  });

  it('parses an inner target with a label', () => {
    expect(parseEdgeExpression('-> Process Payment {Charge Card} : "cart valid"')).toEqual({
      target: 'Process Payment',
      innerTarget: 'Charge Card',
      label: 'cart valid',
      data: null,
    });
  });

  it('serializes with and without labels and inner targets', () => {
    expect(serializeEdgeExpression({ target: 'T', innerTarget: null, label: null, data: null })).toBe('-> T');
    expect(serializeEdgeExpression({ target: 'T', innerTarget: null, label: 'go', data: null })).toBe('-> T : "go"');
    expect(serializeEdgeExpression({
      target: 'Process Payment',
      innerTarget: 'Charge Card',
      label: null,
      data: null,
    })).toBe('-> Process Payment {Charge Card}');
    expect(serializeEdgeExpression({
      target: 'Process Payment',
      innerTarget: 'Charge Card',
      label: 'cart valid',
      data: null,
    })).toBe('-> Process Payment {Charge Card} : "cart valid"');
  });

  it('round-trips inner targets through parse and serialize', () => {
    const text = '-> Sub {Inner} : "label"';
    expect(serializeEdgeExpression(parseEdgeExpression(text))).toBe(text);
  });
});

describe('node properties', () => {
  it('gets and sets props', () => {
    const node = emptyNode('N');
    expect(getProp(node, 'expand')).toBeNull();
    setProp(node, 'expand', 'Sub');
    expect(getProp(node, 'expand')).toBe('Sub');
    setProp(node, 'expand', 'Other');
    expect(getProp(node, 'expand')).toBe('Other');
    expect(node.props).toHaveLength(1);
  });

  it('removes a prop when set to null or empty', () => {
    const node = emptyNode('N');
    setProp(node, 'expand', 'Sub');
    setProp(node, 'expand', null);
    expect(getProp(node, 'expand')).toBeNull();
    setProp(node, 'expand', 'Sub');
    setProp(node, 'expand', '');
    expect(getProp(node, 'expand')).toBeNull();
  });
});

describe('preamble fields', () => {
  it('creates the preamble on first set', () => {
    const doc = parseFlow('Node\n');
    expect(doc.preamble).toBeNull();
    setPreambleField(doc, 'name', 'flow');
    expect(getPreambleField(doc, 'name')).toBe('flow');
  });

  it('removes fields when set to null', () => {
    const doc = parseFlow('---\nname: flow\n---\n');
    setPreambleField(doc, 'name', null);
    expect(getPreambleField(doc, 'name')).toBeNull();
  });
});

describe('value helpers', () => {
  it('unquotes quoted values and passes through bare ones', () => {
    expect(unquote('"hello"')).toBe('hello');
    expect(unquote('  bare  ')).toBe('bare');
    expect(unquote(null)).toBe('');
  });

  it('quotes values and rewrites embedded double quotes', () => {
    expect(quoteValue('say "hi"')).toBe('"say ’hi’"');
  });

  it('parses and formats list values', () => {
    expect(parseListValue('[Auth, Cart]')).toEqual(['Auth', 'Cart']);
    expect(parseListValue(null)).toEqual([]);
    expect(formatListValue(['Auth', 'Cart'])).toBe('[Auth, Cart]');
  });

  it('parses expand links', () => {
    expect(parseExpandLink('[Login](auth/login.flow)')).toEqual({ label: 'Login', path: 'auth/login.flow' });
    expect(parseExpandLink('PlainGraphName')).toBeNull();
    expect(parseExpandLink(null)).toBeNull();
  });
});

describe('resolveLinkPath', () => {
  it('resolves relative to the containing file directory', () => {
    expect(resolveLinkPath('flows/main.flow', 'sub.flow')).toBe('flows/sub.flow');
    expect(resolveLinkPath('flows/main.flow', './sub.flow')).toBe('flows/sub.flow');
    expect(resolveLinkPath('flows/main.flow', '../other/sub.flow')).toBe('other/sub.flow');
    expect(resolveLinkPath(null, 'sub.flow')).toBe('sub.flow');
  });
});

describe('external expand description', () => {
  it('resolves the expand target path and ignores local expands', () => {
    expect(resolvedExpandPath('[Dashboard](dashboard.flow)', 'flows/main.flow')).toBe('flows/dashboard.flow');
    expect(resolvedExpandPath('Local Graph', 'flows/main.flow')).toBeNull();
  });

  it('prefers the expand target preamble over a legacy node prop', () => {
    const parent = parseFlow('Load\n  description: "on parent"\n  expand: [Dash](dash.flow)\n');
    const child = parseFlow('---\nname: Dash\ndescription: "in preamble"\n---\n');
    const node = parent.items.find((item) => item.kind === 'node')!.node;
    expect(descriptionForNode(node, child)).toBe('in preamble');
  });

  it('falls back to the node prop when the preamble has no description', () => {
    const parent = parseFlow('Load\n  description: "legacy"\n  expand: [Dash](dash.flow)\n');
    const child = parseFlow('---\nname: Dash\n---\n');
    const node = parent.items.find((item) => item.kind === 'node')!.node;
    expect(descriptionForNode(node, child)).toBe('legacy');
  });

  it('writes description to the preamble and clears the node prop', () => {
    const parent = parseFlow('Load\n  description: "legacy"\n  expand: [Dash](dash.flow)\n');
    const child = parseFlow('---\nname: Dash\n---\n');
    const node = parent.items.find((item) => item.kind === 'node')!.node;
    writeDescriptionForNode(node, child, '"fresh"');
    expect(getPreambleField(child, 'description')).toBe('"fresh"');
    expect(getProp(node, 'description')).toBeNull();
  });
});

describe('name helpers', () => {
  it('sanitizes names that would break the line format', () => {
    expect(sanitizeName('a: b')).toBe('a - b');
    expect(sanitizeName('multi\nline   name')).toBe('multi line name');
    expect(sanitizeName('trailing:')).toBe('trailing -');
    expect(sanitizeName('Has {braces}')).toBe('Has braces');
  });

  it('collapses whitespace to a single line', () => {
    expect(collapseToSingleLine(' a\n b\t c ')).toBe('a b c');
  });

  it('numbers colliding names', () => {
    const taken = new Set(['Step', 'Step 2']);
    expect(uniqueName(taken, 'Step')).toBe('Step 3');
    expect(uniqueName(taken, 'Fresh')).toBe('Fresh');
    expect(uniqueName(new Set(), '')).toBe('Untitled');
  });

  it('generates uuid-shaped ids', () => {
    expect(newUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
