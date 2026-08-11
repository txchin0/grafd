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
// (grafd.manifest.json) travels through the same read/write calls as any other file;
// backends exclude it from file listings.

export type WorkspaceKind = 'server' | 'browser' | 'folder';

export interface WorkspaceDelegate {
  filesChanged(files: string[]): void;
  // A file was renamed by the workspace itself (another client in server or browser mode),
  // before the follow-up file-list broadcast. The delegate retargets its in-memory handles
  // so the old path is not treated as deleted and never written back.
  fileRenamed?(from: string, to: string): void;
  fileChanged(path: string, text: string): void;
  connectionChanged(connected: boolean): void;
}

export interface Workspace {
  readonly kind: WorkspaceKind;
  readonly label: string;
  // Absolute path that node references resolve against, when the backend can know one.
  // Only the server workspace can; the others leave references to the clipboard.
  readonly projectRoot?: string | null;
  // Portable path of the workspace root relative to the project root ('' when they are the
  // same), used to rewrite project-root-relative reference targets after a rename. Only the
  // server workspace knows it; the others leave it null and references are treated as
  // workspace-relative.
  readonly workspaceRootPrefix?: string | null;
  start(delegate: WorkspaceDelegate): Promise<string[]>;
  stop(): void;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, text: string): void;
  deleteFile(path: string): void;
  // Moves a file (and its content) from one workspace path to another. Both paths are
  // portable and .flow-relative to the workspace root, like the read/write/delete paths.
  // Resolves to whether the move actually happened: every backend refuses a rename whose
  // source is missing or whose target is already taken (a same-file case-only rename being
  // the one exception), and none of them overwrite. Backends also refuse without attempting
  // when they cannot currently perform the move — the connection is down, or the browser
  // lacks the file-system API a case-only rename would need.
  renameFile(from: string, to: string): Promise<boolean>;
}
