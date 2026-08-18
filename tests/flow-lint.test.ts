import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintFlowFile } from '../src/shared/flow-lint.js';
import { lintWorkspace } from '../src/shared/flow-lint-workspace.js';

function rulesOf(text: string): string[] {
  return lintFlowFile(text).map((diagnostic) => diagnostic.rule);
}

function severityOf(text: string, rule: string): string | undefined {
  return lintFlowFile(text).find((diagnostic) => diagnostic.rule === rule)?.severity;
}

const CLEAN = `# A well-formed file, used as the baseline for every rule below.
---
name: Checkout
description: "Handles the cart through payment"
references:
  - [Checkout service](src/server/checkout.ts:10-80)
  - https://stripe.com/docs
---

context: Cart
  description: "Line items and totals, held until payment succeeds"
  nodes:
    - Process Payment

Validate Cart
  id: 11111111-1111-4111-8111-111111111111
  pos: 40, 40, 200, 88
  entrypoint: true
  references:
    - src/shared/cart.ts:12
  -> Process Payment {Charge Card} : "cart valid"
    data:
      cartId: string
  -> Show Error : "cart empty"

Process Payment
  id: 22222222-2222-4222-8222-222222222222
  updates: [Cart]
  on_error: -> Show Error
  expand: Process Payment
  {Send Receipt} -> Show Error : "receipt failed"

Show Error

graph: Process Payment
  Charge Card
    -> Send Receipt

  Send Receipt
`;

describe('lintFlowFile', () => {
  it('reports nothing for a well-formed file', () => {
    expect(lintFlowFile(CLEAN)).toEqual([]);
  });
});

