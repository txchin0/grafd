import { describe, expect, it } from 'vitest';
import { parseFlow, serializeFlow, type FlowDocument } from '../src/shared/flow-format.js';
import { emptyManifest } from '../src/shared/manifest.js';
import { relativizePath } from '../src/client/flow-paths.js';
import {
  renameTargetPath,
  renameManifestPaths,
  rewriteFileReferences,
  validateFlowRename,
} from '../src/client/file-rename.js';

function doc(text: string): FlowDocument {
  return parseFlow(text);
}

describe('relativizePath', () => {
  it('keeps root-relative and same-folder paths as-is', () => {
    expect(relativizePath('', 'auth/signin.flow')).toBe('auth/signin.flow');
    expect(relativizePath('auth', 'auth/signin.flow')).toBe('signin.flow');
  });

  it('climbs out of deeper containing folders', () => {
    expect(relativizePath('auth', 'auth/signin.flow')).toBe('signin.flow');
    expect(relativizePath('auth/inner', 'auth/signin.flow')).toBe('../signin.flow');
    expect(relativizePath('billing/checkout', 'auth/signin.flow')).toBe('../../auth/signin.flow');
  });

  it('descends into a folder the container does not know', () => {
    expect(relativizePath('billing', 'auth/signin.flow')).toBe('../auth/signin.flow');
  });
});

describe('validateFlowRename', () => {
  const files = ['main.flow', 'auth/login.flow', 'auth/logout.flow'];

  it('resolves a subfolder rename inside the same folder', () => {
    expect(renameTargetPath('auth/login.flow', 'signin')).toBe('auth/signin.flow');
    expect(renameTargetPath('auth/login.flow', 'signin.flow')).toBe('auth/signin.flow');
    expect(renameTargetPath('main.flow', 'renamed')).toBe('renamed.flow');
  });

  it('returns the normalized request unchanged for blank or path-like input', () => {
    expect(renameTargetPath('auth/login.flow', '   ')).toBe('');
    expect(renameTargetPath('auth/login.flow', 'other/signin')).toBe('other/signin.flow');
  });

  it('accepts a plain new name with the extension implied', () => {
    expect(validateFlowRename(files, 'auth/login.flow', 'signin')).toBeNull();
  });

  it('accepts an explicit extension and a case-only rename of the same file', () => {
    expect(validateFlowRename(files, 'main.flow', 'Main.flow')).toBeNull();
    expect(validateFlowRename(files, 'auth/login.flow', 'Login')).toBeNull();
  });

  it('treats the unchanged name and a blank box as a no-op cancel', () => {
    expect(validateFlowRename(files, 'auth/login.flow', 'login.flow')).toBeNull();
    expect(validateFlowRename(files, 'auth/login.flow', 'login')).toBeNull();
    expect(validateFlowRename(files, 'auth/login.flow', '   ')).toBeNull();
  });

  it('keeps the file in its current folder', () => {
    expect(validateFlowRename(files, 'auth/login.flow', 'auth/signin')).toMatch(/current folder/);
  });

  it('rejects a case-insensitive collision with another file', () => {
    expect(validateFlowRename(['main.flow', 'MAIN.flow'], 'main.flow', 'MAIN')).toMatch(/already exists/);
    expect(validateFlowRename(['auth/login.flow', 'auth/Login.flow'], 'auth/login.flow', 'Login')).toMatch(/already exists/);
    expect(validateFlowRename(['auth/login.flow', 'auth/signin.flow'], 'auth/login.flow', 'signin')).toMatch(/already exists/);
  });

  it('rejects names the workspace listing hides', () => {
    expect(validateFlowRename(files, 'main.flow', '.secret')).toMatch(/hidden/);
    expect(validateFlowRename(files, 'auth/login.flow', '.secret')).toMatch(/hidden/);
  });
});

