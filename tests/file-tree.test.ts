import { describe, expect, it } from 'vitest';
import { buildFileTree } from '../src/client/file-tree.js';

describe('buildFileTree', () => {
  it('returns an empty root for no files', () => {
    expect(buildFileTree([])).toEqual({ name: '', path: '', folders: [], files: [] });
  });

  it('keeps root-level files on the root and nests the rest by folder', () => {
    const tree = buildFileTree(['main.flow', 'auth/login.flow', 'auth/logout.flow', 'checkout/pay.flow']);
    expect(tree.files).toEqual([{ name: 'main.flow', path: 'main.flow' }]);
    expect(tree.folders.map((folder) => folder.name)).toEqual(['auth', 'checkout']);
    expect(tree.folders[0].files).toEqual([
      { name: 'login.flow', path: 'auth/login.flow' },
      { name: 'logout.flow', path: 'auth/logout.flow' },
    ]);
  });

  it('builds deep chains with full folder paths at every level', () => {
    const tree = buildFileTree(['a/b/c/deep.flow']);
    const levelA = tree.folders[0];
    const levelB = levelA.folders[0];
    const levelC = levelB.folders[0];
    expect([levelA.path, levelB.path, levelC.path]).toEqual(['a', 'a/b', 'a/b/c']);
    expect(levelC.files[0]).toEqual({ name: 'deep.flow', path: 'a/b/c/deep.flow' });
  });

  it('sorts folders and files alphabetically regardless of input order', () => {
    const tree = buildFileTree(['z.flow', 'b/x.flow', 'a/y.flow', 'a/1.flow']);
    expect(tree.folders.map((folder) => folder.name)).toEqual(['a', 'b']);
    expect(tree.folders[0].files.map((file) => file.name)).toEqual(['1.flow', 'y.flow']);
    expect(tree.files.map((file) => file.name)).toEqual(['z.flow']);
  });
});
