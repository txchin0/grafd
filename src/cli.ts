import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from './server/server.js';
import { emptyManifest, MANIFEST_FILE_NAME, serializeManifest } from './shared/manifest.js';
import { installSkill, removeSkill, SKILL_NAME, type SkillInstallLocation } from './skill-install.js';
import { runFlowLayout } from './tools/flow-layout.js';
import { runFlowLint } from './tools/flow-lint.js';
import { runFlowRender } from './tools/flow-render.js';
import { runFlowScore } from './tools/flow-score.js';
import { runFlowStyle } from './tools/flow-style.js';

const require = createRequire(import.meta.url);
const GUIDE_SOURCE_URL = new URL('../SAVE-GUIDE.md', import.meta.url);

const DEFAULT_WORKSPACE_DIR = '.grafd';
const MAIN_FLOW_TEMPLATE = `---
name: My Flow
---

Start
`;

export interface StartArgs {
  workspace: string | null;
  port?: number;
  host?: string;
  projectRoot?: string;
  open: boolean;
  dev: boolean;
}

export type StartParseResult = StartArgs | { help: true } | { error: string };

export function readPackageVersion(): string {
  return (require('../package.json') as { version: string }).version;
}

interface ValuedFlag {
  value: string;
  consumed: number; // 1 when the value was the next argument, 0 for --name=value
}

// Reads a flag that takes a value in either spelling, --name value or --name=value.
function readValuedFlag(argv: string[], index: number, name: string): ValuedFlag | 'missing-value' | null {
  const argument = argv[index];
  if (argument === name) {
    const value = argv[index + 1];
    return value === undefined ? 'missing-value' : { value, consumed: 1 };
  }
  if (argument.startsWith(`${name}=`)) return { value: argument.slice(name.length + 1), consumed: 0 };
  return null;
}

export function parseStartArgs(argv: string[]): StartParseResult {
  const options: StartArgs = { workspace: null, open: false, dev: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--open') {
      options.open = true;
      continue;
    }
    if (argument === '--dev') {
      options.dev = true;
      continue;
    }
    const portFlag = readValuedFlag(argv, index, '--port');
    if (portFlag !== null) {
      if (portFlag === 'missing-value') return { error: '--port requires a value' };
      const value = Number(portFlag.value);
      if (!Number.isInteger(value) || value < 0 || value > 65535) return { error: `Invalid port: ${portFlag.value}` };
      options.port = value;
      index += portFlag.consumed;
      continue;
    }
    const hostFlag = readValuedFlag(argv, index, '--host');
    if (hostFlag !== null) {
      if (hostFlag === 'missing-value' || hostFlag.value === '') return { error: '--host requires a value' };
      options.host = hostFlag.value;
      index += hostFlag.consumed;
      continue;
    }
    const projectRootFlag = readValuedFlag(argv, index, '--project-root');
    if (projectRootFlag !== null) {
      if (projectRootFlag === 'missing-value' || projectRootFlag.value === '')
        return { error: '--project-root requires a value' };
      options.projectRoot = projectRootFlag.value;
      index += projectRootFlag.consumed;
      continue;
    }
    if (argument.startsWith('-')) return { error: `Unknown option: ${argument}` };
    if (options.workspace !== null) return { error: 'Only one workspace path may be passed to start' };
    options.workspace = argument;
  }
  return options;
}

async function directoryHasManifest(directory: string): Promise<boolean> {
  try {
    const info = await stat(path.join(directory, MANIFEST_FILE_NAME));
    return info.isFile();
  } catch {
    return false;
  }
}

export async function resolveDefaultWorkspace(cwd: string): Promise<string | null> {
  const grafdDirectory = path.join(cwd, DEFAULT_WORKSPACE_DIR);
  if (await directoryHasManifest(grafdDirectory)) return grafdDirectory;
  if (await directoryHasManifest(cwd)) return cwd;
  return null;
}

// Resolves the workspace a command will operate on: the explicitly passed path, else the
// given fallback, else a directory under cwd that contains grafd.manifest.json. Reports the
// hint and returns null when none of those exist.
async function resolveWorkspace(cwd: string, explicit: string | null, fallback: string | null): Promise<string | null> {
  const workspace = explicit !== null ? path.resolve(cwd, explicit) : fallback ?? (await resolveDefaultWorkspace(cwd));
  if (workspace === null) {
    console.error("No workspace found. Run 'grafd init' or pass a workspace path.");
    return null;
  }
  return workspace;
}

export interface InitResult {
  created: string[];
  existing: string[];
}

export async function initWorkspace(cwd: string): Promise<InitResult> {
  const target = path.join(cwd, DEFAULT_WORKSPACE_DIR);
  await mkdir(target, { recursive: true });
  const entries = [
    { path: path.join(target, 'main.flow'), content: MAIN_FLOW_TEMPLATE },
    {
      path: path.join(target, MANIFEST_FILE_NAME),
      content: serializeManifest({ ...emptyManifest(), entrypoint: 'main.flow' }),
    },
    { path: path.join(target, 'SAVE-GUIDE.md'), content: await readFile(GUIDE_SOURCE_URL, 'utf8') },
  ];
  const created: string[] = [];
  const existing: string[] = [];
  for (const entry of entries) {
    try {
      await writeFile(entry.path, entry.content, { flag: 'wx' });
      created.push(entry.path);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') existing.push(entry.path);
      else throw error;
    }
  }
  return { created, existing };
}

