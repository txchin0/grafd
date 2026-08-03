// Maps a VS Code color-theme JSON onto the Grafd token set declared in public/themes.css.
//
// A theme imports as one `:root[data-theme="…"]` block: the same token set every hand-written
// theme declares, so the existing theme tests (identical token sets per block, one block per
// registered id) hold for imported themes without changing the tests. `theme-import.ts` is the
// CLI that turns the mapped tokens into edits; this module stays pure and file-free.

export type ThemeScheme = 'dark' | 'light';

export interface VscodeColorTheme {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: Array<{
    scope?: string | string[];
    settings?: { foreground?: string; fontStyle?: string };
  }>;
}

// The declaration order of the fallback block in themes.css; imported blocks are rendered in
// this order so the file stays diff-friendly even though nothing depends on the ordering.
export const THEME_TOKEN_ORDER = [
  '--color-scheme',
  '--bg',
  '--panel',
  '--panel-border',
  '--ink',
  '--muted',
  '--accent',
  '--danger',
  '--success',
  '--disabled',
  '--row-hover',
  '--row-active',
  '--field-bg',
  '--scrim',
  '--shadow-floating',
  '--shadow-modal',
  '--canvas-grid',
  '--canvas-ink',
  '--canvas-muted',
  '--canvas-node-fill',
  '--canvas-node-stroke',
  '--canvas-entry-stroke',
  '--canvas-decision-stroke',
  '--canvas-expand-stroke',
  '--canvas-region-stroke',
  '--canvas-region-fill',
  '--canvas-ghost',
  '--canvas-edge',
  '--canvas-edge-label',
  '--canvas-edge-label-bg',
  '--canvas-error',
  '--canvas-updates',
  '--canvas-select',
  '--canvas-marquee-fill',
  '--canvas-port-fill',
] as const;

export function deriveThemeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`cannot derive an id from "${name}"`);
  return slug;
}

// Theme JSON in the wild is often hand-edited JSONC: VSCode parses theme files with comments
// enabled, and popular themes (Monokai Night) ship commented-out entries. The strip must walk
// the text rather than regex it, because a "//" inside a string value like "http://…" is data.
export function stripJsonComments(json: string): string {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    const next = json[i + 1];
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (char === '\\') {
        result += next ?? '';
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else {
      result += char;
    }
  }
  return result;
}

export function detectScheme(theme: VscodeColorTheme): ThemeScheme {
  const declared = theme.type?.trim().toLowerCase();
  if (declared === 'light') return 'light';
  if (declared === 'dark' || declared === 'hc') return 'dark';
  const background = theme.colors?.['editor.background'];
  if (background) return perceivedBrightness(background) < 0.5 ? 'dark' : 'light';
  return 'dark';
}

// Adds an alpha channel to a hex colour; anything else (named, rgb(), already rgba) cannot be
// rewritten without parsing a full CSS colour grammar, so it passes through untouched.
export function toAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  if (alpha === 1) return color;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

