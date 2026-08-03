// Command line entry point for importing a VS Code color theme into Grafd:
// `node dist/tools/theme-import.js path/to/theme.color-theme.json`.
//
// A Grafd theme is one `:root[data-theme="…"]` block in public/themes.css plus one entry in
// the THEMES registry in src/client/theme.ts — the two places a theme exists — so this tool
// edits exactly those two files. The id is derived from the theme's "name"; importing a theme
// whose id already exists fails rather than silently replacing the block, because a re-import
// would discard any manual tuning made since.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveThemeId,
  mapThemeToTokens,
  renderThemeBlock,
  stripJsonComments,
  type VscodeColorTheme,
} from './vscode-theme-map.js';

const USAGE = `Usage: theme-import <theme.json>

Imports a VS Code color theme (a *.color-theme.json file) into Grafd: appends a
:root[data-theme="..."] block to public/themes.css and registers the theme in the
THEMES list in src/client/theme.ts. The theme then appears in the Preferences dialog.

The theme file must declare a "name" ("colors" and "tokenColors" are optional).
The id is derived from the name; importing an id that already exists is an error.`;

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const themesCssPath = path.join(projectRoot, 'public', 'themes.css');
const themeRegistryPath = path.join(projectRoot, 'src', 'client', 'theme.ts');

main();

async function main(): Promise<void> {
  const [themePath, ...extra] = process.argv.slice(2);
  if (themePath === '--help' || themePath === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  if (!themePath || extra.length > 0) {
    console.log(USAGE);
    process.exit(2);
  }

  const theme = await readTheme(themePath);
  const id = deriveId(theme);
  const label = theme.name!.trim();

  const css = await readFile(themesCssPath, 'utf8');
  if (css.includes(`data-theme="${id}"`)) {
    fail(`theme "${id}" already exists in public/themes.css`);
  }
  const registry = await readFile(themeRegistryPath, 'utf8');
  if (registry.includes(`id: '${id}'`)) {
    fail(`theme "${id}" already registered in src/client/theme.ts`);
  }

  const { scheme, tokens } = mapThemeToTokens(theme);
  const block = renderThemeBlock(id, tokens);
  const separator = css.endsWith('\n') ? '' : '\n';
  await writeFile(themesCssPath, css + separator + '\n' + block);

  const registryEntry = `  { id: '${id}', label: '${escapeQuotes(label)}' },`;
  const closingBracket = '] as const satisfies';
  const insertion = registry.indexOf(closingBracket);
  if (insertion === -1) {
    fail('cannot find the THEMES closing bracket in src/client/theme.ts');
  }
  await writeFile(themeRegistryPath, registry.slice(0, insertion) + registryEntry + '\n' + registry.slice(insertion));

  console.log(`Imported "${label}" as \`${id}\` (${scheme}).`);
  console.log(`  ${path.relative(projectRoot, themesCssPath)} — new :root[data-theme="${id}"] block`);
  console.log(`  ${path.relative(projectRoot, themeRegistryPath)} — registered in THEMES`);
  console.log('Run `npm test` to confirm the theme satisfies the theme invariants.');
}

async function readTheme(themePath: string): Promise<VscodeColorTheme> {
  let raw: string;
  try {
    raw = await readFile(themePath, 'utf8');
  } catch {
    fail(`cannot read ${themePath}`);
  }
  try {
    return JSON.parse(stripJsonComments(raw)) as VscodeColorTheme;
  } catch {
    fail(`${themePath} is not valid JSON`);
  }
}

function deriveId(theme: VscodeColorTheme): string {
  if (typeof theme.name !== 'string' || !theme.name.trim()) {
    fail('the theme file must declare a non-empty "name"');
  }
  try {
    return deriveThemeId(theme.name);
  } catch (error) {
    fail(error instanceof Error ? error.message : `cannot derive an id from "${theme.name}"`);
  }
}

function escapeQuotes(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function fail(message: string): never {
  console.error(`theme-import: ${message}`);
  process.exit(1);
}
