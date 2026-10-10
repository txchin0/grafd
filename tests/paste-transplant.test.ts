// What a copy needs before it is pasted into another graph: edges that leave the copy dropped with
// their visuals, expand links respelled, local subgraphs found and renamed, and the walk that tells
// a paste it would put a node inside its own expansion.

import { describe, expect, it } from 'vitest';
import { getProp, parseFlow, type FlowDocument } from '../src/shared/flow-format.js';
import { allNodes } from '../src/client/flow-doc.js';
import type { CapturedVisuals } from '../src/shared/canvas-layer.js';
import {
  assignSubgraphNames,
  expansionReaches,
  keepEdgesWithinCopy,
  localSubgraphNames,
  rebaseExpandLinks,
  renameLocalExpands,
  renameUpdatedRegions,
} from '../src/client/paste-transplant.js';

const MAIN = `---
name: Main
---

A
  pos: 0, 0, 100, 50
  on_error: -> C
  -> B : "kept"
  -> C : "dropped"

B
  pos: 200, 0, 100, 50
  expand: Outer

C
  pos: 400, 0, 100, 50
  expand: [Far](far.flow)
  updates: [Auth, Other]

graph: Outer
  Middle
    expand: Inner

graph: Inner
  Bottom
    -> Bottom

graph: Unused
  Lone
`;

function nodesNamed(doc: FlowDocument, ...names: string[]) {
  return names.map((name) => allNodes(doc).find((node) => node.name === name)!);
}

const GREEN = { color: 'green' };
const RED = { color: 'red' };
const DASHED = { line: 'dashed' };

describe('keepEdgesWithinCopy', () => {
  it('drops edges and on_error that leave the copy, with the visuals paired to them', () => {
    const doc = parseFlow(MAIN);
    const [a, b] = nodesNamed(doc, 'A', 'B');
    const visuals = [
      { node: null, edges: [GREEN, RED], onError: DASHED },
      { node: null, edges: [], onError: null },
    ] as unknown as CapturedVisuals;

    const kept = keepEdgesWithinCopy([a, b], visuals);

    expect(kept.nodes[0].edges.map((edge) => edge.target)).toEqual(['B']);
    expect(getProp(kept.nodes[0], 'on_error')).toBeNull();
    expect(kept.visuals![0]).toEqual({ node: null, edges: [GREEN], onError: null });
  });

  it('leaves the sources it was given untouched', () => {
    const doc = parseFlow(MAIN);
    const [a] = nodesNamed(doc, 'A');
    keepEdgesWithinCopy([a], null);
    expect(a.edges).toHaveLength(2);
    expect(getProp(a, 'on_error')).toBe('-> C');
  });

  it('keeps an on_error aimed inside the copy', () => {
    const doc = parseFlow(MAIN);
    const kept = keepEdgesWithinCopy(nodesNamed(doc, 'A', 'C'), null);
    expect(getProp(kept.nodes[0], 'on_error')).toBe('-> C');
  });
});

describe('rebaseExpandLinks', () => {
  it('respells a link to reach the same file from another folder', () => {
    const doc = parseFlow(MAIN);
    const [c] = nodesNamed(doc, 'C');
    rebaseExpandLinks([c], 'flows/main.flow', 'other/deep/target.flow');
    expect(getProp(c, 'expand')).toBe('[Far](../../flows/far.flow)');
  });

  it('leaves a local expand and a same-file paste alone', () => {
    const doc = parseFlow(MAIN);
    const [b, c] = nodesNamed(doc, 'B', 'C');
    rebaseExpandLinks([b], 'main.flow', 'sub/x.flow');
    rebaseExpandLinks([c], 'main.flow', 'main.flow');
    expect(getProp(b, 'expand')).toBe('Outer');
    expect(getProp(c, 'expand')).toBe('[Far](far.flow)');
  });
});

describe('local subgraphs', () => {
  it('follows local expands through the blocks they reach, and nothing else', () => {
    const doc = parseFlow(MAIN);
    expect(localSubgraphNames(doc, nodesNamed(doc, 'A', 'B', 'C'))).toEqual(['Outer', 'Inner']);
  });

  it('names each carried block past the names already taken, and renames the expands that use them', () => {
    const renames = assignSubgraphNames(['Outer', 'Outer 2'], ['Outer', 'Inner']);
    expect([...renames]).toEqual([['Outer', 'Outer 3'], ['Inner', 'Inner']]);

    const doc = parseFlow(MAIN);
    const [b, c] = nodesNamed(doc, 'B', 'C');
    renameLocalExpands([b, c], renames);
    expect(getProp(b, 'expand')).toBe('Outer 3');
    expect(getProp(c, 'expand')).toBe('[Far](far.flow)');
  });

  it('points updates at the regions pasted beside them', () => {
    const doc = parseFlow(MAIN);
    const [c] = nodesNamed(doc, 'C');
    renameUpdatedRegions([c], new Map([['Auth', 'Auth 2']]));
    expect(getProp(c, 'updates')).toBe('[Auth 2, Other]');
  });
});

describe('expansionReaches', () => {
  const far = parseFlow(`---\nname: Far\n---\n\nBack\n  expand: [Main](main.flow)\n`);
  const documents = new Map([['main.flow', parseFlow(MAIN)], ['far.flow', far]]);
  const documentAt = (path: string) => documents.get(path) ?? null;

  it('reaches the graph it starts in', () => {
    expect(expansionReaches({ path: 'main.flow', scope: 'Outer' }, { path: 'main.flow', scope: 'Outer' }, documentAt)).toBe(true);
  });

  it('reaches through local blocks', () => {
    expect(expansionReaches({ path: 'main.flow', scope: 'Outer' }, { path: 'main.flow', scope: 'Inner' }, documentAt)).toBe(true);
    expect(expansionReaches({ path: 'main.flow', scope: 'Inner' }, { path: 'main.flow', scope: 'Outer' }, documentAt)).toBe(false);
  });

  it('reaches through a link into another file and back', () => {
    expect(expansionReaches({ path: 'far.flow', scope: null }, { path: 'main.flow', scope: 'Inner' }, documentAt)).toBe(true);
  });

  it('stops at a file that is not loaded', () => {
    const onlyMain = (path: string) => (path === 'main.flow' ? documents.get(path)! : null);
    expect(expansionReaches({ path: 'far.flow', scope: null }, { path: 'main.flow', scope: null }, onlyMain)).toBe(false);
  });

  it('ignores a block nobody has written', () => {
    expect(expansionReaches({ path: 'main.flow', scope: 'Missing' }, { path: 'main.flow', scope: null }, documentAt)).toBe(false);
  });
});
