// How a region is drawn: the colour of its outline, label and fill, a fill colour of its own when
// the background should differ, and the pattern the fill is drawn in. This module owns a region's
// canvas-layer entry; canvas-layer.ts only files it under the provider's name, re-keys it with a
// rename and copies it with a duplicate.
//
// A default is never written: an entry holds only what differs from the theme's region look.

import { isLayerColor, setEntryField, type CanvasLayer } from './canvas-layer.js';

export const REGION_FILL_PATTERNS = ['hachure', 'cross-hatch', 'dots', 'solid', 'none'] as const;
export type RegionFillPattern = (typeof REGION_FILL_PATTERNS)[number];

export interface RegionStyle {
  // Null draws the theme's own region colours.
  color: string | null;
  // Null fills in `color`, so one choice tints the whole region.
  fillColor: string | null;
  fill: RegionFillPattern;
}

// A field set to null returns it to its default; a field left out is untouched.
export type RegionStylePatch = { [Field in keyof RegionStyle]?: RegionStyle[Field] | null };

const REGION_STYLE_FIELDS = ['color', 'fillColor', 'fill'] as const satisfies readonly (keyof RegionStyle)[];

export function defaultRegionStyle(): RegionStyle {
  return { color: null, fillColor: null, fill: 'hachure' };
}

export function isRegionFillPattern(value: unknown): value is RegionFillPattern {
  return (REGION_FILL_PATTERNS as readonly unknown[]).includes(value);
}

// Every field resolved: what the entry says where it says something valid, the default elsewhere.
export function regionStyleOf(layer: CanvasLayer | null, regionName: string): RegionStyle {
  const defaults = defaultRegionStyle();
  const entry = layer?.regions[regionName];
  if (!entry) return defaults;
  return {
    color: isLayerColor(entry.color) ? entry.color : defaults.color,
    fillColor: isLayerColor(entry.fillColor) ? entry.fillColor : defaults.fillColor,
    fill: isRegionFillPattern(entry.fill) ? entry.fill : defaults.fill,
  };
}

export function setRegionStyle(layer: CanvasLayer, regionName: string, patch: RegionStylePatch): void {
  const defaults = defaultRegionStyle();
  for (const field of REGION_STYLE_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const isDefault = value === null || value === defaults[field];
    setEntryField(layer.regions, regionName, field, isDefault ? null : value);
  }
}

// The colour a region's fill is drawn in, or null for the theme's own region fill.
export function regionFillColorOf(style: RegionStyle): string | null {
  return style.fillColor ?? style.color;
}
