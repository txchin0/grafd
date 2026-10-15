// Command line rendering: `grafd render <file.flow>` draws a graph to a PNG with no browser, so an
// agent that wrote or arranged a graph can look at it. It paints with the editor's own scene
// painter (client/canvas/scene-snapshot.ts) in the workspace's font and roughness and a theme's
// colours, so the picture is the one the editor would show.
//
// The canvas comes from @napi-rs/canvas, an optional dependency: a failed install never breaks
// grafd, and this command says how to install it when it is missing.

import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectCanvasFont } from '../client/canvas-font.js';
import { ExpansionLayer } from '../client/canvas/expansion.js';
import { paintSceneSnapshot, snapshotFrameOf, type SnapshotCanvas } from '../client/canvas/scene-snapshot.js';
import { buildModel, graphBlockNames, type FlowModel } from '../client/flow-doc.js';
import { dressModel } from '../client/model-visuals.js';
import { canvasPaletteFromTokens, DEFAULT_THEME_ID, isThemeId, PAGE_BACKGROUND_TOKEN, THEMES, themeTokensFromCss, useCanvasPalette, type ThemeId } from '../client/theme.js';
import { canvasLayerIsUnreadable, canvasLayerPathOf, parseCanvasLayer } from '../shared/canvas-layer.js';
import { IMAGE_KIND } from '../shared/canvas-image.js';
import { getProp, parseFlow, resolvedExpandPath } from '../shared/flow-format.js';
import { emptyManifest, MANIFEST_FILE_NAME, parseManifest, type CanvasFontId } from '../shared/manifest.js';

interface Options {
  file: string;
  out: string | null;
  graph: string | null;
  theme: ThemeId;
  scale: number;
}

// The parts of @napi-rs/canvas this uses.
interface CanvasLibrary {
  createCanvas(width: number, height: number): SnapshotCanvas & { toBuffer(mime: 'image/png'): Buffer };
  loadImage(source: string): Promise<CanvasImageSource>;
  GlobalFonts: { registerFromPath(file: string, family: string): unknown; has(family: string): boolean };
}

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const PLAYPEN_FONT_FILE = path.join(PUBLIC_DIR, 'fonts', 'PlaypenSans-Variable.woff2');
const PLAYPEN_FAMILY = 'Playpen Sans';
// The faces the default canvas font asks the system for; where none is installed — most servers —
// the bundled Playpen Sans draws instead, so text is still hand-lettered and wraps as it would.
const SYSTEM_HAND_FONTS = ['Segoe Print', 'Comic Sans MS'];
const DEFAULT_SCALE = 1;
// Keeps a huge graph's image within what an image viewer, or a model reading it, will take.
const MAX_IMAGE_SIDE = 4096;
const EMPTY_FRAME = { x: 0, y: 0, w: 400, h: 300 };

const USAGE = `Usage: grafd render <file.flow> [options]

Draws a graph to a PNG as the editor shows it: nodes without a position placed where the editor
places them, styled by the graph's canvas layer, in the workspace's font and roughness.

Options:
  --out=<file.png>    where to write the image (default: the graph's name, .png, in this directory)
  --graph=<name>      draw a \`graph:\` block of the file instead of its body
  --theme=<id>        colours to draw in: ${THEMES.map((theme) => theme.id).join(', ')} (default: ${DEFAULT_THEME_ID})
  --scale=<n>         pixels per canvas unit (default: ${DEFAULT_SCALE}); a large graph is scaled down to fit ${MAX_IMAGE_SIDE} px
  --help              show this message`;

export async function runFlowRender(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options === 'help' || options === 'invalid') {
    console.log(USAGE);
    return options === 'help' ? 0 : 2;
  }
  const canvasLibrary = await loadCanvasLibrary();
  if (!canvasLibrary) {
    console.error('grafd render needs @napi-rs/canvas, which did not install with grafd. Install it with:\n  npm install @napi-rs/canvas');
    return 1;
  }
  const rendered = await renderFlowFile(canvasLibrary, options);
  if (typeof rendered === 'string') {
    console.error(rendered);
    return 1;
  }
  console.log(`Rendered ${options.file} to ${rendered.out} (${rendered.width}×${rendered.height})`);
  return 0;
}

function parseOptions(argv: string[]): Options | 'help' | 'invalid' {
  const options: Partial<Options> = { out: null, graph: null, theme: DEFAULT_THEME_ID, scale: DEFAULT_SCALE };
  for (const argument of argv) {
    const [flag, value] = splitFlag(argument);
    if (flag === '--help' || flag === '-h') return 'help';
    else if (flag === '--out' && value) options.out = value;
    else if (flag === '--graph' && value) options.graph = value;
    else if (flag === '--theme' && value && isThemeId(value)) options.theme = value;
    else if (flag === '--scale' && value && Number(value) > 0) options.scale = Number(value);
    else if (argument.startsWith('-') || options.file) return 'invalid';
    else options.file = argument;
  }
  return options.file ? (options as Options) : 'invalid';
}

function splitFlag(argument: string): [string, string | null] {
  const separator = argument.indexOf('=');
  return separator < 0 ? [argument, null] : [argument.slice(0, separator), argument.slice(separator + 1)];
}

