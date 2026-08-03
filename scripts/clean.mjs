// Empties a build output directory before a build. tsc only ever writes output — it never
// removes the artifact of a source file that has since been renamed or moved, so a stale copy
// of every moved module would linger. That is not merely untidy: build-site.mjs copies
// dist/client wholesale into the static build, so the dead files would ship.
//
// The target defaults to dist/. The linter passes .lint-build instead, so its scratch build
// never deletes the dist/ a running dev server is watching.

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = path.resolve(projectRoot, process.argv[2] ?? 'dist');
if (target !== projectRoot && !target.startsWith(projectRoot + path.sep)) {
  console.error(`Refusing to remove a path outside the project: ${target}`);
  process.exit(2);
}
await rm(target, { recursive: true, force: true });
