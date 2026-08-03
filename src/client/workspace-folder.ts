// A local folder opened through the File System Access API (Chromium browsers). Works in
// both hosting modes since it is entirely client-side. External edits — an agent rewriting
// a .flow file, another editor saving — are picked up by a polling watcher that compares
// modification times and file text, so editing stays synchronized without a server.

import type { Workspace, WorkspaceDelegate } from './workspace.js';

const POLL_INTERVAL_MS = 1500;
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.claude', 'dist']);

export function folderPickingIsSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

// Returns null when the user dismisses the picker.
export async function pickWorkspaceFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await window.showDirectoryPicker!({ id: 'grafd-workspace', mode: 'readwrite' })) ?? null;
  } catch {
    return null;
  }
}

export class FolderWorkspace implements Workspace {
  readonly kind = 'folder';
  readonly label: string;
  private readonly root: FileSystemDirectoryHandle;
  private delegate: WorkspaceDelegate | null = null;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private fileHandles = new Map<string, FileSystemFileHandle>();
  private readonly lastModified = new Map<string, number>();
  private readonly lastSeenText = new Map<string, string>();

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
    this.label = root.name;
  }

  async start(delegate: WorkspaceDelegate): Promise<string[]> {
    this.delegate = delegate;
    this.fileHandles = await this.discoverFlowFiles();
    await this.recordModificationTimes();
    delegate.connectionChanged(true);
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    return this.sortedFlowPaths();
  }

  stop(): void {
    clearInterval(this.pollTimer);
    this.delegate = null;
  }

  async readFile(path: string): Promise<string | null> {
    const handle = this.fileHandles.get(path) ?? (await this.locateFile(path, { create: false }));
    if (!handle) return null;
    const file = await handle.getFile();
    const text = await file.text();
    this.lastModified.set(path, file.lastModified);
    this.lastSeenText.set(path, text);
    return text;
  }

  writeFile(path: string, text: string): void {
    void this.performWrite(path, text).catch((error) => {
      console.error(`Failed to write ${path} to the opened folder`, error);
      this.delegate?.connectionChanged(false);
    });
  }

  deleteFile(path: string): void {
    void this.performDelete(path).catch((error) => {
      console.error(`Failed to delete ${path} from the opened folder`, error);
    });
  }

  private async performDelete(path: string): Promise<void> {
    const segments = path.split('/');
    const fileName = segments.pop()!;
    const chain: { parent: FileSystemDirectoryHandle; name: string; directory: FileSystemDirectoryHandle }[] = [];
    let directory = this.root;
    for (const segment of segments) {
      const child = await directory.getDirectoryHandle(segment, { create: false });
      chain.push({ parent: directory, name: segment, directory: child });
      directory = child;
    }
    await directory.removeEntry(fileName);
    await this.removeEmptyDirectories(chain);
    this.fileHandles.delete(path);
    this.lastModified.delete(path);
    this.lastSeenText.delete(path);
    this.delegate?.filesChanged(this.sortedFlowPaths());
  }

  // Innermost first; a non-empty directory ends the walk because its parents contain it.
  private async removeEmptyDirectories(
    chain: { parent: FileSystemDirectoryHandle; name: string; directory: FileSystemDirectoryHandle }[],
  ): Promise<void> {
    for (const { parent, name, directory } of chain.reverse()) {
      const isEmpty = (await directory.values().next()).done === true;
      if (!isEmpty) return;
      await parent.removeEntry(name);
    }
  }

  private async performWrite(path: string, text: string): Promise<void> {
    this.lastSeenText.set(path, text);
    const handle = (await this.locateFile(path, { create: true }))!;
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    const written = await handle.getFile();
    this.lastModified.set(path, written.lastModified);
    if (path.endsWith('.flow') && !this.fileHandles.has(path)) {
      this.fileHandles.set(path, handle);
      this.delegate?.filesChanged(this.sortedFlowPaths());
    }
  }

  private async locateFile(
    path: string,
    { create }: { create: boolean },
  ): Promise<FileSystemFileHandle | null> {
    const segments = path.split('/');
    const fileName = segments.pop()!;
    let directory = this.root;
    try {
      for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment, { create });
      }
      return await directory.getFileHandle(fileName, { create });
    } catch {
      return null;
    }
  }

  private async discoverFlowFiles(
    directory: FileSystemDirectoryHandle = this.root,
    prefix = '',
  ): Promise<Map<string, FileSystemFileHandle>> {
    const discovered = new Map<string, FileSystemFileHandle>();
    for await (const entry of directory.values()) {
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (entry.kind === 'directory') {
        const nested = await this.discoverFlowFiles(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`);
        for (const [path, handle] of nested) discovered.set(path, handle);
      } else if (entry.name.endsWith('.flow')) {
        discovered.set(`${prefix}${entry.name}`, entry as FileSystemFileHandle);
      }
    }
    return discovered;
  }

  private async recordModificationTimes(): Promise<void> {
    for (const [path, handle] of this.fileHandles) {
      this.lastModified.set(path, (await handle.getFile()).lastModified);
    }
  }

  private sortedFlowPaths(): string[] {
    return [...this.fileHandles.keys()].sort();
  }

  private async poll(): Promise<void> {
    if (!this.delegate) return;
    let discovered: Map<string, FileSystemFileHandle>;
    try {
      discovered = await this.discoverFlowFiles();
    } catch {
      this.delegate.connectionChanged(false);
      return;
    }
    this.delegate.connectionChanged(true);

    const removedPaths = [...this.fileHandles.keys()].filter((path) => !discovered.has(path));
    const addedPaths = [...discovered.keys()].filter((path) => !this.fileHandles.has(path));
    this.fileHandles = discovered;
    for (const path of removedPaths) {
      this.lastModified.delete(path);
      this.lastSeenText.delete(path);
    }
    if (removedPaths.length > 0 || addedPaths.length > 0) {
      this.delegate.filesChanged(this.sortedFlowPaths());
    }
    await this.emitChangedFiles();
  }

  private async emitChangedFiles(): Promise<void> {
    for (const [path, handle] of this.fileHandles) {
      let file: File;
      try {
        file = await handle.getFile();
      } catch {
        continue;
      }
      const recordedTime = this.lastModified.get(path);
      this.lastModified.set(path, file.lastModified);
      if (recordedTime === file.lastModified) continue;
      const text = await file.text();
      if (this.lastSeenText.get(path) === text) continue;
      this.lastSeenText.set(path, text);
      this.delegate?.fileChanged(path, text);
    }
  }
}
