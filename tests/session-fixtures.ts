// The workspace the random sessions start from. It holds one of every kind of thing a press can
// land on — nodes inside and outside regions, a drawn region and one sized by its members, edges,
// a subgraph host, an edge to a node that does not exist yet (drawn as a ghost), loose strokes and
// a group of them — so that a sequence of gestures has every pairing of kind and destination within
// reach. A kind added to the canvas belongs here too, or no session ever touches it; the coverage
// test in editor-sessions.test.ts fails until one is.

import { parseFlow, serializeFlow } from '../src/shared/flow-format.js';
import { canvasLayerPathOf, parseCanvasLayer, serializeCanvasLayer } from '../src/shared/canvas-layer.js';

export const SESSION_FLOW_PATH = 'main.flow';

const SESSION_FLOW = `---
name: Session
---

context: Drawn
  pos: 0, 0, 700, 360
  nodes:
    - Alpha
    - Beta

context: Loose
  nodes:
    - Gamma

Alpha
  id: alpha-1
  pos: 80, 120, 180, 80
  -> Beta : "next"
  -> Gamma

Beta
  id: beta-1
  pos: 420, 120, 180, 80
  -> Delta

Gamma
  id: gamma-1
  pos: 80, 600, 180, 80

Delta
  id: delta-1
  pos: 900, 300, 180, 80
  expand: Delta
  -> Gamma : "back"
  -> Missing

graph: Delta
  Inner
    id: inner-1
    pos: 0, 0, 160, 72
    -> Second

  Second
    id: second-1
    pos: 260, 0, 160, 72
`;

const SESSION_LAYER = {
  format: 'grafd-canvas/1',
  nodes: { 'beta-1': { shape: 'diamond' } },
  drawings: [
    { id: 'loose-stroke', kind: 'stroke', width: 'medium', points: [[460, 560], [520, 600], [600, 620], [680, 610]] },
    { id: 'grouped-a', kind: 'stroke', width: 'thin', points: [[1300, 100], [1360, 140], [1420, 120]] },
    { id: 'grouped-b', kind: 'stroke', width: 'thick', points: [[1300, 220], [1380, 260], [1440, 240]] },
    { id: 'inside-region', kind: 'stroke', width: 'medium', points: [[300, 260], [360, 300], [420, 280]] },
  ],
  groups: [
    { id: 'pair', members: [{ kind: 'drawing', id: 'grouped-a' }, { kind: 'drawing', id: 'grouped-b' }] },
  ],
};

// Canonical text, as the editor itself would write it, so that a file the session never touched
// and one it rewrote are compared on equal terms.
export function sessionWorkspaceFiles(): Record<string, string> {
  return {
    [SESSION_FLOW_PATH]: serializeFlow(parseFlow(SESSION_FLOW)),
    [canvasLayerPathOf(SESSION_FLOW_PATH)]: serializeCanvasLayer(parseCanvasLayer(JSON.stringify(SESSION_LAYER)))!,
  };
}
