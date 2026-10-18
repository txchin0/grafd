import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SKILL_NAME = 'grafd-diagrams';
const SKILL_FILE_NAME = 'SKILL.md';
const SKILL_SOURCE_URL = new URL(`../.claude/skills/${SKILL_NAME}/${SKILL_FILE_NAME}`, import.meta.url);

// The skill as it reads inside this repo. An installed copy runs in other repos, against the
// published package, so this binding is swapped for one pinned to the version that installed it:
// the flags the skill names are then always the flags that CLI has.
export const SOURCE_COMMAND_BINDING = '`grafd` = `npx --yes grafd-ai` (inside the grafd repo itself: `node dist/cli-main.js`)';

// Every agent that reads the shared Agent Skills folder (Codex, Cursor, OpenCode, Gemini CLI,
// Copilot) looks in ~/.agents/skills; Claude Code reads only its own config directory.
const SHARED_AGENTS_DIRECTORY = '.agents';
const CLAUDE_DIRECTORY = '.claude';
const SKILLS_DIRECTORY = 'skills';

export interface SkillInstallLocation {
  home: string;
  // CLAUDE_CONFIG_DIR, when Claude Code's config lives somewhere other than ~/.claude.
  claudeConfigDir?: string;
}

export type InstallOutcome = 'created' | 'updated' | 'unchanged';
export type RemoveOutcome = 'removed' | 'absent';

export interface SkillTargetResult<Outcome> {
  file: string;
  outcome: Outcome;
}

export function commandBindingFor(version: string): string {
  return `\`grafd\` = \`npx --yes grafd-ai@${version}\``;
}

export function installedSkillText(source: string, version: string): string {
  const occurrences = source.split(SOURCE_COMMAND_BINDING).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${SKILL_FILE_NAME} must name the grafd command exactly once (found ${occurrences})`);
  }
  return source.replace(SOURCE_COMMAND_BINDING, commandBindingFor(version));
}

export async function readSkillSource(): Promise<string> {
  return readFile(SKILL_SOURCE_URL, 'utf8');
}

// Claude Code's folder is used only when Claude Code is already there: installing never creates
// a config directory for an agent the user does not run.
export async function skillInstallTargets(location: SkillInstallLocation): Promise<string[]> {
  const sharedSkills = path.join(location.home, SHARED_AGENTS_DIRECTORY, SKILLS_DIRECTORY);
  const targets = [skillFileIn(sharedSkills)];
  const claudeDirectory = location.claudeConfigDir ?? path.join(location.home, CLAUDE_DIRECTORY);
  if (await isDirectory(claudeDirectory)) targets.push(skillFileIn(path.join(claudeDirectory, SKILLS_DIRECTORY)));
  return targets;
}

export async function installSkill(
  location: SkillInstallLocation,
  version: string,
): Promise<SkillTargetResult<InstallOutcome>[]> {
  const text = installedSkillText(await readSkillSource(), version);
  const results: SkillTargetResult<InstallOutcome>[] = [];
  for (const file of await skillInstallTargets(location)) {
    results.push({ file, outcome: await writeSkillFile(file, text) });
  }
  return results;
}

export async function removeSkill(location: SkillInstallLocation): Promise<SkillTargetResult<RemoveOutcome>[]> {
  const results: SkillTargetResult<RemoveOutcome>[] = [];
  for (const file of await skillInstallTargets(location)) {
    const skillDirectory = path.dirname(file);
    const existed = await isDirectory(skillDirectory);
    if (existed) await rm(skillDirectory, { recursive: true, force: true });
    results.push({ file, outcome: existed ? 'removed' : 'absent' });
  }
  return results;
}

function skillFileIn(skillsDirectory: string): string {
  return path.join(skillsDirectory, SKILL_NAME, SKILL_FILE_NAME);
}

async function writeSkillFile(file: string, text: string): Promise<InstallOutcome> {
  const previous = await readFile(file, 'utf8').catch(() => null);
  if (previous === text) return 'unchanged';
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return previous === null ? 'created' : 'updated';
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}
