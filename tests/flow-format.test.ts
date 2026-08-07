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
  parseReference,
  formatReference,
  referencesForNode,
  writeReferencesForNode,
  sanitizeName,
  collapseToSingleLine,
  uniqueName,
  newUuid,
  type NodeItem,
  type GraphItem,
  type ContextItem,
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

context: Session
  description: "Signed token in a cookie"
  references:
    - src/session.ts
  nodes:
    - Start
    - Validate

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

context: Session
  description: "Signed token in a cookie"
  references:
    - src/session.ts
  nodes:
    - Start
    - Validate

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
    expect(start.edges).toEqual([{ target: 'Validate', label: 'ok', innerSource: null, innerTarget: null, data: null }]);
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

  it('parses context blocks with their definition and membership list', () => {
    const block = (doc.items[3] as ContextItem).block;
    expect(block.name).toBe('Session');
    expect(block.pos).toBeNull();
    expect(block.props).toEqual([{ key: 'description', value: '"Signed token in a cookie"' }]);
    expect(block.references).toEqual([{ label: null, target: 'src/session.ts' }]);
    expect(block.members).toEqual(['Start', 'Validate']);
  });

  it('parses graph blocks with nested nodes', () => {
    const graph = doc.items[4] as GraphItem;
    expect(graph.kind).toBe('graph');
    expect(graph.name).toBe('Details');
    const inner = (graph.items[0] as NodeItem).node;
    expect(inner.name).toBe('Inner');
    expect(inner.edges).toEqual([{ target: 'Other', label: null, innerSource: null, innerTarget: null, data: null }]);
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

const REFERENCED_DOCUMENT = `---
name: Login Flow
references:
  - [Auth service](src/server/auth-service.ts)
  - https://jwt.io/introduction
---

Show Login
  description: "Email and password form"
  references:
    - [Login form](src/client/login.tsx:42-88)
    - docs/decisions/0007-session-cookies.md
  -> Submit Credentials : "user taps login"
    data:
      email: string

Submit Credentials
`;

describe('references', () => {
  const doc = parseFlow(REFERENCED_DOCUMENT);
  const showLogin = (doc.items[0] as NodeItem).node;

  it('parses labeled and bare entries on a node', () => {
    expect(showLogin.references).toEqual([
      { label: 'Login form', target: 'src/client/login.tsx:42-88' },
      { label: null, target: 'docs/decisions/0007-session-cookies.md' },
    ]);
  });

  it('parses a preamble block without leaking it into fields', () => {
    expect(doc.preamble?.references).toEqual([
      { label: 'Auth service', target: 'src/server/auth-service.ts' },
      { label: null, target: 'https://jwt.io/introduction' },
    ]);
    expect(doc.preamble?.fields).toEqual([{ key: 'name', value: 'Login Flow' }]);
  });

  it('keeps references out of the flat property list', () => {
    expect(showLogin.props).toEqual([{ key: 'description', value: '"Email and password form"' }]);
  });

  // The two indented blocks are distinguished only by the line above them, so a node
  // carrying both must not let its references land in the edge's data schema.
  it('binds each indented block to the line directly above it', () => {
    expect(showLogin.edges[0].data).toEqual([{ key: 'email', type: 'string' }]);
    expect(showLogin.references).toHaveLength(2);
  });

  it('round-trips a canonical document unchanged', () => {
    expect(serializeFlow(doc)).toBe(REFERENCED_DOCUMENT);
  });

  it('writes the block after single-line properties and before edges', () => {
    const node = emptyNode('Node');
    setProp(node, 'description', '"text"');
    node.references = [{ label: null, target: 'src/a.ts' }];
    node.edges = [{ target: 'Next', innerSource: null, innerTarget: null, label: null, data: null }];
    expect(serializeFlow({ leading: [], preamble: null, items: [{ kind: 'node', node }] })).toBe(
      'Node\n  description: "text"\n  references:\n    - src/a.ts\n  -> Next\n',
    );
  });

  it('omits an empty block entirely', () => {
    expect(serializeFlow(parseFlow('Node\n  references:\n'))).toBe('Node\n');
  });

  it('keeps a hand-written one-line entry', () => {
    const doc = parseFlow('Node\n  references: src/a.ts\n');
    expect((doc.items[0] as NodeItem).node.references).toEqual([{ label: null, target: 'src/a.ts' }]);
  });

  it('parses entry text into a reference', () => {
    expect(parseReference('[Label](src/a.ts:12)')).toEqual({ label: 'Label', target: 'src/a.ts:12' });
    expect(parseReference('https://example.com')).toEqual({ label: null, target: 'https://example.com' });
    expect(parseReference('[](src/a.ts)')).toEqual({ label: null, target: 'src/a.ts' });
    expect(parseReference('   ')).toBeNull();
    expect(parseReference('[Label]()')).toBeNull();
  });

  it('formats a reference back to entry text', () => {
    expect(formatReference({ label: 'Label', target: 'src/a.ts' })).toBe('[Label](src/a.ts)');
    expect(formatReference({ label: null, target: 'src/a.ts' })).toBe('src/a.ts');
  });
});

const CONTEXT_DOCUMENT = `---
name: Checkout
---

context: Auth
  pos: 40, 60, 480, 320
  description: "JWT in an httpOnly cookie"
  references:
    - [Session middleware](src/server/session.ts)
  nodes:
    - Show Login
    - Submit Credentials

Show Login

Submit Credentials
`;

describe('context blocks', () => {
  it('round-trips a canonical document unchanged', () => {
    expect(serializeFlow(parseFlow(CONTEXT_DOCUMENT))).toBe(CONTEXT_DOCUMENT);
  });

  it('parses the editor-owned pos the user drew', () => {
    const block = (parseFlow(CONTEXT_DOCUMENT).items[0] as ContextItem).block;
    expect(block.pos).toEqual({ x: 40, y: 60, w: 480, h: 320 });
  });

  // Unlike `references:`, a membership list is required: a block scopes its provider to exactly
  // the nodes it lists, so an absent `nodes:` says something different from an empty one.
  it('writes nodes: even when the membership list is empty', () => {
    expect(serializeFlow(parseFlow('context: Auth\n  nodes:\n'))).toBe('context: Auth\n  nodes:\n');
    expect(serializeFlow(parseFlow('context: Auth\n'))).toBe('context: Auth\n  nodes:\n');
  });

  it('binds each indented block to the line directly above it', () => {
    const block = (parseFlow('context: Auth\n  references:\n    - src/a.ts\n  nodes:\n    - Show Login\n')
      .items[0] as ContextItem).block;
    expect(block.references).toEqual([{ label: null, target: 'src/a.ts' }]);
    expect(block.members).toEqual(['Show Login']);
  });

  // A block references nodes rather than containing them, so it has no edge list to attach to.
  it('drops an edge line under a context block', () => {
    const doc = parseFlow('context: Auth\n  -> Show Login\n  nodes:\n    - Show Login\n');
    expect((doc.items[0] as ContextItem).block.members).toEqual(['Show Login']);
    expect(serializeFlow(doc)).toBe('context: Auth\n  nodes:\n    - Show Login\n');
  });

  it('leaves a nested context header as an ordinary node, as the parser sees it', () => {
    const doc = parseFlow('graph: Details\n  context: Auth\n');
    expect(((doc.items[0] as GraphItem).items[0] as NodeItem).node.name).toBe('context: Auth');
  });
});

describe('references across an expand link', () => {
  it('prefers the expand target preamble over the referencing node', () => {
    const node = emptyNode('Host');
    node.references = [{ label: null, target: 'stale.ts' }];
    const expandDoc = parseFlow('---\nname: Target\nreferences:\n  - src/real.ts\n---\n');
    expect(referencesForNode(node, expandDoc)).toEqual([{ label: null, target: 'src/real.ts' }]);
    expect(referencesForNode(node, null)).toEqual([{ label: null, target: 'stale.ts' }]);
  });

  it('writes to the expand target preamble and clears the node', () => {
    const node = emptyNode('Host');
    node.references = [{ label: null, target: 'stale.ts' }];
    const expandDoc = parseFlow('---\nname: Target\n---\n');
    writeReferencesForNode(node, expandDoc, [{ label: 'Real', target: 'src/real.ts' }]);
    expect(expandDoc.preamble?.references).toEqual([{ label: 'Real', target: 'src/real.ts' }]);
    expect(node.references).toEqual([]);
  });

  it('writes to the node when there is no expand target', () => {
    const node = emptyNode('Leaf');
    writeReferencesForNode(node, null, [{ label: null, target: 'src/a.ts' }]);
    expect(node.references).toEqual([{ label: null, target: 'src/a.ts' }]);
  });
});

describe('edge expressions', () => {
  it('parses a bare target', () => {
    expect(parseEdgeExpression('-> Target')).toEqual({
      target: 'Target',
      innerSource: null,
      innerTarget: null,
      label: null,
      data: null,
    });
  });

  it('parses a labeled edge', () => {
    expect(parseEdgeExpression('-> Target : "on success"')).toEqual({
      target: 'Target',
      innerSource: null,
      innerTarget: null,
      label: 'on success',
      data: null,
    });
  });

  it('parses an inner subgraph target', () => {
    expect(parseEdgeExpression('-> Process Payment {Charge Card}')).toEqual({
      target: 'Process Payment',
      innerSource: null,
      innerTarget: 'Charge Card',
      label: null,
      data: null,
    });
  });

  it('parses an inner target with a label', () => {
    expect(parseEdgeExpression('-> Process Payment {Charge Card} : "cart valid"')).toEqual({
      target: 'Process Payment',
      innerSource: null,
      innerTarget: 'Charge Card',
      label: 'cart valid',
      data: null,
    });
  });

  it('parses an inner source prefix (§5.8)', () => {
    expect(parseEdgeExpression('{Charge Card} -> Notify Admin : "charged"')).toEqual({
      target: 'Notify Admin',
      innerSource: 'Charge Card',
      innerTarget: null,
      label: 'charged',
      data: null,
    });
  });

  it('parses an inner source and inner target together', () => {
    expect(parseEdgeExpression('{A} -> Sub {B}')).toEqual({
      target: 'Sub',
      innerSource: 'A',
      innerTarget: 'B',
      label: null,
      data: null,
    });
  });

  it('serializes with and without labels and inner refinements', () => {
    expect(serializeEdgeExpression({ target: 'T', innerSource: null, innerTarget: null, label: null, data: null })).toBe('-> T');
    expect(serializeEdgeExpression({ target: 'T', innerSource: null, innerTarget: null, label: 'go', data: null })).toBe('-> T : "go"');
    expect(serializeEdgeExpression({
      target: 'Process Payment',
      innerSource: null,
      innerTarget: 'Charge Card',
      label: null,
      data: null,
    })).toBe('-> Process Payment {Charge Card}');
    expect(serializeEdgeExpression({
      target: 'Process Payment',
      innerSource: null,
      innerTarget: 'Charge Card',
      label: 'cart valid',
      data: null,
    })).toBe('-> Process Payment {Charge Card} : "cart valid"');
    expect(serializeEdgeExpression({
      target: 'Notify Admin',
      innerSource: 'Charge Card',
      innerTarget: null,
      label: 'charged',
      data: null,
    })).toBe('{Charge Card} -> Notify Admin : "charged"');
    expect(serializeEdgeExpression({
      target: 'Sub',
      innerSource: 'A',
      innerTarget: 'B',
      label: null,
      data: null,
    })).toBe('{A} -> Sub {B}');
  });

  it('round-trips an inner-source edge through the full document parser', () => {
    const text = 'Process Payment\n  expand: Payment Steps\n  {Charge Card} -> Notify Admin : "charged"\n';
    const node = (parseFlow(text).items[0] as NodeItem).node;
    expect(node.props).toEqual([{ key: 'expand', value: 'Payment Steps' }]);
    expect(node.edges).toEqual([
      { target: 'Notify Admin', innerSource: 'Charge Card', innerTarget: null, label: 'charged', data: null },
    ]);
    expect(serializeFlow(parseFlow(text))).toBe(text);
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
    expect(resolveLinkPath('.grafd/main.flow', 'sub.flow')).toBe('.grafd/sub.flow');
    expect(resolveLinkPath('.grafd/main.flow', './sub.flow')).toBe('.grafd/sub.flow');
    expect(resolveLinkPath('.grafd/main.flow', '../other/sub.flow')).toBe('other/sub.flow');
    expect(resolveLinkPath(null, 'sub.flow')).toBe('sub.flow');
  });
});

describe('external expand description', () => {
  it('resolves the expand target path and ignores local expands', () => {
    expect(resolvedExpandPath('[Dashboard](dashboard.flow)', '.grafd/main.flow')).toBe('.grafd/dashboard.flow');
    expect(resolvedExpandPath('Local Graph', '.grafd/main.flow')).toBeNull();
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
