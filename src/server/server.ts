import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import chokidar from 'chokidar';
import { WebSocketServer, type WebSocket } from 'ws';
import { contentHash, listFlowFiles, resolveFlowPath, toPortablePath } from './flow-files.js';

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

app.get('/api/file', async (request, response) => {
  const absolute = resolveFlowPath(projectRoot, String(request.query.path ?? ''));
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

function broadcast(message: object, { except }: { except?: WebSocket } = {}): void {
  const payload = JSON.stringify(message);
  for (const client of socketServer.clients) {
    if (client !== except && client.readyState === client.OPEN) client.send(payload);
  }
}

socketServer.on('connection', (socket) => {
  socket.on('message', async (raw) => {
    let message: Partial<WriteMessage>;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === 'write') {
      const absolute = resolveFlowPath(projectRoot, message.path);
      if (!absolute || typeof message.text !== 'string') return;
      lastWrittenHashes.set(absolute, contentHash(message.text));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, message.text, 'utf8');
      broadcast({ type: 'file', path: message.path, text: message.text }, { except: socket });
    }
  });
});

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
