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
context: [Cart]
references:
  - [Checkout service](src/server/checkout.ts:10-80)
  - https://stripe.com/docs
---

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
  expand: Payment Steps
  {Send Receipt} -> Show Error : "receipt failed"

Show Error

graph: Payment Steps
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

  it('reports context misuse only when the graph declares its context', () => {
    const declared = '---\nname: T\ncontext: [Cart]\n---\n\nA\n  updates: [Auth]\n';
    expect(rulesOf(declared)).toContain('updates-undeclared-context');

    const undeclared = '---\nname: T\n---\n\nA\n  updates: [Auth]\n';
    expect(rulesOf(undeclared)).not.toContain('updates-undeclared-context');

    const onLeaf = '---\nname: T\n---\n\nA\n  context: [Cart]\n';
    expect(rulesOf(onLeaf)).toContain('context-on-non-graph-node');
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

describe('the sample workspace', () => {
  it('has no errors', () => {
    const root = path.resolve('flows');
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
