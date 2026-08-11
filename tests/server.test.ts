import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function openSocket(server: StartedServer): Promise<WebSocket> {
  const client = new WebSocket(server.url.replace('http://', 'ws://'));
  return new Promise((resolve, reject) => {
    client.once('open', () => resolve(client));
    client.once('error', () => reject(new Error('websocket connection failed')));
  });
}

function waitForFiles(client: WebSocket, predicate: (files: string[]) => boolean): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for a files message')), 3000);
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as { type?: string; files?: string[] };
      if (message.type === 'files' && predicate(message.files ?? [])) {
        clearTimeout(timeout);
        client.off('message', listener);
        resolve(message.files!);
      }
    };
    client.on('message', listener);
  });
}

function waitForRenameResult(client: WebSocket): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for a rename result')), 3000);
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as { type?: string; ok?: boolean };
      if (message.type === 'rename-result') {
        clearTimeout(timeout);
        client.off('message', listener);
        resolve(message.ok ?? false);
      }
    };
    client.on('message', listener);
  });
}

function waitForRenameMessage(client: WebSocket): Promise<{ from: string; to: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for a rename broadcast')), 3000);
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as { type?: string; from?: string; to?: string };
      if (message.type === 'rename') {
        clearTimeout(timeout);
        client.off('message', listener);
        resolve({ from: message.from!, to: message.to! });
      }
    };
    client.on('message', listener);
  });
}

async function filesAt(server: StartedServer): Promise<string[]> {
  const response = await fetch(`${server.url}/api/files`);
  return ((await response.json()) as { files: string[] }).files;
}

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

