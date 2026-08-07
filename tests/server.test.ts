import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type StartedServer } from '../src/server/server.js';

const servers: StartedServer[] = [];
const tempDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grafd-server-'));
  tempDirectories.push(directory);
  await writeFile(path.join(directory, 'main.flow'), '---\nname: T\n---\n\nStart\n');
  return directory;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('startServer', () => {
  it('serves the workspace, guide, and roughjs bundle, then closes cleanly', async () => {
    const workspace = await makeWorkspace();
    const server = await startServer({ workspaceRoot: workspace, port: 0, host: '127.0.0.1' });
    servers.push(server);

    const filesResponse = await fetch(`${server.url}/api/files`);
    expect(filesResponse.ok).toBe(true);
    expect(await filesResponse.json()).toEqual({ files: ['main.flow'] });

    const guideResponse = await fetch(`${server.url}/SAVE-GUIDE.md`);
    expect(guideResponse.ok).toBe(true);
    expect(await guideResponse.text()).toContain('.flow Format Guide');

    const roughResponse = await fetch(`${server.url}/vendor/roughjs/rough.esm.js`);
    expect(roughResponse.ok).toBe(true);
    expect((await roughResponse.text()).length).toBeGreaterThan(0);

    await server.close();
    const index = servers.indexOf(server);
    if (index >= 0) servers.splice(index, 1);

    let refused = false;
    try {
      const response = await fetch(`${server.url}/api/files`);
      refused = !response.ok;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it('closes even while a client is connected', async () => {
    const workspace = await makeWorkspace();
    const server = await startServer({ workspaceRoot: workspace, port: 0, host: '127.0.0.1' });
    servers.push(server);

    const client = new WebSocket(server.url.replace('http://', 'ws://'));
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', () => reject(new Error('websocket connection failed')));
    });

    await server.close();
    const index = servers.indexOf(server);
    if (index >= 0) servers.splice(index, 1);
  });

  it('rejects with EADDRINUSE when the port is already taken', async () => {
    const workspace = await makeWorkspace();
    const first = await startServer({ workspaceRoot: workspace, port: 0, host: '127.0.0.1' });
    servers.push(first);

    await expect(
      startServer({ workspaceRoot: workspace, port: first.port, host: '127.0.0.1' }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
