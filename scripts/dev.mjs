// Development loop: one blocking build so dist/ exists, then `tsc --watch` recompiling in
// the background alongside the server in live-reload mode. Client and shared recompiles
// reach the browser over the existing WebSocket; server recompiles restart the process via
// node --watch, and the browser reloads when it reconnects.
//
// Run from an npm script — node_modules/.bin must be on PATH for `tsc` to resolve.

import { spawn } from 'node:child_process';

const workspaceArguments = process.argv.slice(2);

function run(command, { inheritExit = false } = {}) {
  const child = spawn(command, { shell: true, stdio: 'inherit' });
  if (inheritExit) child.on('exit', (code) => process.exit(code ?? 0));
  return child;
}

function runToCompletion(command) {
  return new Promise((resolve, reject) => {
    run(command).on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

await runToCompletion('tsc -p tsconfig.build.json');

const compiler = run('tsc -p tsconfig.build.json --watch --preserveWatchOutput');
const server = run(
  ['node --watch dist/server/server.js --dev', ...workspaceArguments].join(' '),
  { inheritExit: true },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    compiler.kill();
    server.kill();
    process.exit(0);
  });
}
