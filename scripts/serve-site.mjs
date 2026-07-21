// Previews the serverless build locally: a plain static file server over site/ with no API
// endpoints, so the app boots exactly as it would on a static host (browser-storage mode).
// Run `npm run build:site` first.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 4601;
const siteRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'site');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

createServer(async (request, response) => {
  const requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relativePath = requestPath.endsWith('/') ? `${requestPath}index.html` : requestPath;
  const absolute = path.resolve(siteRoot, `.${relativePath}`);
  if (!absolute.startsWith(siteRoot)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(absolute);
    const type = CONTENT_TYPES[path.extname(absolute)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type }).end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
}).listen(PORT, () => {
  console.log(`Serverless preview of site/ at http://localhost:${PORT}`);
});