// A fully transparent hex (#rrggbb00) is a theme's way of saying "don't draw this" — a focus
// ring, a border. It carries no colour information, so it must not satisfy a pick() chain.
function isOpaque(color: string): boolean {
  const hex = color.trim().replace(/^#/, '');
  if (hex.length !== 8) return true;
  return hex.slice(6, 8).toLowerCase() !== '00';
}

interface MappedTheme {
  scheme: ThemeScheme;
  tokens: Map<string, string>;
}

// The fallback values an imported theme falls back on, mirroring the grafd-dark and grafd-light
// blocks for whatever a VS Code theme has no opinion about (shadows, scrim, trait hues).
interface SchemeDefaults {
  bg: string;
  ink: string;
  accent: string;
  danger: string;
  success: string;
  nodeStroke: string;
  entry: string;
  decision: string;
  expand: string;
  region: string;
  scrim: string;
  shadowFloating: string;
  shadowModal: string;
  borderAlpha: number;
  mutedAlpha: number;
  hoverAlpha: number;
  activeAlpha: number;
  gridAlpha: number;
  nodeFillAlpha: number;
  ghostAlpha: number;
  edgeAlpha: number;
  edgeLabelAlpha: number;
  regionFillAlpha: number;
  marqueeAlpha: number;
}

const DARK_DEFAULTS: SchemeDefaults = {
  bg: '#17191d',
  ink: '#e8e2d5',
  accent: '#6aa9e9',
  danger: '#d97a7a',
  success: '#7fc48a',
  nodeStroke: '#9ba8b8',
  entry: '#7fc48a',
  decision: '#d9b96a',
  expand: '#b48ad9',
  region: '#6fb5a8',
  scrim: 'rgba(0, 0, 0, 0.55)',
  shadowFloating: '0 8px 28px rgba(0, 0, 0, 0.45)',
  shadowModal: '0 12px 40px rgba(0, 0, 0, 0.55)',
  borderAlpha: 0.12,
  mutedAlpha: 0.6,
  hoverAlpha: 0.06,
  activeAlpha: 0.15,
  gridAlpha: 0.07,
  nodeFillAlpha: 0.94,
  ghostAlpha: 0.45,
  edgeAlpha: 0.6,
  edgeLabelAlpha: 0.75,
  regionFillAlpha: 0.13,
  marqueeAlpha: 0.08,
};

const LIGHT_DEFAULTS: SchemeDefaults = {
  bg: '#ffffff',
  ink: '#1f1f1f',
  accent: '#005fb8',
  danger: '#cd3131',
  success: '#2f8a3f',
  nodeStroke: '#1f1f1f',
  entry: '#47b374',
  decision: '#ddaa25',
  expand: '#9a6ee0',
  region: '#2f8f7d',
  scrim: 'rgba(0, 0, 0, 0.3)',
  shadowFloating: '0 8px 28px rgba(0, 0, 0, 0.12)',
  shadowModal: '0 12px 40px rgba(0, 0, 0, 0.18)',
  borderAlpha: 0.1,
  mutedAlpha: 0.6,
  hoverAlpha: 0.06,
  activeAlpha: 0.1,
  gridAlpha: 0.09,
  nodeFillAlpha: 1,
  ghostAlpha: 0.32,
  edgeAlpha: 1,
  edgeLabelAlpha: 0.85,
  regionFillAlpha: 0.13,
  marqueeAlpha: 0.1,
};

export function mapThemeToTokens(theme: VscodeColorTheme): MappedTheme {
  const scheme = detectScheme(theme);
  const defaults = scheme === 'dark' ? DARK_DEFAULTS : LIGHT_DEFAULTS;
  const colors = theme.colors ?? {};

  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = colors[key];
      if (value && isOpaque(value)) return value;
    }
    return undefined;
  };

  const bg = pick('editor.background') ?? defaults.bg;
  const ink = pick('editor.foreground') ?? defaults.ink;
  const panel = pick('sideBar.background', 'editorGroupHeader.tabsBackground', 'titleBar.activeBackground') ?? bg;
  const panelBorder = pick('sideBar.border', 'panel.border', 'editorGroup.border', 'input.border') ?? toAlpha(ink, defaults.borderAlpha);
  const muted = pick('editorLineNumber.foreground', 'descriptionForeground') ?? toAlpha(ink, defaults.mutedAlpha);
  const accent = pick('focusBorder', 'textLink.foreground', 'list.activeSelectionBackground', 'button.background') ?? defaults.accent;
  const danger = pick('errorForeground', 'editorError.foreground', 'gitDecoration.deletedResourceForeground') ?? defaults.danger;
  const success = pick('gitDecoration.addedResourceForeground', 'successForeground') ?? defaults.success;
  const disabled = pick('editorWidget.background', 'badge.background', 'input.background') ?? panelBorder;
  const rowHover = pick('list.hoverBackground', 'editor.lineHighlightBackground') ?? toAlpha(ink, defaults.hoverAlpha);
  const rowActive = pick('list.activeSelectionBackground', 'editor.selectionBackground') ?? toAlpha(accent, defaults.activeAlpha);
  const fieldBg = pick('input.background', 'settings.textInputBackground') ?? bg;
  const nodeStroke = pick('editorLineNumber.activeForeground', 'editorCursor.foreground') ?? defaults.nodeStroke;
  const edgeLabelBg = pick('editorWidget.background') ?? bg;
  const canvasGrid = pick('editorIndentGuide.background1', 'editorIndentGuide.background') ?? toAlpha(ink, defaults.gridAlpha);

  const traits = scanTraitColors(theme, ink);
  const entry = traits.get('entry') ?? defaults.entry;
  const decision = traits.get('decision') ?? defaults.decision;
  const expand = traits.get('expand') ?? defaults.expand;
  const region = traits.get('region') ?? defaults.region;

  const tokens = new Map<string, string>([
    ['--color-scheme', scheme],
    ['--bg', bg],
    ['--panel', panel],
    ['--panel-border', panelBorder],
    ['--ink', ink],
    ['--muted', muted],
    ['--accent', accent],
    ['--danger', danger],
    ['--success', success],
    ['--disabled', disabled],
    ['--row-hover', rowHover],
    ['--row-active', rowActive],
    ['--field-bg', fieldBg],
    ['--scrim', defaults.scrim],
    ['--shadow-floating', defaults.shadowFloating],
    ['--shadow-modal', defaults.shadowModal],
    ['--canvas-grid', canvasGrid],
    ['--canvas-ink', ink],
    ['--canvas-muted', toAlpha(muted, defaults.mutedAlpha)],
    ['--canvas-node-fill', toAlpha(bg, defaults.nodeFillAlpha)],
    ['--canvas-node-stroke', nodeStroke],
    ['--canvas-entry-stroke', entry],
    ['--canvas-decision-stroke', decision],
    ['--canvas-expand-stroke', expand],
    ['--canvas-region-stroke', region],
    ['--canvas-region-fill', toAlpha(region, defaults.regionFillAlpha)],
    ['--canvas-ghost', toAlpha(nodeStroke, defaults.ghostAlpha)],
    ['--canvas-edge', pick('editorLineNumber.activeForeground', 'editorCursor.foreground') ?? toAlpha(ink, defaults.edgeAlpha)],
    ['--canvas-edge-label', toAlpha(ink, defaults.edgeLabelAlpha)],
    ['--canvas-edge-label-bg', edgeLabelBg],
    ['--canvas-error', danger],
    ['--canvas-updates', success],
    ['--canvas-select', accent],
    ['--canvas-marquee-fill', toAlpha(accent, defaults.marqueeAlpha)],
    ['--canvas-port-fill', bg],
  ]);
  return { scheme, tokens };
}