describe('websocket rename', () => {
  it('renames a flow file on disk and broadcasts the updated list', async () => {
    const workspace = await makeWorkspace();
    const server = await startServer({ workspaceRoot: workspace, port: 0, host: '127.0.0.1' });
    servers.push(server);
    const client = await openSocket(server);
    // The watcher may broadcast the list more than once around the rename, so the test only
    // asserts that a list containing the new name arrives.
    const listPromise = waitForFiles(client, (files) => files.includes('renamed.flow'));
    const resultPromise = waitForRenameResult(client);
    client.send(JSON.stringify({ type: 'rename', from: 'main.flow', to: 'renamed.flow' }));
    const files = await listPromise;
    expect(await resultPromise).toBe(true);
    expect(files).not.toContain('main.flow');

    const content = await fetch(`${server.url}/api/file?path=${encodeURIComponent('renamed.flow')}`);
    expect(content.ok).toBe(true);
    expect(((await content.json()) as { text: string }).text).toContain('name: T');
    const gone = await fetch(`${server.url}/api/file?path=${encodeURIComponent('main.flow')}`);
    expect(gone.status).toBe(404);
  });

  it('supports a case-only rename', async () => {
    const workspace = await makeWorkspace();
    const server = await startServer({ workspaceRoot: workspace, port: 0, host: '127.0.0.1' });
    servers.push(server);
    const client = await openSocket(server);
    const listPromise = waitForFiles(client, (files) => files.includes('Main.flow'));
    const resultPromise = waitForRenameResult(client);
    client.send(JSON.stringify({ type: 'rename', from: 'main.flow', to: 'Main.flow' }));
    await listPromise;
    expect(await resultPromise).toBe(true);
    const content = await fetch(`${server.url}/api/file?path=${encodeURIComponent('Main.flow')}`);
    expect(content.ok).toBe(true);
  });

  it('renames a file inside a subfolder and broadcasts the updated list', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'grafd-server-'));
    tempDirectories.push(directory);
    await mkdir(path.join(directory, 'auth'));
    await writeFile(path.join(directory, 'auth', 'login.flow'), 'Login\n');
    const server = await startServer({ workspaceRoot: directory, port: 0, host: '127.0.0.1' });
    servers.push(server);
    const client = await openSocket(server);
    const listPromise = waitForFiles(client, (files) => files.includes('auth/signin.flow'));
    const resultPromise = waitForRenameResult(client);
    client.send(JSON.stringify({ type: 'rename', from: 'auth/login.flow', to: 'auth/signin.flow' }));
    const files = await listPromise;
    expect(await resultPromise).toBe(true);
    expect(files).not.toContain('auth/login.flow');

    const content = await fetch(`${server.url}/api/file?path=${encodeURIComponent('auth/signin.flow')}`);
    expect(content.ok).toBe(true);
    expect(((await content.json()) as { text: string }).text).toBe('Login\n');
  });

  it('ignores a rename whose source is missing', async () => {
    const workspace = await makeWorkspace();
    const server = await startServer({ workspaceRoot: workspace, port: 0, host: '127.0.0.1' });
    servers.push(server);
    const client = await openSocket(server);
    client.send(JSON.stringify({ type: 'rename', from: 'missing.flow', to: 'new.flow' }));
    expect(await waitForRenameResult(client)).toBe(false);
    expect(await filesAt(server)).toEqual(['main.flow']);
  });

  it('refuses to overwrite an existing target', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'grafd-server-'));
    tempDirectories.push(directory);
    await writeFile(path.join(directory, 'a.flow'), 'A\n');
    await writeFile(path.join(directory, 'b.flow'), 'B\n');
    const server = await startServer({ workspaceRoot: directory, port: 0, host: '127.0.0.1' });
    servers.push(server);
    const client = await openSocket(server);
    client.send(JSON.stringify({ type: 'rename', from: 'a.flow', to: 'b.flow' }));
    expect(await waitForRenameResult(client)).toBe(false);
    expect(await filesAt(server)).toEqual(['a.flow', 'b.flow']);
    const response = await fetch(`${server.url}/api/file?path=b.flow`);
    expect(((await response.json()) as { text: string }).text).toBe('B\n');
  });

  it('rejects rename paths outside the workspace root', async () => {
    const workspace = await makeWorkspace();
    const server = await startServer({ workspaceRoot: workspace, port: 0, host: '127.0.0.1' });
    servers.push(server);
    const client = await openSocket(server);
    client.send(JSON.stringify({ type: 'rename', from: 'main.flow', to: '../evil.flow' }));
    expect(await waitForRenameResult(client)).toBe(false);
    expect(await filesAt(server)).toEqual(['main.flow']);
  });

  it('broadcasts the rename to other clients', async () => {
    const workspace = await makeWorkspace();
    const server = await startServer({ workspaceRoot: workspace, port: 0, host: '127.0.0.1' });
    servers.push(server);
    const renamer = await openSocket(server);
    const observer = await openSocket(server);
    const renameMessage = waitForRenameMessage(observer);
    const listPromise = waitForFiles(observer, (files) => files.includes('renamed.flow'));
    renamer.send(JSON.stringify({ type: 'rename', from: 'main.flow', to: 'renamed.flow' }));
    expect(await waitForRenameResult(renamer)).toBe(true);
    expect(await renameMessage).toEqual({ from: 'main.flow', to: 'renamed.flow' });
    expect(await listPromise).toContain('renamed.flow');
  });

  it('refuses to rename onto or away from the manifest', async () => {
    const workspace = await makeWorkspace();
    const server = await startServer({ workspaceRoot: workspace, port: 0, host: '127.0.0.1' });
    servers.push(server);
    const client = await openSocket(server);
    client.send(JSON.stringify({ type: 'rename', from: 'main.flow', to: 'grafd.manifest.json' }));
    expect(await waitForRenameResult(client)).toBe(false);
    client.send(JSON.stringify({ type: 'rename', from: 'grafd.manifest.json', to: 'main.flow' }));
    expect(await waitForRenameResult(client)).toBe(false);
    expect(await filesAt(server)).toEqual(['main.flow']);
  });

  it('refuses to move a directory whose name ends in .flow', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'grafd-server-'));
    tempDirectories.push(directory);
    await mkdir(path.join(directory, 'dir.flow'));
    await writeFile(path.join(directory, 'dir.flow', 'inner.flow'), '---\nname: Inner\n---\n');
    const server = await startServer({ workspaceRoot: directory, port: 0, host: '127.0.0.1' });
    servers.push(server);
    const client = await openSocket(server);
    client.send(JSON.stringify({ type: 'rename', from: 'dir.flow', to: 'dir2.flow' }));
    expect(await waitForRenameResult(client)).toBe(false);
    expect(await filesAt(server)).toEqual(['dir.flow/inner.flow']);
  });
});
