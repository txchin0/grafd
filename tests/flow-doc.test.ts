import { describe, expect, it } from 'vitest';
import { getProp, parseFlow, parseEdgeExpression, type GraphItem } from '../src/shared/flow-format.js';
import {
  addEdge,
  addNode,
  allNodes,
  assignMissingIds,
  buildModel,
  containingItems,
  deleteEdge,
  deleteNodes,
  duplicateNodes,
  expandEntryNames,
  findNodeById,
  graphBlockNames,
  nodesIn,
  renameGraphBlock,
  renameNode,
  scopeItems,
  setEdgeLabel,
  type ModelEdge,
} from '../src/client/flow-doc.js';

const PLACED = (x: number, y: number) => `pos: ${x}, ${y}, 200, 88`;

function docFrom(text: string) {
  const doc = parseFlow(text);
  assignMissingIds(doc);
  return doc;
}

describe('buildModel', () => {
  const doc = docFrom(`A
  ${PLACED(0, 0)}
  -> B
  -> C : "yes"
  -> D : "no"
  on_error: -> H

B
  ${PLACED(300, 0)}

H
  ${PLACED(0, 300)}
`);
  const model = buildModel(doc, null);

  it('resolves edges to nodes and invents ghosts for unresolved targets', () => {
    expect(model.nodes.map((node) => node.name)).toEqual(['A', 'B', 'H']);
    expect(model.ghosts.map((ghost) => ghost.name)).toEqual(['C', 'D']);
    const toB = model.edges.find((edge) => edge.spec.target === 'B')!;
    expect(toB.to).toBe(model.nodesByName.get('B'));
  });

  it('derives an error edge from on_error', () => {
    const errorEdge = model.edges.find((edge) => edge.kind === 'error')!;
    expect(errorEdge.from.name).toBe('A');
    expect(errorEdge.spec.target).toBe('H');
  });

  it('infers traits', () => {
    const a = model.nodesByName.get('A')!;
    const b = model.nodesByName.get('B')!;
    const h = model.nodesByName.get('H')!;
    expect(model.traits.get(a)).toMatchObject({ entry: true, decision: true, hasErrorHandler: true });
    expect(model.traits.get(b)).toMatchObject({ entry: false, decision: false });
    // Error edges do not count as incoming flow, so the handler still reads as an entry.
    expect(model.traits.get(h)).toMatchObject({ entry: true });
  });

  it('records the source document on the model', () => {
    expect(model.sourceDoc).toBe(doc);
  });
});

describe('autoLayout (via buildModel)', () => {
  it('lays out unplaced nodes in flow-depth columns', () => {
    const doc = docFrom(`A
  -> B

B
  -> C

C
`);
    const model = buildModel(doc, null);
    const [a, b, c] = model.nodes;
    expect(a.pos).toEqual({ x: 80, y: 80, w: 200, h: 88 });
    expect(b.pos).toEqual({ x: 360, y: 80, w: 200, h: 88 });
    expect(c.pos).toEqual({ x: 640, y: 80, w: 200, h: 88 });
  });

  it('places new nodes below existing placed content', () => {
    const doc = docFrom(`A
  ${PLACED(0, 0)}

B
`);
    buildModel(doc, null);
    const b = allNodes(doc)[1];
    expect(b.pos!.y).toBe(88 + 90);
  });
});

describe('scope helpers', () => {
  const doc = docFrom(`Top

graph: Sub
  Inner
`);

  it('lists graph block names', () => {
    expect(graphBlockNames(doc)).toEqual(['Sub']);
  });

  it('scopes items to a graph block, falling back to the root', () => {
    expect(nodesIn(scopeItems(doc, 'Sub')).map((node) => node.name)).toEqual(['Inner']);
    expect(nodesIn(scopeItems(doc, null)).map((node) => node.name)).toEqual(['Top']);
    expect(nodesIn(scopeItems(doc, 'Missing')).map((node) => node.name)).toEqual(['Top']);
  });

  it('finds nodes by id anywhere in the document', () => {
    const inner = nodesIn(scopeItems(doc, 'Sub'))[0];
    expect(findNodeById(doc, inner.id)).toBe(inner);
    expect(findNodeById(doc, 'nope')).toBeNull();
  });

  it('finds the item list containing a node', () => {
    const inner = nodesIn(scopeItems(doc, 'Sub'))[0];
    expect(containingItems(doc, inner)).toBe((doc.items[1] as GraphItem).items);
    const top = nodesIn(doc.items)[0];
    expect(containingItems(doc, top)).toBe(doc.items);
  });
});

