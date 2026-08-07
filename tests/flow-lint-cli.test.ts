import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runFlowLint } from '../src/tools/flow-lint.js';

const tempDirectories: string[] = [];

async function makeWorkspace(text: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grafd-lint-'));
  tempDirectories.push(directory);
  await writeFile(path.join(directory, 'main.flow'), text);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runFlowLint', () => {
  it('returns 0 for --help and 2 for invalid options', async () => {
    expect(await runFlowLint(['--help'])).toBe(0);
    expect(await runFlowLint(['--bogus'])).toBe(2);
  });

  it('returns 0 for a clean workspace and 1 for errors', async () => {
    const clean = await makeWorkspace('---\nname: Clean\n---\n\nStart\n');
    expect(await runFlowLint([clean])).toBe(0);

    const broken = await makeWorkspace('Start\n');
    expect(await runFlowLint([broken])).toBe(1);
  });
});
