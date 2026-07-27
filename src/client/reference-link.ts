// Turning a node reference into something clickable. Targets are either external URLs or
// paths relative to the project root (FLOW-SPEC §4.5) — deliberately not relative to the
// .flow file, since referenced code normally lives outside the workspace.
//
// A path only becomes openable once it is absolute, and the absolute project root is known
// only in self-hosted mode (the server reports it). Browser and folder workspaces therefore
// fall back to copying the target, which is why openUrlForReference returns null rather than
// throwing when it cannot build a link.

import { parseReferenceTarget, type ReferenceTarget } from '../shared/reference-target.js';

export { parseReferenceTarget, type ReferenceTarget };

export type EditorLinkScheme = 'vscode' | 'vscode-insiders' | 'cursor' | 'none';

export const EDITOR_LINK_SCHEMES: EditorLinkScheme[] = ['vscode', 'vscode-insiders', 'cursor', 'none'];

export interface LinkContext {
  projectRoot: string | null;
  editorLinkScheme: EditorLinkScheme;
}

/** The URL to open for a reference, or null when the caller should copy it instead. */
export function openUrlForReference(target: string, context: LinkContext): string | null {
  const parsed = parseReferenceTarget(target);
  if (parsed.kind === 'url') return parsed.url;
  if (context.editorLinkScheme === 'none' || !context.projectRoot) return null;
  const absolute = joinProjectPath(context.projectRoot, parsed.path);
  if (absolute === '') return null;
  const line = parsed.line == null ? '' : `:${parsed.line}`;
  return `${context.editorLinkScheme}://file/${absolute}${line}`;
}

// Editor URIs take the absolute path with forward slashes and no leading slash, so POSIX
// "/home/me/app" becomes vscode://file/home/me/app/... and Windows keeps its drive letter.
function joinProjectPath(projectRoot: string, relativePath: string): string {
  const root = toForwardSlashes(projectRoot).replace(/\/+$/, '');
  const path = toForwardSlashes(relativePath).replace(/^\/+/, '');
  return `${root}/${path}`.replace(/^\/+/, '');
}

function toForwardSlashes(text: string): string {
  return text.trim().replace(/\\/g, '/');
}