describe('addNode', () => {
  it('adds a node with a rounded rect, fresh id, and unique name', () => {
    const doc = docFrom('Untitled\n');
    const node = addNode(doc.items, { x: 10.6, y: 19.2, w: 100.5, h: 50.4 });
    expect(node.name).toBe('Untitled 2');
    expect(node.id).toBeTruthy();
    expect(node.pos).toEqual({ x: 11, y: 19, w: 101, h: 50 });
    expect(allNodes(doc)).toHaveLength(2);
  });
});

describe('duplicateNodes', () => {
  it('gives copies unique names, fresh ids, and offset positions', () => {
    const doc = docFrom(`Login
  ${PLACED(0, 0)}
`);
    const [login] = allNodes(doc);
    const [copy] = duplicateNodes(doc.items, [login], { x: 24, y: 24 });
    expect(copy.name).toBe('Login 2');
    expect(copy.id).toBeTruthy();
    expect(copy.id).not.toBe(login.id);
    expect(copy.pos).toEqual({ x: 24, y: 24, w: 200, h: 88 });
    expect(allNodes(doc)).toHaveLength(2);
  });

  it('rewires edges among the copied set but leaves edges to untouched nodes alone', () => {
    const doc = docFrom(`A
  ${PLACED(0, 0)}
  -> B
  -> C
  on_error: -> B

B
  ${PLACED(300, 0)}

C
  ${PLACED(0, 300)}
`);
    const [a, b] = allNodes(doc);
    const [copyA, copyB] = duplicateNodes(doc.items, [a, b], { x: 24, y: 24 });
    expect([copyA.name, copyB.name]).toEqual(['A 2', 'B 2']);
    // Edge to the co-duplicated B is rewired to the copy; the edge to un-copied C is not.
    expect(copyA.edges.map((edge) => edge.target)).toEqual(['B 2', 'C']);
    expect(getProp(copyA, 'on_error')).toBe('-> B 2');
    // Originals are untouched.
    expect(a.edges.map((edge) => edge.target)).toEqual(['B', 'C']);
  });
});

describe('deleteNodes', () => {
  it('removes nodes plus edges and on_error references pointing at them', () => {
    const doc = docFrom(`A
  -> B
  on_error: -> B

B
`);
    const [a, b] = allNodes(doc);
    deleteNodes(doc.items, [b], doc);
    expect(allNodes(doc)).toEqual([a]);
    expect(a.edges).toEqual([]);
    expect(getProp(a, 'on_error')).toBeNull();
  });
});

describe('renameNode', () => {
  it('retargets inbound edges and on_error, deduplicating against taken names', () => {
    const doc = docFrom(`A
  -> B
  on_error: -> B

B

C
`);
    const [a, b] = allNodes(doc);
    const finalName = renameNode(doc.items, b, 'C', doc);
    expect(finalName).toBe('C 2');
    expect(a.edges[0].target).toBe('C 2');
    expect(getProp(a, 'on_error')).toBe('-> C 2');
  });

  it('keeps the current name when the request is empty or unchanged', () => {
    const doc = docFrom('A\n');
    const [a] = allNodes(doc);
    expect(renameNode(doc.items, a, '   ', doc)).toBe('A');
    expect(renameNode(doc.items, a, 'A', doc)).toBe('A');
  });
});

