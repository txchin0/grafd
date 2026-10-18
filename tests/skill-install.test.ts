import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPackageVersion, runCli } from '../src/cli.js';
import {
  commandBindingFor,
  installedSkillText,
  installSkill,
  readSkillSource,
  removeSkill,
  SKILL_NAME,
  SOURCE_COMMAND_BINDING,
} from '../src/skill-install.js';

const VERSION = '9.8.7';
const tempDirectories: string[] = [];

async function makeHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'grafd-home-'));
  tempDirectories.push(home);
  return home;
}

function sharedSkillFile(home: string): string {
  return path.join(home, '.agents', 'skills', SKILL_NAME, 'SKILL.md');
}

function claudeSkillFile(claudeDirectory: string): string {
  return path.join(claudeDirectory, 'skills', SKILL_NAME, 'SKILL.md');
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('the skill source', () => {
  it('names the grafd command exactly once, so an install can pin it', async () => {
    const source = await readSkillSource();
    expect(source.split(SOURCE_COMMAND_BINDING)).toHaveLength(2);
  });

  it('is named after its folder, as Agent Skills requires', async () => {
    expect(await readSkillSource()).toMatch(new RegExp(`^---\\r?\\nname: ${SKILL_NAME}\\r?\\n`));
  });
});

describe('installedSkillText', () => {
  it('pins the command to the installing version', async () => {
    const installed = installedSkillText(await readSkillSource(), VERSION);
    expect(installed).toContain(commandBindingFor(VERSION));
    expect(installed).not.toContain(SOURCE_COMMAND_BINDING);
  });

  it('refuses a skill that does not name the command exactly once', () => {
    expect(() => installedSkillText('no binding here', VERSION)).toThrow();
    expect(() => installedSkillText(`${SOURCE_COMMAND_BINDING}\n${SOURCE_COMMAND_BINDING}`, VERSION)).toThrow();
  });
});

describe('installSkill', () => {
  it('installs into the shared agents folder and leaves an absent Claude folder absent', async () => {
    const home = await makeHome();
    const results = await installSkill({ home }, VERSION);
    expect(results).toEqual([{ file: sharedSkillFile(home), outcome: 'created' }]);
    expect(await readFile(sharedSkillFile(home), 'utf8')).toContain(commandBindingFor(VERSION));
    expect(await exists(path.join(home, '.claude'))).toBe(false);
  });

  it('also installs for Claude Code when its folder exists', async () => {
    const home = await makeHome();
    await mkdir(path.join(home, '.claude'));
    const results = await installSkill({ home }, VERSION);
    expect(results.map((result) => result.file)).toEqual([
      sharedSkillFile(home),
      claudeSkillFile(path.join(home, '.claude')),
    ]);
  });

  it("uses Claude Code's configured folder in place of ~/.claude", async () => {
    const home = await makeHome();
    const configured = path.join(home, 'claude-config');
    await mkdir(configured);
    await mkdir(path.join(home, '.claude'));
    const results = await installSkill({ home, claudeConfigDir: configured }, VERSION);
    expect(results.map((result) => result.file)).toEqual([sharedSkillFile(home), claudeSkillFile(configured)]);
  });

  it('reports an identical copy as unchanged and rewrites a stale one', async () => {
    const home = await makeHome();
    await installSkill({ home }, VERSION);
    expect(await installSkill({ home }, VERSION)).toEqual([{ file: sharedSkillFile(home), outcome: 'unchanged' }]);

    await writeFile(sharedSkillFile(home), 'an older skill\n');
    expect(await installSkill({ home }, VERSION)).toEqual([{ file: sharedSkillFile(home), outcome: 'updated' }]);
    expect(await readFile(sharedSkillFile(home), 'utf8')).toContain(commandBindingFor(VERSION));
  });
});

describe('removeSkill', () => {
  it('removes only this skill and reports a second removal as absent', async () => {
    const home = await makeHome();
    const neighbour = path.join(home, '.agents', 'skills', 'other-skill', 'SKILL.md');
    await mkdir(path.dirname(neighbour), { recursive: true });
    await writeFile(neighbour, 'someone else\n');
    await installSkill({ home }, VERSION);

    expect(await removeSkill({ home })).toEqual([{ file: sharedSkillFile(home), outcome: 'removed' }]);
    expect(await exists(path.dirname(sharedSkillFile(home)))).toBe(false);
    expect(await readFile(neighbour, 'utf8')).toBe('someone else\n');
    expect(await removeSkill({ home })).toEqual([{ file: sharedSkillFile(home), outcome: 'absent' }]);
  });
});

describe('grafd install', () => {
  function stubHome(home: string): void {
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  }

  it('installs the skill pinned to this package and removes it with --remove', async () => {
    const home = await makeHome();
    stubHome(home);
    expect(await runCli(['install'])).toBe(0);
    expect(await readFile(sharedSkillFile(home), 'utf8')).toContain(commandBindingFor(readPackageVersion()));
    expect(await runCli(['install', '--remove'])).toBe(0);
    expect(await exists(sharedSkillFile(home))).toBe(false);
  });

  it('rejects unknown options with exit code 2', async () => {
    const home = await makeHome();
    stubHome(home);
    expect(await runCli(['install', '--bogus'])).toBe(2);
    expect(await exists(sharedSkillFile(home))).toBe(false);
  });
});