async function runInit(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printInitHelp();
    return 0;
  }
  if (args.length > 0) {
    console.error(`Unknown option: ${args[0]}`);
    printInitHelp();
    return 2;
  }
  try {
    const result = await initWorkspace(process.cwd());
    for (const file of result.created) console.log(`Created ${displayPath(file)}`);
    for (const file of result.existing) console.log(`Already exists ${displayPath(file)}`);
    return 0;
  } catch (error) {
    console.error(`Could not initialize ${DEFAULT_WORKSPACE_DIR}/: ${errorMessage(error)}`);
    return 1;
  }
}

async function runInstall(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printInstallHelp();
    return 0;
  }
  const unknown = args.find((argument) => argument !== '--remove');
  if (unknown !== undefined) {
    console.error(`Unknown option: ${unknown}`);
    printInstallHelp();
    return 2;
  }
  const removing = args.includes('--remove');
  try {
    if (removing) await reportSkillRemoval(userSkillLocation());
    else await reportSkillInstall(userSkillLocation(), readPackageVersion());
    return 0;
  } catch (error) {
    console.error(`Could not ${removing ? 'remove' : 'install'} the ${SKILL_NAME} skill: ${errorMessage(error)}`);
    return 1;
  }
}

function userSkillLocation(): SkillInstallLocation {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  return { home: os.homedir(), claudeConfigDir: claudeConfigDir === '' ? undefined : claudeConfigDir };
}

const INSTALL_OUTCOME_LABELS = { created: 'Installed', updated: 'Updated', unchanged: 'Already up to date' } as const;

async function reportSkillInstall(location: SkillInstallLocation, version: string): Promise<void> {
  for (const { file, outcome } of await installSkill(location, version)) {
    console.log(`${INSTALL_OUTCOME_LABELS[outcome]} ${file} (grafd-ai@${version})`);
  }
  console.log('Agents pick up the skill in their next session, in any repository.');
}

async function reportSkillRemoval(location: SkillInstallLocation): Promise<void> {
  for (const { file, outcome } of await removeSkill(location)) {
    console.log(`${outcome === 'removed' ? 'Removed' : 'Not installed'} ${file}`);
  }
}

export interface StartContext {
  // Fallback workspace when no path argument is given; null resolves a manifest-bearing
  // directory instead.
  defaultWorkspace?: string | null;
}

export async function runStart(args: string[], { defaultWorkspace = null }: StartContext = {}): Promise<number> {
  const parsed = parseStartArgs(args);
  if ('help' in parsed) {
    printStartHelp();
    return 0;
  }
  if ('error' in parsed) {
    console.error(parsed.error);
    printStartHelp();
    return 2;
  }

  const workspace = await resolveWorkspace(process.cwd(), parsed.workspace, defaultWorkspace);
  if (workspace === null) return 1;
  try {
    const info = await stat(workspace);
    if (!info.isDirectory()) {
      console.error(`Workspace is not a directory: ${workspace}`);
      return 1;
    }
  } catch {
    console.error(`Workspace not found: ${workspace}`);
    return 1;
  }

  const requestedPort = resolveRequestedPort(parsed.port);
  try {
    const server = await startServer({
      workspaceRoot: workspace,
      projectRoot: parsed.projectRoot,
      port: requestedPort,
      host: parsed.host,
      dev: parsed.dev,
    });
    if (parsed.open) openBrowser(server.url);
    const shutdown = async (): Promise<void> => {
      await server.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    return 0;
  } catch (error) {
    if (errorCode(error) === 'EADDRINUSE') {
      console.error(`Port ${requestedPort} is already in use. Use --port to choose another.`);
    } else {
      console.error(`Failed to start: ${errorMessage(error)}`);
    }
    return 1;
  }
}

function resolveRequestedPort(parsedPort: number | undefined): number {
  if (parsedPort !== undefined) return parsedPort;
  if (process.env.PORT !== undefined && process.env.PORT !== '') return Number(process.env.PORT);
  return DEFAULT_PORT;
}

async function runLint(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printLintHelp();
    return 0;
  }
  const hasWorkspace = args.some((argument) => !argument.startsWith('-'));
  if (!hasWorkspace) {
    const workspace = await resolveWorkspace(process.cwd(), null, null);
    if (workspace === null) return 1;
    args = [workspace, ...args];
  }
  try {
    return await runFlowLint(args);
  } catch (error) {
    console.error(`Lint failed: ${errorMessage(error)}`);
    return 1;
  }
}

async function runLayout(args: string[]): Promise<number> {
  return runWorkspaceTool(args, runFlowLayout, 'Layout');
}

