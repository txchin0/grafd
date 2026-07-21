// graf.manifest.json is the editor-owned workspace state file that lives at the root of a
// .flow workspace (a served project, an opened local folder, browser storage, or an
// export). It records which flow is the workspace entrypoint plus session UI state — the
// last opened flow and per-flow cameras — so reopening a workspace restores where the user
// left off. Semantic content stays in the .flow files; agents read `entrypoint` and leave
// `ui` alone.

export const MANIFEST_FILE_NAME = 'graf.manifest.json';
export const MANIFEST_FORMAT = 'graf-workspace/1';

export interface CameraState {
  x: number;
  y: number;
  scale: number;
}

export interface WorkspaceManifest {
  format: string;
  entrypoint: string | null;
  ui: {
    activeFlow: string | null;
    cameras: Record<string, CameraState>;
  };
}

export function emptyManifest(): WorkspaceManifest {
  return { format: MANIFEST_FORMAT, entrypoint: null, ui: { activeFlow: null, cameras: {} } };
}

// Tolerant of hand-edited or older manifests: unknown fields are dropped, missing fields
// fall back to defaults, and unparseable text yields null so callers start fresh.
export function parseManifest(text: string | null | undefined): WorkspaceManifest | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw == null) return null;
  const record = raw as Record<string, unknown>;
  const ui = (typeof record.ui === 'object' && record.ui != null ? record.ui : {}) as Record<string, unknown>;
  return {
    format: typeof record.format === 'string' ? record.format : MANIFEST_FORMAT,
    entrypoint: typeof record.entrypoint === 'string' ? record.entrypoint : null,
    ui: {
      activeFlow: typeof ui.activeFlow === 'string' ? ui.activeFlow : null,
      cameras: readCameras(ui.cameras),
    },
  };
}

function readCameras(raw: unknown): Record<string, CameraState> {
  if (typeof raw !== 'object' || raw == null) return {};
  const cameras: Record<string, CameraState> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const camera = value as Partial<CameraState> | null;
    if (
      camera != null &&
      typeof camera.x === 'number' &&
      typeof camera.y === 'number' &&
      typeof camera.scale === 'number'
    ) {
      cameras[path] = { x: camera.x, y: camera.y, scale: camera.scale };
    }
  }
  return cameras;
}

export function serializeManifest(manifest: WorkspaceManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

export function defaultEntrypoint(files: string[]): string | null {
  if (files.includes('main.flow')) return 'main.flow';
  const rootFiles = files.filter((path) => !path.includes('/'));
  return rootFiles[0] ?? files[0] ?? null;
}

// The flow shown when a workspace opens: last active flow, then the entrypoint, then the
// best default for the file set.
export function chooseStartupFlow(manifest: WorkspaceManifest, files: string[]): string | null {
  if (manifest.ui.activeFlow && files.includes(manifest.ui.activeFlow)) return manifest.ui.activeFlow;
  if (manifest.entrypoint && files.includes(manifest.entrypoint)) return manifest.entrypoint;
  return defaultEntrypoint(files);
}
