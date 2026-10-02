// Filesystem-facing helpers for the .flow editor server: locating .flow files under the
// workspace root, converting between absolute and portable (forward-slash, root-relative)
// paths, and hashing file contents so the watcher can recognize the server's own writes.

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { isCanvasLayerPath, isFlowPath } from '../shared/canvas-layer.js';
import { MANIFEST_FILE_NAME } from '../shared/manifest.js';

export const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.claude', 'dist']);

// Only .flow files, their canvas layers and the workspace manifest at the root are readable
// and writable; anything else — other extensions, traversal outside the root, non-string
// input — resolves to null.
export function resolveWorkspacePath(projectRoot: string, relativePath: unknown): string | null {
  if (typeof relativePath !== 'string') return null;
  if (!isWorkspaceFilePath(relativePath)) return null;
  const absolute = path.resolve(projectRoot, relativePath);
  if (!absolute.startsWith(projectRoot + path.sep)) return null;
  return absolute;
}

function isWorkspaceFilePath(relativePath: string): boolean {
  return isFlowPath(relativePath) || isCanvasLayerPath(relativePath) || relativePath === MANIFEST_FILE_NAME;
}

export function toPortablePath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
}

export function listFlowFiles(projectRoot: string): Promise<string[]> {
  return listWorkspaceFiles(projectRoot, isFlowPath);
}

export function listCanvasLayerFiles(projectRoot: string): Promise<string[]> {
  return listWorkspaceFiles(projectRoot, isCanvasLayerPath);
}

async function listWorkspaceFiles(
  projectRoot: string,
  matches: (fileName: string) => boolean,
  directory = projectRoot,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listWorkspaceFiles(projectRoot, matches, entryPath)));
    } else if (matches(entry.name)) {
      files.push(toPortablePath(projectRoot, entryPath));
    }
  }
  return files.sort();
}

export function contentHash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
