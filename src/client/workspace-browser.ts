// Serverless default workspace: files persist in IndexedDB so a statically hosted Grafd
// keeps the user's work across visits. Other tabs on the same origin edit the same store;
// a BroadcastChannel relays writes between them (tagged with a sender id so a tab ignores
// its own).

import { MANIFEST_FILE_NAME } from '../shared/manifest.js';
import { newUuid } from '../shared/flow-format.js';
import type { Workspace, WorkspaceDelegate } from './workspace.js';

const DATABASE_NAME = 'grafd-workspace';
const DATABASE_VERSION = 1;
const FILE_STORE = 'files';
const CHANNEL_NAME = 'grafd-workspace';

interface StoredFile {
  path: string;
  text: string;
}

type ChannelMessage =
  | { sender: string; kind: 'file'; path: string; text: string }
  | { sender: string; kind: 'delete'; path: string }
  | { sender: string; kind: 'rename'; from: string; to: string };

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(FILE_STORE)) {
      request.result.createObjectStore(FILE_STORE, { keyPath: 'path' });
    }
  };
  return requestToPromise(request as IDBRequest<IDBDatabase>);
}

export class BrowserWorkspace implements Workspace {
  readonly kind = 'browser';
  readonly label = 'browser storage';
  private readonly clientId = newUuid();
  private delegate: WorkspaceDelegate | null = null;
  private database: IDBDatabase | null = null;
  private channel: BroadcastChannel | null = null;
  private knownFiles: string[] = [];

  async start(delegate: WorkspaceDelegate): Promise<string[]> {
    this.delegate = delegate;
    this.database = await openDatabase();
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (event) => this.receiveFromOtherTab(event.data as ChannelMessage);
    delegate.connectionChanged(true);
    this.knownFiles = await this.listFlowPaths();
    return this.knownFiles;
  }

  stop(): void {
    this.channel?.close();
    this.database?.close();
  }

  async readFile(path: string): Promise<string | null> {
    const stored = await requestToPromise<StoredFile | undefined>(
      this.fileStore('readonly').get(path) as IDBRequest<StoredFile | undefined>,
    );
    return stored?.text ?? null;
  }

  writeFile(path: string, text: string): void {
    const request = this.fileStore('readwrite').put({ path, text } satisfies StoredFile);
    request.onsuccess = () => {
      this.channel?.postMessage({ sender: this.clientId, kind: 'file', path, text } satisfies ChannelMessage);
    };
  }

  deleteFile(path: string): void {
    const request = this.fileStore('readwrite').delete(path);
    request.onsuccess = () => {
      this.knownFiles = this.knownFiles.filter((known) => known !== path);
      this.channel?.postMessage({ sender: this.clientId, kind: 'delete', path } satisfies ChannelMessage);
    };
  }

  renameFile(from: string, to: string): Promise<boolean> {
    return new Promise((resolve) => {
      const transaction = this.database!.transaction(FILE_STORE, 'readwrite');
      const store = transaction.objectStore(FILE_STORE);
      // Issued first so its result is settled before the source read's success handler runs.
      const toRequest = store.get(to) as IDBRequest<StoredFile | undefined>;
      const fromRequest = store.get(from) as IDBRequest<StoredFile | undefined>;
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      fromRequest.onsuccess = () => {
        const stored = fromRequest.result;
        if (!stored) {
          finish(false);
          return;
        }
        // IDB keys are case-sensitive, so a hit at the exact target key is a different file —
        // never let a rename overwrite it (the folder and server backends refuse too). A
        // case-variant collision is refused on top of that, matching the file list the
        // sidebar validates against.
        if (toRequest.result || this.hasCaseVariant(from, to)) {
          finish(false);
          return;
        }
        store.put({ path: to, text: stored.text } satisfies StoredFile);
        store.delete(from);
      };
      fromRequest.onerror = () => finish(false);
      toRequest.onerror = () => finish(false);
      transaction.oncomplete = () => {
        // The source read may have already rejected the rename (missing source, target
        // taken); the transaction still auto-commits, so the state only moves on a
        // completed, accepted move.
        if (settled) return;
        this.knownFiles = this.knownFiles.filter((known) => known !== from);
        if (!this.knownFiles.includes(to)) {
          this.knownFiles.push(to);
          this.knownFiles.sort();
        }
        this.channel?.postMessage({ sender: this.clientId, kind: 'rename', from, to } satisfies ChannelMessage);
        finish(true);
      };
      transaction.onabort = () => finish(false);
      transaction.onerror = () => finish(false);
    });
  }

  private hasCaseVariant(from: string, to: string): boolean {
    const lowered = to.toLowerCase();
    return this.knownFiles.some((known) => known !== from && known.toLowerCase() === lowered);
  }

  private fileStore(mode: IDBTransactionMode): IDBObjectStore {
    return this.database!.transaction(FILE_STORE, mode).objectStore(FILE_STORE);
  }

  private async listFlowPaths(): Promise<string[]> {
    const keys = await requestToPromise(this.fileStore('readonly').getAllKeys());
    return keys
      .map(String)
      .filter((path) => path !== MANIFEST_FILE_NAME)
      .sort();
  }

  private receiveFromOtherTab(message: ChannelMessage): void {
    if (message.sender === this.clientId) return;
    if (message.kind === 'delete') {
      this.knownFiles = this.knownFiles.filter((known) => known !== message.path);
      this.delegate?.filesChanged([...this.knownFiles]);
      return;
    }
    if (message.kind === 'rename') {
      this.knownFiles = this.knownFiles.filter((known) => known !== message.from);
      if (!this.knownFiles.includes(message.to)) {
        this.knownFiles.push(message.to);
        this.knownFiles.sort();
      }
      this.delegate?.fileRenamed?.(message.from, message.to);
      return;
    }
    if (message.path !== MANIFEST_FILE_NAME && !this.knownFiles.includes(message.path)) {
      this.knownFiles.push(message.path);
      this.knownFiles.sort();
      this.delegate?.filesChanged([...this.knownFiles]);
    }
    this.delegate?.fileChanged(message.path, message.text);
  }
}
