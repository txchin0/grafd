// Self-hosted workspace: the Grafd server owns the files on disk. Reads go through the REST
// endpoints, writes and external changes travel over the WebSocket (the server suppresses
// echoes of its own writes by content hash and broadcasts everything else).

import type { Workspace, WorkspaceDelegate } from './workspace.js';

// Relative so the probe works when the app is hosted under a subpath (where no Grafd server
// answers and the app falls back to the serverless browser workspace).
const FILES_ENDPOINT = './api/files';
const PROJECT_ROOT_ENDPOINT = './api/project-root';

export async function serverIsAvailable(): Promise<boolean> {
  try {
    const response = await fetch(FILES_ENDPOINT);
    if (!response.ok) return false;
    const body = (await response.json()) as { files?: unknown };
    return Array.isArray(body.files);
  } catch {
    return false;
  }
}

export class ServerWorkspace implements Workspace {
  readonly kind = 'server';
  readonly label = 'server';
  // Absolute path node references resolve against; only this backend can know it.
  projectRoot: string | null = null;
  // Portable path of the workspace root relative to the project root, e.g. ".grafd" when the
  // flow files live in a subfolder of the project; '' when the workspace is the project root.
  workspaceRootPrefix: string | null = null;
  private delegate: WorkspaceDelegate | null = null;
  private socket: WebSocket | null = null;
  private stopped = false;
  // Set by the server's greeting when it was started with --dev. A reconnect then means the
  // server restarted on a recompile, so the page is reloaded to pick up the new modules.
  private reloadOnReconnect = false;
  private hasConnectedBefore = false;
  // The rename whose server result is still awaited, if any. A rename is only sent while the
  // socket is open, so a pending slot always has a message in flight. Every message carries
  // an id so a slow result from an earlier rename can never settle a later one.
  private pendingRename: { id: number; resolve: (ok: boolean) => void } | null = null;
  private nextRenameId = 1;
  // Messages composed while the socket was down, flushed in order on reconnect (renames are
  // never queued — see renameFile). Order matters: a delete followed by a re-create must
  // replay as such.
  private readonly pendingMessages: string[] = [];

  async start(delegate: WorkspaceDelegate): Promise<string[]> {
    this.delegate = delegate;
    this.connect();
    void this.loadProjectRoot();
    const response = await fetch(FILES_ENDPOINT);
    return ((await response.json()) as { files: string[] }).files;
  }

  // Best-effort: an older server without the endpoint just leaves references un-linkable.
  private async loadProjectRoot(): Promise<void> {
    try {
      const response = await fetch(PROJECT_ROOT_ENDPOINT);
      if (!response.ok) return;
      const body = (await response.json()) as { root?: unknown; workspaceRoot?: unknown };
      if (typeof body.root === 'string') this.projectRoot = body.root;
      if (typeof body.workspaceRoot === 'string') this.workspaceRootPrefix = body.workspaceRoot;
    } catch {
      this.projectRoot = null;
      this.workspaceRootPrefix = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  async readFile(path: string): Promise<string | null> {
    const response = await fetch(`./api/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) return null;
    return ((await response.json()) as { text: string }).text;
  }

  writeFile(path: string, text: string): void {
    this.send(JSON.stringify({ type: 'write', path, text }));
  }

  deleteFile(path: string): void {
    this.send(JSON.stringify({ type: 'delete', path }));
  }

  renameFile(from: string, to: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        // Never queue a rename for replay: a queued message could move the file after the
        // editor has already shown the rename as refused.
        resolve(false);
        return;
      }
      const id = this.nextRenameId++;
      this.pendingRename?.resolve(false);
      this.pendingRename = { id, resolve };
      this.socket.send(JSON.stringify({ type: 'rename', from, to, id }));
    });
  }

  private send(message: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
    else this.pendingMessages.push(message);
  }

  private connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}`);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.reloadOnReconnect && this.hasConnectedBefore) {
        location.reload();
        return;
      }
      this.hasConnectedBefore = true;
      this.delegate?.connectionChanged(true);
      for (const message of this.pendingMessages) socket.send(message);
      this.pendingMessages.length = 0;
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data as string) as
        | { type: 'files'; files: string[] }
        | { type: 'file'; path: string; text: string }
        | { type: 'hello'; reloadOnReconnect: boolean }
        | { type: 'rename'; from: string; to: string }
        | { type: 'rename-result'; ok: boolean; id?: number }
        | { type: 'reload' };
      if (message.type === 'files') this.delegate?.filesChanged(message.files);
      else if (message.type === 'file') this.delegate?.fileChanged(message.path, message.text);
      else if (message.type === 'hello') this.reloadOnReconnect = message.reloadOnReconnect;
      else if (message.type === 'rename-result') {
        const pending = this.pendingRename;
        if (pending && message.id === pending.id) {
          pending.resolve(message.ok);
          this.pendingRename = null;
        }
      }
      else if (message.type === 'rename') {
        this.delegate?.fileRenamed?.(message.from, message.to);
      }
      else if (message.type === 'reload') location.reload();
    });
    socket.addEventListener('close', () => {
      this.pendingRename?.resolve(false);
      this.pendingRename = null;
      this.delegate?.connectionChanged(false);
      if (!this.stopped) setTimeout(() => this.connect(), 1000);
    });
  }
}
