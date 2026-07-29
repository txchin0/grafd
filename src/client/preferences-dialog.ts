// The Preferences modal: one control per option in `Preferences`, plus the settings the open
// workspace stores in its manifest. Every change is written through to its own store
// immediately and reported to the app, so there is no apply/cancel step.

import { createModal, type Modal } from './modal.js';
import { loadPreferences, savePreferences, type Preferences } from './preferences.js';
import type { EditorLinkScheme } from './reference-link.js';
import { THEMES, type ThemeId } from './theme.js';

// Workspace-scoped settings live in graf.manifest.json, so the dialog reads and writes them
// through the app rather than touching the localStorage the user-level preferences use.
export interface WorkspaceDisplaySettings {
  roughness(): number;
  setRoughness(value: number): void;
}

export function createPreferencesDialog(
  onChange: (preferences: Preferences) => void,
  workspaceDisplay: WorkspaceDisplaySettings,
): Modal {
  const modal = createModal('preferences-modal', 'preferences-panel');
  const showCanvasGrid = document.getElementById('pref-canvas-grid') as HTMLInputElement;
  const openSubgraphOnDoubleClick = document.getElementById('pref-open-subgraph-dblclick') as HTMLInputElement;
  const editorLinkScheme = document.getElementById('pref-editor-link') as HTMLSelectElement;
  const theme = document.getElementById('pref-theme') as HTMLSelectElement;
  const roughness = document.getElementById('pref-roughness') as HTMLInputElement;
  const roughnessValue = document.getElementById('pref-roughness-value') as HTMLOutputElement;
  const closeButton = document.getElementById('preferences-close') as HTMLButtonElement;

  // Generated from the registry so that adding a theme never means editing this dialog.
  theme.append(
    ...THEMES.map((descriptor) => new Option(descriptor.label, descriptor.id)),
  );

  function currentPreferences(): Preferences {
    return {
      showCanvasGrid: showCanvasGrid.checked,
      openSubgraphOnDoubleClick: openSubgraphOnDoubleClick.checked,
      editorLinkScheme: editorLinkScheme.value as EditorLinkScheme,
      theme: theme.value as ThemeId,
    };
  }

  function applyChange(): void {
    const preferences = currentPreferences();
    savePreferences(preferences);
    onChange(preferences);
  }

  // `input` rather than `change`, so the canvas redraws under the thumb as it is dragged.
  function applyRoughness(): void {
    const value = Number(roughness.value);
    roughnessValue.value = formatRoughness(value);
    workspaceDisplay.setRoughness(value);
  }

  for (const control of [showCanvasGrid, openSubgraphOnDoubleClick, editorLinkScheme, theme]) {
    control.addEventListener('change', applyChange);
  }
  roughness.addEventListener('input', applyRoughness);
  closeButton.addEventListener('click', modal.close);

  return {
    ...modal,
    open() {
      const stored = loadPreferences();
      showCanvasGrid.checked = stored.showCanvasGrid;
      openSubgraphOnDoubleClick.checked = stored.openSubgraphOnDoubleClick;
      editorLinkScheme.value = stored.editorLinkScheme;
      theme.value = stored.theme;
      const workspaceRoughness = workspaceDisplay.roughness();
      roughness.value = String(workspaceRoughness);
      roughnessValue.value = formatRoughness(workspaceRoughness);
      modal.open();
    },
  };
}

function formatRoughness(value: number): string {
  return value.toFixed(1);
}