async function runScore(args: string[]): Promise<number> {
  return runWorkspaceTool(args, runFlowScore, 'Scoring');
}

// A tool over workspace directories, run in the resolved default workspace when none is named.
async function runWorkspaceTool(args: string[], tool: (argv: string[]) => Promise<number>, name: string): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) return tool(['--help']);
  const hasWorkspace = args.some((argument) => !argument.startsWith('-'));
  if (!hasWorkspace) {
    const workspace = await resolveWorkspace(process.cwd(), null, null);
    if (workspace === null) return 1;
    args = [workspace, ...args];
  }
  return runReportingFailure(args, tool, name);
}

// A tool's failure reported as one line and an exit code, never as an unhandled rejection.
async function runReportingFailure(args: string[], tool: (argv: string[]) => Promise<number>, name: string): Promise<number> {
  try {
    return await tool(args);
  } catch (error) {
    console.error(`${name} failed: ${errorMessage(error)}`);
    return 1;
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', (error) => console.warn(`Could not open the browser: ${error.message}`));
  child.unref();
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv.length === 0) return runStart(argv);
  if (argv[0] === '--help' || argv[0] === '-h') {
    printGlobalHelp();
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(readPackageVersion());
    return 0;
  }
  if (argv[0].startsWith('-')) {
    console.error(`Unknown option: ${argv[0]}`);
    printGlobalHelp();
    return 2;
  }
  switch (argv[0]) {
    case 'init':
      return runInit(argv.slice(1));
    case 'install':
      return runInstall(argv.slice(1));
    case 'start':
      return runStart(argv.slice(1));
    case 'lint':
      return runLint(argv.slice(1));
    case 'layout':
      return runLayout(argv.slice(1));
    case 'score':
      return runScore(argv.slice(1));
    case 'render':
      return runReportingFailure(argv.slice(1), runFlowRender, 'Rendering');
    case 'style':
      return runReportingFailure(argv.slice(1), runFlowStyle, 'Styling');
    default:
      console.error(`Unknown command: ${argv[0]}`);
      printGlobalHelp();
      return 2;
  }
}

function printGlobalHelp(): void {
  console.log(`Usage: grafd [command] [options]

Commands:
  init       Create ${DEFAULT_WORKSPACE_DIR}/ with main.flow, grafd.manifest.json, and SAVE-GUIDE.md
  install    Install the ${SKILL_NAME} agent skill for your user, so agents in any repository can diagram
  start      Run the editor server (default command; defaults to ${DEFAULT_HOST}:${DEFAULT_PORT})
  lint       Lint .flow workspaces
  layout     Place nodes that have no position, or lay every graph out afresh with --all
  score      Score how readable each graph is, with the fix for everything that costs it points
  render     Draw a graph to a PNG as the editor shows it
  style      Style a graph's nodes by their roles (start, decision, datastore…) in its canvas layer

Run 'grafd <command> --help' for command options.`);
}

function printInitHelp(): void {
  console.log(`Usage: grafd init

Creates ${DEFAULT_WORKSPACE_DIR}/main.flow, ${DEFAULT_WORKSPACE_DIR}/${MANIFEST_FILE_NAME}, and
${DEFAULT_WORKSPACE_DIR}/SAVE-GUIDE.md. Existing files are left untouched.`);
}

function printInstallHelp(): void {
  console.log(`Usage: grafd install [--remove]

Installs the ${SKILL_NAME} skill for your user: ~/.agents/skills/${SKILL_NAME}/, which Codex,
Cursor, OpenCode, Gemini CLI and Copilot read, and Claude Code's skills folder when Claude Code is
set up (~/.claude, or CLAUDE_CONFIG_DIR). The skill teaches an agent to set up a workspace and draw
a readable diagram in any repository, using this version of grafd. Run it again from a newer
version to update the skill.

Options:
  --remove   remove the skill from those folders
  --help     show this message`);
}

function printStartHelp(): void {
  console.log(`Usage: grafd start [workspace] [options]

Starts the Grafd editor server. With no workspace, uses ${DEFAULT_WORKSPACE_DIR}/ or the current
directory when either contains ${MANIFEST_FILE_NAME}.

Options:
  --port=<n>             port to bind (default: ${DEFAULT_PORT}, or the PORT environment variable)
  --host=<host>          host to bind (default: ${DEFAULT_HOST})
  --open                 open the editor in the default browser after starting
  --dev                  watch compiled output and reload browsers on change
  --project-root=<path>  project root for file references (default: current directory)
  --help                 show this message`);
}

function printLintHelp(): void {
  console.log(`Usage: grafd lint [workspace…] [options]

Lints every .flow file in each workspace directory. With no workspace, uses ${DEFAULT_WORKSPACE_DIR}/
or the current directory when either contains ${MANIFEST_FILE_NAME}.

Options:
  --strict         exit non-zero on warnings as well as errors
  --format=json    emit diagnostics as JSON instead of text
  --help           show this message`);
}

function displayPath(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
