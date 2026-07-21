import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import chokidar from 'chokidar';
import { WebSocketServer, type WebSocket } from 'ws';
import { contentHash, listFlowFiles, resolveWorkspacePath, toPortablePath } from './flow-files.js';

const PORT = 4600;
const DEFAULT_WORKSPACE = 'flows';
// This file runs from dist/server, two levels below the repo root. Static assets stay
// under the repo; the .flow workspace defaults to flows/ and can be overridden with a
// path argument (absolute, or relative to the repo root).
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workspaceRoot = path.resolve(repoRoot, process.argv[2] ?? DEFAULT_WORKSPACE);

const app = express();
app.use(express.static(path.join(repoRoot, 'public')));
app.use('/js', express.static(path.join(repoRoot, 'dist', 'client')));
app.use('/shared', express.static(path.join(repoRoot, 'dist', 'shared')));
app.use('/vendor/roughjs', express.static(path.join(repoRoot, 'node_modules', 'roughjs', 'bundled')));

app.get('/api/files', async (request, response) => {
  response.json({ files: await listFlowFiles(workspaceRoot) });
});

app.get('/SAVE-GUIDE.md', (request, response) => {
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

interface WriteMessage {
  type: 'write';
  path: string;
  text: string;
}

interface DeleteMessage {
  type: 'delete';
  path: string;
}

type ClientMessage = WriteMessage | DeleteMessage;

function broadcast(message: object, { except }: { except?: WebSocket } = {}): void {
  const payload = JSON.stringify(message);
  for (const client of socketServer.clients) {
    if (client !== except && client.readyState === client.OPEN) client.send(payload);
  }
}

socketServer.on('connection', (socket) => {
  socket.on('message', async (raw) => {
    let message: Partial<ClientMessage>;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const absolute = resolveWorkspacePath(workspaceRoot, message.path);
    if (!absolute) return;
    if (message.type === 'write' && typeof (message as Partial<WriteMessage>).text === 'string') {
      const text = (message as WriteMessage).text;
      lastWrittenHashes.set(absolute, contentHash(text));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, text, 'utf8');
      broadcast({ type: 'file', path: message.path, text }, { except: socket });
    } else if (message.type === 'delete') {
      lastWrittenHashes.delete(absolute);
      await rm(absolute, { force: true });
      await removeEmptyParentDirectories(path.dirname(absolute));
      await broadcastFileList();
    }
  });
});

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

httpServer.listen(PORT, () => {
  console.log(`Graf editor running at http://localhost:${PORT} (watching ${workspaceRoot})`);
});
