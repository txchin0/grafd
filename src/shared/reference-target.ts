// Classification of a `references:` entry's target (FLOW-SPEC §4.5). Kinds are inferred,
// never declared: a URI scheme means an external link, anything else is a project-root
// relative file path with an optional `:line` or `:startLine-endLine` suffix.

export type ReferenceTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string; line: number | null };

export interface ReferenceLineRange {
  start: number;
  end: number;
}

// A scheme needs two or more characters so a Windows drive letter ("C:/src") is read as a
// path rather than as a URL scheme.
const URL_SCHEME = /^[a-z][a-z\d+.-]+:/i;
const TRAILING_LINE_RANGE = /^(.*?):(\d+)(?:-(\d+))?$/;

export function parseReferenceTarget(target: string): ReferenceTarget {
  const text = target.trim();
  if (URL_SCHEME.test(text)) return { kind: 'url', url: text };
  const withLine = text.match(TRAILING_LINE_RANGE);
  if (withLine) return { kind: 'file', path: withLine[1], line: Number(withLine[2]) };
  return { kind: 'file', path: text, line: null };
}

/** The `:start-end` suffix of a file target, or null when it carries no line numbers. */
export function parseReferenceLineRange(target: string): ReferenceLineRange | null {
  const parsed = parseReferenceTarget(target);
  if (parsed.kind === 'url' || parsed.line == null) return null;
  const withLine = target.trim().match(TRAILING_LINE_RANGE);
  const end = withLine?.[3];
  return { start: parsed.line, end: end == null ? parsed.line : Number(end) };
}