describe('renameGraphBlock', () => {
  it('renames the block and updates expand references', () => {
    const doc = docFrom(`Host
  expand: Sub

graph: Sub
  Inner
`);
    const graphItem = doc.items[1] as GraphItem;
    const finalName = renameGraphBlock(doc, graphItem, 'Detail');
    expect(finalName).toBe('Detail');
    expect(getProp(allNodes(doc)[0], 'expand')).toBe('Detail');
  });
});

describe('edge mutations', () => {
  it('adds and deletes flow edges', () => {
    const doc = docFrom('A\n\nB\n');
    const [a] = allNodes(doc);
    const spec = addEdge(a, 'B', 'go');
    expect(a.edges).toEqual([{ target: 'B', innerSource: null, innerTarget: null, label: 'go', data: null }]);
    deleteEdge({ from: a, spec, kind: 'flow' });
    expect(a.edges).toEqual([]);
  });

  it('stores an optional inner subgraph target on addEdge', () => {
    const doc = docFrom('A\n\nB\n');
    const [a] = allNodes(doc);
    addEdge(a, 'B', null, 'Inner');
    expect(a.edges[0]).toEqual({ target: 'B', innerSource: null, innerTarget: 'Inner', label: null, data: null });
  });

  it('stores an optional inner subgraph source on addEdge (§5.8)', () => {
    const doc = docFrom('A\n\nB\n');
    const [a] = allNodes(doc);
    addEdge(a, 'B', null, null, 'Inner Source');
    expect(a.edges[0]).toEqual({ target: 'B', innerSource: 'Inner Source', innerTarget: null, label: null, data: null });
  });

  it('routes error-edge mutations through the on_error prop', () => {
    const doc = docFrom(`A
  on_error: -> H

H
`);
    const [a] = allNodes(doc);
    const edge: ModelEdge = { from: a, spec: parseEdgeExpression(getProp(a, 'on_error')!), kind: 'error' };
    setEdgeLabel(edge, 'boom');
    expect(getProp(a, 'on_error')).toBe('-> H : "boom"');
    deleteEdge(edge);
    expect(getProp(a, 'on_error')).toBeNull();
  });

  it('clears an edge label set to blank', () => {
    const doc = docFrom('A\n  -> B : "go"\n\nB\n');
    const [a] = allNodes(doc);
    const model = buildModel(doc, null);
    setEdgeLabel(model.edges[0], '   ');
    expect(a.edges[0].label).toBeNull();
  });
});

describe('inner-target propagation', () => {
  const subgraphDoc = () => docFrom(`Validate Cart
  -> Process Payment {Charge Card}

Process Payment
  expand: Payment Steps

graph: Payment Steps
  Charge Card

  Capture Funds
`);

  it('retargets parent-scope {Inner} when a local graph-block node is renamed', () => {
    const doc = subgraphDoc();
    const charge = allNodes(doc).find((node) => node.name === 'Charge Card')!;
    renameNode(containingItems(doc, charge), charge, 'Bill Card', doc);
    expect(allNodes(doc)[0].edges[0].innerTarget).toBe('Bill Card');
  });

  it('clears parent-scope {Inner} when a local graph-block node is deleted', () => {
    const doc = subgraphDoc();
    const charge = allNodes(doc).find((node) => node.name === 'Charge Card')!;
    deleteNodes(containingItems(doc, charge), [charge], doc);
    expect(allNodes(doc)[0].edges[0]).toMatchObject({
      target: 'Process Payment',
      innerTarget: null,
    });
  });

  it('retargets {Inner} across files when an external expand entry is renamed', () => {
    const parent = docFrom(`Validate Cart
  -> Process Payment {Charge Card}

Process Payment
  expand: [Payment](payment.flow)
`);
    const payment = docFrom(`Charge Card

Capture Funds
`);
    const charge = allNodes(payment).find((node) => node.name === 'Charge Card')!;
    renameNode(payment.items, charge, 'Bill Card', payment, {
      path: 'payment.flow',
      relatedDocs: [
        { doc: parent, path: 'cart.flow' },
        { doc: payment, path: 'payment.flow' },
      ],
    });
    expect(allNodes(parent)[0].edges[0].innerTarget).toBe('Bill Card');
  });

  it('clears {Inner} across files when an external expand entry is deleted', () => {
    const parent = docFrom(`Validate Cart
  -> Process Payment {Charge Card}

Process Payment
  expand: [Payment](payment.flow)
`);
    const payment = docFrom(`Charge Card

Capture Funds
`);
    const charge = allNodes(payment).find((node) => node.name === 'Charge Card')!;
    deleteNodes(payment.items, [charge], payment, {
      path: 'payment.flow',
      relatedDocs: [
        { doc: parent, path: 'cart.flow' },
        { doc: payment, path: 'payment.flow' },
      ],
    });
    expect(allNodes(parent)[0].edges[0]).toMatchObject({
      target: 'Process Payment',
      innerTarget: null,
    });
  });
});

