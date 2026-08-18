// Pure helpers for renaming a .flow file from the sidebar: validating the requested name and
// rewriting every reference to the old path — expand links, references rows, and manifest path
// fields — so a rename never strands links to a file that no longer exists. Expand links are
// file-relative; reference targets resolve against the project root (spec §4.5), so they are
// matched both bare and with the workspace's prefix under the project root. No DOM, no I/O.
//
// Every rewrite matches paths case-insensitively, matching the file systems Grafd writes to
// (see flow-paths.ts), so a case-only rename retargets references instead of clobbering them.

import {
  getProp,
  parseExpandLink,
  resolveLinkPath,
  setProp,
  type FlowDocument,
  type Reference,
} from '../shared/flow-format.js';
import type { WorkspaceManifest } from '../shared/manifest.js';
import { parseReferenceTarget } from '../shared/reference-target.js';
import { allNodes, allContextBlocks } from './flow-doc.js';
import { folderOf, normalizeFlowPath, relativizePath } from './flow-paths.js';

// The path a same-folder rename resolves to: the normalized requested name rejoined to the
// source file's folder, so renaming "auth/login.flow" to "signin" moves to "auth/signin.flow"
// rather than the workspace root. Returns '' for a blank request, matching normalizeFlowPath.
export function renameTargetPath(from: string, requested: string): string {
  const name = normalizeFlowPath(requested);
  if (!name || name.includes('/')) return name;
  const folder = folderOf(from);
  return folder ? `${folder}/${name}` : name;
}

// Returns why the rename cannot happen, or null when the editor should close: a valid rename
// and an unchanged no-op both close the editor; only an error keeps it open.
export function validateFlowRename(files: string[], from: string, requested: string): string | null {
  const name = normalizeFlowPath(requested);
  if (!name) return null;
  const to = renameTargetPath(from, requested);
  if (to === from) return null;
  if (name.includes('/')) return 'Rename keeps the file in its current folder — pick a file name, not a path.';
  if (name.startsWith('.')) return 'File names starting with “.” are hidden from the workspace.';
  // The source file itself is the one case-insensitive match a rename may take over — a
  // case-only rename. Any other match is a real collision.
  const collision = files.find((file) => file.toLowerCase() === to.toLowerCase() && file !== from);
  if (collision) return `${collision} already exists — pick another name.`;
  return null;
}

// Rewrites every reference to `from` so it spells `to`: `expand: [Label](path)` links become
// the relative path from the containing file's folder, and references rows get the new
// project-root-relative path (prefixed with `workspacePrefix`, e.g. ".grafd", when the
// workspace sits under the project root) with their `:line` / `:start-end` suffix and label
// preserved. Returns whether anything changed.
export function rewriteFileReferences(
  doc: FlowDocument,
  containingPath: string,
  from: string,
  to: string,
  workspacePrefix = '',
): boolean {
  let changed = false;
  const prefixedFrom = joinReferencePrefix(workspacePrefix, from);
  const prefixedTo = joinReferencePrefix(workspacePrefix, to);
  const rewriteReference = (reference: Reference): void => {
    const rewritten = renamedReferenceTarget(reference.target, prefixedFrom, prefixedTo, from, to);
    if (rewritten == null) return;
    reference.target = rewritten;
    changed = true;
  };
  for (const node of allNodes(doc)) {
    const link = parseExpandLink(getProp(node, 'expand'));
    if (link && pathsEqual(resolveLinkPath(containingPath, link.path), from)) {
      setProp(node, 'expand', `[${link.label}](${relativizePath(folderOf(containingPath), to)})`);
      changed = true;
    }
    node.references.forEach(rewriteReference);
  }
  doc.preamble?.references.forEach(rewriteReference);
  allContextBlocks(doc).forEach((block) => block.references.forEach(rewriteReference));
  return changed;
}

// Moves every manifest field keyed or valued by the old path to the new one: entrypoint,
// active flow, cameras, and remembered expansions.
export function renameManifestPaths(manifest: WorkspaceManifest, from: string, to: string): void {
  manifest.entrypoint = renamedPathValue(manifest.entrypoint, from, to);
  manifest.ui.activeFlow = renamedPathValue(manifest.ui.activeFlow, from, to);
  manifest.ui.cameras = renamedPathKeyed(manifest.ui.cameras, from, to);
  manifest.ui.expansions = renamedPathKeyed(manifest.ui.expansions, from, to);
}

function renamedReferenceTarget(
  target: string,
  prefixedFrom: string,
  prefixedTo: string,
  bareFrom: string,
  bareTo: string,
): string | null {
  const parsed = parseReferenceTarget(target);
  if (parsed.kind !== 'file') return null;
  const text = target.trim();
  // parseReferenceTarget's path is the exact text before any `:line` suffix, so the
  // remainder is the suffix as written — rebuilt onto the new path without losing it.
  if (pathsEqual(parsed.path, prefixedFrom)) return `${prefixedTo}${text.slice(parsed.path.length)}`;
  // A reference written in the bare workspace-relative convention is kept in that convention
  // rather than silently gaining a prefix the author never used.
  if (prefixedFrom !== bareFrom && pathsEqual(parsed.path, bareFrom)) {
    return `${bareTo}${text.slice(parsed.path.length)}`;
  }
  return null;
}

function joinReferencePrefix(prefix: string, path: string): string {
  return prefix ? `${prefix}/${path}` : path;
}

function renamedPathValue(value: string | null, from: string, to: string): string | null {
  if (value == null) return null;
  return pathsEqual(value, from) ? to : value;
}

function renamedPathKeyed<V>(map: Record<string, V>, from: string, to: string): Record<string, V> {
  const exact = Object.keys(map).find((key) => key === from);
  const match = exact ?? Object.keys(map).find((key) => pathsEqual(key, from));
  if (match == null) return map;
  const renamed: Record<string, V> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key !== match) renamed[key] = value;
  }
  renamed[to] = map[match];
  return renamed;
}

function pathsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
