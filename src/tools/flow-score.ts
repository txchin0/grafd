// Command line scoring for .flow workspaces: `grafd score [workspace…]`. Rates every graph as the
// editor would show it, lists what costs it points with the fix for each, and says when arranging
// the graph would do better than fixing it by hand. Made for an agent that writes positions: score,
// apply the moves, score again.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listFlowFiles } from '../server/flow-files.js';
import { canvasLayerIsUnreadable, canvasLayerPathOf, parseCanvasLayer, type CanvasLayer } from '../shared/canvas-layer.js';
import { scoreDocumentText, type ScopeScore } from '../shared/document-score.js';
import { FINDING_KINDS, type FindingKind } from '../shared/layout-score.js';

interface Options {
  roots: string[];
  format: 'text' | 'json';
  minimum: number | null;
}

interface ScoredFile {
  path: string;
  graphs: ScopeScore[];
}

const DEFAULT_WORKSPACE = '.grafd';
// Arranging is only worth recommending over hand fixes when it does clearly better.
const ARRANGE_WORTHWHILE = 5;
const USAGE = `Usage: grafd score [workspace…] [options]

Scores how readable every graph in each workspace directory (default: ${DEFAULT_WORKSPACE}) is, out of
100, as the editor shows it: crossings, edges through nodes, overlaps, crowding, labels on top of
things, regions holding nodes that are not theirs, cut-off text and near-misses in alignment —
each with the move or resize that fixes it.

Options:
  --min=<n>        exit non-zero when any graph scores below n
  --format=json    emit the scores and findings as JSON
  --help           show this message`;

const NOUNS: Record<FindingKind, [string, string]> = {
  overlap: ['overlap', 'overlaps'],
  'edge-through-node': ['edge through a node', 'edges through nodes'],
  'outsider-in-region': ['node in a region not its own', 'nodes in regions not their own'],
  'regions-overlap': ['overlapping pair of regions', 'overlapping pairs of regions'],
  crossing: ['crossing', 'crossings'],
  'label-collision': ['label collision', 'label collisions'],
  crowded: ['crowded pair', 'crowded pairs'],
  'text-cut-off': ['node with cut-off text', 'nodes with cut-off text'],
  'near-miss': ['near-miss in alignment', 'near-misses in alignment'],
};

export async function runFlowScore(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options === 'help' || options === 'invalid') {
    console.log(USAGE);
    return options === 'help' ? 0 : 2;
  }

  const files: ScoredFile[] = [];
  for (const root of options.roots) files.push(...(await scoreWorkspace(root)));

  if (options.format === 'json') console.log(JSON.stringify({ files: files.map(jsonOf) }, null, 2));
  else printReport(files);

  const scores = files.flatMap((file) => file.graphs.map((graph) => graph.current.score));
  return options.minimum !== null && scores.some((score) => score < options.minimum!) ? 1 : 0;
}

function parseOptions(argv: string[]): Options | 'help' | 'invalid' {
  const options: Options = { roots: [], format: 'text', minimum: null };
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') return 'help';
    else if (argument === '--format=json') options.format = 'json';
    else if (argument === '--format=text') options.format = 'text';
    else if (argument.startsWith('--min=') && Number.isFinite(Number(argument.slice('--min='.length)))) {
      options.minimum = Number(argument.slice('--min='.length));
    } else if (argument.startsWith('-')) return 'invalid';
    else options.roots.push(argument);
  }
  if (options.roots.length === 0) options.roots.push(DEFAULT_WORKSPACE);
  return options;
}

export async function scoreWorkspace(root: string): Promise<ScoredFile[]> {
  const absoluteRoot = path.resolve(root);
  const files: ScoredFile[] = [];
  for (const file of await listFlowFiles(absoluteRoot)) {
    const text = await readFile(path.join(absoluteRoot, file), 'utf8');
    const graphs = scoreDocumentText(text, await readLayer(path.join(absoluteRoot, canvasLayerPathOf(file))));
    files.push({ path: path.join(root, file).split(path.sep).join('/'), graphs });
  }
  return files;
}

// A layer that cannot be read is scored as no layer: the editor draws every edge straight then too.
async function readLayer(absolutePath: string): Promise<CanvasLayer | null> {
  const text = await readFile(absolutePath, 'utf8').catch(() => null);
  return text === null || canvasLayerIsUnreadable(text) ? null : parseCanvasLayer(text);
}

function printReport(files: ScoredFile[]): void {
  for (const file of files) {
    for (const graph of file.graphs) {
      const where = graph.scope === null ? file.path : `${file.path} (graph: ${graph.scope})`;
      console.log(`${where}  ${graph.current.score}/100`);
      const tally = FINDING_KINDS.filter((kind) => graph.current.counts[kind] > 0)
        .map((kind) => `${graph.current.counts[kind]} ${NOUNS[kind][graph.current.counts[kind] === 1 ? 0 : 1]}`);
      if (tally.length > 0) console.log(`  ${tally.join(' · ')}`);
      for (const finding of graph.current.findings) console.log(`  - ${finding.message} ${finding.fix}`);
      if (graph.arranged >= graph.current.score + ARRANGE_WORTHWHILE) {
        console.log(`  Arranging this graph would score ${graph.arranged}: press Ctrl+Shift+L in the editor, or run \`grafd layout --all\`.`);
      }
      console.log('');
    }
  }
}

function jsonOf(file: ScoredFile): object {
  return {
    path: file.path,
    graphs: file.graphs.map((graph) => ({
      scope: graph.scope,
      score: graph.current.score,
      arranged: graph.arranged,
      counts: graph.current.counts,
      findings: graph.current.findings,
    })),
  };
}