describe('syntax rules', () => {
  it('reports an unterminated preamble, which costs the whole file body', () => {
    const diagnostics = lintFlowFile('---\nname: Truncated\n\nStart\n  -> Finish\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ rule: 'unterminated-preamble', severity: 'error', line: 1 });
  });

  it('reports a missing preamble and a preamble without a name', () => {
    expect(rulesOf('Start\n')).toContain('missing-preamble');
    expect(rulesOf('---\ndescription: "no name"\n---\n\nStart\n')).toContain('missing-preamble-name');
  });

  it('reports every line the parser would discard', () => {
    const text = `---
name: Messy
stray preamble line
---

  before any node

Start
  description "no colon"
    orphan block entry
  - entry with no references block
`;
    expect(rulesOf(text)).toEqual([
      'unparsable-preamble-line',
      'property-before-node',
      'unparsable-property',
      'orphan-block-entry',
      'unparsable-property',
    ]);
  });

  it('reports tabs and odd indentation', () => {
    expect(rulesOf('---\nname: T\n---\n\nStart\n\tdescription: "x"\n')).toContain('tab-indentation');
    expect(rulesOf('---\nname: T\n---\n\nStart\n   description: "x"\n')).toContain('odd-indentation');
  });

  it('reports a nested graph block, whose body the parser discards', () => {
    expect(rulesOf('---\nname: T\n---\n\ngraph: Outer\n  graph: Inner\n    A\n')).toContain('nested-graph-block');
  });

  it('reports node names carrying a colon or braces', () => {
    expect(rulesOf('---\nname: T\n---\n\nfoo: bar\n')).toContain('node-name-contains-colon');
    expect(rulesOf('---\nname: T\n---\n\nA {B}\n')).toContain('node-name-contains-braces');
  });

  it('reports duplicate names within a scope, but not across scopes', () => {
    expect(rulesOf('---\nname: T\n---\n\nA\n\nA\n')).toContain('duplicate-node-name');
    const acrossScopes = '---\nname: T\n---\n\nA\n  expand: Block\n\ngraph: Block\n  A\n';
    expect(rulesOf(acrossScopes)).not.toContain('duplicate-node-name');
  });

  it('reports a node id reused within the file', () => {
    const text = '---\nname: T\n---\n\nA\n  id: same\n\nB\n  id: same\n';
    expect(rulesOf(text)).toContain('duplicate-node-id');
  });

  it('reports an unquoted edge label, which the parser swallows into the target name', () => {
    expect(severityOf('---\nname: T\n---\n\nA\n  -> B : yes\n', 'unquoted-edge-label')).toBe('error');
    expect(rulesOf('---\nname: T\n---\n\nA\n  -> B : "yes" extra\n')).toContain('unquoted-edge-label');
    expect(rulesOf('---\nname: T\n---\n\nA\n  -> B : "yes"\n\nB\n')).toEqual([]);
  });

  it('reports quotes that the escape-free format cannot represent', () => {
    expect(rulesOf('---\nname: T\n---\n\nA\n  description: "he said "hi""\n')).toContain('quote-in-value');
    expect(rulesOf('---\nname: T\n---\n\nA\n  description: "unclosed\n')).toContain('quote-in-value');
  });

  it('reports property values the editor would silently discard or misread', () => {
    expect(rulesOf('---\nname: T\n---\n\nA\n  pos: 1, 2, 3\n')).toContain('malformed-pos');
    expect(rulesOf('---\nname: T\n---\n\nA\n  entrypoint: yes\n')).toContain('entrypoint-not-boolean');
    expect(rulesOf('---\nname: T\n---\n\nA\n  updates: Cart\n')).toContain('malformed-list-value');
    expect(rulesOf('---\nname: T\n---\n\nA\n  descripton: "typo"\n')).toContain('unknown-property');
    expect(rulesOf('---\nname: T\n---\n\nA\n  description: "one"\n  description: "two"\n')).toContain('duplicate-property');
  });

  it('accepts a context block nested in a graph block', () => {
    const text = '---\nname: T\n---\n\nOuter\n  expand: Outer\n\ngraph: Outer\n  context: Auth\n    nodes:\n      - Inner\n\n  Inner\n';
    expect(rulesOf(text)).not.toContain('nested-context-block');
    expect(rulesOf(text)).toEqual([]);
  });

  it('reports the lines a context block discards but a node would have kept', () => {
    const text = '---\nname: T\n---\n\ncontext: Auth\n  -> A\n  nodes:\n    A\n\nA\n';
    expect(rulesOf(text)).toEqual(expect.arrayContaining(['edge-in-context-block', 'malformed-member-entry']));
  });

  it('reports context blocks that are duplicated, misnamed, or missing their membership list', () => {
    const duplicated = '---\nname: T\n---\n\ncontext: Auth\n  nodes:\n    - A\n\ncontext: Auth\n  nodes:\n    - A\n\nA\n';
    expect(severityOf(duplicated, 'duplicate-context-block')).toBe('error');
    expect(rulesOf(duplicated)).toContain('duplicate-context-block');
    const nestedDup =
      '---\nname: T\n---\n\ncontext: Auth\n  nodes:\n\ngraph: Sub\n  context: Auth\n    nodes:\n';
    expect(rulesOf(nestedDup)).toContain('duplicate-context-block');
    expect(rulesOf('---\nname: T\n---\n\ncontext: Auth\n  description: "no members"\n\nA\n')).toContain(
      'context-block-missing-nodes',
    );
    expect(rulesOf('---\nname: T\n---\n\ncontext: A: B\n  nodes:\n')).toContain('context-name-contains-colon');
  });

  it('reports properties that no longer belong where they are written', () => {
    expect(rulesOf('---\nname: T\ncontext: [Cart]\n---\n\nA\n')).toContain('unknown-property');
    expect(rulesOf('---\nname: T\n---\n\nA\n  context: [Cart]\n')).toContain('unknown-property');
    expect(rulesOf('---\nname: T\n---\n\ncontext: Cart\n  expand: Sub\n  nodes:\n    - A\n\nA\n')).toContain(
      'unknown-property',
    );
  });

  it('reports empty blocks, which the serializer drops', () => {
    expect(rulesOf('---\nname: T\n---\n\nA\n  references:\n')).toContain('empty-references-block');
    expect(rulesOf('---\nname: T\n---\n\nA\n  -> B\n    data:\n\nB\n')).toContain('empty-edge-data-block');
  });
});

describe('semantic rules', () => {
  it('reports an edge or handler pointing at a node that does not exist', () => {
    expect(rulesOf('---\nname: T\n---\n\nA\n  -> Missing\n')).toContain('unresolved-edge-target');
    expect(rulesOf('---\nname: T\n---\n\nA\n  on_error: -> Missing\n')).toContain('unresolved-on-error-target');
    expect(rulesOf('---\nname: T\non_error: -> Missing\n---\n\nA\n')).toContain('unresolved-on-error-target');
    expect(rulesOf('---\nname: T\n---\n\nA\n  on_error: Show Error\n')).toContain('malformed-on-error');
  });

  it('reports an expand that resolves to nothing', () => {
    expect(rulesOf('---\nname: T\n---\n\nA\n  expand: Nowhere\n')).toContain('unresolved-local-expand');
    expect(rulesOf('---\nname: T\n---\n\nA\n  expand: [X](notes.md)\n')).toContain('expand-path-not-flow');
  });

  it('reports graph blocks nobody expands and blocks with no nodes', () => {
    const text = '---\nname: T\n---\n\nA\n\ngraph: Unused\n';
    expect(rulesOf(text)).toEqual(expect.arrayContaining(['unused-graph-block', 'empty-graph-block']));
  });

  it('reports a block only one node expands under a different name', () => {
    const diverged = '---\nname: T\n---\n\nA\n  expand: Sub\n\ngraph: Sub\n  Inner\n';
    expect(rulesOf(diverged)).toContain('sole-host-name-mismatch');
    expect(severityOf(diverged, 'sole-host-name-mismatch')).toBe('warning');

    const mirrored = '---\nname: T\n---\n\nSub\n  expand: Sub\n\ngraph: Sub\n  Inner\n';
    expect(rulesOf(mirrored)).not.toContain('sole-host-name-mismatch');

    const shared = '---\nname: T\n---\n\nA\n  expand: Sub\n\nB\n  expand: Sub\n\ngraph: Sub\n  Inner\n';
    expect(rulesOf(shared)).not.toContain('sole-host-name-mismatch');
  });

  it('reports inner-node refinements that name nothing', () => {
    const onLeaf = '---\nname: T\n---\n\nA\n  -> B {Inner}\n\nB\n';
    expect(rulesOf(onLeaf)).toContain('inner-target-on-non-subgraph');

    const wrongName = '---\nname: T\n---\n\nA\n  -> B {Nope}\n\nB\n  expand: Block\n\ngraph: Block\n  Inner\n';
    expect(rulesOf(wrongName)).toContain('inner-target-not-found');

    const sourceOnLeaf = '---\nname: T\n---\n\nA\n  {Inner} -> B\n\nB\n';
    expect(rulesOf(sourceOnLeaf)).toContain('inner-source-without-expand');

    const wrongSource = '---\nname: T\n---\n\nA\n  expand: Block\n  {Nope} -> B\n\nB\n\ngraph: Block\n  Inner\n';
    expect(rulesOf(wrongSource)).toContain('inner-source-not-found');
  });

  it('reports an update to a context the node cannot read, once the file says what it reads', () => {
    const inherited = '---\nname: T\ninherits: [Cart]\n---\n\nA\n  updates: [Auth]\n';
    expect(rulesOf(inherited)).toContain('updates-undeclared-context');

    const undeclared = '---\nname: T\n---\n\nA\n  updates: [Auth]\n';
    expect(rulesOf(undeclared)).not.toContain('updates-undeclared-context');
  });

  // Membership, not mere declaration: a provider declared in this file but scoped to other nodes
  // is not readable here, and the fix is the `nodes:` list rather than the `updates` line.
  it('reads a context through membership, inheritance, or the host node of a graph block', () => {
    const member = '---\nname: T\n---\n\ncontext: Cart\n  nodes:\n    - A\n\nA\n  updates: [Cart]\n';
    expect(rulesOf(member)).not.toContain('updates-undeclared-context');

    const nonMember = '---\nname: T\n---\n\ncontext: Cart\n  nodes:\n    - B\n\nA\n  updates: [Cart]\n\nB\n';
    expect(rulesOf(nonMember)).toContain('updates-undeclared-context');

    const inherited = '---\nname: T\ninherits: [Cart]\n---\n\nA\n  updates: [Cart]\n';
    expect(rulesOf(inherited)).not.toContain('updates-undeclared-context');

    const throughHost =
      '---\nname: T\n---\n\ncontext: Cart\n  nodes:\n    - A\n\nA\n  expand: Sub\n\ngraph: Sub\n  Inner\n    updates: [Cart]\n';
    expect(rulesOf(throughHost)).not.toContain('updates-undeclared-context');

    const hostNotAMember =
      '---\nname: T\n---\n\ncontext: Cart\n  nodes:\n\nA\n  expand: Sub\n\ngraph: Sub\n  Inner\n    updates: [Cart]\n';
    expect(rulesOf(hostNotAMember)).toContain('updates-undeclared-context');
  });

  it('reports a membership list that grants access to nothing', () => {
    const missing = '---\nname: T\n---\n\ncontext: Cart\n  nodes:\n    - Nowhere\n\nA\n';
    expect(rulesOf(missing)).toContain('context-member-not-found');

    const nested = '---\nname: T\n---\n\ncontext: Cart\n  nodes:\n    - Inner\n\nA\n  expand: Sub\n\ngraph: Sub\n  Inner\n';
    expect(rulesOf(nested)).toContain('context-member-in-graph-block');

    const nestedOk =
      '---\nname: T\n---\n\nA\n  expand: Sub\n\ngraph: Sub\n  context: Cart\n    nodes:\n      - Inner\n\n  Inner\n    updates: [Cart]\n';
    expect(rulesOf(nestedOk)).not.toContain('updates-undeclared-context');
    expect(rulesOf(nestedOk)).not.toContain('context-member-in-graph-block');

    const nestedMissing =
      '---\nname: T\n---\n\ngraph: Sub\n  context: Cart\n    nodes:\n      - Nowhere\n\n  Inner\n';
    expect(rulesOf(nestedMissing)).toContain('context-member-not-found');
  });

  it('reports a block that redeclares an inherited provider it cannot narrow', () => {
    const text = '---\nname: T\ninherits: [Cart]\n---\n\ncontext: Cart\n  nodes:\n    - A\n\nA\n';
    expect(rulesOf(text)).toContain('context-redeclares-inherited');
  });

  it('reports a provider with neither members nor an area, which nothing can read or draw', () => {
    expect(rulesOf('---\nname: T\n---\n\ncontext: Cart\n  nodes:\n\nA\n')).toContain('context-region-has-no-geometry');
    const drawn = '---\nname: T\n---\n\ncontext: Cart\n  pos: 0, 0, 400, 300\n  nodes:\n\nA\n';
    expect(rulesOf(drawn)).not.toContain('context-region-has-no-geometry');
  });

  it('reports a node lying fully inside a region that does not list it', () => {
    const text = `---
name: T
---

context: Cart
  pos: 0, 0, 400, 300
  nodes:
    - A

A
  pos: 40, 40, 200, 88

B
  pos: 100, 100, 100, 50
`;
    const diagnostics = lintFlowFile(text);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'node-inside-unassigned-region', severity: 'warning', line: 13 }),
      ]),
    );
    expect(rulesOf(text).filter((rule) => rule === 'node-inside-unassigned-region')).toHaveLength(1);
  });

  it('accepts a listed member inside its region, and a node that only overlaps it', () => {
    const text = `---
name: T
---

context: Cart
  pos: 0, 0, 400, 300
  nodes:
    - A
    - B

A
  pos: 40, 40, 200, 88

B
  pos: 100, 100, 100, 50

C
  pos: 300, 250, 200, 100
`;
    expect(rulesOf(text)).not.toContain('node-inside-unassigned-region');
  });

  // A region created by grouping a selection has no `pos` — its frame is the members' padded
  // bounds (spec §8.3), so the padding band counts toward the drawn area.
  it('derives a memberless region from the members\' bounds, padding included', () => {
    const text = `---
name: T
---

context: Cart
  nodes:
    - A

A
  pos: 40, 40, 200, 88

B
  pos: 60, 100, 80, 30
`;
    expect(rulesOf(text)).toContain('node-inside-unassigned-region');
  });

  // The canvas auto-lays out a node with no `pos` before painting, so the linter places it the
  // same way instead of skipping it.
  it('places a node without pos on the auto-layout grid before judging it', () => {
    const text = `---
name: T
---

context: Cart
  pos: 0, 0, 400, 400
  nodes:
    - A

A
  pos: 40, 40, 200, 88

B
`;
    expect(rulesOf(text)).toContain('node-inside-unassigned-region');
  });

  it('stays silent without any region geometry, or for nodes that cannot be members', () => {
    const noGeometry = '---\nname: T\n---\n\ncontext: Cart\n  nodes:\n\nA\n';
    expect(rulesOf(noGeometry)).not.toContain('node-inside-unassigned-region');

    const nested = `---
name: T
---

context: Cart
  pos: 0, 0, 400, 300
  nodes:

A
  pos: 500, 500, 100, 50
  expand: Sub

graph: Sub
  Inner
    pos: 100, 100, 100, 50
`;
    expect(rulesOf(nested)).not.toContain('node-inside-unassigned-region');
  });

  // A redeclared inherited context is inert — the declaring graph owns its membership — so a
  // region drawn on the redeclaration must not recruit nodes; both warnings on one block would
  // contradict each other.
  it('does not report nodes inside a region that redeclares an inherited context', () => {
    const text = `---
name: T
inherits: [Cart]
---

context: Cart
  pos: 0, 0, 400, 300

A
  pos: 40, 40, 200, 88
`;
    expect(rulesOf(text)).toContain('context-redeclares-inherited');
    expect(rulesOf(text)).not.toContain('node-inside-unassigned-region');
  });

  it('reports a duplicated edge', () => {
    expect(rulesOf('---\nname: T\n---\n\nA\n  -> B\n  -> B\n\nB\n')).toContain('duplicate-edge');
  });

  it('reports reference entries the editor would rewrite or drop', () => {
    expect(rulesOf('---\nname: T\n---\n\nA\n  references:\n    - [Label]()\n')).toContain('empty-reference-entry');
    expect(rulesOf('---\nname: T\n---\n\nA\n  references:\n    - https://x.test/a_(b)\n')).toContain(
      'reference-target-parentheses',
    );
    expect(rulesOf('---\nname: T\n---\n\nA\n  references:\n    - src/a.ts:90-12\n')).toContain(
      'reference-invalid-line-range',
    );
  });
});

