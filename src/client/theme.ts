// The theme registry and the bridge between the stylesheet's colour tokens and the canvas.
//
// public/themes.css is the single source of truth for every colour: DOM chrome themes itself
// through `var(--token)`, and the canvas — which cannot read custom properties — gets the
// same tokens resolved into concrete colour strings once per theme change.

export interface ThemeDescriptor {
  id: string;
  label: string;
}

export const THEMES = [
  { id: 'graf-dark', label: 'Graf Dark' },
  { id: 'graf-light', label: 'Graf Light' },
] as const satisfies readonly ThemeDescriptor[];

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME_ID: ThemeId = 'graf-dark';

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export interface CanvasPalette {
  grid: string;
  ink: string;
  muted: string;
  nodeFill: string;
  nodeStroke: string;
  entryStroke: string;
  decisionStroke: string;
  expandStroke: string;
  regionStroke: string;
  regionFill: string;
  ghost: string;
  edge: string;
  edgeLabel: string;
  edgeLabelBg: string;
  error: string;
  updates: string;
  select: string;
  marqueeFill: string;
  portFill: string;
}

export const CANVAS_COLOR_TOKENS: Record<keyof CanvasPalette, string> = {
  grid: '--canvas-grid',
  ink: '--canvas-ink',
  muted: '--canvas-muted',
  nodeFill: '--canvas-node-fill',
  nodeStroke: '--canvas-node-stroke',
  entryStroke: '--canvas-entry-stroke',
  decisionStroke: '--canvas-decision-stroke',
  expandStroke: '--canvas-expand-stroke',
  regionStroke: '--canvas-region-stroke',
  regionFill: '--canvas-region-fill',
  ghost: '--canvas-ghost',
  edge: '--canvas-edge',
  edgeLabel: '--canvas-edge-label',
  edgeLabelBg: '--canvas-edge-label-bg',
  error: '--canvas-error',
  updates: '--canvas-updates',
  select: '--canvas-select',
  marqueeFill: '--canvas-marquee-fill',
  portFill: '--canvas-port-fill',
};

export const PAGE_BACKGROUND_TOKEN = '--bg';

// A mirror of the default theme's block in themes.css, which the stylesheet overrides the
// moment it loads. It exists so the canvas is never asked to draw with undefined colours —
// before the first applyTheme, or in tests with no stylesheet. It does not grow as themes are
// added: only the fallback theme is mirrored, and tests/theme.test.ts fails if it drifts.
export const DEFAULT_CANVAS_PALETTE: CanvasPalette = {
  grid: 'rgba(232, 226, 213, 0.07)',
  ink: '#e8e2d5',
  muted: 'rgba(232, 226, 213, 0.55)',
  nodeFill: 'rgba(36, 40, 48, 0.94)',
  nodeStroke: '#9ba8b8',
  entryStroke: '#7fc48a',
  decisionStroke: '#d9b96a',
  expandStroke: '#b48ad9',
  regionStroke: '#6fb5a8',
  regionFill: 'rgba(111, 181, 168, 0.13)',
  ghost: 'rgba(155, 168, 184, 0.45)',
  edge: '#8fa1b3',
  edgeLabel: '#b9c2cc',
  edgeLabelBg: '#20242b',
  error: '#d97a7a',
  updates: '#7fc48a',
  select: '#6aa9e9',
  marqueeFill: 'rgba(106, 169, 233, 0.08)',
  portFill: '#1b1e24',
};

export const DEFAULT_PAGE_BACKGROUND = '#17191d';

export function resolveCanvasPalette(style: CSSStyleDeclaration): CanvasPalette {
  const resolved = {} as CanvasPalette;
  for (const field of Object.keys(CANVAS_COLOR_TOKENS) as (keyof CanvasPalette)[]) {
    resolved[field] = readColorToken(style, CANVAS_COLOR_TOKENS[field], DEFAULT_CANVAS_PALETTE[field]);
  }
  return resolved;
}

function readColorToken(style: CSSStyleDeclaration, token: string, fallback: string): string {
  return style.getPropertyValue(token).trim() || fallback;
}

// The live palette the canvas draws from. Its identity never changes — drawing code holds on
// to it across renders — so a theme change refills it in place rather than replacing it.
export const canvasPalette: CanvasPalette = { ...DEFAULT_CANVAS_PALETTE };

export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
  Object.assign(canvasPalette, resolveCanvasPalette(rootStyle()));
}

// The canvas itself is transparent — the background a viewer sees is the page's, so the theme
// stays the single source of truth for it, including in PNG exports.
export function pageBackgroundColor(): string {
  return readColorToken(rootStyle(), PAGE_BACKGROUND_TOKEN, DEFAULT_PAGE_BACKGROUND);
}

function rootStyle(): CSSStyleDeclaration {
  return getComputedStyle(document.documentElement);
}
