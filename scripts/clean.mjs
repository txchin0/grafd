// Empties dist/ before a build. tsc only ever writes output — it never removes the artifact
// of a source file that has since been renamed or moved, so a stale copy of every moved
// module would linger. That is not merely untidy: build-site.mjs copies dist/client wholesale
// into the static build, so the dead files would ship.

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
await rm(path.join(projectRoot, 'dist'), { recursive: true, force: true });
