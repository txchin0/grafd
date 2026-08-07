import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStart } from '../cli.js';
import { DEFAULT_WORKSPACE } from './server.js';

// Keeps `node dist/server/server-main.js` — and the `npm start` that calls it — working as
// the CLI's start command with the package's own .grafd/ as the fallback workspace.
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

process.exitCode = await runStart(process.argv.slice(2), {
  defaultWorkspace: path.join(repoRoot, DEFAULT_WORKSPACE),
});
