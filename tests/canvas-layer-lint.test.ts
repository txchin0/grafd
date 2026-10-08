import { describe, expect, it } from 'vitest';
import { lintCanvasLayer } from '../src/shared/canvas-layer-lint.js';
import { lintWorkspace } from '../src/shared/flow-lint-workspace.js';
import { lintFlowFile } from '../src/shared/flow-lint.js';
import { countDiagnostics } from '../src/shared/flow-diagnostics.js';

const START = '11111111-1111-4111-8111-111111111111';
const END = '22222222-2222-4222-8222-222222222222';
const FLOW = `---\nname: demo\n---\n\nStart\n  id: ${START}\n  -> End : "go"\n\nEnd\n  id: ${END}\n`;
const EDGE_KEY = `${START} -> #${END} : "go"`;

function layerText(layer: object): string {
  return JSON.stringify({ format: 'grafd-canvas/1', ...layer }, null, 2);
}

function rulesOf(layer: string, flow: string | null = FLOW): string[] {
  return lintCanvasLayer(layer, flow).map((diagnostic) => `${diagnostic.severity} ${diagnostic.rule}`);
}

describe('lintCanvasLayer', () => {
  it('passes a layer whose entries all match the graph', () => {
    expect(rulesOf(layerText({ nodes: { [START]: { shape: 'diamond' } }, edges: { [EDGE_KEY]: { color: 'red' } } }))).toEqual([]);
  });

  it('warns about a layer that is not a JSON object', () => {
    expect(rulesOf('{ nope')).toEqual(['warning canvas-layer-unreadable']);
  });

  it('warns about a layer with no .flow beside it', () => {
    expect(rulesOf(layerText({}), null)).toEqual(['warning canvas-layer-without-flow']);
  });

  it('warns about unknown shapes and colours, on the line that sets them', () => {
    const text = layerText({ nodes: { [START]: { shape: 'blob' } }, edges: { [EDGE_KEY]: { color: 'mauve' } } });
    const diagnostics = lintCanvasLayer(text, FLOW);
    expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual(['unknown-node-shape', 'invalid-edge-color']);
    expect(text.split('\n')[diagnostics[0].line - 1]).toContain(START);
  });

  it('passes an edge drawn with a line style, heads at both ends and a bend', () => {
    const edge = { line: 'dotted', startHead: 'dot', endHead: 'triangle', bend: [0.5, -0.2] };
    expect(rulesOf(layerText({ edges: { [EDGE_KEY]: edge } }))).toEqual([]);
  });

  it('warns about an unknown line, unknown heads and a malformed bend', () => {
    const edge = { line: 'wavy', startHead: 'flag', endHead: 'spear', bend: [0.5, 'up'] };
    expect(rulesOf(layerText({ edges: { [EDGE_KEY]: edge } })).sort()).toEqual([
      'warning invalid-edge-bend',
      'warning unknown-arrowhead',
      'warning unknown-arrowhead',
      'warning unknown-edge-line',
    ]);
  });

  it('says which end of the edge an unknown head is on', () => {
    const messages = lintCanvasLayer(layerText({ edges: { [EDGE_KEY]: { startHead: 'flag' } } }), FLOW).map((diagnostic) => diagnostic.message);
    expect(messages).toEqual([expect.stringContaining('start head "flag"')]);
  });

  it('reports entries the graph no longer has as info, which never fails a run', () => {
    const text = layerText({ nodes: { gone: { shape: 'ellipse' } }, edges: { 'gone -> #x': { color: 'red' } } });
    expect(rulesOf(text)).toEqual(['info stale-canvas-entry', 'info stale-canvas-entry']);
    expect(countDiagnostics([{ path: 'a', diagnostics: lintCanvasLayer(text, FLOW) }])).toEqual({ errors: 0, warnings: 0 });
  });
});

