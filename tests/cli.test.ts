import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initWorkspace, parseStartArgs, readPackageVersion, resolveDefaultWorkspace, runCli } from '../src/cli.js';
import { startServer } from '../src/server/server.js';
import type { StartedServer } from '../src/server/server.js';
import { MANIFEST_FILE_NAME, parseManifest, serializeManifest, emptyManifest } from '../src/shared/manifest.js';

const tempDirectories: string[] = [];
const servers: StartedServer[] = [];
const originalCwd = process.cwd();

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grafd-cli-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('parseStartArgs', () => {
  it('parses defaults, flags, and the workspace path', () => {
    expect(parseStartArgs([])).toEqual({ workspace: null, open: false, dev: false });
    expect(parseStartArgs(['--port', '3103', '--host', '127.0.0.1', '--open', '--dev'])).toMatchObject({
      workspace: null,
      port: 3103,
      host: '127.0.0.1',
      open: true,
      dev: true,
    });
    expect(parseStartArgs(['path/to/workspace', '--port=4100'])).toMatchObject({
      workspace: 'path/to/workspace',
      port: 4100,
      open: false,
    });
  });

  it('rejects invalid ports, unknown flags, and multiple workspaces', () => {
    expect(parseStartArgs(['--port', 'abc'])).toMatchObject({ error: expect.stringContaining('Invalid port') });
    expect(parseStartArgs(['--port=abc'])).toMatchObject({ error: expect.stringContaining('Invalid port') });
    expect(parseStartArgs(['--port'])).toMatchObject({ error: '--port requires a value' });
    expect(parseStartArgs(['--host='])).toMatchObject({ error: '--host requires a value' });
    expect(parseStartArgs(['--project-root'])).toMatchObject({ error: '--project-root requires a value' });
    expect(parseStartArgs(['--bogus'])).toMatchObject({ error: 'Unknown option: --bogus' });
    expect(parseStartArgs(['one', 'two'])).toMatchObject({ error: 'Only one workspace path may be passed to start' });
  });

  it('supports per-command help', () => {
    expect(parseStartArgs(['--help'])).toEqual({ help: true });
  });
});

describe('resolveDefaultWorkspace', () => {
  it('prefers .grafd with a manifest, then cwd with a manifest, then null', async () => {
    const empty = await makeTempDirectory();
    expect(await resolveDefaultWorkspace(empty)).toBeNull();

    const grafdOnly = await makeTempDirectory();
    await mkdir(path.join(grafdOnly, '.grafd'));
    expect(await resolveDefaultWorkspace(grafdOnly)).toBeNull();

    const grafdWorkspace = await makeTempDirectory();
    const grafdDirectory = path.join(grafdWorkspace, '.grafd');
    await mkdir(grafdDirectory);
    await writeFile(
      path.join(grafdDirectory, MANIFEST_FILE_NAME),
      serializeManifest({ ...emptyManifest(), entrypoint: 'main.flow' }),
    );
    expect(await resolveDefaultWorkspace(grafdWorkspace)).toBe(grafdDirectory);

    const manifestInCwd = await makeTempDirectory();
    await writeFile(
      path.join(manifestInCwd, MANIFEST_FILE_NAME),
      serializeManifest({ ...emptyManifest(), entrypoint: 'main.flow' }),
    );
    expect(await resolveDefaultWorkspace(manifestInCwd)).toBe(manifestInCwd);

    const flowsOnly = await makeTempDirectory();
    await writeFile(path.join(flowsOnly, 'main.flow'), '---\nname: T\n---\n\nStart\n');
    expect(await resolveDefaultWorkspace(flowsOnly)).toBeNull();
  });
});

