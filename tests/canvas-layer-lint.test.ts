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

  it('reports entries the graph no longer has as info, which never fails a run', () => {
    const text = layerText({ nodes: { gone: { shape: 'ellipse' } }, edges: { 'gone -> #x': { color: 'red' } } });
    expect(rulesOf(text)).toEqual(['info stale-canvas-entry', 'info stale-canvas-entry']);
    expect(countDiagnostics([{ path: 'a', diagnostics: lintCanvasLayer(text, FLOW) }])).toEqual({ errors: 0, warnings: 0 });
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
