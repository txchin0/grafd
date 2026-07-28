// The Preferences modal: one checkbox per option in `Preferences`. Every change is written
// through to storage immediately and reported to the app, so there is no apply/cancel step.

import { createModal, type Modal } from './modal.js';
import { loadPreferences, savePreferences, type Preferences } from './preferences.js';
import type { EditorLinkScheme } from './reference-link.js';
import { THEMES, type ThemeId } from './theme.js';

export function createPreferencesDialog(onChange: (preferences: Preferences) => void): Modal {
  const modal = createModal('preferences-modal', 'preferences-panel');
  const showCanvasGrid = document.getElementById('pref-canvas-grid') as HTMLInputElement;
  const editorLinkScheme = document.getElementById('pref-editor-link') as HTMLSelectElement;
  const theme = document.getElementById('pref-theme') as HTMLSelectElement;
  const closeButton = document.getElementById('preferences-close') as HTMLButtonElement;

  // Generated from the registry so that adding a theme never means editing this dialog.
  theme.append(
    ...THEMES.map((descriptor) => new Option(descriptor.label, descriptor.id)),
  );

  function currentPreferences(): Preferences {
    return {
      showCanvasGrid: showCanvasGrid.checked,
      editorLinkScheme: editorLinkScheme.value as EditorLinkScheme,
      theme: theme.value as ThemeId,
    };
  }

  function applyChange(): void {
    const preferences = currentPreferences();
    savePreferences(preferences);
    onChange(preferences);
  }

  for (const control of [showCanvasGrid, editorLinkScheme, theme]) {
    control.addEventListener('change', applyChange);
  }
  closeButton.addEventListener('click', modal.close);

  return {
    ...modal,
    open() {
      const stored = loadPreferences();
      showCanvasGrid.checked = stored.showCanvasGrid;
      editorLinkScheme.value = stored.editorLinkScheme;
      theme.value = stored.theme;
      modal.open();
    },
  };
}
