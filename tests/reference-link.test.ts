import { describe, expect, it } from 'vitest';
import { openUrlForReference, parseReferenceTarget } from '../src/client/reference-link.js';

describe('parseReferenceTarget', () => {
  it('recognizes URLs by their scheme', () => {
    expect(parseReferenceTarget('https://stripe.com/docs')).toEqual({
      kind: 'url',
      url: 'https://stripe.com/docs',
    });
    expect(parseReferenceTarget('mailto:team@example.com')).toEqual({
      kind: 'url',
      url: 'mailto:team@example.com',
    });
  });

  it('splits a trailing line or line range off a path', () => {
    expect(parseReferenceTarget('src/login.tsx:42')).toEqual({ kind: 'file', path: 'src/login.tsx', line: 42 });
    expect(parseReferenceTarget('src/login.tsx:42-88')).toEqual({ kind: 'file', path: 'src/login.tsx', line: 42 });
    expect(parseReferenceTarget('src/login.tsx')).toEqual({ kind: 'file', path: 'src/login.tsx', line: null });
  });

  // "C:" is a drive letter, not a URL scheme.
  it('reads a Windows absolute path as a file', () => {
    expect(parseReferenceTarget('C:/app/src/a.ts:7')).toEqual({ kind: 'file', path: 'C:/app/src/a.ts', line: 7 });
  });
});

describe('openUrlForReference', () => {
  const context = { projectRoot: 'E:\\Projects\\app', editorLinkScheme: 'vscode' as const };

  it('opens a URL target as-is, whatever the editor settings', () => {
    expect(openUrlForReference('https://example.com', { projectRoot: null, editorLinkScheme: 'none' })).toBe(
      'https://example.com',
    );
  });

  it('builds an editor link against the project root', () => {
    expect(openUrlForReference('src/login.tsx:42-88', context)).toBe('vscode://file/E:/Projects/app/src/login.tsx:42');
    expect(openUrlForReference('src/login.tsx', context)).toBe('vscode://file/E:/Projects/app/src/login.tsx');
  });

  it('strips the leading slash of a POSIX root', () => {
    expect(
      openUrlForReference('src/a.ts:3', { projectRoot: '/home/me/app/', editorLinkScheme: 'cursor' }),
    ).toBe('cursor://file/home/me/app/src/a.ts:3');
  });

  it('returns null for a file target when no link can be built', () => {
    expect(openUrlForReference('src/a.ts', { projectRoot: null, editorLinkScheme: 'vscode' })).toBeNull();
    expect(openUrlForReference('src/a.ts', { ...context, editorLinkScheme: 'none' })).toBeNull();
  });
});