export function renderThemeBlock(id: string, tokens: Map<string, string>): string {
  const declarations = THEME_TOKEN_ORDER.map((token) => `  ${token}: ${tokens.get(token)};`);
  return `:root[data-theme="${id}"] {\n${declarations.join('\n')}\n}\n`;
}

type Trait = 'entry' | 'decision' | 'expand' | 'region';

// The canvas trait hues come from the theme's own syntax palette. Each token entry is
// classified by the first trait whose scope keywords match it (an entry scoped
// ["keyword", "keyword.control"] is a decision, never an expand), and the first classified
// entry per trait supplies the hue. The keyword sets track what the trait strokes mean: an
// entry is a step (strings, functions), a decision is a branch (keywords, constants), an
// expand holds structure (storage), a region is a container (type names).
const TRAIT_SCOPES: ReadonlyArray<{ trait: Trait; keywords: readonly string[] }> = [
  { trait: 'entry', keywords: ['string', 'support.function', 'entity.name.function', 'meta.function'] },
  { trait: 'decision', keywords: ['keyword', 'constant'] },
  { trait: 'expand', keywords: ['storage.type', 'storage'] },
  { trait: 'region', keywords: ['entity.name.type', 'support.type', 'support.class', 'entity.name.struct'] },
];

function scanTraitColors(theme: VscodeColorTheme, ink: string): Map<Trait, string> {
  const found = new Map<Trait, string>();
  for (const entry of theme.tokenColors ?? []) {
    const foreground = entry.settings?.foreground;
    if (!foreground || foreground === ink) continue;
    const scopes = typeof entry.scope === 'string' ? [entry.scope] : entry.scope ?? [];
    const trait = TRAIT_SCOPES.find(({ keywords }) =>
      scopes.some((scope) => keywords.some((keyword) => scope.includes(keyword))),
    )?.trait;
    if (trait && !found.has(trait)) found.set(trait, foreground);
  }
  return found;
}

function parseHex(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const expanded = hex.length === 3 ? hex.split('').map((digit) => digit + digit).join('') : hex;
  const value = Number.parseInt(expanded.slice(0, 6), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function perceivedBrightness(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return 0;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}
