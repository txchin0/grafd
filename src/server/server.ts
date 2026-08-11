import { createServer, type Server } from 'node:http';
import { access, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import chokidar from 'chokidar';
import { WebSocketServer, type WebSocket } from 'ws';
import { contentHash, listFlowFiles, resolveWorkspacePath, toPortablePath } from './flow-files.js';

export const DEFAULT_WORKSPACE = '.grafd';
export const DEFAULT_PORT = 3103;
export const DEFAULT_HOST = '127.0.0.1';
const COMPILED_OUTPUT_SETTLE_MS = 120;
// This file runs from dist/server, two levels below the package root. Static assets stay
// under the package; the .flow workspace defaults to .grafd/ relative to the package root
// and can be overridden with a path argument (absolute, or relative to the package root).
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
// The server used to serve `repoRoot/node_modules/roughjs/bundled`, which breaks in an
// installed package: npm hoists roughjs to the consumer's node_modules, not inside
// node_modules/grafd/node_modules. Resolving from this module finds it in either place.
const require = createRequire(import.meta.url);
const roughjsBundledRoot = path.join(path.dirname(require.resolve('roughjs/package.json')), 'bundled');

export interface StartServerOptions {
  workspaceRoot?: string;
  projectRoot?: string;
  port?: number;
  host?: string;
  dev?: boolean;
}

export interface StartedServer {
  port: number;
  host: string;
  url: string;
  workspaceRoot: string;
  close(): Promise<void>;
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new RangeError(`Port must be an integer between 0 and 65535, got ${value}`);
  }
  return value;
}

