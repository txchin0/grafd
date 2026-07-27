// User-level options for the editor chrome. These live in localStorage rather than in
// graf.manifest.json because they describe how this browser draws any workspace, not
// anything about a workspace's documents — the manifest travels inside a .zip export, and
// one person's display choices must not ride along into someone else's copy.

export const PREFERENCES_STORAGE_KEY = 'graf.preferences';

import { EDITOR_LINK_SCHEMES, type EditorLinkScheme } from './reference-link.js';

export interface Preferences {
  showCanvasGrid: boolean;
  editorLinkScheme: EditorLinkScheme;
}

export function defaultPreferences(): Preferences {
  return { showCanvasGrid: true, editorLinkScheme: 'vscode' };
}

// Tolerant of hand-edited or older stored values: anything missing or of the wrong type
// falls back to its default, so a bad entry can never keep the editor from booting.
export function parsePreferences(text: string | null | undefined): Preferences {
  const defaults = defaultPreferences();
  if (!text) return defaults;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return defaults;
  }
  if (typeof raw !== 'object' || raw == null) return defaults;
  const record = raw as Record<string, unknown>;
  return {
    showCanvasGrid: typeof record.showCanvasGrid === 'boolean' ? record.showCanvasGrid : defaults.showCanvasGrid,
    editorLinkScheme: isEditorLinkScheme(record.editorLinkScheme)
      ? record.editorLinkScheme
      : defaults.editorLinkScheme,
  };
}

function isEditorLinkScheme(value: unknown): value is EditorLinkScheme {
  return EDITOR_LINK_SCHEMES.includes(value as EditorLinkScheme);
}

export function loadPreferences(): Preferences {
  try {
    return parsePreferences(localStorage.getItem(PREFERENCES_STORAGE_KEY));
  } catch {
    return defaultPreferences();
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.error('Could not save preferences', error);
  }
}
