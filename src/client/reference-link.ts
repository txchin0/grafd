// Turning a node reference into something clickable. Targets are either external URLs or
// paths relative to the project root (FLOW-SPEC §4.5) — deliberately not relative to the
// .flow file, since referenced code normally lives outside the workspace.
//
// A path only becomes openable once it is absolute, and the absolute project root is known
// only in self-hosted mode (the server reports it). Browser and folder workspaces therefore
// fall back to copying the target, which is why openUrlForReference returns null rather than
// throwing when it cannot build a link.

import type { Reference } from '../shared/flow-format.js';
import { parseReferenceTarget, type ReferenceTarget } from '../shared/reference-target.js';

export { parseReferenceTarget, type ReferenceTarget };

export type EditorLinkScheme = 'vscode' | 'vscode-insiders' | 'cursor' | 'none';

export const EDITOR_LINK_SCHEMES: EditorLinkScheme[] = ['vscode', 'vscode-insiders', 'cursor', 'none'];

export interface LinkContext {
  projectRoot: string | null;
  editorLinkScheme: EditorLinkScheme;
}

export type ReferenceOpenAction =
  | { kind: 'web'; href: string }
  | { kind: 'mailto'; href: string }
  | { kind: 'app'; href: string }
  | { kind: 'copy'; text: string };

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

export function openActionForReference(target: string, context: LinkContext): ReferenceOpenAction | null {
  const text = target.trim();
  if (text === '') return null;
  const href = openUrlForReference(text, context);
  if (!href) return { kind: 'copy', text };
  if (/^https?:/i.test(href)) return { kind: 'web', href };
  if (/^mailto:/i.test(href)) return { kind: 'mailto', href };
  return { kind: 'app', href };
}

/** What a reference row shows when it is not being edited. */
export interface ReferencePresentation {
  text: string;
  href: string | null;
  title: string;
}

// A markdown `[label](target)` shows only the label; a bare target shows itself. The href is
// set when the target can actually be opened, and the title is the authored target so a
// labelled link still reveals where it goes on hover.
export function presentReference(reference: Reference, context: LinkContext): ReferencePresentation {
  const target = reference.target.trim();
  const action = openActionForReference(target, context);
  return {
    text: reference.label || target,
    href: action == null || action.kind === 'copy' ? null : action.href,
    title: target,
  };
}

export function bindReferenceAnchor(anchor: HTMLAnchorElement, target: string, context: LinkContext): void {
  const action = openActionForReference(target, context);
  if (action == null || action.kind === 'copy') return;
  anchor.href = action.href;
  switch (action.kind) {
    case 'web':
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      return;
    case 'mailto':
      return;
    case 'app':
      anchor.addEventListener('click', (event) => {
        event.preventDefault();
        window.open(action.href, '_blank', 'noopener');
      });
      return;
    default: {
      const _never: never = action;
      return _never;
    }
  }
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
