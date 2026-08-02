// The workspace's canvas typeface: which hand-drawn family node and edge labels are drawn in.
// Unlike theme colours, the canvas cannot read CSS custom properties, so the active family
// stack is held here and applied when the workspace display settings change.

import {
  CANVAS_FONTS as CANVAS_FONT_OPTIONS,
  DEFAULT_CANVAS_FONT,
  isCanvasFontId,
  type CanvasFontId,
} from '../shared/manifest.js';

// Match TITLE_FONT_PX / DESCRIPTION_FONT_PX in node-metrics.ts — preload faces used for layout.
const TITLE_LOAD_PX = 15;
const DESCRIPTION_LOAD_PX = 12.5;

const FAMILY_STACKS = {
  system: '"Segoe Print", "Comic Sans MS", cursive',
  playpen: '"Playpen Sans", cursive',
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

async function ensureWebFontLoaded(family: string): Promise<void> {
  await Promise.all([
    document.fonts.load(`600 ${TITLE_LOAD_PX}px ${family}`),
    document.fonts.load(`${DESCRIPTION_LOAD_PX}px ${family}`),
  ]);
}

export async function applyCanvasFont(id: CanvasFontId): Promise<void> {
  const fontId = isCanvasFontId(id) ? id : DEFAULT_CANVAS_FONT;
  activeFamilyStack = FAMILY_STACKS[fontId];
  if (!WEB_FONT_IDS.has(fontId)) return;
  try {
    await ensureWebFontLoaded(activeFamilyStack);
  } catch (error) {
    console.error('Failed to load canvas font', error);
  }
}
