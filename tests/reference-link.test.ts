import { describe, expect, it } from 'vitest';
import {
  openActionForReference,
  openUrlForReference,
  parseReferenceTarget,
  presentReference,
} from '../src/client/reference-link.js';

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

describe('presentReference', () => {
  const context = { projectRoot: 'E:\\Projects\\app', editorLinkScheme: 'vscode' as const };
  const noEditor = { projectRoot: null, editorLinkScheme: 'none' as const };

  it('shows a bare URL as itself, clickable, with the URL on hover', () => {
    expect(presentReference({ label: null, target: 'https://stripe.com/docs' }, noEditor)).toEqual({
      text: 'https://stripe.com/docs',
      href: 'https://stripe.com/docs',
      title: 'https://stripe.com/docs',
    });
  });

  it('shows only the markdown label, clickable when the target is a URL, hover is the href', () => {
    expect(presentReference({ label: 'Login form', target: 'https://example.com/login' }, noEditor)).toEqual({
      text: 'Login form',
      href: 'https://example.com/login',
      title: 'https://example.com/login',
    });
  });

  it('makes a labelled file path clickable when an editor link can be built', () => {
    expect(presentReference({ label: 'Login form', target: 'src/login.tsx:42' }, context)).toEqual({
      text: 'Login form',
      href: 'vscode://file/E:/Projects/app/src/login.tsx:42',
      title: 'src/login.tsx:42',
    });
  });

  it('shows a labelled file path as plain text when no link can be built', () => {
    expect(presentReference({ label: 'Login form', target: 'src/login.tsx:42' }, noEditor)).toEqual({
      text: 'Login form',
      href: null,
      title: 'src/login.tsx:42',
    });
  });

  it('shows a bare file path as itself when it cannot be opened', () => {
    expect(presentReference({ label: null, target: 'src/login.tsx' }, noEditor)).toEqual({
      text: 'src/login.tsx',
      href: null,
      title: 'src/login.tsx',
    });
  });
});

describe('openActionForReference', () => {
  const context = { projectRoot: 'E:\\Projects\\app', editorLinkScheme: 'vscode' as const };
  const noEditor = { projectRoot: null, editorLinkScheme: 'none' as const };

  it('opens http(s) as a web link', () => {
    expect(openActionForReference('https://stripe.com/docs', noEditor)).toEqual({
      kind: 'web',
      href: 'https://stripe.com/docs',
    });
  });

  it('opens mailto as a native mail link', () => {
    expect(openActionForReference('mailto:team@example.com', noEditor)).toEqual({
      kind: 'mailto',
      href: 'mailto:team@example.com',
    });
  });

  it('opens a file path through the editor protocol when a link can be built', () => {
    expect(openActionForReference('src/login.tsx:42', context)).toEqual({
      kind: 'app',
      href: 'vscode://file/E:/Projects/app/src/login.tsx:42',
    });
  });

  it('copies a file path when no link can be built', () => {
    expect(openActionForReference('src/login.tsx', noEditor)).toEqual({
      kind: 'copy',
      text: 'src/login.tsx',
    });
  });

  it('returns null for an empty target', () => {
    expect(openActionForReference('  ', noEditor)).toBeNull();
  });
});
