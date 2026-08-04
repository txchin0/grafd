import { describe, expect, it } from 'vitest';
import { REGION_MEMBER_PADDING } from '../src/shared/rect-math.js';
import { DEFAULT_NODE_SIZE } from '../src/shared/auto-layout.js';
import {
  emptyNode,
  getPreambleField,
  getProp,
  parseFlow,
  parseEdgeExpression,
  serializeFlow,
  type FlowNode,
  type GraphItem,
} from '../src/shared/flow-format.js';
import {
  addContextBlock,
  addEdge,
  addNode,
  allNodes,
  assignMissingIds,
  buildModel,
  containingItems,
  contextBlockNamed,
  contextNamesReadableBy,
  contextsContainedIn,
  referencesContext,
  renameContextBlock,
  renameContextReferences,
  displayRects,
  inheritedContextNames,
  groupNodesByOwner,
  deleteContextBlock,
  deleteEdge,
  deleteNodes,
  duplicateNodes,
  edgeSupportsData,
  ensureScopeItems,
  expandEntryNames,
  expandIdentityForNode,
  extractGraphBlockToDocument,
  extractSubgraph,
  findNodeById,
  graphBlockNames,
  hostsOfExpansion,
  membershipChangesForNewNode,
  membershipChangesForRegionMove,
  nodesIn,
  regionRectOf,
  renameGraphBlock,
  renameNode,
  retargetInnerRefs,
  scopeItems,
  setEdgeData,
  setEdgeLabel,
  setNodeReferences,
  type ModelEdge,
} from '../src/client/flow-doc.js';
import { boundsOfRects } from '../src/shared/rect-math.js';

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

  it('materializes a missing graph block when ensuring its items', () => {
    const fresh = docFrom('Top\n  expand: Unwritten\n');
    const items = ensureScopeItems(fresh, 'Unwritten');
    addNode(items, { x: 0, y: 0, w: 200, h: 88 }, 'First');

    expect(graphBlockNames(fresh)).toEqual(['Unwritten']);
    expect(nodesIn(scopeItems(fresh, 'Unwritten')).map((node) => node.name)).toEqual(['First']);
    expect(ensureScopeItems(fresh, 'Unwritten')).toBe(items);
    expect(ensureScopeItems(fresh, null)).toBe(fresh.items);
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

  it('carries references onto the copy without sharing them', () => {
    const doc = docFrom(`Login
  ${PLACED(0, 0)}
  references:
    - src/login.tsx:12
`);
    const [login] = allNodes(doc);
    const [copy] = duplicateNodes(doc.items, [login], { x: 24, y: 24 });
    expect(copy.references).toEqual([{ label: null, target: 'src/login.tsx:12' }]);
    copy.references[0].target = 'other.ts';
    expect(login.references[0].target).toBe('src/login.tsx:12');
  });
});

