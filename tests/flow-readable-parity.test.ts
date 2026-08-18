// The editor and the linter resolve read access independently: flow-doc over the parsed AST,
// flow-lint-semantics over the scan. They must agree for every node in a file — the editor
// generates `inherits` from its map and the linter checks that map against its own. These tests
// put the two side by side, including the scope orderings and name collisions that used to
// split them.

import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/shared/flow-format.js';
import { contextNamesReadableBy, nodesIn, scopeItems } from '../src/client/flow-doc.js';
import { readableContextsByNode } from '../src/shared/flow-lint-semantics.js';
import { scanFlow } from '../src/shared/flow-scan.js';

function assertParity(text: string): void {
  const doc = parseFlow(text);
  const scan = scanFlow(text);
  const readable = readableContextsByNode(scan);
  for (const scope of scan.scopes) {
    const items = scope.name == null ? doc.items : scopeItems(doc, scope.name);
    for (const scanned of scope.nodes) {
      const node = nodesIn(items).find((candidate) => candidate.name === scanned.name);
      expect(node, `node "${scanned.name}" in scope ${scope.name ?? 'body'}`).toBeDefined();
      const editor = [...contextNamesReadableBy(doc, node!)].sort();
      const linter = [...(readable.get(scanned) ?? [])].sort();
      expect(editor, `readable set of "${scanned.name}" in scope ${scope.name ?? 'body'}`).toEqual(linter);
    }
  }
}

describe('readable-context parity between editor and linter', () => {
  it('agrees on a plain nested context', () => {
    assertParity(`Host
  expand: Steps

graph: Steps
  context: Dialog
    nodes:
      - Worker

  Worker
`);
  });

  it('agrees on host-inherited providers unioned with nested membership', () => {
    assertParity(`context: Auth
  nodes:
    - Host

Host
  expand: Steps

graph: Steps
  context: Dialog
    nodes:
      - Worker

  Worker
`);
  });

  it('agrees when a graph\'s host is declared in a later scope', () => {
    assertParity(`graph: Inner
  context: Local
    nodes:
      - X

  X

graph: Steps
  context: Dialog
    nodes:
      - Host

  Host
    expand: Inner
`);
  });

  it('agrees when a file-body node and a graph node share a name', () => {
    assertParity(`context: Auth
  nodes:
    - Worker

Worker
  expand: Steps

graph: Steps
  context: Dialog
    nodes:
      - Worker

  Worker
`);
  });

  it('agrees on the inherited fallback for nodes in no block', () => {
    assertParity(`---
name: T
inherits: [Billing]
---

context: Session
  nodes:
    - A

A

graph: Sub
  B
`);
  });
});
