// Command line layout for .flow workspaces: `grafd layout [workspace…]`. Gives every node without a
// `pos` the place the editor would give it on opening the file, or with `--all` lays every graph
// out afresh as the editor's Arrange command does — so a workspace an agent wrote reads well
// before anyone opens it. Canvas layers are read for the shapes nodes are sized for, and `--all`
// writes the bends it settles into them, as Arrange does.

import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listFlowFiles, readFileIfPresent, UNREADABLE_FILE } from '../server/flow-files.js';
import {
  canvasLayerIsUnreadable,
  canvasLayerPathOf,
  emptyCanvasLayer,
  parseCanvasLayer,
  serializeCanvasLayer,
  type CanvasLayer,
} from '../shared/canvas-layer.js';
import { arrangeDocument, assignMissingNodeIds, graphScopesOf, layerReadingOf, placeMissingPositions, setPlannedBends } from '../shared/document-layout.js';
import { parseFlow, serializeFlow, type FlowDocument } from '../shared/flow-format.js';
import type { LayoutDirection } from '../shared/layered-layout.js';

interface Options {
  roots: string[];
  all: boolean;
  direction?: LayoutDirection;
}

const DIRECTIONS: readonly LayoutDirection[] = ['LR', 'TB'];

const DEFAULT_WORKSPACE = '.grafd';
const USAGE = `Usage: grafd layout [workspace…] [options]

Places every node without a position in each workspace directory (default: ${DEFAULT_WORKSPACE})
where the editor would place it: beside the nodes it connects to, or, in a graph with no positions
at all, as a layered drawing of the whole graph. Nodes that already have a position stay put.

Options:
  --all     lay every graph out afresh, moving nodes that already have a position, and bend long
            edges along the lanes kept clear for them (written to each graph's canvas layer)
  --direction=LR|TB
            with --all, flow left to right or top to bottom (default: the way each graph
            already flows; left to right for one with no positions)
  --help    show this message`;

export async function runFlowLayout(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options === 'help' || options === 'invalid') {
    console.log(USAGE);
    return options === 'help' ? 0 : 2;
  }

  const written: string[] = [];
  for (const root of options.roots) {
    for (const file of await layOutWorkspace(path.resolve(root), options.all, options.direction)) {
      written.push(path.join(root, file).split(path.sep).join('/'));
    }
  }
  if (written.length === 0) {
    console.log(options.all ? 'Every graph was already arranged.' : 'Every node already has a position.');
  } else {
    for (const file of written) console.log(`Laid out ${file}`);
  }
  return 0;
}

// The layer beside a file: its text as it is on disk (null when there is none), and what it reads
// as — null when it cannot be read or parsed, which is then drawn in defaults and never written.
async function layerAt(file: string): Promise<{ text: string | null; layer: CanvasLayer | null }> {
  const text = await readFileIfPresent(file);
  if (text === UNREADABLE_FILE) return { text: null, layer: null };
  if (text === null) return { text, layer: emptyCanvasLayer() };
  return { text, layer: canvasLayerIsUnreadable(text) ? null : parseCanvasLayer(text) };
}

function parseOptions(argv: string[]): Options | 'help' | 'invalid' {
  const options: Options = { roots: [], all: false };
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') return 'help';
    else if (argument === '--all') options.all = true;
    else if (argument.startsWith('--direction=')) {
      const direction = argument.slice('--direction='.length).toUpperCase() as LayoutDirection;
      if (!DIRECTIONS.includes(direction)) return 'invalid';
      options.direction = direction;
    } else if (argument.startsWith('-')) return 'invalid';
    else options.roots.push(argument);
  }
  if (options.direction && !options.all) return 'invalid';
  if (options.roots.length === 0) options.roots.push(DEFAULT_WORKSPACE);
  return options;
}

// The workspace-relative paths of the files it rewrote. A file whose layout is already what was
// asked for is left byte for byte as it was, and so is its layer.
export async function layOutWorkspace(absoluteRoot: string, all: boolean, direction?: LayoutDirection): Promise<string[]> {
  const written: string[] = [];
  for (const file of await listFlowFiles(absoluteRoot)) {
    const absolutePath = path.join(absoluteRoot, file);
    const doc = parseFlow(await readFile(absolutePath, 'utf8'));
    const changed = all ? await arrangeFile(absolutePath, doc, direction) : placeMissingPositions(doc);
    if (!changed) continue;
    await writeFile(absolutePath, serializeFlow(doc));
    written.push(file);
  }
  return written;
}

// Arranges a document and writes the bends it settles to its layer, giving every node an id first,
// since a bend is filed under the ids at both ends of its edge. An unreadable layer is left as it
// is, and its edges straight. Says whether the document or its layer changed.
async function arrangeFile(flowPath: string, doc: FlowDocument, direction?: LayoutDirection): Promise<boolean> {
  const layerPath = canvasLayerPathOf(flowPath);
  const { text: layerText, layer } = await layerAt(layerPath);
  const idsAssigned = layer !== null && graphScopesOf(doc).map(assignMissingNodeIds).some((assigned) => assigned);
  const { moved, bends } = arrangeDocument(doc, layerReadingOf(doc, layer), direction);
  if (layer === null) return moved;
  setPlannedBends(layer, doc, bends);
  const layerOut = serializeCanvasLayer(layer);
  const layerChanged = layerOut !== layerText;
  if (layerChanged && layerOut === null) await rm(layerPath, { force: true });
  else if (layerChanged) await writeFile(layerPath, layerOut!);
  return moved || idsAssigned || layerChanged;
}
