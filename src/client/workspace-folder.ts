// A local folder opened through the File System Access API (Chromium browsers). Works in
// both hosting modes since it is entirely client-side. External edits — an agent rewriting
// a .flow file, another editor saving — are picked up by a polling watcher that compares
// modification times and file text, so editing stays synchronized without a server.

import { canvasLayerPathOf, companionLayerOf, isCanvasLayerPath, isFlowPath } from '../shared/canvas-layer.js';
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
  // Canvas layers are watched like .flow files but never listed, so they are kept apart.
  private layerHandles = new Map<string, FileSystemFileHandle>();
  private readonly lastModified = new Map<string, number>();
  private readonly lastSeenText = new Map<string, string>();
  // Mutations run one at a time in the order they were asked for, so a delete can never land
  // before the write that created the file, a rename before the edit it moves, or a poll's
  // directory snapshot before the mutation that changed it. Polls run through the same chain
  // for that last reason: a snapshot taken mid-rename would otherwise re-key the handle map
  // back to the old name until the next poll.
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
    this.label = root.name;
  }

  async start(delegate: WorkspaceDelegate): Promise<string[]> {
    this.delegate = delegate;
    ({ flows: this.fileHandles, layers: this.layerHandles } = await this.discoverFiles());
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
    void this.enqueueMutation(async () => {
      try {
        await this.performWrite(path, text);
      } catch (error) {
        console.error(`Failed to write ${path} to the opened folder`, error);
        this.delegate?.connectionChanged(false);
      }
    });
  }

  deleteFile(path: string): void {
    void this.enqueueMutation(async () => {
      try {
        await this.performDelete(path);
        await this.deleteCompanionLayerOf(path);
      } catch (error) {
        console.error(`Failed to delete ${path} from the opened folder`, error);
      }
    });
  }

  private async deleteCompanionLayerOf(path: string): Promise<void> {
    const layerPath = companionLayerOf(path);
    if (layerPath && (await this.locateFile(layerPath, { create: false }))) await this.performDelete(layerPath);
  }

  renameFile(from: string, to: string): Promise<boolean> {
    let renamed = false;
    const done = this.enqueueMutation(async () => {
      try {
        renamed = await this.performRename(from, to);
      } catch (error) {
        console.error(`Failed to rename ${from} to ${to} in the opened folder`, error);
      }
    });
    return done.then(() => renamed);
  }

  private enqueueMutation(mutation: () => Promise<void>): Promise<void> {
    // A failed mutation must not cancel the ones queued behind it, which are usually the
    // writes that would have corrected it — same policy as the server's file queue.
    const next = this.mutationChain.then(mutation, mutation);
    this.mutationChain = next.catch(() => undefined);
    return next;
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
    this.lastModified.delete(path);
    this.lastSeenText.delete(path);
    if (this.layerHandles.delete(path)) return;
    this.fileHandles.delete(path);
    this.delegate?.filesChanged(this.sortedFlowPaths());
  }

  private async performRename(from: string, to: string): Promise<boolean> {
    const handle = this.fileHandles.get(from) ?? (await this.locateFile(from, { create: false }));
    if (!handle) return false;
    const fileName = to.split('/').pop()!;
    // The handle map is only as fresh as the last poll, so a target that appeared on disk
    // since then is checked directly — and refused unless it is the file being renamed (a
    // case-only rename is the same entry on a case-insensitive filesystem).
    const existing = await this.locateFile(to, { create: false });
    const sameEntry = await isSameEntry(handle, existing);
    if (existing && !sameEntry) return false;
    const move = moveOf(handle);
    if (!move) {
      // Older Chromium without FileSystemHandle.move: copy to the new name, then remove the
      // old entry. A same-entry target is a case-only rename, which the copy/delete pair
      // cannot express (the copy and delete would hit the same file), so those are refused.
      if (sameEntry) return false;
      const file = await handle.getFile();
      const text = await file.text();
      await this.performWrite(to, text);
      try {
        await this.performDelete(from);
      } catch (error) {
        // performDelete only throws before the old entry is removed, so the source still
        // exists here; undo the copy so a failed fallback does not leave both files behind.
        try {
          await this.performDelete(to);
        } catch {
          // The disk is authoritative — leave both files rather than lose data.
        }
        throw error;
      }
      await this.moveCanvasLayer(from, to);
      return true;
    }
    await move(fileName);
    this.fileHandles.delete(from);
    this.fileHandles.set(to, handle);
    this.carryWatchState(from, to);
    await this.moveCanvasLayer(from, to);
    this.delegate?.filesChanged(this.sortedFlowPaths());
    return true;
  }

  private carryWatchState(from: string, to: string): void {
    const modified = this.lastModified.get(from);
    const seen = this.lastSeenText.get(from);
    this.lastModified.delete(from);
    this.lastSeenText.delete(from);
    if (modified != null) this.lastModified.set(to, modified);
    if (seen != null) this.lastSeenText.set(to, seen);
  }

  // A .flow's canvas layer follows it. Best-effort: the .flow has already moved, and reporting
  // the rename as failed would leave the client writing to the old path, re-creating it.
  private async moveCanvasLayer(from: string, to: string): Promise<void> {
    try {
      await this.performCanvasLayerMove(canvasLayerPathOf(from), canvasLayerPathOf(to));
    } catch (error) {
      console.error(`Failed to move the canvas layer of ${from} to ${to} in the opened folder`, error);
    }
  }

  // Whatever sits at the destination is an orphan — no .flow owns it, or the rename would have
  // been refused — and is replaced.
  private async performCanvasLayerMove(layerPath: string, destinationPath: string): Promise<void> {
    const layer = await this.locateFile(layerPath, { create: false });
    const existing = await this.locateFile(destinationPath, { create: false });
    if (layer && (await isSameEntry(layer, existing))) {
      await this.moveCaseOnly(layer, layerPath, destinationPath);
      return;
    }
    if (existing) await this.performDelete(destinationPath);
    if (!layer) return;
    const text = await (await layer.getFile()).text();
    await this.performWrite(destinationPath, text);
    await this.performDelete(layerPath);
  }

  // One entry under two spellings, which a copy and a delete would destroy. Without the move
  // API the layer keeps its old spelling and is simply orphaned.
  private async moveCaseOnly(layer: FileSystemFileHandle, layerPath: string, destinationPath: string): Promise<void> {
    const move = moveOf(layer);
    if (!move) return;
    await move(destinationPath.split('/').pop()!);
    this.layerHandles.delete(layerPath);
    this.layerHandles.set(destinationPath, layer);
    this.carryWatchState(layerPath, destinationPath);
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
    if (isCanvasLayerPath(path)) {
      this.layerHandles.set(path, handle);
    } else if (isFlowPath(path) && !this.fileHandles.has(path)) {
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

  private async discoverFiles(
    directory: FileSystemDirectoryHandle = this.root,
    prefix = '',
    discovered: DiscoveredFiles = { flows: new Map(), layers: new Map() },
  ): Promise<DiscoveredFiles> {
    for await (const entry of directory.values()) {
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const path = `${prefix}${entry.name}`;
      if (entry.kind === 'directory') {
        await this.discoverFiles(entry as FileSystemDirectoryHandle, `${path}/`, discovered);
      } else if (isFlowPath(entry.name)) {
        discovered.flows.set(path, entry as FileSystemFileHandle);
      } else if (isCanvasLayerPath(entry.name)) {
        discovered.layers.set(path, entry as FileSystemFileHandle);
      }
    }
    return discovered;
  }

  private async recordModificationTimes(): Promise<void> {
    for (const [path, handle] of this.watchedHandles()) {
      this.lastModified.set(path, (await handle.getFile()).lastModified);
    }
  }

  private watchedHandles(): [string, FileSystemFileHandle][] {
    return [...this.fileHandles, ...this.layerHandles];
  }

  private sortedFlowPaths(): string[] {
    return [...this.fileHandles.keys()].sort();
  }

  private async poll(): Promise<void> {
    if (!this.delegate) return;
    let merged = false;
    await this.enqueueMutation(async () => {
      let discovered: DiscoveredFiles;
      try {
        discovered = await this.discoverFiles();
      } catch {
        this.delegate?.connectionChanged(false);
        return;
      }
      this.delegate?.connectionChanged(true);

      // The scan and this merge are serialized against every mutation, so the snapshot is
      // never older than the rename that re-keyed the map: wholesale replacement is safe.
      const removedPaths = [...this.fileHandles.keys()].filter((path) => !discovered.flows.has(path));
      const addedPaths = [...discovered.flows.keys()].filter((path) => !this.fileHandles.has(path));
      const removedLayers = [...this.layerHandles.keys()].filter((path) => !discovered.layers.has(path));
      this.fileHandles = discovered.flows;
      this.layerHandles = discovered.layers;
      for (const path of [...removedPaths, ...removedLayers]) {
        this.lastModified.delete(path);
        this.lastSeenText.delete(path);
      }
      if (removedPaths.length > 0 || addedPaths.length > 0) {
        this.delegate?.filesChanged(this.sortedFlowPaths());
      }
      for (const path of removedLayers) this.delegate?.fileDeleted?.(path);
      merged = true;
    });
    if (!merged) return;
    await this.emitChangedFiles();
  }

  private async emitChangedFiles(): Promise<void> {
    for (const [path, handle] of this.watchedHandles()) {
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

// Two spellings of one entry (a case-only rename on a case-insensitive filesystem). Without
// isSameEntry the two cannot be told apart, so they are treated as distinct.
async function isSameEntry(handle: FileSystemFileHandle, other: FileSystemFileHandle | null): Promise<boolean> {
  if (other == null || typeof handle.isSameEntry !== 'function') return false;
  return handle.isSameEntry(other);
}

// FileSystemHandle.move is missing from older Chromium and from the DOM typings.
function moveOf(handle: FileSystemFileHandle): ((name: string) => Promise<unknown>) | null {
  const move = (handle as FileSystemFileHandle & { move?(name: string): Promise<unknown> }).move;
  return move ? (name) => move.call(handle, name) : null;
}

interface DiscoveredFiles {
  flows: Map<string, FileSystemFileHandle>;
  layers: Map<string, FileSystemFileHandle>;
}