describe('rewriteFileReferences', () => {
  const from = 'auth/login.flow';
  const to = 'auth/signin.flow';

  it('rewrites an expand link from the root to the new relative path', () => {
    const flow = doc('Host\n  id: h-1\n  expand: [Auth](auth/login.flow)\n');
    expect(rewriteFileReferences(flow, 'main.flow', from, to)).toBe(true);
    expect(serializeFlow(flow)).toContain('expand: [Auth](auth/signin.flow)');
  });

  it('rewrites an expand link from inside the renamed folder to a bare name', () => {
    const flow = doc('Host\n  id: h-1\n  expand: [Auth](login.flow)\n');
    expect(rewriteFileReferences(flow, 'auth/other.flow', from, to)).toBe(true);
    expect(serializeFlow(flow)).toContain('expand: [Auth](signin.flow)');
  });

  it('rewrites an expand link from a sibling folder through ..', () => {
    const flow = doc('Host\n  id: h-1\n  expand: [Auth](../auth/login.flow)\n');
    expect(rewriteFileReferences(flow, 'billing/checkout.flow', from, to)).toBe(true);
    expect(serializeFlow(flow)).toContain('expand: [Auth](../auth/signin.flow)');
  });

  it('leaves expand links and references to other files alone', () => {
    const flow = doc('Host\n  id: h-1\n  expand: [Other](auth/logout.flow)\n');
    expect(rewriteFileReferences(flow, 'main.flow', from, to)).toBe(false);
    expect(serializeFlow(flow)).toContain('[Other](auth/logout.flow)');
  });

  it('rewrites preamble, node and context references preserving line ranges and labels', () => {
    const flow = doc(`---
name: demo
references:
  - [Guide](auth/login.flow:10-20)
---

Host
  id: h-1
  references:
    - [Node](auth/login.flow:5)
    - https://example.com/x
    - auth/logout.flow

context: Zone
  references:
    - [Block](auth/login.flow:1)
  nodes:
    - Host
`);
    expect(rewriteFileReferences(flow, 'main.flow', from, to)).toBe(true);
    const text = serializeFlow(flow);
    expect(text).toContain('[Guide](auth/signin.flow:10-20)');
    expect(text).toContain('[Node](auth/signin.flow:5)');
    expect(text).toContain('[Block](auth/signin.flow:1)');
    expect(text).toContain('https://example.com/x');
    expect(text).toContain('auth/logout.flow');
  });

  it('rewrites plain references without labels', () => {
    const flow = doc('Host\n  id: h-1\n  references:\n    - auth/login.flow\n');
    expect(rewriteFileReferences(flow, 'main.flow', from, to)).toBe(true);
    expect(serializeFlow(flow)).toContain('auth/signin.flow');
  });

  it('matches case-insensitively for a case-only rename', () => {
    const flow = doc('Host\n  id: h-1\n  expand: [Auth](Auth/LOGIN.FLOW)\n');
    expect(rewriteFileReferences(flow, 'main.flow', 'auth/login.flow', 'auth/Login.flow')).toBe(true);
    expect(serializeFlow(flow)).toContain('expand: [Auth](auth/Login.flow)');
  });

  it('rewrites project-root-relative references through the workspace prefix', () => {
    const flow = doc('Host\n  id: h-1\n  references:\n    - [Guide](.grafd/auth/login.flow:10-20)\n');
    expect(rewriteFileReferences(flow, 'main.flow', from, to, '.grafd')).toBe(true);
    expect(serializeFlow(flow)).toContain('[Guide](.grafd/auth/signin.flow:10-20)');
  });

  it('keeps a bare workspace-relative reference in its bare convention', () => {
    const flow = doc('Host\n  id: h-1\n  references:\n    - auth/login.flow\n');
    expect(rewriteFileReferences(flow, 'main.flow', from, to, '.grafd')).toBe(true);
    expect(serializeFlow(flow)).toContain('auth/signin.flow');
  });

  it('leaves references outside the workspace prefix alone', () => {
    const flow = doc('Host\n  id: h-1\n  references:\n    - [Other](docs/auth/login.flow)\n');
    expect(rewriteFileReferences(flow, 'main.flow', from, to, '.grafd')).toBe(false);
    expect(serializeFlow(flow)).toContain('[Other](docs/auth/login.flow)');
  });
});

describe('renameManifestPaths', () => {
  it('moves entrypoint, active flow, cameras and expansions', () => {
    const manifest = emptyManifest();
    manifest.entrypoint = 'auth/login.flow';
    manifest.ui.activeFlow = 'auth/login.flow';
    manifest.ui.cameras = {
      'auth/login.flow': { x: 1, y: 2, scale: 1 },
      'main.flow': { x: 3, y: 4, scale: 1 },
    };
    manifest.ui.expansions = { 'auth/login.flow': ['n-1'] };
    renameManifestPaths(manifest, 'auth/login.flow', 'auth/signin.flow');
    expect(manifest.entrypoint).toBe('auth/signin.flow');
    expect(manifest.ui.activeFlow).toBe('auth/signin.flow');
    expect(manifest.ui.cameras).toEqual({
      'auth/signin.flow': { x: 1, y: 2, scale: 1 },
      'main.flow': { x: 3, y: 4, scale: 1 },
    });
    expect(manifest.ui.expansions).toEqual({ 'auth/signin.flow': ['n-1'] });
  });

  it('matches path keys case-insensitively', () => {
    const manifest = emptyManifest();
    manifest.ui.cameras = { 'AUTH/Login.flow': { x: 0, y: 0, scale: 1 } };
    renameManifestPaths(manifest, 'auth/login.flow', 'auth/signin.flow');
    expect(manifest.ui.cameras['auth/signin.flow']).toEqual({ x: 0, y: 0, scale: 1 });
    expect(manifest.ui.cameras['AUTH/Login.flow']).toBeUndefined();
  });
});
