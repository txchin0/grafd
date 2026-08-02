// graf.manifest.json is the editor-owned workspace state file that lives at the root of a
// .flow workspace (a served project, an opened local folder, browser storage, or an
// export). It records which flow is the workspace entrypoint, how the workspace's canvas is
// drawn, plus session UI state — the last opened flow, per-flow cameras, and which nodes are
// inline-expanded — so reopening a workspace restores where the user left off. Semantic
// content stays in the .flow files; agents read `entrypoint` and leave the rest alone.
//
// `display` is a deliberate authoring choice about the workspace and is meant to travel with
// it (including inside a .zip export), which is why it sits beside `ui` rather than inside
// it: `ui` is one browser's session state, and the editor ignores other clients' pushes of it.

export const MANIFEST_FILE_NAME = 'graf.manifest.json';
export const MANIFEST_FORMAT = 'graf-workspace/1';

export const DEFAULT_ROUGHNESS = 1;
export const MIN_ROUGHNESS = 0;
export const MAX_ROUGHNESS = 10;

export const CANVAS_FONTS = [
  { id: 'system', label: 'System' },
  { id: 'playpen', label: 'Playpen Sans' },
] as const;

export type CanvasFontId = (typeof CANVAS_FONTS)[number]['id'];
export const DEFAULT_CANVAS_FONT: CanvasFontId = 'system';

export function isCanvasFontId(value: unknown): value is CanvasFontId {
  return CANVAS_FONTS.some((font) => font.id === value);
}

export interface CameraState {
  x: number;
  y: number;
  scale: number;
}

export interface DisplaySettings {
  // The base every canvas element's rough.js roughness is scaled by. 0 draws clean lines.
  roughness: number;
  // Which typeface the canvas draws node and edge labels in.
  font: CanvasFontId;
}

export interface WorkspaceManifest {
  format: string;
  entrypoint: string | null;
  display: DisplaySettings;
  ui: {
    activeFlow: string | null;
    cameras: Record<string, CameraState>;
    expansions: Record<string, string[]>;
  };
}

export function emptyManifest(): WorkspaceManifest {
  return {
    format: MANIFEST_FORMAT,
    entrypoint: null,
    display: { roughness: DEFAULT_ROUGHNESS, font: DEFAULT_CANVAS_FONT },
    ui: { activeFlow: null, cameras: {}, expansions: {} },
  };
}

export function clampRoughness(value: number): number {
  return Math.min(MAX_ROUGHNESS, Math.max(MIN_ROUGHNESS, value));
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
    display: readDisplay(record.display),
    ui: {
      activeFlow: typeof ui.activeFlow === 'string' ? ui.activeFlow : null,
      cameras: readCameras(ui.cameras),
      expansions: readExpansions(ui.expansions),
    },
  };
}

function readDisplay(raw: unknown): DisplaySettings {
  const defaults = { roughness: DEFAULT_ROUGHNESS, font: DEFAULT_CANVAS_FONT };
  if (typeof raw !== 'object' || raw == null) return defaults;
  const record = raw as Partial<DisplaySettings>;
  return {
    roughness: typeof record.roughness === 'number' && Number.isFinite(record.roughness)
      ? clampRoughness(record.roughness)
      : defaults.roughness,
    font: isCanvasFontId(record.font) ? record.font : defaults.font,
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

function readExpansions(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw == null) return {};
  const expansions: Record<string, string[]> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    expansions[path] = value.filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
  return expansions;
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