describe('inner-source propagation', () => {
  // The edge is declared under the subgraph node itself; its {Inner Source} prefix names a
  // node inside that node's own expansion (spec §5.8).
  const subgraphDoc = () => docFrom(`Process Payment
  expand: Payment Steps
  {Charge Card} -> Notify Admin

Notify Admin

graph: Payment Steps
  Charge Card

  Capture Funds
`);

  it('retargets {Inner Source} when a local graph-block node is renamed', () => {
    const doc = subgraphDoc();
    const charge = allNodes(doc).find((node) => node.name === 'Charge Card')!;
    renameNode(containingItems(doc, charge), charge, 'Bill Card', doc);
    const processPayment = allNodes(doc).find((node) => node.name === 'Process Payment')!;
    expect(processPayment.edges[0].innerSource).toBe('Bill Card');
  });

  it('clears {Inner Source} when a local graph-block node is deleted', () => {
    const doc = subgraphDoc();
    const charge = allNodes(doc).find((node) => node.name === 'Charge Card')!;
    deleteNodes(containingItems(doc, charge), [charge], doc);
    const processPayment = allNodes(doc).find((node) => node.name === 'Process Payment')!;
    expect(processPayment.edges[0]).toMatchObject({ target: 'Notify Admin', innerSource: null });
  });

  it('retargets {Inner Source} across files when an external expand entry is renamed', () => {
    const parent = docFrom(`Process Payment
  expand: [Payment](payment.flow)
  {Charge Card} -> Notify Admin

Notify Admin
`);
    const payment = docFrom(`Charge Card

Capture Funds
`);
    const charge = allNodes(payment).find((node) => node.name === 'Charge Card')!;
    renameNode(payment.items, charge, 'Bill Card', payment, {
      path: 'payment.flow',
      relatedDocs: [
        { doc: parent, path: 'cart.flow' },
        { doc: payment, path: 'payment.flow' },
      ],
    });
    expect(allNodes(parent).find((node) => node.name === 'Process Payment')!.edges[0].innerSource).toBe('Bill Card');
  });
});

describe('expandEntryNames', () => {
  it('lists only top-level nodes for an external expand file', () => {
    const local = docFrom('Host\n  expand: [Pay](pay.flow)\n');
    const external = docFrom(`Charge Card

graph: Nested
  Hidden Step
`);
    expect(expandEntryNames('[Pay](pay.flow)', local, 'cart.flow', () => external)).toEqual([
      'Charge Card',
    ]);
  });

  it('lists local graph-block nodes for a same-file expand', () => {
    const doc = docFrom(`Process Payment
  expand: Payment Steps

graph: Payment Steps
  Charge Card

  Capture Funds
`);
    expect(expandEntryNames('Payment Steps', doc, 'cart.flow', () => null)).toEqual([
      'Charge Card',
      'Capture Funds',
    ]);
  });
});

describe('assignMissingIds', () => {
  it('fills ids only where missing', () => {
    const doc = parseFlow(`A
  id: keep-me

B
`);
    assignMissingIds(doc);
    const [a, b] = allNodes(doc);
    expect(a.id).toBe('keep-me');
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
