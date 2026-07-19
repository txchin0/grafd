import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import chokidar from 'chokidar';
import { WebSocketServer } from 'ws';

const PORT = 4600;
const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.claude']);

const app = express();
app.use(express.static(path.join(projectRoot, 'public')));
app.use('/shared', express.static(path.join(projectRoot, 'shared')));
app.use('/vendor/roughjs', express.static(path.join(projectRoot, 'node_modules', 'roughjs', 'bundled')));

function resolveFlowPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.endsWith('.flow')) return null;
  const absolute = path.resolve(projectRoot, relativePath);
  if (!absolute.startsWith(projectRoot + path.sep)) return null;
  return absolute;
}

function toPortablePath(absolutePath) {
  return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
}

async function listFlowFiles(directory = projectRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFlowFiles(entryPath)));
    } else if (entry.name.endsWith('.flow')) {
      files.push(toPortablePath(entryPath));
    }
  }
  return files.sort();
}

app.get('/api/files', async (request, response) => {
  response.json({ files: await listFlowFiles() });
});

app.get('/api/file', async (request, response) => {
  const absolute = resolveFlowPath(String(request.query.path ?? ''));
  if (!absolute) return response.status(400).json({ error: 'invalid path' });
  try {
    response.json({ path: request.query.path, text: await readFile(absolute, 'utf8') });
  } catch {
    response.status(404).json({ error: 'not found' });
  }
});

const httpServer = createServer(app);
const socketServer = new WebSocketServer({ server: httpServer });
const lastWrittenHashes = new Map();

function contentHash(text) {
  return createHash('sha1').update(text).digest('hex');
}

function broadcast(message, { except } = {}) {
  const payload = JSON.stringify(message);
  for (const client of socketServer.clients) {
    if (client !== except && client.readyState === client.OPEN) client.send(payload);
  }
}

socketServer.on('connection', (socket) => {
  socket.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === 'write') {
      const absolute = resolveFlowPath(message.path);
      if (!absolute || typeof message.text !== 'string') return;
      lastWrittenHashes.set(absolute, contentHash(message.text));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, message.text, 'utf8');
      broadcast({ type: 'file', path: message.path, text: message.text }, { except: socket });
    }
  });
});

async function handleFileChangedOnDisk(relativePath) {
  const absolute = path.resolve(projectRoot, relativePath);
  let text;
  try {
    text = await readFile(absolute, 'utf8');
  } catch {
    return;
  }
  const isOwnWrite = lastWrittenHashes.get(absolute) === contentHash(text);
  if (isOwnWrite) return;
  broadcast({ type: 'file', path: toPortablePath(absolute), text });
}

async function broadcastFileList() {
  broadcast({ type: 'files', files: await listFlowFiles() });
}

const watcher = chokidar.watch('**/*.flow', {
  cwd: projectRoot,
  ignored: /(^|[\\/])(node_modules|\.git|\.claude)([\\/]|$)/,
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
