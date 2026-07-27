// The Preferences modal: one checkbox per option in `Preferences`. Every change is written
// through to storage immediately and reported to the app, so there is no apply/cancel step.

import { createModal, type Modal } from './modal.js';
import { loadPreferences, savePreferences, type Preferences } from './preferences.js';
import type { EditorLinkScheme } from './reference-link.js';

export function createPreferencesDialog(onChange: (preferences: Preferences) => void): Modal {
  const modal = createModal('preferences-modal', 'preferences-panel');
  const showCanvasGrid = document.getElementById('pref-canvas-grid') as HTMLInputElement;
  const editorLinkScheme = document.getElementById('pref-editor-link') as HTMLSelectElement;
  const closeButton = document.getElementById('preferences-close') as HTMLButtonElement;

  function currentPreferences(): Preferences {
    return {
      showCanvasGrid: showCanvasGrid.checked,
      editorLinkScheme: editorLinkScheme.value as EditorLinkScheme,
    };
  }

  function applyChange(): void {
    const preferences = currentPreferences();
    savePreferences(preferences);
    onChange(preferences);
  }

  showCanvasGrid.addEventListener('change', applyChange);
  editorLinkScheme.addEventListener('change', applyChange);
  closeButton.addEventListener('click', modal.close);

  return {
    ...modal,
    open() {
      const stored = loadPreferences();
      showCanvasGrid.checked = stored.showCanvasGrid;
      editorLinkScheme.value = stored.editorLinkScheme;
      modal.open();
    },
  };
}
