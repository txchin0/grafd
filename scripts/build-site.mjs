// Assembles the serverless (static-host) build in site/: the shell from public/, the
// compiled client and shared modules laid out exactly as the self-hosted server serves
// them, the rough.js bundle, and SAVE-GUIDE.md for workspace export. Deploy the site/
// directory to any static host; the app detects the missing Grafd server and runs in
// browser-storage mode.

import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const siteRoot = path.join(projectRoot, 'site');

await rm(siteRoot, { recursive: true, force: true });
await mkdir(siteRoot, { recursive: true });

const copies = [
  ['public', '.'],
  ['dist/client', 'js'],
  ['dist/shared', 'shared'],
  ['node_modules/roughjs/bundled', 'vendor/roughjs'],
  ['SAVE-GUIDE.md', 'SAVE-GUIDE.md'],
];

for (const [source, destination] of copies) {
  await cp(path.join(projectRoot, source), path.join(siteRoot, destination), { recursive: true });
}

console.log(`Static site written to ${siteRoot}`);