describe('setNodeReferences', () => {
  it('drops entries with no target and collapses whitespace', () => {
    const node = emptyNode('Node');
    setNodeReferences(node, [
      { label: '  Login\n  form ', target: ' src/login.tsx:42 ' },
      { label: 'empty', target: '  ' },
    ]);
    expect(node.references).toEqual([{ label: 'Login form', target: 'src/login.tsx:42' }]);
  });

  it('strips the delimiters the format cannot escape', () => {
    const node = emptyNode('Node');
    setNodeReferences(node, [{ label: '[odd] label', target: 'https://x.test/a_(b)' }]);
    expect(node.references).toEqual([{ label: 'odd label', target: 'https://x.test/a_b' }]);
  });

  it('treats a blank label as absent', () => {
    const node = emptyNode('Node');
    setNodeReferences(node, [{ label: '   ', target: 'src/a.ts' }]);
    expect(node.references).toEqual([{ label: null, target: 'src/a.ts' }]);
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

describe('context blocks', () => {
  const MEMBERSHIP = `context: Auth
  nodes:
    - A
    - B

A

B

graph: Sub
  A
`;

  it('adds a block with a drawn area and rounded coordinates', () => {
    const doc = docFrom('A\n');
    const block = addContextBlock(doc.items, 'Auth', { x: 1.4, y: 2.6, w: 480.2, h: 320.5 }, ['A']);
    expect(block.pos).toEqual({ x: 1, y: 3, w: 480, h: 321 });
    expect(contextBlockNamed(doc, 'Auth')).toBe(block);
  });

  it('groups a selection into a block with no area of its own', () => {
    const doc = docFrom('A\n\nB\n');
    expect(addContextBlock(doc.items, 'Auth', null, ['A', 'B']).pos).toBeNull();
  });

  it('makes a new block name unique against the blocks already in the file', () => {
    const doc = docFrom('context: Auth\n  nodes:\n');
    expect(addContextBlock(doc.items, 'Auth', null, []).name).toBe('Auth 2');
  });

  it('drops blank and duplicate member names', () => {
    const doc = docFrom('A\n');
    expect(addContextBlock(doc.items, 'Auth', null, ['A', ' A ', '  ']).members).toEqual(['A']);
  });

  it('resolves members into the model and marks them on the node', () => {
    const doc = docFrom(`---\nname: T\ninherits: [Session]\n---\n\n${MEMBERSHIP}`);
    const model = buildModel(doc, null);
    const [a, b] = model.nodes;
    expect(model.contexts).toHaveLength(1);
    expect(model.contexts[0].members).toEqual([a, b]);
    expect(model.traits.get(a)).toMatchObject({ contexts: ['Auth'], inheritsContexts: true });
  });

  // The file is authoritative about membership: an entry naming a node that is not here is a
  // linter matter, and no render pass repairs it.
  it('leaves a member naming a node that is not in the model out of the model', () => {
    const doc = docFrom('context: Auth\n  nodes:\n    - Nowhere\n    - A\n\nA\n');
    expect(buildModel(doc, null).contexts[0].members.map((node) => node.name)).toEqual(['A']);
  });

  // A `graph:` block has no body of its own, so it declares no regions (spec §8.2).
  it('carries no regions in a model scoped to a graph block', () => {
    const doc = docFrom(MEMBERSHIP);
    expect(buildModel(doc, 'Sub').contexts).toEqual([]);
  });

  it('deletes a block without touching its members', () => {
    const doc = docFrom(MEMBERSHIP);
    deleteContextBlock(doc.items, contextBlockNamed(doc, 'Auth')!);
    expect(contextBlockNamed(doc, 'Auth')).toBeNull();
    expect(nodesIn(doc.items).map((node) => node.name)).toEqual(['A', 'B']);
  });

  it('follows a renamed member', () => {
    const doc = docFrom(MEMBERSHIP);
    renameNode(doc.items, nodesIn(doc.items)[0], 'Start', doc);
    expect(contextBlockNamed(doc, 'Auth')!.members).toEqual(['Start', 'B']);
  });

  it('drops a deleted member', () => {
    const doc = docFrom(MEMBERSHIP);
    deleteNodes(doc.items, [nodesIn(doc.items)[1]], doc);
    expect(contextBlockNamed(doc, 'Auth')!.members).toEqual(['A']);
  });

  // Only nodes at column 0 can be members, so a same-named node inside a `graph:` block is not
  // the member the list refers to.
  it('ignores renames and deletions inside a graph block', () => {
    const doc = docFrom(MEMBERSHIP);
    const block = doc.items.find((item): item is GraphItem => item.kind === 'graph')!;
    renameNode(block.items, nodesIn(block.items)[0], 'Inner', doc);
    expect(contextBlockNamed(doc, 'Auth')!.members).toEqual(['A', 'B']);
    deleteNodes(block.items, nodesIn(block.items), doc);
    expect(contextBlockNamed(doc, 'Auth')!.members).toEqual(['A', 'B']);
  });
});

describe('renaming a context', () => {
  const DECLARING = `---
name: Main
---

context: Auth
  nodes:
    - A

A
  updates: [Auth, Cart]

B
  updates: [Cart]

graph: Sub
  Inner
    updates: [Auth]
`;

  // A provider is addressed by name, so every name that refers to it moves with it — including
  // one inside a `graph:` block, whose nodes read through their host.
  it('carries the `updates` entries naming it, in the same mutation', () => {
    const doc = docFrom(DECLARING);
    const block = contextBlockNamed(doc, 'Auth')!;
    expect(renameContextBlock(doc, block, 'Session')).toBe('Session');
    expect(block.name).toBe('Session');
    expect(getProp(allNodes(doc)[0], 'updates')).toBe('[Session, Cart]');
    expect(getProp(allNodes(doc)[1], 'updates')).toBe('[Cart]');
    expect(getProp(allNodes(doc)[2], 'updates')).toBe('[Session]');
  });

  it('keeps the current name when the request is empty or unchanged', () => {
    const doc = docFrom(DECLARING);
    const block = contextBlockNamed(doc, 'Auth')!;
    expect(renameContextBlock(doc, block, '   ')).toBe('Auth');
    expect(renameContextBlock(doc, block, 'Auth')).toBe('Auth');
  });

  it('rewrites the generated `inherits` and the authored `updates` of a downstream file', () => {
    const doc = docFrom(`---
name: Child
inherits: [Auth, Billing]
---

Leaf
  updates: [Auth]
`);
    expect(renameContextReferences(doc, 'Auth', 'Session')).toBe(true);
    expect(getPreambleField(doc, 'inherits')).toBe('[Session, Billing]');
    expect(getProp(allNodes(doc)[0], 'updates')).toBe('[Session]');
  });

  it('reports a file that names the provider, so untouched files are never rewritten', () => {
    expect(referencesContext(docFrom(`---
name: C
inherits: [Auth]
---

Leaf
`), 'Auth')).toBe(true);
    expect(referencesContext(docFrom(`Leaf
  updates: [Auth]
`), 'Auth')).toBe(true);
    expect(referencesContext(docFrom(`Leaf
  updates: [Cart]
`), 'Auth')).toBe(false);
    expect(renameContextReferences(docFrom(`Leaf
`), 'Auth', 'Session')).toBe(false);
  });
});

describe('contextNamesReadableBy', () => {
  const DOC = `---
name: T
inherits: [Billing]
---

context: Session
  nodes:
    - A

context: Cart
  nodes:
    - B

A

B
`;

  it('unions the blocks listing the node with what the file inherits', () => {
    const doc = docFrom(DOC);
    expect(contextNamesReadableBy(doc, 'A')).toEqual(['Billing', 'Session']);
    expect(contextNamesReadableBy(doc, 'B')).toEqual(['Billing', 'Cart']);
  });

  // An inherited provider is graph-wide, so a node in no block still reads it.
  it('gives a node in no block whatever the file inherits', () => {
    expect(contextNamesReadableBy(docFrom(DOC), 'Nobody')).toEqual(['Billing']);
    expect(contextNamesReadableBy(docFrom('context: Session\n  nodes:\n\nA\n'), 'A')).toEqual([]);
  });

  it('reads the preamble list the editor generates', () => {
    expect(inheritedContextNames(docFrom(DOC))).toEqual(['Billing']);
    expect(inheritedContextNames(docFrom('A\n'))).toEqual([]);
  });
});

describe('membershipChangesForNewNode', () => {
  const ZONE = `context: Zone
  pos: 0, 0, 800, 600
  nodes:

Outside
  pos: 900, 200, 200, 88
`;

  const OVERLAPS = `context: Left
  pos: 0, 0, 700, 700
  nodes:

context: Right
  pos: 400, 0, 700, 700
  nodes:
`;

  function changesFor(text: string, rect: { x: number; y: number; w: number; h: number }) {
    const doc = docFrom(text);
    const node = addNode(doc.items, rect);
    const model = buildModel(doc, null);
    return membershipChangesForNewNode(model, node);
  }

  it('joins every region that fully encloses the new node (R9a)', () => {
    const changes = changesFor(ZONE, { x: 200, y: 200, w: 200, h: 88 });
    expect(changes).toEqual([{ block: expect.objectContaining({ name: 'Zone' }), node: expect.anything(), joins: true }]);
  });

  it('joins nothing when the node is only partly inside a region', () => {
    expect(changesFor(ZONE, { x: 750, y: 200, w: 200, h: 88 })).toEqual([]);
  });

  it('joins every overlapping region independently (R15)', () => {
    const changes = changesFor(OVERLAPS, { x: 500, y: 300, w: 200, h: 88 });
    expect(changes.map((change) => change.block.name).sort()).toEqual(['Left', 'Right']);
    expect(changes.every((change) => change.joins)).toBe(true);
  });
});

describe('membershipChangesForRegionMove', () => {
  function changesFor(groupNames: string[], text: string) {
    const model = buildModel(docFrom(text), null);
    const group = model.contexts.filter((entry) => groupNames.includes(entry.block.name));
    return membershipChangesForRegionMove(model, group);
  }

  // The frames stand at their post-move rest, which is what a finished drag leaves behind: the
  // sweep claims every non-member the dragged frame and each carried frame came to rest over.
  it('sweeps a non-member into each region of the group', () => {
    const changes = changesFor(['Zone', 'Inner'], `context: Zone
  pos: 1360, 600, 800, 600
  nodes:
    - Inside

context: Inner
  pos: 1760, 920, 200, 120
  nodes:
    - Deep

Inside
  pos: 1560, 800, 200, 88

Deep
  pos: 1800, 960, 100, 50

Wanderer
  pos: 1776, 936, 100, 50
`);
    expect(changes.map((change) => [change.block.name, change.node.name, change.joins]).sort()).toEqual([
      ['Inner', 'Wanderer', true],
      ['Zone', 'Deep', true],
      ['Zone', 'Wanderer', true],
    ]);
  });

  it('sweeps a carried region with no drawn area through its padded member bounds', () => {
    const changes = changesFor(['Zone', 'Inner'], `context: Zone
  pos: 1360, 600, 800, 600
  nodes:

context: Inner
  nodes:
    - Deep

Deep
  pos: 1800, 960, 100, 50

Wanderer
  pos: 1776, 936, 100, 50
`);
    expect(changes.map((change) => [change.block.name, change.node.name, change.joins]).sort()).toEqual([
      ['Inner', 'Wanderer', true],
      ['Zone', 'Deep', true],
      ['Zone', 'Wanderer', true],
    ]);
  });

  // A move can only ever add: every member travelled with its own frame, and a region's frame
  // unions its members in (R2), so nothing a region owns can be outside it.
  it('never removes a member', () => {
    const changes = changesFor(['Auth'], `context: Auth
  pos: 0, 0, 60, 60
  nodes:
    - A

A
  pos: 400, 300, 200, 88
`);
    expect(changes).toEqual([]);
  });

  it('leaves a node outside every frame alone', () => {
    const changes = changesFor(['Auth'], `context: Auth
  pos: 0, 0, 800, 600
  nodes:
    - A

A
  pos: 200, 200, 200, 88

Far
  pos: 1400, 900, 200, 88
`);
    expect(changes).toEqual([]);
  });

  it('skips a region with no frame at all', () => {
    const changes = changesFor(['Empty'], `context: Empty
  nodes:

A
  pos: 100, 100, 200, 88
`);
    expect(changes).toEqual([]);
  });

  // The group is the contract: a region outside it is not swept, even one the dragged frame
  // fully encloses — that one was never carried (R28a) and the move must leave it alone.
  it('does not sweep a region outside the group, even one the dragged frame encloses', () => {
    const changes = changesFor(['Big'], `context: Big
  pos: 400, 0, 900, 900
  nodes:

context: Small
  pos: 820, 100, 200, 200
  nodes:
    - InSmall

InSmall
  pos: 860, 140, 100, 50

Passerby
  pos: 880, 200, 100, 50
`);
    expect(changes.map((change) => [change.block.name, change.node.name, change.joins]).sort()).toEqual([
      ['Big', 'InSmall', true],
      ['Big', 'Passerby', true],
    ]);
  });
});

describe('regionRectOf', () => {
  const PADDING = REGION_MEMBER_PADDING;

  function regionOf(text: string) {
    const model = buildModel(docFrom(text), null);
    return { model, rect: regionRectOf(model, model.contexts[0]) };
  }

  it('encloses its members with a standoff', () => {
    const { rect } = regionOf(`context: Auth\n  nodes:\n    - A\n    - B\n\nA\n  ${PLACED(100, 100)}\n\nB\n  ${PLACED(400, 300)}\n`);
    expect(rect).toEqual({
      x: 100 - PADDING,
      y: 100 - PADDING,
      w: 500 + 2 * PADDING,
      h: 288 + 2 * PADDING,
    });
  });

  // The drawn area is a floor, not a fence: a member can never fall outside the region, so the
  // picture can never contradict the file (spec §8.3).
  it('unions the area the user drew with its members rather than clipping to it', () => {
    const { rect } = regionOf(`context: Auth\n  pos: 0, 0, 60, 60\n  nodes:\n    - A\n\nA\n  ${PLACED(400, 300)}\n`);
    expect(rect).toEqual({ x: 0, y: 0, w: 400 + 200 + PADDING, h: 300 + 88 + PADDING });
  });

  it('draws an area the user reserved before populating it', () => {
    const { rect } = regionOf('context: Auth\n  pos: 10, 20, 300, 200\n  nodes:\n\nA\n');
    expect(rect).toEqual({ x: 10, y: 20, w: 300, h: 200 });
  });

  it('has no geometry with neither an area nor members, and the editor invents none', () => {
    expect(regionOf('context: Auth\n  nodes:\n\nA\n').rect).toBeNull();
  });

  // Fit-to-content and PNG export both measure through displayRects, so a region the user drew
  // before populating it would otherwise be cropped out of both.
  it('is measured by displayRects, including when no node accounts for it', () => {
    const { model } = regionOf(`context: Auth\n  pos: -400, -400, 100, 100\n  nodes:\n\nA\n  ${PLACED(0, 0)}\n`);
    expect(displayRects(model)).toContainEqual({ x: -400, y: -400, w: 100, h: 100 });
    expect(boundsOfRects(displayRects(model))).toMatchObject({ x: -400, y: -400 });
  });
});

describe('contextsContainedIn', () => {
  function containedNames(text: string, name: string): string[] {
    const model = buildModel(docFrom(text), null);
    const context = model.contexts.find((entry) => entry.block.name === name)!;
    return contextsContainedIn(model, context).map((entry) => entry.block.name);
  }

  it('excludes the context itself', () => {
    const names = containedNames(`context: Outer
  pos: 0, 0, 800, 600
  nodes:

A
  ${PLACED(100, 100)}
`, 'Outer');
    expect(names).toEqual([]);
  });

  it('includes a drawn region whose whole frame lies inside, and no region it only overlaps', () => {
    const names = containedNames(`context: Outer
  pos: 0, 0, 800, 600
  nodes:

context: Inner
  pos: 300, 300, 200, 120
  nodes:

context: Straddler
  pos: 600, 400, 700, 700
  nodes:
`, 'Outer');
    expect(names).toEqual(['Inner']);
  });

  it('counts a region sharing the frame border as contained, since containment is inclusive', () => {
    const names = containedNames(`context: Outer
  pos: 0, 0, 800, 600
  nodes:

context: Touching
  pos: 0, 0, 800, 600
  nodes:
`, 'Outer');
    expect(names).toEqual(['Touching']);
  });

  it('includes a member-derived region whose padded member bounds fit inside', () => {
    const names = containedNames(`context: Outer
  pos: 0, 0, 800, 600
  nodes:

context: Derived
  nodes:
    - D

D
  ${PLACED(400, 400)}
`, 'Outer');
    expect(names).toEqual(['Derived']);
  });

  // The filter tests every context against the dragged frame, so a region nested two levels down
  // is carried by the outermost drag even though it is not a direct "child" of its frame.
  it('carries transitively: a region inside a contained region is contained itself', () => {
    const names = containedNames(`context: Outer
  pos: 0, 0, 800, 600
  nodes:

context: Inner
  pos: 300, 300, 400, 280
  nodes:

context: Deep
  pos: 350, 350, 100, 100
  nodes:
`, 'Outer');
    expect(names).toEqual(['Inner', 'Deep']);
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

describe('mirrored host and graph block names', () => {
  const MIRRORED = `Payment
  expand: Payment

graph: Payment
  Charge Card
`;

  it('renames the block along with its only host', () => {
    const doc = docFrom(MIRRORED);
    const host = allNodes(doc).find((node) => node.name === 'Payment')!;
    expect(renameNode(doc.items, host, 'Take Payment', doc)).toBe('Take Payment');
    expect(graphBlockNames(doc)).toEqual(['Take Payment']);
    expect(getProp(host, 'expand')).toBe('Take Payment');
  });

  it('renames the only host along with the block', () => {
    const doc = docFrom(MIRRORED);
    const host = allNodes(doc).find((node) => node.name === 'Payment')!;
    const graphItem = doc.items.find((item): item is GraphItem => item.kind === 'graph')!;
    expect(renameGraphBlock(doc, graphItem, 'Take Payment')).toBe('Take Payment');
    expect(host.name).toBe('Take Payment');
    expect(getProp(host, 'expand')).toBe('Take Payment');
  });

  it('leaves a block whose name the user has diverged alone', () => {
    const doc = docFrom(`Payment
  expand: Payment Steps

graph: Payment Steps
  Charge Card
`);
    const host = allNodes(doc).find((node) => node.name === 'Payment')!;
    renameNode(doc.items, host, 'Take Payment', doc);
    expect(graphBlockNames(doc)).toEqual(['Payment Steps']);
    expect(getProp(host, 'expand')).toBe('Payment Steps');
  });

  it('leaves a block several nodes share alone', () => {
    const doc = docFrom(`Validate
  expand: Validate

Revalidate
  expand: Validate

graph: Validate
  Check Fields
`);
    const host = allNodes(doc).find((node) => node.name === 'Validate')!;
    renameNode(doc.items, host, 'Validate Input', doc);
    expect(graphBlockNames(doc)).toEqual(['Validate']);
    expect(getProp(host, 'expand')).toBe('Validate');
  });

  it('drops the mirror rather than fight a block name that is already taken', () => {
    const doc = docFrom(`Payment
  expand: Payment

Other
  expand: Refund

graph: Payment
  Charge Card

graph: Refund
  Reverse Charge
`);
    const host = allNodes(doc).find((node) => node.name === 'Payment')!;
    renameNode(doc.items, host, 'Refund', doc);
    expect(host.name).toBe('Refund');
    expect(graphBlockNames(doc)).toEqual(['Refund 2', 'Refund']);
    expect(getProp(host, 'expand')).toBe('Refund 2');
  });

  it('carries the host rename into inner refinements naming it', () => {
    const doc = docFrom(`Checkout
  expand: Checkout
  {Charge Card} -> Done : "charged"

Done

graph: Checkout
  Charge Card
`);
    const graphItem = doc.items.find((item): item is GraphItem => item.kind === 'graph')!;
    const inner = nodesIn(graphItem.items)[0];
    renameNode(graphItem.items, inner, 'Bill Card', doc);
    const host = allNodes(doc).find((node) => node.name === 'Checkout')!;
    expect(host.edges[0].innerSource).toBe('Bill Card');
  });
});

describe('hostsOfExpansion', () => {
  it('finds every node that unfolds a local block', () => {
    const doc = docFrom(`A
  expand: Shared

B
  expand: Shared

C
  expand: [Elsewhere](other.flow)

graph: Shared
  Inner
`);
    const hosts = hostsOfExpansion([{ doc, path: null }], { kind: 'graph-block', name: 'Shared' });
    expect(hosts.map((node) => node.name)).toEqual(['A', 'B']);
  });

  it('resolves external hosts through the containing file path', () => {
    const doc = docFrom(`A
  expand: [Elsewhere](sub/other.flow)
`);
    const hosts = hostsOfExpansion(
      [{ doc, path: 'auth/main.flow' }],
      { kind: 'external-path', path: 'auth/sub/other.flow' },
    );
    expect(hosts.map((node) => node.name)).toEqual(['A']);
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

  it('writes an edge data schema, sanitizing keys and dropping keyless rows', () => {
    const doc = docFrom('A\n  -> B\n\nB\n');
    const [a] = allNodes(doc);
    const model = buildModel(doc, null);
    setEdgeData(model.edges[0], [
      { key: 'cart id', type: 'string' },
      { key: '  ', type: 'number' },
      { key: '2fa', type: ' boolean ' },
    ]);
    expect(a.edges[0].data).toEqual([
      { key: 'cart_id', type: 'string' },
      { key: '_2fa', type: 'boolean' },
    ]);
    expect(serializeFlow(doc)).toContain('    data:\n      cart_id: string\n      _2fa: boolean');
  });

  it('drops an emptied edge data schema', () => {
    const doc = docFrom('A\n  -> B\n    data:\n      cartId: string\n\nB\n');
    const [a] = allNodes(doc);
    const model = buildModel(doc, null);
    setEdgeData(model.edges[0], []);
    expect(a.edges[0].data).toBeNull();
    expect(serializeFlow(doc)).not.toContain('data:');
  });

  it('refuses edge data on error edges, which serialize to a single line', () => {
    const doc = docFrom('A\n  on_error: -> H\n\nH\n');
    const [a] = allNodes(doc);
    const edge: ModelEdge = { from: a, spec: parseEdgeExpression(getProp(a, 'on_error')!), kind: 'error' };
    setEdgeData(edge, [{ key: 'reason', type: 'string' }]);
    expect(edgeSupportsData(edge)).toBe(false);
    expect(edge.spec.data).toBeNull();
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

describe('extractSubgraph', () => {
  it('moves nodes into a new top-level graph block and sets expand on the host', () => {
    const doc = docFrom(`Outside
  ${PLACED(0, 0)}
  -> InnerA

InnerA
  ${PLACED(300, 0)}

InnerB
  ${PLACED(300, 150)}
`);
    const [innerA, innerB] = allNodes(doc).filter((node) => node.name.startsWith('Inner'));
    const { host, blockName } = extractSubgraph(doc.items, [innerA, innerB], doc);
    expect(blockName).toBe('Subgraph');
    expect(getProp(host, 'expand')).toBe('Subgraph');
    const block = doc.items.find((item): item is GraphItem => item.kind === 'graph' && item.name === 'Subgraph');
    expect(block).toBeDefined();
    expect(nodesIn(block!.items).map((node) => node.name)).toEqual(['InnerA', 'InnerB']);
    expect(nodesIn(doc.items).map((node) => node.name)).toEqual(['Outside', 'Subgraph']);
  });

  it('centres the host on the extracted bbox and splices it at the first-extracted index', () => {
    const doc = docFrom(`Keep
  ${PLACED(0, 0)}

InnerA
  ${PLACED(100, 100)}

InnerB
  ${PLACED(400, 200)}

Tail
  ${PLACED(700, 0)}
`);
    const innerA = allNodes(doc).find((node) => node.name === 'InnerA')!;
    const innerB = allNodes(doc).find((node) => node.name === 'InnerB')!;
    const { host } = extractSubgraph(doc.items, [innerA, innerB], doc);
    expect(host.pos).toEqual({ x: 250, y: 150, w: DEFAULT_NODE_SIZE.w, h: DEFAULT_NODE_SIZE.h });
    const names = doc.items.filter((item) => item.kind === 'node').map((item) => item.node.name);
    expect(names).toEqual(['Keep', 'Subgraph', 'Tail']);
  });

  it('leaves internal edges untouched, including one carrying {Inner}', () => {
    const doc = docFrom(`InnerA
  ${PLACED(0, 0)}
  -> InnerB
  -> InnerB {InnerB}

InnerB
  ${PLACED(300, 0)}
`);
    const [innerA, innerB] = allNodes(doc);
    extractSubgraph(doc.items, [innerA, innerB], doc);
    const block = doc.items.find((item): item is GraphItem => item.kind === 'graph')!;
    const movedA = nodesIn(block.items).find((node) => node.name === 'InnerA')!;
    expect(movedA.edges).toEqual([
      { target: 'InnerB', innerSource: null, innerTarget: null, label: null, data: null },
      { target: 'InnerB', innerSource: null, innerTarget: 'InnerB', label: null, data: null },
    ]);
    expect(innerB.edges).toEqual([]);
  });

  it('rewires incoming flow edges to -> Host {Inner} preserving label and data', () => {
    const doc = docFrom(`Outside
  ${PLACED(0, 0)}
  -> InnerA : "in"
    data:
      amount: number

InnerA
  ${PLACED(300, 0)}
`);
    const innerA = allNodes(doc).find((node) => node.name === 'InnerA')!;
    const { host } = extractSubgraph(doc.items, [innerA], doc);
    const outside = allNodes(doc).find((node) => node.name === 'Outside')!;
    expect(outside.edges[0]).toMatchObject({
      target: host.name,
      innerTarget: 'InnerA',
      label: 'in',
      data: [{ key: 'amount', type: 'number' }],
    });
    expect(serializeFlow(doc)).toContain('-> Subgraph {InnerA} : "in"');
  });

  it('replaces an existing innerTarget on incoming edges (single-level truncation)', () => {
    const doc = docFrom(`Outside
  ${PLACED(0, 0)}
  -> InnerA {Deep}

InnerA
  ${PLACED(300, 0)}
`);
    const innerA = allNodes(doc).find((node) => node.name === 'InnerA')!;
    const { host } = extractSubgraph(doc.items, [innerA], doc);
    const outside = allNodes(doc).find((node) => node.name === 'Outside')!;
    expect(outside.edges[0]).toMatchObject({ target: host.name, innerTarget: 'InnerA' });
  });

  it('lifts outgoing edges onto the host with innerSource, preserving label and data', () => {
    const doc = docFrom(`InnerA
  ${PLACED(0, 0)}
  -> Outside : "out"
    data:
      amount: number
  {Deep} -> Far
  -> Ghost

InnerB
  ${PLACED(300, 0)}

Outside
  ${PLACED(600, 0)}

Far
  ${PLACED(600, 150)}
`);
    const innerA = allNodes(doc).find((node) => node.name === 'InnerA')!;
    const innerB = allNodes(doc).find((node) => node.name === 'InnerB')!;
    const { host } = extractSubgraph(doc.items, [innerA, innerB], doc);
    expect(innerA.edges).toEqual([]);
    expect(host.edges).toEqual([
      { target: 'Outside', innerSource: 'InnerA', innerTarget: null, label: 'out', data: [{ key: 'amount', type: 'number' }] },
      { target: 'Far', innerSource: 'InnerA', innerTarget: null, label: null, data: null },
      { target: 'Ghost', innerSource: 'InnerA', innerTarget: null, label: null, data: null },
    ]);
    expect(serializeFlow(doc)).toContain('{InnerA} -> Outside : "out"');
  });

  it('retargets incoming on_error to -> Host without braces and leaves escaping on_error intact', () => {
    const doc = docFrom(`Outside
  ${PLACED(0, 0)}
  on_error: -> InnerA : "err"

InnerA
  ${PLACED(300, 0)}
  on_error: -> Outside2 : "escape"

Outside2
  ${PLACED(600, 0)}
`);
    const innerA = allNodes(doc).find((node) => node.name === 'InnerA')!;
    const { host } = extractSubgraph(doc.items, [innerA], doc);
    const outside = allNodes(doc).find((node) => node.name === 'Outside')!;
    expect(getProp(outside, 'on_error')).toBe('-> Subgraph : "err"');
    const block = doc.items.find((item): item is GraphItem => item.kind === 'graph')!;
    const movedInner = nodesIn(block.items)[0];
    expect(getProp(movedInner, 'on_error')).toBe('-> Outside2 : "escape"');
    expect(host.name).toBe('Subgraph');
  });

  it('copies entrypoint to the host, retains it inside, and preserves expand on extracted nodes', () => {
    const doc = docFrom(`InnerA
  ${PLACED(0, 0)}
  entrypoint: true
  expand: Other

InnerB
  ${PLACED(300, 0)}

graph: Other
  Nested
`);
    const [innerA, innerB] = allNodes(doc).filter((node) => node.name.startsWith('Inner'));
    const { host } = extractSubgraph(doc.items, [innerA, innerB], doc);
    expect(getProp(host, 'entrypoint')).toBe('true');
    const block = doc.items.find((item): item is GraphItem => item.kind === 'graph' && item.name === 'Subgraph')!;
    const movedA = nodesIn(block.items).find((node) => node.name === 'InnerA')!;
    expect(getProp(movedA, 'entrypoint')).toBe('true');
    expect(getProp(movedA, 'expand')).toBe('Other');
  });

  it('picks a unique name against existing graph blocks and node names', () => {
    const doc = docFrom(`graph: Subgraph
  Existing

Subgraph
  ${PLACED(0, 0)}

A
  ${PLACED(300, 0)}

B
  ${PLACED(300, 150)}
`);
    const a = allNodes(doc).find((node) => node.name === 'A')!;
    const b = allNodes(doc).find((node) => node.name === 'B')!;
    const { host, blockName } = extractSubgraph(doc.items, [a, b], doc);
    expect(blockName).toBe('Subgraph 2');
    expect(host.name).toBe('Subgraph 2');
  });

  it('retargets same-file innerTarget and innerSource after extraction', () => {
    const doc = docFrom(`Validate
  -> Process Payment {Charge Card}

Process Payment
  expand: Payment Steps
  {Charge Card} -> Notify Admin

Notify Admin

graph: Payment Steps
  Charge Card
    ${PLACED(100, 100)}
  Capture Funds
    ${PLACED(400, 100)}
`);
    const charge = allNodes(doc).find((node) => node.name === 'Charge Card')!;
    const capture = allNodes(doc).find((node) => node.name === 'Capture Funds')!;
    const retargets = [charge, capture].map((node) => ({
      identity: expandIdentityForNode(doc, null, node)!,
      name: node.name,
    }));
    const { host } = extractSubgraph(scopeItems(doc, 'Payment Steps'), [charge, capture], doc);
    for (const { identity, name } of retargets) {
      retargetInnerRefs([{ doc, path: null }], identity, name, host.name);
    }
    expect(allNodes(doc).find((node) => node.name === 'Validate')!.edges[0]).toMatchObject({
      target: 'Process Payment',
      innerTarget: host.name,
    });
    expect(allNodes(doc).find((node) => node.name === 'Process Payment')!.edges[0]).toMatchObject({
      target: 'Notify Admin',
      innerSource: host.name,
    });
  });

  it('retargets {Extracted} refs elsewhere to the host for graph-block and external-path identities', () => {
    const parent = docFrom(`Validate
  -> Process Payment {InnerA}

Process Payment
  expand: Payment Steps

graph: Payment Steps
  InnerA
    ${PLACED(100, 100)}
  InnerB
    ${PLACED(400, 100)}
`);
    const innerA = allNodes(parent).find((node) => node.name === 'InnerA')!;
    const innerB = allNodes(parent).find((node) => node.name === 'InnerB')!;
    const identity = expandIdentityForNode(parent, null, innerA)!;
    const { host } = extractSubgraph(scopeItems(parent, 'Payment Steps'), [innerA, innerB], parent);
    retargetInnerRefs([{ doc: parent, path: null }], identity, 'InnerA', host.name);
    expect(allNodes(parent).find((node) => node.name === 'Validate')!.edges[0]).toMatchObject({
      target: 'Process Payment',
      innerTarget: host.name,
    });

    const cart = docFrom(`Validate
  -> Process Payment {InnerA}

Process Payment
  expand: [Payment](payment.flow)
`);
    const payment = docFrom(`InnerA
  ${PLACED(0, 0)}

InnerB
  ${PLACED(300, 0)}
`);
    const payInnerA = allNodes(payment).find((node) => node.name === 'InnerA')!;
    const payInnerB = allNodes(payment).find((node) => node.name === 'InnerB')!;
    const extIdentity = expandIdentityForNode(payment, 'payment.flow', payInnerA)!;
    const { host: payHost } = extractSubgraph(payment.items, [payInnerA, payInnerB], payment);
    retargetInnerRefs(
      [
        { doc: cart, path: 'cart.flow' },
        { doc: payment, path: 'payment.flow' },
      ],
      extIdentity,
      'InnerA',
      payHost.name,
    );
    expect(allNodes(cart).find((node) => node.name === 'Validate')!.edges[0]).toMatchObject({
      target: 'Process Payment',
      innerTarget: payHost.name,
    });
  });

  it('builds a model without ghosts and round-trips brace forms through serialize', () => {
    const doc = docFrom(`Outside
  ${PLACED(0, 0)}
  -> InnerA : "in"

InnerA
  ${PLACED(300, 0)}
  -> InnerB
  -> Outside2 : "out"

InnerB
  ${PLACED(300, 150)}

Outside2
  ${PLACED(600, 0)}
`);
    const innerA = allNodes(doc).find((node) => node.name === 'InnerA')!;
    const innerB = allNodes(doc).find((node) => node.name === 'InnerB')!;
    const { host, blockName } = extractSubgraph(doc.items, [innerA, innerB], doc);
    const innerModel = buildModel(doc, blockName);
    expect(innerModel.ghosts).toEqual([]);
    const outerModel = buildModel(doc, null);
    const incoming = outerModel.edges.find((edge) => edge.spec.label === 'in')!;
    expect(incoming.spec.target).toBe(host.name);
    expect(incoming.to).toBe(host);
    const text = serializeFlow(doc);
    expect(text).toContain('-> Subgraph {InnerA} : "in"');
    expect(text).toContain('{InnerA} -> Outside2 : "out"');
    expect(parseFlow(text).items.some((item) => item.kind === 'graph' && item.name === 'Subgraph')).toBe(true);
  });
});

describe('extractGraphBlockToDocument', () => {
  const HOSTED = `Host
  ${PLACED(0, 0)}
  expand: Payment Steps

graph: Payment Steps
  Charge Card
    ${PLACED(0, 0)}
    -> Send Receipt
  Send Receipt
    ${PLACED(300, 0)}
`;

  it('moves the block into a named document and relinks the host', () => {
    const doc = docFrom(HOSTED);
    const extracted = extractGraphBlockToDocument(doc, 'Payment Steps', 'payment-steps.flow');
    expect(getPreambleField(extracted, 'name')).toBe('Payment Steps');
    expect(nodesIn(extracted.items).map((node) => node.name)).toEqual(['Charge Card', 'Send Receipt']);
    expect(graphBlockNames(doc)).toEqual([]);
    const host = allNodes(doc).find((node) => node.name === 'Host')!;
    expect(getProp(host, 'expand')).toBe('[Payment Steps](payment-steps.flow)');
  });

  it('relinks every node that referenced the block', () => {
    const doc = docFrom(`One
  ${PLACED(0, 0)}
  expand: Shared

Two
  ${PLACED(300, 0)}
  expand: Shared

graph: Shared
  Step
    ${PLACED(0, 0)}
`);
    extractGraphBlockToDocument(doc, 'Shared', 'shared.flow');
    for (const node of allNodes(doc)) {
      if (node.name === 'Step') continue;
      expect(getProp(node, 'expand')).toBe('[Shared](shared.flow)');
    }
  });

  it('moves a sole host description into the new preamble', () => {
    const doc = docFrom(`Host
  ${PLACED(0, 0)}
  expand: Payment Steps
  description: "charges the customer"

graph: Payment Steps
  Charge Card
    ${PLACED(0, 0)}
`);
    const extracted = extractGraphBlockToDocument(doc, 'Payment Steps', 'payment-steps.flow');
    expect(getPreambleField(extracted, 'description')).toBe('"charges the customer"');
    const host = allNodes(doc).find((node) => node.name === 'Host')!;
    expect(getProp(host, 'description')).toBeNull();
  });

  it('leaves per-host descriptions alone when the block has several hosts', () => {
    const doc = docFrom(`One
  ${PLACED(0, 0)}
  expand: Shared
  description: "first"

Two
  ${PLACED(300, 0)}
  expand: Shared
  description: "second"

graph: Shared
  Step
    ${PLACED(0, 0)}
`);
    const extracted = extractGraphBlockToDocument(doc, 'Shared', 'shared.flow');
    expect(getPreambleField(extracted, 'description')).toBeNull();
    expect(getProp(allNodes(doc).find((node) => node.name === 'One')!, 'description')).toBe('"first"');
  });

  it('moves a sole host references block into the new preamble', () => {
    const doc = docFrom(`Host
  ${PLACED(0, 0)}
  expand: Payment Steps
  references:
    - [Charge](src/payments/charge.ts:20)

graph: Payment Steps
  Charge Card
    ${PLACED(0, 0)}
`);
    const extracted = extractGraphBlockToDocument(doc, 'Payment Steps', 'payment-steps.flow');
    expect(extracted.preamble?.references).toEqual([{ label: 'Charge', target: 'src/payments/charge.ts:20' }]);
    expect(allNodes(doc).find((node) => node.name === 'Host')!.references).toEqual([]);
  });

  it('leaves per-host references alone when the block has several hosts', () => {
    const doc = docFrom(`One
  ${PLACED(0, 0)}
  expand: Shared
  references:
    - src/one.ts

Two
  ${PLACED(300, 0)}
  expand: Shared

graph: Shared
  Step
    ${PLACED(0, 0)}
`);
    const extracted = extractGraphBlockToDocument(doc, 'Shared', 'shared.flow');
    expect(extracted.preamble?.references).toEqual([]);
    expect(allNodes(doc).find((node) => node.name === 'One')!.references).toEqual([
      { label: null, target: 'src/one.ts' },
    ]);
  });

  it('keeps an inner refinement pointing into the relinked host', () => {
    const doc = docFrom(`Outside
  ${PLACED(0, 0)}
  -> Host {Charge Card} : "in"

${HOSTED}`);
    extractGraphBlockToDocument(doc, 'Payment Steps', 'payment-steps.flow');
    const outside = allNodes(doc).find((node) => node.name === 'Outside')!;
    expect(outside.edges[0]).toMatchObject({ target: 'Host', innerTarget: 'Charge Card' });
  });

  it('takes a nested block that only the extracted content reaches', () => {
    const doc = docFrom(`Host
  ${PLACED(0, 0)}
  expand: Outer

graph: Outer
  Step
    ${PLACED(0, 0)}
    expand: Nested

graph: Nested
  Deep
    ${PLACED(0, 0)}
`);
    const extracted = extractGraphBlockToDocument(doc, 'Outer', 'outer.flow');
    expect(graphBlockNames(doc)).toEqual([]);
    expect(graphBlockNames(extracted)).toEqual(['Nested']);
    expect(nodesIn(extracted.items).map((node) => node.name)).toEqual(['Step']);
  });

  it('copies a nested block the parent still reaches, with fresh ids', () => {
    const doc = docFrom(`Host
  ${PLACED(0, 0)}
  expand: Outer

Sibling
  ${PLACED(300, 0)}
  expand: Nested

graph: Outer
  Step
    ${PLACED(0, 0)}
    expand: Nested

graph: Nested
  Deep
    ${PLACED(0, 0)}
`);
    const extracted = extractGraphBlockToDocument(doc, 'Outer', 'outer.flow');
    expect(graphBlockNames(doc)).toEqual(['Nested']);
    expect(graphBlockNames(extracted)).toEqual(['Nested']);
    const originalId = allNodes(doc).find((node) => node.name === 'Deep')!.id;
    const copyId = allNodes(extracted).find((node) => node.name === 'Deep')!.id;
    expect(copyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(copyId).not.toBe(originalId);
  });

  it('names the document and link label from the caller, not the block', () => {
    const doc = docFrom(HOSTED);
    const extracted = extractGraphBlockToDocument(doc, 'Payment Steps', 'host.flow', 'Host');
    expect(getPreambleField(extracted, 'name')).toBe('Host');
    const host = allNodes(doc).find((node) => node.name === 'Host')!;
    expect(getProp(host, 'expand')).toBe('[Host](host.flow)');
  });

  it('creates a preamble-only document when the block does not exist yet', () => {
    const doc = docFrom(`Host
  ${PLACED(0, 0)}
  expand: Planned
`);
    const extracted = extractGraphBlockToDocument(doc, 'Planned', 'planned.flow');
    expect(extracted.items).toEqual([]);
    expect(serializeFlow(extracted)).toBe('---\nname: Planned\n---\n');
    const host = allNodes(doc).find((node) => node.name === 'Host')!;
    expect(getProp(host, 'expand')).toBe('[Planned](planned.flow)');
  });
});

describe('groupNodesByOwner', () => {
  const doc = docFrom(`Top
  ${PLACED(0, 0)}

Second
  ${PLACED(300, 0)}

graph: Inner
  Nested
    ${PLACED(0, 300)}
`);
  const other = docFrom(`Elsewhere
  ${PLACED(0, 0)}
`);
  const [top, second, nested] = allNodes(doc);
  const [elsewhere] = allNodes(other);
  const ownerOf = (node: FlowNode) =>
    allNodes(doc).includes(node) ? { doc, path: 'main.flow' } : { doc: other, path: 'other.flow' };

  it('splits a selection by owning document', () => {
    const groups = groupNodesByOwner([top, elsewhere], ownerOf);
    expect(groups.map((group) => group.owner.path)).toEqual(['main.flow', 'other.flow']);
  });

  it('buckets nodes of one document by the item list that holds them', () => {
    const [group] = groupNodesByOwner([top, nested, second], ownerOf);
    expect(group.itemGroups).toHaveLength(2);
    expect(group.itemGroups[0].items).toBe(doc.items);
    expect(group.itemGroups[0].nodes).toEqual([top, second]);
    expect(group.itemGroups[1].items).toBe(containingItems(doc, nested));
    expect(group.itemGroups[1].nodes).toEqual([nested]);
  });

  it('preserves the order the nodes were given in, at both levels', () => {
    const groups = groupNodesByOwner([nested, elsewhere, top], ownerOf);
    expect(groups.map((group) => group.owner.path)).toEqual(['main.flow', 'other.flow']);
    expect(groups[0].itemGroups.map((entry) => entry.nodes)).toEqual([[nested], [top]]);
  });

  it('returns nothing for an empty selection', () => {
    expect(groupNodesByOwner([], ownerOf)).toEqual([]);
  });
});
