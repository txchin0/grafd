// Command line entry point for the .flow linter: `node dist/tools/flow-lint.js [workspace…]`.
//
// A workspace is a directory of .flow files with an optional grafd.manifest.json at its root —
// the same shape the server watches — because the cross-file rules need the whole set to
// resolve `expand` links against.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listFlowFiles } from '../server/flow-files.js';
import { countDiagnostics, type FileDiagnostics } from '../shared/flow-diagnostics.js';
import { lintWorkspace, type WorkspaceFile } from '../shared/flow-lint-workspace.js';
import { MANIFEST_FILE_NAME, parseManifest } from '../shared/manifest.js';

interface Options {
  roots: string[];
  strict: boolean;
  format: 'text' | 'json';
}

const DEFAULT_WORKSPACE = '.grafd';
const USAGE = `Usage: grafd lint [workspace…] [options]

Lints every .flow file in each workspace directory (default: ${DEFAULT_WORKSPACE}).

Options:
  --strict         exit non-zero on warnings as well as errors
  --format=json    emit diagnostics as JSON instead of text
  --help           show this message`;

export async function runFlowLint(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options === 'help' || options === 'invalid') {
    console.log(USAGE);
    return options === 'help' ? 0 : 2;
  }

  const results: FileDiagnostics[] = [];
  for (const root of options.roots) {
    results.push(...(await lintWorkspaceDirectory(root)));
  }

  const counts = countDiagnostics(results);
  if (options.format === 'json') console.log(JSON.stringify({ files: results, ...counts }, null, 2));
  else printReport(results, counts.errors, counts.warnings);

  return counts.errors > 0 || (options.strict && counts.warnings > 0) ? 1 : 0;
}

function parseOptions(argv: string[]): Options | 'help' | 'invalid' {
  const options: Options = { roots: [], strict: false, format: 'text' };
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') return 'help';
    else if (argument === '--strict') options.strict = true;
    else if (argument === '--format=json') options.format = 'json';
    else if (argument === '--format=text') options.format = 'text';
    else if (argument.startsWith('-')) return 'invalid';
    else options.roots.push(argument);
  }
  if (options.roots.length === 0) options.roots.push(DEFAULT_WORKSPACE);
  return options;
}

async function lintWorkspaceDirectory(root: string): Promise<FileDiagnostics[]> {
  const absoluteRoot = path.resolve(root);
  const relativePaths = await listFlowFiles(absoluteRoot);
  const files: WorkspaceFile[] = await Promise.all(
    relativePaths.map(async (relativePath) => ({
      path: relativePath,
      text: await readFile(path.join(absoluteRoot, relativePath), 'utf8'),
    })),
  );

  const results = lintWorkspace({ files, manifest: await readWorkspaceManifest(absoluteRoot) });
  return results.map((result) => ({ ...result, path: displayPath(root, result.path) }));
}

async function readWorkspaceManifest(absoluteRoot: string) {
  try {
    return parseManifest(await readFile(path.join(absoluteRoot, MANIFEST_FILE_NAME), 'utf8'));
  } catch {
    return null;
  }
}

function displayPath(root: string, workspacePath: string): string {
  return path.join(root, workspacePath).split(path.sep).join('/');
}

function printReport(results: FileDiagnostics[], errors: number, warnings: number): void {
  const locationWidth = Math.max(
    0,
    ...results.flatMap((file) => file.diagnostics.map((diagnostic) => `${file.path}:${diagnostic.line}`.length)),
  );

  for (const file of results) {
    if (file.diagnostics.length === 0) continue;
    console.log('');
    for (const diagnostic of file.diagnostics) {
      const location = `${file.path}:${diagnostic.line}`.padEnd(locationWidth);
      console.log(`${location}  ${diagnostic.severity.padEnd(7)} ${diagnostic.rule}  ${diagnostic.message}`);
    }
  }
  console.log(`\n${describe(errors, 'error')}, ${describe(warnings, 'warning')} in ${results.length} files`);
}

function describe(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
