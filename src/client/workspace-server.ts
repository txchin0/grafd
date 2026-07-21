// Self-hosted workspace: the Graf server owns the files on disk. Reads go through the REST
// endpoints, writes and external changes travel over the WebSocket (the server suppresses
// echoes of its own writes by content hash and broadcasts everything else).

import type { Workspace, WorkspaceDelegate } from './workspace.js';

// Relative so the probe works when the app is hosted under a subpath (where no Graf server
// answers and the app falls back to the serverless browser workspace).
const FILES_ENDPOINT = './api/files';

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
  private delegate: WorkspaceDelegate | null = null;
  private socket: WebSocket | null = null;
  private stopped = false;
  // Messages composed while the socket was down, flushed in order on reconnect. Order
  // matters: a delete followed by a re-create must replay as such.
  private readonly pendingMessages: string[] = [];

  async start(delegate: WorkspaceDelegate): Promise<string[]> {
    this.delegate = delegate;
    this.connect();
    const response = await fetch(FILES_ENDPOINT);
    return ((await response.json()) as { files: string[] }).files;
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

  private send(message: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
    else this.pendingMessages.push(message);
  }

  private connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}`);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.delegate?.connectionChanged(true);
      for (const message of this.pendingMessages) socket.send(message);
      this.pendingMessages.length = 0;
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data as string) as
        | { type: 'files'; files: string[] }
        | { type: 'file'; path: string; text: string };
      if (message.type === 'files') this.delegate?.filesChanged(message.files);
      else if (message.type === 'file') this.delegate?.fileChanged(message.path, message.text);
    });
    socket.addEventListener('close', () => {
      this.delegate?.connectionChanged(false);
      if (!this.stopped) setTimeout(() => this.connect(), 1000);
    });
  }
}
