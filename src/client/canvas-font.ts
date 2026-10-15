// The workspace's canvas typeface: which hand-drawn family node and edge labels are drawn in.
// Unlike theme colours, the canvas cannot read CSS custom properties, so the active family
// stack is held here and applied when the workspace display settings change.

import {
  CANVAS_FONTS as CANVAS_FONT_OPTIONS,
  DEFAULT_CANVAS_FONT,
  isCanvasFontId,
  type CanvasFontId,
} from '../shared/manifest.js';

// Match TITLE_FONT_PX / DESCRIPTION_FONT_PX in shared/node-text-metrics.ts — preload faces used for layout.
const TITLE_LOAD_PX = 15;
const DESCRIPTION_LOAD_PX = 12.5;

// The canvas draws a few symbols the hand fonts lack (the badges' ⤢ ⊞ ⊟, ▶, ⚠, ↺). A browser finds
// them in some system font of its own accord; a server-side canvas (`grafd render`) only looks
// through the families it is given, so these name a symbol font on each platform.
const SYMBOL_FALLBACKS = '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", "DejaVu Sans"';

const FAMILY_STACKS = {
  system: `"Segoe Print", "Comic Sans MS", ${SYMBOL_FALLBACKS}, cursive`,
  playpen: `"Playpen Sans", ${SYMBOL_FALLBACKS}, cursive`,
} as const satisfies Record<CanvasFontId, string>;

const WEB_FONT_IDS = new Set<CanvasFontId>(['playpen']);

export interface CanvasFontDescriptor {
  id: CanvasFontId;
  label: string;
  familyStack: string;
}

export const CANVAS_FONTS = CANVAS_FONT_OPTIONS.map((font) => ({
  id: font.id,
  label: font.label,
  familyStack: FAMILY_STACKS[font.id],
})) satisfies readonly CanvasFontDescriptor[];

let activeFamilyStack = FAMILY_STACKS[DEFAULT_CANVAS_FONT];

export function handFontFamily(): string {
  return activeFamilyStack;
}

// Draws the canvas in a family without loading it, for a renderer that has registered its fonts
// itself (`grafd render`). Returns the family chosen: an unknown id falls back to the default.
export function selectCanvasFont(id: CanvasFontId): CanvasFontId {
  const fontId = isCanvasFontId(id) ? id : DEFAULT_CANVAS_FONT;
  activeFamilyStack = FAMILY_STACKS[fontId];
  return fontId;
}

async function ensureWebFontLoaded(family: string): Promise<void> {
  await Promise.all([
    document.fonts.load(`600 ${TITLE_LOAD_PX}px ${family}`),
    document.fonts.load(`${DESCRIPTION_LOAD_PX}px ${family}`),
  ]);
}

export async function applyCanvasFont(id: CanvasFontId): Promise<void> {
  const fontId = selectCanvasFont(id);
  if (!WEB_FONT_IDS.has(fontId)) return;
  try {
    await ensureWebFontLoaded(activeFamilyStack);
  } catch (error) {
    console.error('Failed to load canvas font', error);
  }
}