describe('lintCanvasLayer on drawings', () => {
  const FLOW_WITH_BLOCK = `${FLOW}\ngraph: Steps\n  Inner\n    id: 33333333-3333-4333-8333-333333333333\n`;

  // As the editor writes it: pretty-printed, one drawing per line.
  function layerWithDrawings(drawings: unknown[]): string {
    const head = JSON.stringify({ format: 'grafd-canvas/1' }, null, 2).slice(0, -2);
    const lines = drawings.map((drawing) => `    ${JSON.stringify(drawing)}`).join(',\n');
    return `${head},\n  "drawings": [\n${lines}\n  ]\n}\n`;
  }

  const GOOD = { id: 'ok', kind: 'stroke', graph: 'Steps', color: 'red', width: 'thin', points: [[0, 0], [1, 1]] };

  it('passes valid strokes, and drawings of kinds it does not know', () => {
    expect(rulesOf(layerWithDrawings([GOOD, { id: 'note', kind: 'text' }]), FLOW_WITH_BLOCK)).toEqual([]);
  });

  it('flags each problem on the drawing\'s own line', () => {
    const text = layerWithDrawings([
      GOOD,
      { id: 'bad-points', kind: 'stroke', points: [[0]] },
      { id: 'bad-style', kind: 'stroke', color: 'mauve', width: 'huge', points: [[0, 0]] },
      { kind: 'stroke', points: [[0, 0]] },
      'not an object',
    ]);
    const diagnostics = lintCanvasLayer(text, FLOW_WITH_BLOCK);
    const lines = text.split('\n');
    expect(diagnostics.map((diagnostic) => `${diagnostic.rule} ${lines[diagnostic.line - 1].trim().slice(0, 18)}`)).toEqual([
      'invalid-stroke {"id":"bad-points"',
      'invalid-stroke-color {"id":"bad-style",',
      'unknown-stroke-width {"id":"bad-style",',
      'invalid-stroke {"kind":"stroke","',
      'invalid-drawings "not an object"',
    ]);
  });

  it('reports a stroke filed under a block the .flow lacks as info', () => {
    expect(rulesOf(layerWithDrawings([{ ...GOOD, graph: 'Gone' }]), FLOW_WITH_BLOCK)).toEqual(['info unknown-drawing-graph']);
  });

  it('warns when drawings is not a list, and when two drawings share an id', () => {
    expect(rulesOf(layerText({ drawings: { oops: true } }))).toEqual(['warning invalid-drawings']);
    expect(rulesOf(layerWithDrawings([GOOD, GOOD]), FLOW_WITH_BLOCK)).toEqual(['warning duplicate-drawing-id']);
  });

  it('finds a drawing by its id in a hand-formatted file', () => {
    const text = layerText({ drawings: [{ kind: 'stroke', id: 'hand', points: 'nope' }] });
    const [diagnostic] = lintCanvasLayer(text, FLOW);
    expect(text.split('\n')[diagnostic.line - 1]).toContain('"hand"');
  });
});

describe('workspace lint of canvas layers', () => {
  it('lints each layer against the .flow beside it', () => {
    const results = lintWorkspace({
      files: [{ path: 'main.flow', text: FLOW }],
      canvasLayers: [
        { path: 'main.flow.canvas.json', text: layerText({ nodes: { [START]: { shape: 'diamond' } } }) },
        { path: 'gone.flow.canvas.json', text: layerText({}) },
      ],
    });
    const layerResults = results.filter((result) => result.path.endsWith('.canvas.json'));
    expect(layerResults.map((result) => [result.path, result.diagnostics.map((diagnostic) => diagnostic.rule)])).toEqual([
      ['main.flow.canvas.json', []],
      ['gone.flow.canvas.json', ['canvas-layer-without-flow']],
    ]);
  });
});

describe('styling written into a .flow', () => {
  it('says where styling lives instead of only calling the key unknown', () => {
    const diagnostics = lintFlowFile(`---\nname: demo\n---\n\nStart\n  shape: diamond\n  color: red\n  owner: me\n`);
    expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual(['style-in-flow', 'style-in-flow', 'unknown-property']);
  });
});