describe('initWorkspace', () => {
  it('creates main.flow, the manifest, and SAVE-GUIDE.md', async () => {
    const directory = await makeTempDirectory();
    const result = await initWorkspace(directory);
    expect(result.created.map((file) => path.basename(file)).sort()).toEqual([
      'SAVE-GUIDE.md',
      MANIFEST_FILE_NAME,
      'main.flow',
    ]);

    const manifest = parseManifest(await readFile(path.join(directory, '.grafd', MANIFEST_FILE_NAME), 'utf8'));
    expect(manifest?.entrypoint).toBe('main.flow');

    const workspaceGuide = await readFile(path.join(directory, '.grafd', 'SAVE-GUIDE.md'), 'utf8');
    const sourceGuide = await readFile(new URL('../SAVE-GUIDE.md', import.meta.url), 'utf8');
    expect(workspaceGuide).toBe(sourceGuide);
  });

  it('never overwrites an existing workspace', async () => {
    const directory = await makeTempDirectory();
    await initWorkspace(directory);
    const mainPath = path.join(directory, '.grafd', 'main.flow');
    await writeFile(mainPath, 'custom content\n');

    const second = await initWorkspace(directory);
    expect(second.existing.map((file) => path.basename(file)).sort()).toEqual([
      'SAVE-GUIDE.md',
      MANIFEST_FILE_NAME,
      'main.flow',
    ]);
    expect(await readFile(mainPath, 'utf8')).toBe('custom content\n');
  });
});

describe('readPackageVersion', () => {
  it('reads the version from package.json', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(readPackageVersion()).toBe(packageJson.version);
  });
});

describe('runCli', () => {
  it('prints the version and global help, and exits 0', async () => {
    expect(await runCli(['--version'])).toBe(0);
    expect(await runCli(['--help'])).toBe(0);
  });

  it('treats no command as start', async () => {
    const empty = await makeTempDirectory();
    process.chdir(empty);
    expect(await runCli([])).toBe(1);
    expect(await runCli(['start'])).toBe(1);
  });

  it('rejects unknown commands and options with exit code 2', async () => {
    expect(await runCli(['frobnicate'])).toBe(2);
    expect(await runCli(['--bogus'])).toBe(2);
  });

  it('runs init in the current directory and never overwrites', async () => {
    const directory = await makeTempDirectory();
    process.chdir(directory);
    expect(await runCli(['init'])).toBe(0);
    expect(await readFile(path.join(directory, '.grafd', 'main.flow'), 'utf8')).toContain('My Flow');
    expect(await runCli(['init'])).toBe(0);
  });

  it('runs lint in the current directory when it contains a manifest', async () => {
    const clean = await makeTempDirectory();
    await writeFile(
      path.join(clean, MANIFEST_FILE_NAME),
      serializeManifest({ ...emptyManifest(), entrypoint: 'main.flow' }),
    );
    await writeFile(path.join(clean, 'main.flow'), '---\nname: Clean\n---\n\nStart\n');
    process.chdir(clean);
    expect(await runCli(['lint'])).toBe(0);

    const broken = await makeTempDirectory();
    await writeFile(
      path.join(broken, MANIFEST_FILE_NAME),
      serializeManifest({ ...emptyManifest(), entrypoint: 'main.flow' }),
    );
    await writeFile(path.join(broken, 'main.flow'), 'Start\n');
    process.chdir(broken);
    expect(await runCli(['lint'])).toBe(1);
  });

  it('exits 1 when start has no workspace to serve', async () => {
    const empty = await makeTempDirectory();
    process.chdir(empty);
    expect(await runCli(['start'])).toBe(1);
    expect(await runCli(['start', 'does-not-exist'])).toBe(1);
  });

  it('exits 1 when start is given a path that is not a directory', async () => {
    const directory = await makeTempDirectory();
    const file = path.join(directory, 'main.flow');
    await writeFile(file, '---\nname: T\n---\n\nStart\n');
    expect(await runCli(['start', file])).toBe(1);
  });

  it('exits 1 when the requested port is already in use', async () => {
    const workspace = await makeTempDirectory();
    await writeFile(path.join(workspace, 'main.flow'), '---\nname: T\n---\n\nStart\n');
    const server = await startServer({ workspaceRoot: workspace, port: 0, host: '127.0.0.1' });
    servers.push(server);
    expect(await runCli(['start', workspace, '--port', String(server.port)])).toBe(1);
  });
});