describe('cross-file context rules', () => {
  function workspaceRules(files: { path: string; text: string }[], path: string): string[] {
    return lintWorkspace({ files })
      .find((file) => file.path === path)!
      .diagnostics.map((diagnostic) => diagnostic.rule);
  }

  const child = (inherits: string) => ({
    path: 'child.flow',
    text: `---\nname: Child\ninherits: ${inherits}\n---\n\nInner\n  updates: [Auth]\n`,
  });

  const parent = (members: string) => ({
    path: 'main.flow',
    text: `---\nname: Main\n---\n\ncontext: Auth\n  nodes:\n${members}\n\nHost\n  expand: [Child](child.flow)\n`,
  });

  it('accepts an inherits generated from the parent block listing the host node', () => {
    expect(workspaceRules([parent('    - Host'), child('[Auth]')], 'child.flow')).not.toContain(
      'inherits-without-parent-membership',
    );
  });

  it('reports an inherits the parent no longer backs with membership', () => {
    expect(workspaceRules([parent('    - Other'), child('[Auth]')], 'main.flow')).toContain('context-member-not-found');
    expect(workspaceRules([parent(''), child('[Auth]')], 'child.flow')).toContain(
      'inherits-without-parent-membership',
    );
  });

  // The direction no user can see: `inherits` is auto-generated, so a provider that never reached
  // an expansion leaves nothing in the child to look wrong.
  it('reports an expansion that never received the context its host can read', () => {
    const files = [parent('    - Host'), { path: 'child.flow', text: '---\nname: Child\n---\n\nInner\n' }];
    expect(workspaceRules(files, 'main.flow')).toContain('expansion-missing-inherits');
    expect(workspaceRules([parent('    - Host'), child('[Auth]')], 'main.flow')).not.toContain(
      'expansion-missing-inherits',
    );
  });

  const grandchildFrom = (childInherits: string) => [
    parent('    - Host'),
    {
      path: 'child.flow',
      text: `---\nname: Child\n${childInherits}---\n\nInner\n  expand: [Deep](deep.flow)\n`,
    },
    { path: 'deep.flow', text: '---\nname: Deep\n---\n\nLeaf\n' },
  ];

  // An inherited provider is graph-wide in the file that receives it (§8.4), so it keeps
  // propagating. Each file is measured against what its own children carry, which is what makes
  // the check reach any depth without walking the tree — and what keeps one break from cascading.
  it('follows inheritance to any depth, reporting the level where it breaks', () => {
    expect(workspaceRules(grandchildFrom('inherits: [Auth]\n'), 'child.flow')).toContain(
      'expansion-missing-inherits',
    );
    expect(workspaceRules(grandchildFrom(''), 'main.flow')).toContain('expansion-missing-inherits');
    expect(workspaceRules(grandchildFrom(''), 'child.flow')).not.toContain('expansion-missing-inherits');
  });

  it('carries a provider into an expansion reached through a local graph block', () => {
    const files = [
      {
        path: 'main.flow',
        text: '---\nname: Main\n---\n\ncontext: Auth\n  nodes:\n    - Host\n\nHost\n  expand: Host\n\ngraph: Host\n  Deep\n    expand: [Child](child.flow)\n',
      },
      { path: 'child.flow', text: '---\nname: Child\n---\n\nLeaf\n' },
    ];
    expect(workspaceRules(files, 'main.flow')).toContain('expansion-missing-inherits');
  });
});

describe('the sample workspace', () => {
  it('has no errors', () => {
    const root = path.resolve('.grafd');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.flow'))
      .map((entry) => ({
        path: entry.split(path.sep).join('/'),
        text: readFileSync(path.join(root, entry), 'utf8'),
      }));

    const errors = lintWorkspace({ files })
      .flatMap((file) => file.diagnostics.map((diagnostic) => ({ ...diagnostic, path: file.path })))
      .filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors).toEqual([]);
  });
});
