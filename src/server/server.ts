import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import chokidar from 'chokidar';
import { WebSocketServer, type WebSocket } from 'ws';
import { contentHash, listFlowFiles, resolveWorkspacePath, toPortablePath } from './flow-files.js';

const PORT = 4600;
// This file runs from dist/server, two levels below the project root.
const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const app = express();
app.use(express.static(path.join(projectRoot, 'public')));
app.use('/js', express.static(path.join(projectRoot, 'dist', 'client')));
app.use('/shared', express.static(path.join(projectRoot, 'dist', 'shared')));
app.use('/vendor/roughjs', express.static(path.join(projectRoot, 'node_modules', 'roughjs', 'bundled')));

app.get('/api/files', async (request, response) => {
  response.json({ files: await listFlowFiles(projectRoot) });
});

app.get('/SAVE-GUIDE.md', (request, response) => {
  response.sendFile(path.join(projectRoot, 'SAVE-GUIDE.md'));
});

app.get('/api/file', async (request, response) => {
  const absolute = resolveWorkspacePath(projectRoot, String(request.query.path ?? ''));
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
    const absolute = resolveWorkspacePath(projectRoot, message.path);
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
    while (directory.startsWith(projectRoot + path.sep)) {
      if ((await readdir(directory)).length > 0) return;
      await rmdir(directory);
      directory = path.dirname(directory);
    }
  } catch {
    // A concurrent write into the directory loses the race benignly — leave it in place.
  }
}

async function handleFileChangedOnDisk(relativePath: string): Promise<void> {
  const absolute = path.resolve(projectRoot, relativePath);
  let text: string;
  try {
    text = await readFile(absolute, 'utf8');
  } catch {
    return;
  }
  const isOwnWrite = lastWrittenHashes.get(absolute) === contentHash(text);
  if (isOwnWrite) return;
  broadcast({ type: 'file', path: toPortablePath(projectRoot, absolute), text });
}

async function broadcastFileList(): Promise<void> {
  broadcast({ type: 'files', files: await listFlowFiles(projectRoot) });
}

const watcher = chokidar.watch('**/*.flow', {
  cwd: projectRoot,
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
  console.log(`Graf editor running at http://localhost:${PORT} (watching ${projectRoot})`);
});
