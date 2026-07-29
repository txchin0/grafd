// The workspace's `graf.manifest.json`: its entrypoint, its display settings, plus the UI
// state the editor remembers between sessions — which flow was open, where each flow's camera
// sat, and which frames were unfolded in it.
//
// Saves are debounced because the events that dirty this are continuous: every pan and zoom
// records a camera. It is editor-owned and agents ignore everything but `entrypoint`, so a
// lost save costs a remembered viewport, never content — which is why nothing here is folded
// into the .flow commit pipeline or the undo history.

import {
  MANIFEST_FILE_NAME,
  chooseStartupFlow,
  clampRoughness,
  defaultEntrypoint,
  emptyManifest,
  parseManifest,
  serializeManifest,
  type WorkspaceManifest,
} from '../shared/manifest.js';
import type { View } from './canvas-view.js';

const SAVE_DEBOUNCE_MS = 800;

export interface SavedFlowView {
  camera: View | null;
  openExpansions: string[] | null;
}

export interface WorkspaceUiStateOptions {
  writeFile(path: string, text: string): void;
  // What the editor currently looks like, sampled at save time rather than pushed on change.
  activePath(): string | null;
  camera(): View;
  openExpansionIds(): string[];
}

export function createWorkspaceUiState(options: WorkspaceUiStateOptions) {
  let manifest: WorkspaceManifest = emptyManifest();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  function record(): void {
    manifest.ui.activeFlow = options.activePath();
    const path = manifest.ui.activeFlow;
    if (!path) return;
    const { x, y, scale } = options.camera();
    manifest.ui.cameras[path] = { x, y, scale };
    manifest.ui.expansions[path] = options.openExpansionIds();
  }

  function scheduleSave(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  function saveNow(): void {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    record();
    options.writeFile(MANIFEST_FILE_NAME, serializeManifest(manifest));
  }

  return {
    // Adopts the manifest of a freshly opened workspace, cancelling any save still pending
    // against the previous one — its paths mean different files.
    adopt(text: string | null, files: string[]): void {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      manifest = parseManifest(text) ?? emptyManifest();
      if (!manifest.entrypoint) manifest.entrypoint = defaultEntrypoint(files);
    },

    scheduleSave,
    saveNow,

    // Snapshot for export. Brought up to date first, since the export includes it verbatim.
    forExport(files: string[]): WorkspaceManifest {
      record();
      if (!manifest.entrypoint) manifest.entrypoint = defaultEntrypoint(files);
      return manifest;
    },

    startupFlow(files: string[]): string | null {
      return chooseStartupFlow(manifest, files);
    },

    roughness(): number {
      return manifest.display.roughness;
    },

    setRoughness(value: number): void {
      manifest.display.roughness = clampRoughness(value);
      scheduleSave();
    },

    savedViewOf(path: string): SavedFlowView {
      return {
        camera: manifest.ui.cameras[path] ?? null,
        openExpansions: manifest.ui.expansions[path] ?? null,
      };
    },

    // A flow created while the workspace had none becomes its entrypoint.
    adoptEntrypointIfUnset(path: string): void {
      if (!manifest.entrypoint) manifest.entrypoint = path;
    },

    forgetFlow(path: string, remainingFiles: string[]): void {
      delete manifest.ui.cameras[path];
      delete manifest.ui.expansions[path];
      if (manifest.ui.activeFlow === path) manifest.ui.activeFlow = null;
      if (manifest.entrypoint === path) manifest.entrypoint = defaultEntrypoint(remainingFiles);
      scheduleSave();
    },
  };
}
