import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CANVAS_COLOR_TOKENS,
  DEFAULT_CANVAS_PALETTE,
  DEFAULT_PAGE_BACKGROUND,
  DEFAULT_THEME_ID,
  PAGE_BACKGROUND_TOKEN,
  THEMES,
  isThemeId,
  resolveCanvasPalette,
  type CanvasPalette,
} from '../src/client/theme.js';

const themesCss = readFileSync(new URL('../public/themes.css', import.meta.url), 'utf8');

interface ThemeBlock {
  selectors: string[];
  tokens: Map<string, string>;
}

function parseThemeBlocks(css: string): ThemeBlock[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectorText, body]) => ({
    selectors: selectorText.split(',').map((selector) => selector.trim()),
    tokens: new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()])),
  }));
}

const blocks = parseThemeBlocks(themesCss);
// The block that also matches bare `:root` is the fallback theme, and so defines the full
// set of tokens every other theme has to answer for.
const fallbackBlock = blocks.find((block) => block.selectors.includes(':root'))!;

function blockFor(themeId: string): ThemeBlock | undefined {
  return blocks.find((block) => block.selectors.includes(`:root[data-theme="${themeId}"]`));
}

function stubbedStyle(tokens: Record<string, string>): CSSStyleDeclaration {
  return { getPropertyValue: (token: string) => tokens[token] ?? '' } as CSSStyleDeclaration;
}

describe('themes.css', () => {
  it('declares a block for every registered theme', () => {
    for (const theme of THEMES) expect(blockFor(theme.id), theme.id).toBeDefined();
  });

  it('serves the default theme from the fallback block, so an unknown data-theme still renders', () => {
    expect(fallbackBlock.selectors).toContain(`:root[data-theme="${DEFAULT_THEME_ID}"]`);
  });

  it('defines the same tokens in every theme', () => {
    const expected = [...fallbackBlock.tokens.keys()].sort();
    for (const block of blocks) {
      expect([...block.tokens.keys()].sort(), block.selectors.join(', ')).toEqual(expected);
    }
  });

  it('declares every canvas token the palette resolves', () => {
    for (const token of Object.values(CANVAS_COLOR_TOKENS)) {
      expect(fallbackBlock.tokens.has(token), token).toBe(true);
    }
  });

  it('matches the fallback palette mirrored in theme.ts', () => {
    for (const field of Object.keys(CANVAS_COLOR_TOKENS) as (keyof CanvasPalette)[]) {
      expect(fallbackBlock.tokens.get(CANVAS_COLOR_TOKENS[field]), field).toBe(DEFAULT_CANVAS_PALETTE[field]);
    }
    expect(fallbackBlock.tokens.get(PAGE_BACKGROUND_TOKEN)).toBe(DEFAULT_PAGE_BACKGROUND);
  });
});

describe('resolveCanvasPalette', () => {
  it('reads every field from its token', () => {
    const tokens = Object.fromEntries(Object.values(CANVAS_COLOR_TOKENS).map((token) => [token, `color(${token})`]));
    const resolved = resolveCanvasPalette(stubbedStyle(tokens));
    for (const field of Object.keys(CANVAS_COLOR_TOKENS) as (keyof CanvasPalette)[]) {
      expect(resolved[field]).toBe(`color(${CANVAS_COLOR_TOKENS[field]})`);
    }
  });

  it('trims the surrounding whitespace a declaration may carry', () => {
    expect(resolveCanvasPalette(stubbedStyle({ [CANVAS_COLOR_TOKENS.ink]: '  #fff ' })).ink).toBe('#fff');
  });

  it('falls back per token when the stylesheet is absent or incomplete', () => {
    expect(resolveCanvasPalette(stubbedStyle({}))).toEqual(DEFAULT_CANVAS_PALETTE);
    expect(resolveCanvasPalette(stubbedStyle({ [CANVAS_COLOR_TOKENS.grid]: '#123456' }))).toEqual({
      ...DEFAULT_CANVAS_PALETTE,
      grid: '#123456',
    });
  });
});

describe('isThemeId', () => {
  it('accepts registered ids and rejects anything else', () => {
    for (const theme of THEMES) expect(isThemeId(theme.id)).toBe(true);
    for (const value of ['solarized', '', null, undefined, 7, {}]) expect(isThemeId(value)).toBe(false);
  });
});