// A bind failure surfaces on the HTTP server and, because ws forwards the HTTP server's
// error events onto itself, on the WebSocket server too. The HTTP server's events are the
// single authority for the promise; the WebSocketServer listener only swallows the
// forwarded duplicate so it is never left unhandled.
async function listenForRequests(
  httpServer: Server,
  socketServer: WebSocketServer,
  port: number,
  host: string,
): Promise<void> {
  socketServer.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.once('listening', resolve);
    httpServer.listen(port, host);
  });
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(repoRoot, DEFAULT_WORKSPACE));
  // Reference targets are relative to the project root — the directory an agent works in,
  // which is where Grafd was launched from — not to the .flow workspace under it.
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : process.cwd();
  const host = options.host ?? DEFAULT_HOST;
  const port = normalizePort(options.port ?? DEFAULT_PORT);
  const developmentMode = options.dev ?? false;

  const app = express();
  app.use(express.static(path.join(repoRoot, 'public')));
  app.use('/js', express.static(path.join(repoRoot, 'dist', 'client')));
  app.use('/shared', express.static(path.join(repoRoot, 'dist', 'shared')));
  app.use('/vendor/roughjs', express.static(roughjsBundledRoot));

  app.get('/api/files', async (_request, response) => {
    response.json({ files: await listFlowFiles(workspaceRoot) });
  });

  // Reports the absolute root so the client can turn a node's file references into editor
  // deep links, plus the workspace's portable path under that root so a rename can rewrite
  // project-root-relative reference targets. It exposes paths only — no file access hangs
  // off it.
  app.get('/api/project-root', (_request, response) => {
    response.json({ root: projectRoot, workspaceRoot: toPortablePath(projectRoot, workspaceRoot) });
  });

  app.get('/SAVE-GUIDE.md', (_request, response) => {
    response.sendFile(path.join(repoRoot, 'SAVE-GUIDE.md'));
  });

  app.get('/api/file', async (request, response) => {
    const absolute = resolveWorkspacePath(workspaceRoot, String(request.query.path ?? ''));
    if (!absolute) {
      response.status(400).json({ error: 'invalid path' });
      return;
    }
    try {
      response.json({ path: request.query.path, text: await readFile(absolute, 'utf8') });
    } catch {
      response.status(404).json({ error: 'not found' });
    }
  });

  const httpServer = createServer(app);
  const socketServer = new WebSocketServer({ server: httpServer });
  const lastWrittenHashes = new Map<string, string>();
  const fileOperations = new Map<string, Promise<void>>();
  let compiledOutputWatcher: chokidar.FSWatcher | null = null;
  let pendingReload: NodeJS.Timeout | null = null;
  let closed = false;

  interface WriteMessage {
    type: 'write';
    path: string;
    text: string;
  }

  interface DeleteMessage {
    type: 'delete';
    path: string;
  }

  interface RenameMessage {
    type: 'rename';
    from: string;
    to: string;
    id?: number;
  }

  type ClientMessage = WriteMessage | DeleteMessage | RenameMessage;

  function broadcast(message: object, { except }: { except?: WebSocket } = {}): void {
    const payload = JSON.stringify(message);
    for (const client of socketServer.clients) {
      if (client !== except && client.readyState === client.OPEN) client.send(payload);
    }
  }

  // The rename result gates client-side state (the editor only re-keys its handles after the
  // move is confirmed), so it must always be sent for an attempted rename — even when the
  // operation fails after the move. A socket that closed mid-rename is skipped; the client
  // reconciles through the next file-list broadcast.
  function sendRenameResult(socket: WebSocket, ok: boolean, id?: number): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'rename-result', ok, id }));
    }
  }

  // One in-flight file operation per path. The message handler is async, so without this two
  // messages arriving close together — an undo burst, a debounced commit landing on a drag —
  // start two independent writeFile calls on the same path. Each truncates and writes from
  // offset zero on its own descriptor, so a shorter write finishing inside a longer one leaves
  // the longer one's tail past the end of the file: silent corruption that the tolerant .flow
  // parser then reads as extra nodes. Chaining also keeps `lastWrittenHashes` and the broadcast
  // in the order the writes actually land.
  //
  // A rename spans two paths, so it chains onto both queues: it waits for anything already
  // queued on either, and anything queued after it on either waits for the move.
  function queueFileOperation(paths: string[], operation: () => Promise<void>): Promise<void> {
    const settled = Promise.allSettled(paths.map((filePath) => fileOperations.get(filePath) ?? Promise.resolve()));
    // `.then(op, op)` rather than `.finally`: a failed operation must not cancel the ones queued
    // behind it, which are usually the writes that would have corrected it.
    const next = settled.then(operation, operation);
    const tracked = next.catch((error) => {
      console.error('File operation failed', paths.join(' -> '), error);
    });
    for (const filePath of paths) fileOperations.set(filePath, tracked);
    void tracked.then(() => {
      for (const filePath of paths) {
        if (fileOperations.get(filePath) === tracked) fileOperations.delete(filePath);
      }
    });
    return tracked;
  }

  socketServer.on('connection', (socket) => {
    // The client reloads on any reconnect while this is set, which covers the compile that
    // restarts the server before its own reload broadcast can go out.
    socket.send(JSON.stringify({ type: 'hello', reloadOnReconnect: developmentMode }));
    socket.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (message.type === 'write') {
        const { path: portablePath, text } = message;
        if (typeof text !== 'string') return;
        const absolute = resolveWorkspacePath(workspaceRoot, portablePath);
        if (!absolute) return;
        void queueFileOperation([absolute], async () => {
          // Recorded here rather than on receipt so the watcher's echo suppression follows the
          // order the writes land in, not the order they were queued.
          lastWrittenHashes.set(absolute, contentHash(text));
          await mkdir(path.dirname(absolute), { recursive: true });
          await writeFile(absolute, text, 'utf8');
          broadcast({ type: 'file', path: portablePath, text }, { except: socket });
        });
      } else if (message.type === 'delete') {
        const { path: portablePath } = message;
        const absolute = resolveWorkspacePath(workspaceRoot, portablePath);
        if (!absolute) return;
        void queueFileOperation([absolute], async () => {
          lastWrittenHashes.delete(absolute);
          await rm(absolute, { force: true });
          await removeEmptyParentDirectories(path.dirname(absolute));
          await broadcastFileList();
        });
      } else if (message.type === 'rename') {
        const { from, to, id } = message;
        // Renames move .flow files only — the manifest is client-owned UI state and must not
        // be relocatable through the same path. resolveWorkspacePath also admits the manifest
        // for read/write, so the extension is enforced here rather than by that helper.
        const absolute = resolveWorkspacePath(workspaceRoot, from);
        const toAbsolute = resolveWorkspacePath(workspaceRoot, to);
        if (!absolute || !toAbsolute || !from.endsWith('.flow') || !to.endsWith('.flow')) {
          sendRenameResult(socket, false, id);
          return;
        }
        void queueFileOperation([absolute, toAbsolute], async () => {
          let ok = false;
          try {
            ok = await renameWorkspaceFile(absolute, toAbsolute, from, to, socket);
          } catch (error) {
            console.error('Failed to rename', absolute, 'to', toAbsolute, error);
          }
          sendRenameResult(socket, ok, id);
        });
      }
    });
  });

  // The move itself, plus the watcher-echo suppression and the list broadcast that go with
  // it. Returns whether the file actually moved.
  async function renameWorkspaceFile(
    absolute: string,
    toAbsolute: string,
    portableFrom: string,
    portableTo: string,
    except: WebSocket,
  ): Promise<boolean> {
    if (!(await isFile(absolute))) return false;
    // Never let a rename overwrite an existing file; a case-only rename is the same file on
    // a case-insensitive filesystem and is the one exception.
    if ((await pathExists(toAbsolute)) && !(await sameFilePath(absolute, toAbsolute))) return false;
    try {
      await rename(absolute, toAbsolute);
    } catch (error) {
      console.error('Failed to rename', absolute, 'to', toAbsolute, error);
      return false;
    }
    const hash = lastWrittenHashes.get(absolute);
    if (hash) {
      lastWrittenHashes.delete(absolute);
      // Carried to the new path so the watcher's `add` echo for the moved file is
      // suppressed here too: other clients receive the file list, not a content push,
      // exactly as with an external rename.
      lastWrittenHashes.set(toAbsolute, hash);
    }
    // Other clients retarget their open flow and cached documents from this message; it goes
    // out before the file list so the old path is never mistaken for a deletion.
    broadcast({ type: 'rename', from: portableFrom, to: portableTo }, { except });
    await broadcastFileList();
    return true;
  }

  // Whether two absolute paths name the same entry. realpath resolves to the on-disk casing
  // on Windows, so the two spellings of one file compare equal there, while two genuinely
  // distinct files — e.g. main.flow and Main.flow both present on a case-sensitive
  // filesystem — never do.
  async function sameFilePath(a: string, b: string): Promise<boolean> {
    try {
      return (await realpath(a)) === (await realpath(b));
    } catch {
      return false;
    }
  }

  async function pathExists(absolute: string): Promise<boolean> {
    try {
      await access(absolute);
      return true;
    } catch {
      return false;
    }
  }

  async function isFile(absolute: string): Promise<boolean> {
    try {
      return (await stat(absolute)).isFile();
    } catch {
      return false;
    }
  }

  async function removeEmptyParentDirectories(directory: string): Promise<void> {
    try {
      while (directory.startsWith(workspaceRoot + path.sep)) {
        if ((await readdir(directory)).length > 0) return;
        await rmdir(directory);
        directory = path.dirname(directory);
      }
    } catch {
      // A concurrent write into the directory loses the race benignly — leave it in place.
    }
  }

  async function handleFileChangedOnDisk(relativePath: string): Promise<void> {
    const absolute = path.resolve(workspaceRoot, relativePath);
    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch {
      return;
    }
    const isOwnWrite = lastWrittenHashes.get(absolute) === contentHash(text);
    if (isOwnWrite) return;
    broadcast({ type: 'file', path: toPortablePath(workspaceRoot, absolute), text });
  }

  async function broadcastFileList(): Promise<void> {
    broadcast({ type: 'files', files: await listFlowFiles(workspaceRoot) });
  }

  const watcher = chokidar.watch('**/*.flow', {
    cwd: workspaceRoot,
    ignored: /(^|[\\/])(node_modules|\.git|\.claude|dist)([\\/]|$)/,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });
  watcher.on('change', handleFileChangedOnDisk);
  watcher.on('add', async (relativePath) => {
    await handleFileChangedOnDisk(relativePath);
    await broadcastFileList();
  });
  watcher.on('unlink', broadcastFileList);

  // `tsc --watch` rewrites many files per compile, so the reload is deferred until emission
  // has gone quiet rather than fired per file.
  function watchCompiledOutputForReload(): void {
    compiledOutputWatcher = chokidar.watch(
      [path.join(repoRoot, 'dist', 'client'), path.join(repoRoot, 'dist', 'shared')],
      { ignoreInitial: true },
    );
    const scheduleReload = (): void => {
      if (pendingReload) clearTimeout(pendingReload);
      pendingReload = setTimeout(() => broadcast({ type: 'reload' }), COMPILED_OUTPUT_SETTLE_MS);
    };
    compiledOutputWatcher.on('add', scheduleReload);
    compiledOutputWatcher.on('change', scheduleReload);
  }

  if (developmentMode) watchCompiledOutputForReload();

  async function disposeWatchers(): Promise<void> {
    await watcher.close();
    if (compiledOutputWatcher) await compiledOutputWatcher.close();
  }

  // ws only fires its close callback once every client has disconnected, so
  // shutting down with an editor tab open would otherwise hang forever.
  async function closeSocketServer(): Promise<void> {
    for (const client of socketServer.clients) client.terminate();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (pendingReload) {
      clearTimeout(pendingReload);
      pendingReload = null;
    }
    await disposeWatchers();
    await closeSocketServer();
    await new Promise<void>((resolve) => {
      if (!httpServer.listening) {
        resolve();
        return;
      }
      httpServer.close(() => resolve());
    });
    await Promise.allSettled([...fileOperations.values()]);
  }

  try {
    await listenForRequests(httpServer, socketServer, port, host);
  } catch (error) {
    await disposeWatchers();
    await closeSocketServer();
    throw error;
  }

  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  const displayHost =
    host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `http://${displayHost}:${actualPort}`;
  const mode = developmentMode ? ', live reload on' : '';
  console.log(`Grafd editor running at ${url} (watching ${workspaceRoot}${mode})`);

  return { port: actualPort, host, url, workspaceRoot, close };
}