async function loadCanvasLibrary(): Promise<CanvasLibrary | null> {
  try {
    return (await import('@napi-rs/canvas')) as unknown as CanvasLibrary;
  } catch {
    return null;
  }
}

// Draws the graph and writes the image; a message saying why not when it cannot.
export async function renderFlowFile(
  canvasLibrary: CanvasLibrary,
  options: Options,
): Promise<{ out: string; width: number; height: number } | string> {
  const absoluteFile = path.resolve(options.file);
  const text = await readFile(absoluteFile, 'utf8').catch(() => null);
  if (text === null) return `Cannot read ${options.file}.`;
  const root = await workspaceRootOf(absoluteFile);
  const flowPath = path.relative(root, absoluteFile).split(path.sep).join('/');

  const doc = parseFlow(text);
  if (options.graph !== null && !graphBlockNames(doc).includes(options.graph)) {
    return `${options.file} has no \`graph: ${options.graph}\` block.`;
  }
  const model = buildModel(doc, options.graph);
  model.sourcePath = flowPath;
  const layerText = await readFile(path.join(root, canvasLayerPathOf(flowPath)), 'utf8').catch(() => null);
  dressModel(model, layerText === null || canvasLayerIsUnreadable(layerText) ? null : parseCanvasLayer(layerText));

  const display = (parseManifest(await readFile(path.join(root, MANIFEST_FILE_NAME), 'utf8').catch(() => null)) ?? emptyManifest()).display;
  selectCanvasFont(fontToDrawIn(canvasLibrary, display.font));
  const tokens = themeTokensFromCss(await readFile(path.join(PUBLIC_DIR, 'themes.css'), 'utf8'), options.theme);
  useCanvasPalette(canvasPaletteFromTokens(tokens));

  const expansions = await expansionsFor(model, root, flowPath);
  const images = await decodedImagesOf(canvasLibrary, model);
  const frame = snapshotFrameOf(model) ?? EMPTY_FRAME;
  const scale = Math.min(options.scale, MAX_IMAGE_SIDE / Math.max(frame.w, frame.h));
  const canvas = canvasLibrary.createCanvas(Math.ceil(frame.w * scale), Math.ceil(frame.h * scale));
  paintSceneSnapshot({
    canvas,
    model,
    frame,
    scale,
    background: tokens.get(PAGE_BACKGROUND_TOKEN) ?? '#ffffff',
    roughness: display.roughness,
    expansions,
    images: (src) => images.get(src) ?? null,
  });

  const out = options.out ?? defaultOutputName(absoluteFile, options.graph);
  await writeFile(out, canvas.toBuffer('image/png'));
  return { out, width: canvas.width, height: canvas.height };
}

// The directory holding the workspace's manifest, searched for upward from the file; the file's
// own directory when there is none. Expand links and canvas layers resolve from it.
async function workspaceRootOf(absoluteFile: string): Promise<string> {
  let directory = path.dirname(absoluteFile);
  for (;;) {
    if (await stat(path.join(directory, MANIFEST_FILE_NAME)).then(() => true, () => false)) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return path.dirname(absoluteFile);
    directory = parent;
  }
}

function fontToDrawIn(canvasLibrary: CanvasLibrary, chosen: CanvasFontId): CanvasFontId {
  canvasLibrary.GlobalFonts.registerFromPath(PLAYPEN_FONT_FILE, PLAYPEN_FAMILY);
  const systemFontMissing = !SYSTEM_HAND_FONTS.some((family) => canvasLibrary.GlobalFonts.has(family));
  return chosen === 'system' && systemFontMissing ? 'playpen' : chosen;
}

// The expansion layer the painter asks for what a node's subgraph says about itself, with every
// file the graph's nodes expand into already read.
async function expansionsFor(model: FlowModel, root: string, flowPath: string): Promise<ExpansionLayer> {
  const expansions = new ExpansionLayer({
    onNeedsRender: () => {},
    readExternalFile: (file) => readFile(path.join(root, file), 'utf8').catch(() => null),
  });
  const expandedFiles = model.nodes.flatMap((node) => resolvedExpandPath(getProp(node, 'expand'), flowPath) ?? []);
  await Promise.all(expandedFiles.map((file) => expansions.ensureDocument(file)));
  return expansions;
}

async function decodedImagesOf(canvasLibrary: CanvasLibrary, model: FlowModel): Promise<Map<string, CanvasImageSource>> {
  const sources = (model.visuals?.drawings() ?? []).flatMap((drawing) =>
    (drawing.kind === IMAGE_KIND && typeof drawing.src === 'string' ? [drawing.src] : []));
  const decoded = await Promise.all(sources.map(async (src) => [src, await canvasLibrary.loadImage(src).catch(() => null)] as const));
  return new Map(decoded.filter((entry): entry is readonly [string, CanvasImageSource] => entry[1] !== null));
}

function defaultOutputName(absoluteFile: string, graph: string | null): string {
  const name = path.basename(absoluteFile, '.flow');
  const suffix = graph === null ? '' : `-${graph.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  return `${name}${suffix}.png`;
}
