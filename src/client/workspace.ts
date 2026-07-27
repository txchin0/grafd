// A workspace is where the .flow files of the current editing session live. The app shell
// talks only to this interface; the backends are:
//
// - ServerWorkspace  — the self-hosted mode: files on the server's disk, synced over
//   WebSocket (workspace-server.ts).
// - BrowserWorkspace — the serverless default: files persisted in IndexedDB, synced across
//   tabs with a BroadcastChannel (workspace-browser.ts).
// - FolderWorkspace  — a local folder opened via the File System Access API, with a polling
//   watcher for synchronized editing (workspace-folder.ts).
//
// Paths are portable (forward-slash, workspace-root-relative). The workspace manifest
// (graf.manifest.json) travels through the same read/write calls as any other file;
// backends exclude it from file listings.

export type WorkspaceKind = 'server' | 'browser' | 'folder';

export interface WorkspaceDelegate {
  filesChanged(files: string[]): void;
  fileChanged(path: string, text: string): void;
  connectionChanged(connected: boolean): void;
}

export interface Workspace {
  readonly kind: WorkspaceKind;
  readonly label: string;
  // Absolute path that node references resolve against, when the backend can know one.
  // Only the server workspace can; the others leave references to the clipboard.
  readonly projectRoot?: string | null;
  start(delegate: WorkspaceDelegate): Promise<string[]>;
  stop(): void;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, text: string): void;
  deleteFile(path: string): void;
}
