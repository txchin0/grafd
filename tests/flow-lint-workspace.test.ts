import { describe, expect, it } from 'vitest';
import { lintWorkspace, type WorkspaceFile } from '../src/shared/flow-lint-workspace.js';
import { emptyManifest, MANIFEST_FILE_NAME, type WorkspaceManifest } from '../src/shared/manifest.js';

function file(path: string, text: string): WorkspaceFile {
  return { path, text };
}

function rulesIn(files: WorkspaceFile[], manifest?: WorkspaceManifest): Record<string, string[]> {
  const byPath: Record<string, string[]> = {};
  for (const result of lintWorkspace({ files, manifest })) {
    byPath[result.path] = result.diagnostics.map((diagnostic) => diagnostic.rule);
  }
  return byPath;
}

function manifestWithEntrypoint(entrypoint: string): WorkspaceManifest {
  return { ...emptyManifest(), entrypoint };
}

const MAIN = `---
name: Main
---

Start
  expand: [Login](auth/login.flow)
  -> Finish

Finish
`;

const LOGIN = `---
name: Login
---

Validate
  -> Succeed

Succeed
`;

describe('lintWorkspace', () => {
  it('reports nothing for a workspace whose links all resolve', () => {
    const results = lintWorkspace({
      files: [file('main.flow', MAIN), file('auth/login.flow', LOGIN)],
      manifest: manifestWithEntrypoint('main.flow'),
    });
    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
  });

  it('reports an expand link with no file behind it', () => {
    const rules = rulesIn([file('main.flow', MAIN)], manifestWithEntrypoint('main.flow'));
    expect(rules['main.flow']).toContain('expand-file-not-found');
  });

  it('resolves an inner-node refinement against the linked file body', () => {
    const withInner = MAIN.replace('  -> Finish', '  -> Finish\n  {Succeed} -> Finish : "done"');
    const files = [file('main.flow', withInner), file('auth/login.flow', LOGIN)];
    expect(rulesIn(files, manifestWithEntrypoint('main.flow'))['main.flow']).toEqual([]);

    const wrongName = withInner.replace('{Succeed}', '{Nope}');
    const wrong = [file('main.flow', wrongName), file('auth/login.flow', LOGIN)];
    expect(rulesIn(wrong, manifestWithEntrypoint('main.flow'))['main.flow']).toContain('inner-source-not-found');
  });

  it('reports an on_error handler file that is not in the workspace', () => {
    const text = '---\nname: Main\non_error: [Handler](errors.flow)\n---\n\nStart\n';
    expect(rulesIn([file('main.flow', text)])['main.flow']).toContain('on-error-file-not-found');
  });

  it('treats an on_error handler file as reachable from the entrypoint', () => {
    const main = '---\nname: Main\non_error: [Handler](errors.flow)\n---\n\nStart\n';
    const errors = '---\nname: Errors\n---\n\nHandle\n';
    const rules = rulesIn(
      [file('main.flow', main), file('errors.flow', errors)],
      manifestWithEntrypoint('main.flow'),
    );
    expect(rules['errors.flow'] ?? []).not.toContain('unreachable-flow-file');
  });

  it('reports an expansion that leads back to itself', () => {
    const a = '---\nname: A\n---\n\nStart\n  expand: [B](b.flow)\n';
    const b = '---\nname: B\n---\n\nBack\n  expand: [A](a.flow)\n';
    const rules = rulesIn([file('a.flow', a), file('b.flow', b)], manifestWithEntrypoint('a.flow'));
    expect([...rules['a.flow'], ...rules['b.flow']]).toContain('expansion-cycle');
  });

  it('reports a local graph block that expands itself', () => {
    const text = '---\nname: A\n---\n\nHost\n  expand: Loop\n\ngraph: Loop\n  Inner\n    id: 1\n  Deeper\n    expand: Loop\n';
    expect(rulesIn([file('a.flow', text)])['a.flow']).toContain('expansion-cycle');
  });

  it('reports a file no expand link reaches', () => {
    const orphan = '---\nname: Orphan\n---\n\nAlone\n';
    const rules = rulesIn(
      [file('main.flow', MAIN), file('auth/login.flow', LOGIN), file('stray.flow', orphan)],
      manifestWithEntrypoint('main.flow'),
    );
    expect(rules['stray.flow']).toContain('unreachable-flow-file');
    expect(rules['auth/login.flow']).not.toContain('unreachable-flow-file');
  });

  it('reports a manifest entrypoint that names no file, against the manifest', () => {
    const results = lintWorkspace({
      files: [file('main.flow', MAIN), file('auth/login.flow', LOGIN)],
      manifest: manifestWithEntrypoint('gone.flow'),
    });
    const manifestResult = results.find((result) => result.path === MANIFEST_FILE_NAME);
    expect(manifestResult?.diagnostics.map((diagnostic) => diagnostic.rule)).toEqual(['manifest-entrypoint-missing']);
  });
});
