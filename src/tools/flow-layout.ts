// Command line layout for .flow workspaces: `grafd layout [workspace…]`. Gives every node without a
// `pos` the place the editor would give it on opening the file, or with `--all` lays every graph
// out afresh as the editor's Arrange command does — so a workspace an agent wrote reads well
// before anyone opens it. Canvas layers are read for the shapes nodes are sized for, never written.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listFlowFiles } from '../server/flow-files.js';
import { canvasLayerIsUnreadable, canvasLayerPathOf, nodeShapeOf, parseCanvasLayer, type CanvasLayer } from '../shared/canvas-layer.js';
import { arrangeDocument, placeMissingPositions } from '../shared/document-layout.js';
import { parseFlow, serializeFlow } from '../shared/flow-format.js';

interface Options {
  roots: string[];
  all: boolean;
}

const DEFAULT_WORKSPACE = '.grafd';
const USAGE = `Usage: grafd layout [workspace…] [options]

Places every node without a position in each workspace directory (default: ${DEFAULT_WORKSPACE})
where the editor would place it: beside the nodes it connects to, or, in a graph with no positions
at all, as a layered drawing of the whole graph. Nodes that already have a position stay put.

Options:
  --all     lay every graph out afresh, moving nodes that already have a position
  --help    show this message`;

export async function runFlowLayout(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options === 'help' || options === 'invalid') {
    console.log(USAGE);
    return options === 'help' ? 0 : 2;
  }

  const written: string[] = [];
  for (const root of options.roots) {
    for (const file of await layOutWorkspace(path.resolve(root), options.all)) {
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

// The layer beside a file, read only for the shapes its nodes are drawn in; an unreadable one is
// as good as none, since this never writes it.
async function readableLayerAt(file: string): Promise<CanvasLayer | null> {
  const text = await readFile(file, 'utf8').catch(() => null);
  return text === null || canvasLayerIsUnreadable(text) ? null : parseCanvasLayer(text);
}

function parseOptions(argv: string[]): Options | 'help' | 'invalid' {
  const options: Options = { roots: [], all: false };
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') return 'help';
    else if (argument === '--all') options.all = true;
    else if (argument.startsWith('-')) return 'invalid';
    else options.roots.push(argument);
  }
  if (options.roots.length === 0) options.roots.push(DEFAULT_WORKSPACE);
  return options;
}

// The workspace-relative paths of the files it rewrote. A file whose layout is already what was
// asked for is left byte for byte as it was.
export async function layOutWorkspace(absoluteRoot: string, all: boolean): Promise<string[]> {
  const written: string[] = [];
  for (const file of await listFlowFiles(absoluteRoot)) {
    const absolutePath = path.join(absoluteRoot, file);
    const text = await readFile(absolutePath, 'utf8');
    const doc = parseFlow(text);
    const layer = await readableLayerAt(canvasLayerPathOf(absolutePath));
    const laidOut = all ? arrangeDocument(doc, (node) => nodeShapeOf(layer, node.id)) : placeMissingPositions(doc);
    if (!laidOut) continue;
    await writeFile(absolutePath, serializeFlow(doc));
    written.push(file);
  }
  return written;
}
