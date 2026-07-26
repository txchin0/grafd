// The Preferences modal: one checkbox per option in `Preferences`. Every change is written
// through to storage immediately and reported to the app, so there is no apply/cancel step.

import { createModal, type Modal } from './modal.js';
import { loadPreferences, savePreferences, type Preferences } from './preferences.js';

export function createPreferencesDialog(onChange: (preferences: Preferences) => void): Modal {
  const modal = createModal('preferences-modal', 'preferences-panel');
  const showCanvasGrid = document.getElementById('pref-canvas-grid') as HTMLInputElement;
  const closeButton = document.getElementById('preferences-close') as HTMLButtonElement;

  function currentPreferences(): Preferences {
    return { showCanvasGrid: showCanvasGrid.checked };
  }

  function applyChange(): void {
    const preferences = currentPreferences();
    savePreferences(preferences);
    onChange(preferences);
  }

  showCanvasGrid.addEventListener('change', applyChange);
  closeButton.addEventListener('click', modal.close);

  return {
    ...modal,
    open() {
      showCanvasGrid.checked = loadPreferences().showCanvasGrid;
      modal.open();
    },
  };
}
