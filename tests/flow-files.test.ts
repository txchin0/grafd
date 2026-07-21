import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contentHash, listFlowFiles, resolveWorkspacePath, toPortablePath } from '../src/server/flow-files.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'graf-test-'));
  await mkdir(path.join(root, 'sub'));
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, 'dist'));
  await mkdir(path.join(root, '.hidden'));
  await writeFile(path.join(root, 'a.flow'), 'A\n');
  await writeFile(path.join(root, 'sub', 'b.flow'), 'B\n');
  await writeFile(path.join(root, 'note.txt'), 'not a flow\n');
  await writeFile(path.join(root, 'node_modules', 'x.flow'), 'X\n');
  await writeFile(path.join(root, 'dist', 'd.flow'), 'D\n');
  await writeFile(path.join(root, '.hidden', 'h.flow'), 'H\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveWorkspacePath', () => {
  it('resolves .flow paths inside the project root', () => {
    expect(resolveWorkspacePath(root, 'a.flow')).toBe(path.join(root, 'a.flow'));
    expect(resolveWorkspacePath(root, 'sub/b.flow')).toBe(path.join(root, 'sub', 'b.flow'));
  });

  it('resolves the workspace manifest at the root only', () => {
    expect(resolveWorkspacePath(root, 'graf.manifest.json')).toBe(path.join(root, 'graf.manifest.json'));
    expect(resolveWorkspacePath(root, 'sub/graf.manifest.json')).toBeNull();
  });

  it('rejects traversal outside the root', () => {
    expect(resolveWorkspacePath(root, '../escape.flow')).toBeNull();
    expect(resolveWorkspacePath(root, 'sub/../../escape.flow')).toBeNull();
  });

  it('rejects other extensions and non-string input', () => {
    expect(resolveWorkspacePath(root, 'note.txt')).toBeNull();
    expect(resolveWorkspacePath(root, 'other.json')).toBeNull();
    expect(resolveWorkspacePath(root, undefined)).toBeNull();
    expect(resolveWorkspacePath(root, 42)).toBeNull();
  });
});

describe('toPortablePath', () => {
  it('produces forward-slash root-relative paths', () => {
    expect(toPortablePath(root, path.join(root, 'sub', 'b.flow'))).toBe('sub/b.flow');
  });
});

describe('listFlowFiles', () => {
  it('finds .flow files recursively, skipping ignored and hidden directories', async () => {
    expect(await listFlowFiles(root)).toEqual(['a.flow', 'sub/b.flow']);
  });
});

describe('contentHash', () => {
  it('is a stable sha1 over the text', () => {
    expect(contentHash('hello')).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('hello!'));
  });
});
