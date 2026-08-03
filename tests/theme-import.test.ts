import { describe, expect, it } from 'vitest';
import {
  THEME_TOKEN_ORDER,
  deriveThemeId,
  detectScheme,
  mapThemeToTokens,
  renderThemeBlock,
  stripJsonComments,
  toAlpha,
  type VscodeColorTheme,
} from '../src/tools/vscode-theme-map.js';

describe('deriveThemeId', () => {
  it('slugs a theme name into a css-attribute-safe id', () => {
    expect(deriveThemeId('One Dark Pro')).toBe('one-dark-pro');
    expect(deriveThemeId('Night Owl (no italics)')).toBe('night-owl-no-italics');
    expect(deriveThemeId('  Cobalt2  ')).toBe('cobalt2');
  });

  it('rejects names that slug to nothing', () => {
    expect(() => deriveThemeId('')).toThrow();
    expect(() => deriveThemeId('---')).toThrow();
  });
});

describe('detectScheme', () => {
  it('trusts the declared type', () => {
    expect(detectScheme({ name: 'x', type: 'dark' })).toBe('dark');
    expect(detectScheme({ name: 'x', type: 'light' })).toBe('light');
    expect(detectScheme({ name: 'x', type: 'hc' })).toBe('dark');
  });

  it('falls back to the editor background brightness when type is missing', () => {
    expect(detectScheme({ colors: { 'editor.background': '#1e1e1e' } })).toBe('dark');
    expect(detectScheme({ colors: { 'editor.background': '#ffffff' } })).toBe('light');
    expect(detectScheme({ colors: { 'editor.background': 'rgb(1, 2, 3)' } })).toBe('dark');
  });

  it('defaults to dark when nothing is declared', () => {
    expect(detectScheme({})).toBe('dark');
  });
});

describe('toAlpha', () => {
  it('converts hex to rgba, normalising shorthand and dropping an existing alpha digit', () => {
    expect(toAlpha('#ff8800', 0.5)).toBe('rgba(255, 136, 0, 0.5)');
    expect(toAlpha('#f80', 0.5)).toBe('rgba(255, 136, 0, 0.5)');
    expect(toAlpha('#ff8800aa', 0.3)).toBe('rgba(255, 136, 0, 0.3)');
  });

  it('keeps the hex form when alpha is 1', () => {
    expect(toAlpha('#ff8800', 1)).toBe('#ff8800');
  });

  it('passes non-hex colors through untouched', () => {
    expect(toAlpha('red', 0.5)).toBe('red');
    expect(toAlpha('rgb(1, 2, 3)', 0.5)).toBe('rgb(1, 2, 3)');
  });
});

describe('mapThemeToTokens', () => {
  it('declares every token in the canonical set', () => {
    const { tokens } = mapThemeToTokens({ name: 'x' });
    expect([...tokens.keys()].sort()).toEqual([...THEME_TOKEN_ORDER].sort());
  });

  it('maps the chrome colors', () => {
    const { scheme, tokens } = mapThemeToTokens({
      name: 'x',
      type: 'light',
      colors: {
        'editor.background': '#111111',
        'editor.foreground': '#eeeeee',
        'sideBar.background': '#222222',
        'focusBorder': '#ff0000',
        'errorForeground': '#ff0001',
        'gitDecoration.addedResourceForeground': '#00ff00',
        'input.background': '#333333',
        'list.hoverBackground': '#444444',
        'list.activeSelectionBackground': '#555555',
      },
    });
    expect(scheme).toBe('light');
    expect(tokens.get('--color-scheme')).toBe('light');
    expect(tokens.get('--bg')).toBe('#111111');
    expect(tokens.get('--ink')).toBe('#eeeeee');
    expect(tokens.get('--panel')).toBe('#222222');
    expect(tokens.get('--field-bg')).toBe('#333333');
    expect(tokens.get('--row-hover')).toBe('#444444');
    expect(tokens.get('--row-active')).toBe('#555555');
    expect(tokens.get('--accent')).toBe('#ff0000');
    expect(tokens.get('--danger')).toBe('#ff0001');
    expect(tokens.get('--success')).toBe('#00ff00');
    expect(tokens.get('--canvas-select')).toBe('#ff0000');
    expect(tokens.get('--canvas-error')).toBe('#ff0001');
    expect(tokens.get('--canvas-updates')).toBe('#00ff00');
    expect(tokens.get('--canvas-port-fill')).toBe('#111111');
  });

  it('skips fully transparent colors in the pick chain', () => {
    const { tokens } = mapThemeToTokens({
      name: 'x',
      type: 'dark',
      colors: {
        'focusBorder': '#00000000',
        'editor.background': '#1f1f1f',
      },
    });
    expect(tokens.get('--accent')).toBe('#6aa9e9');
    expect(tokens.get('--canvas-select')).toBe('#6aa9e9');
    expect(tokens.get('--canvas-marquee-fill')).toBe('rgba(106, 169, 233, 0.08)');
  });

  it('derives translucent tokens from their base colors', () => {
    const { tokens } = mapThemeToTokens({
      name: 'x',
      type: 'dark',
      colors: {
        'editor.background': '#17191d',
        'editor.foreground': '#e8e2d5',
        'focusBorder': '#6aa9e9',
      },
    });
    expect(tokens.get('--canvas-node-fill')).toBe('rgba(23, 25, 29, 0.94)');
    expect(tokens.get('--canvas-marquee-fill')).toBe('rgba(106, 169, 233, 0.08)');
  });

  it('uses scheme fallbacks for everything a theme does not declare', () => {
    const dark = mapThemeToTokens({ name: 'x' });
    expect(dark.tokens.get('--bg')).toBe('#17191d');
    expect(dark.tokens.get('--scrim')).toBe('rgba(0, 0, 0, 0.55)');
    const light = mapThemeToTokens({ name: 'x', type: 'light' });
    expect(light.tokens.get('--bg')).toBe('#ffffff');
    expect(light.tokens.get('--scrim')).toBe('rgba(0, 0, 0, 0.3)');
  });

  it('picks the trait hues from tokenColors by scope, first match wins', () => {
    const { tokens } = mapThemeToTokens({
      name: 'x',
      type: 'dark',
      tokenColors: [
        { scope: 'comment', settings: { foreground: '#666666' } },
        { scope: 'string', settings: { foreground: '#7fc48a' } },
        { scope: 'keyword', settings: { foreground: '#d9b96a' } },
        { scope: 'storage.type', settings: { foreground: '#b48ad9' } },
        { scope: 'entity.name.type', settings: { foreground: '#6fb5a8' } },
      ],
    });
    expect(tokens.get('--canvas-entry-stroke')).toBe('#7fc48a');
    expect(tokens.get('--canvas-decision-stroke')).toBe('#d9b96a');
    expect(tokens.get('--canvas-expand-stroke')).toBe('#b48ad9');
    expect(tokens.get('--canvas-region-stroke')).toBe('#6fb5a8');
    expect(tokens.get('--canvas-region-fill')).toBe('rgba(111, 181, 168, 0.13)');
  });

  it('accepts a scope array and skips entries tinted with the editor foreground', () => {
    const { tokens } = mapThemeToTokens({
      name: 'x',
      type: 'dark',
      colors: { 'editor.foreground': '#7fc48a' },
      tokenColors: [
        { scope: ['meta.function', 'support.function'], settings: { foreground: '#7fc48a' } },
        { scope: ['string'], settings: { foreground: '#00ff00' } },
      ],
    });
    expect(tokens.get('--canvas-entry-stroke')).toBe('#00ff00');
  });

  it('falls back to the scheme trait colors when no scope matches', () => {
    const { tokens } = mapThemeToTokens({ name: 'x', type: 'dark' });
    expect(tokens.get('--canvas-entry-stroke')).toBe('#7fc48a');
    expect(tokens.get('--canvas-decision-stroke')).toBe('#d9b96a');
    expect(tokens.get('--canvas-expand-stroke')).toBe('#b48ad9');
    expect(tokens.get('--canvas-region-stroke')).toBe('#6fb5a8');
  });
});

describe('stripJsonComments', () => {
  it('removes line and block comments', () => {
    expect(stripJsonComments('{\n  // note\n  "a": 1, /* mid */\n  "b": 2 // tail\n}')).toBe(
      '{\n  \n  "a": 1, \n  "b": 2 \n}',
    );
  });

  it('keeps comment-looking text inside strings, including escaped quotes', () => {
    expect(stripJsonComments('{ "url": "http://x", "note": "a // b", "q": "say \\"hi\\"" }')).toBe(
      '{ "url": "http://x", "note": "a // b", "q": "say \\"hi\\"" }',
    );
  });

  it('parses a hand-edited JSONC theme file', () => {
    const jsonc = [
      '{',
      '  // FIXME: not added properly',
      '  "name": "Monokai Night",',
      '  "colors": {',
      '    "editor.background": "#0f0f0f", /* tweak me */',
      '    "diffEditor.insertedTextBackground": "#86b42b44", // alpha hex',
      '    "textLink.foreground": "http://" /* no wait */',
      '  }',
      '}',
    ].join('\n');
    expect(() => JSON.parse(stripJsonComments(jsonc))).not.toThrow();
  });
});

describe('renderThemeBlock', () => {
  it('emits every token in canonical order under the theme selector', () => {
    const { tokens } = mapThemeToTokens({ name: 'x', type: 'dark' });
    const block = renderThemeBlock('one-dark-pro', tokens);
    expect(block).toContain(':root[data-theme="one-dark-pro"] {');
    expect(block.endsWith('}\n')).toBe(true);
    const rendered = block.split('\n').filter((line) => line.startsWith('  --'));
    expect(rendered).toHaveLength(THEME_TOKEN_ORDER.length);
    for (const [index, token] of THEME_TOKEN_ORDER.entries()) {
      expect(rendered[index]).toBe(`  ${token}: ${tokens.get(token)};`);
    }
  });
});
