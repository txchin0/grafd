// Styling by role: the roles a graph's structure gives its nodes, the shapes and edge marks each
// role writes into the canvas layer, the nodes grown to fit the shapes they get, and `grafd style`.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allNodes } from '../src/client/flow-doc.js';
import { canvasLayerPathOf, emptyCanvasLayer, nodeShapeOf, parseCanvasLayer, setNodeShape } from '../src/shared/canvas-layer.js';
import { parseFlow, type FlowDocument, type FlowNode } from '../src/shared/flow-format.js';
import { estimateNodeSize, textCutOff } from '../src/shared/node-size-estimate.js';
import { inferRoles, rolesToApply, ROLE_SHAPES, styleByRoles, type NodeRole } from '../src/shared/node-roles.js';
import { shapeContainsPoint, shapeTextBox } from '../src/shared/shape-text-box.js';
import { runFlowStyle } from '../src/tools/flow-style.js';
import { scoreDocumentText } from '../src/shared/document-score.js';

const CHECKOUT = `---
name: Checkout
---

Cart
  id: cart
  pos: 0, 0, 160, 88
  -> Pay

Pay
  id: pay
  pos: 256, 0, 160, 88
  on_error: -> Refund
  -> Receipt : "approved"
  -> Declined : "declined"

Receipt
  id: receipt
  pos: 512, 0, 160, 88

Declined
  id: declined
  pos: 512, 160, 160, 88

Refund
  id: refund
  pos: 256, 200, 160, 88
`;

function nodeNamed(doc: FlowDocument, name: string): FlowNode {
  return allNodes(doc).find((node) => node.name === name)!;
}

function rolesByName(doc: FlowDocument): Record<string, NodeRole> {
  return Object.fromEntries([...inferRoles(doc.items)].map(([node, role]) => [node.name, role]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('roles read off a graph', () => {
  it('starts at the entry, decides where labels branch, handles what is only failed into, and ends where nothing leads on', () => {
    expect(rolesByName(parseFlow(CHECKOUT))).toEqual({
      Cart: 'start',
      Pay: 'decision',
      Receipt: 'end',
      Declined: 'end',
      Refund: 'error',
    });
  });

  it('handles errors at a node only failed into, even one that leads on, rather than starting there', () => {
    const doc = parseFlow(`Cart
  -> Pay

Pay
  on_error: -> Refund
  -> Receipt

Refund
  -> Receipt

Receipt
`);
    expect(rolesByName(doc)).toEqual({ Cart: 'start', Pay: 'process', Refund: 'error', Receipt: 'end' });
  });

  it('never replaces a shape someone chose with a guess, but applies a role named outright', () => {
    const doc = parseFlow(CHECKOUT);
    const layer = emptyCanvasLayer();
    setNodeShape(layer, 'receipt', 'parallelogram');
    const named = new Map([[nodeNamed(doc, 'Cart'), 'datastore' as const]]);
    const roles = rolesToApply(doc.items, layer, named, true);
    expect(roles.get(nodeNamed(doc, 'Receipt'))).toBeUndefined();
    expect(roles.get(nodeNamed(doc, 'Cart'))).toBe('datastore');
    expect(roles.get(nodeNamed(doc, 'Pay'))).toBe('decision');
  });
});

describe('styling by role', () => {
  it('writes each role\'s shape into the layer', () => {
    const doc = parseFlow(CHECKOUT);
    const layer = emptyCanvasLayer();
    styleByRoles(doc, doc.items, layer, inferRoles(doc.items));
    expect(nodeShapeOf(layer, 'pay')).toBe(ROLE_SHAPES.decision);
    expect(nodeShapeOf(layer, 'cart')).toBe(ROLE_SHAPES.start);
  });

  it('draws the edges into an error red and dashed', () => {
    const doc = parseFlow(CHECKOUT);
    const layer = emptyCanvasLayer();
    const styling = styleByRoles(doc, doc.items, layer, new Map([[nodeNamed(doc, 'Declined'), 'error' as const]]));
    expect(styling.edgesIntoErrors).toBe(1);
    expect(Object.values(layer.edges)).toEqual([{ color: 'red', line: 'dashed' }]);
  });

  it('grows a node whose text no longer fits its new shape, about its centre', () => {
    const doc = parseFlow(CHECKOUT);
    const pay = nodeNamed(doc, 'Pay');
    const before = { ...pay.pos! };
    const styling = styleByRoles(doc, doc.items, emptyCanvasLayer(), new Map([[pay, 'decision' as const]]));
    expect(styling.resized.map(({ node }) => node.name)).toEqual(['Pay']);
    expect(styling.flowChanged).toBe(true);
    expect(textCutOff(pay.name, null, pay.pos!, 'diamond')).toBe(false);
    expect(Math.abs(pay.pos!.x + pay.pos!.w / 2 - (before.x + before.w / 2))).toBeLessThanOrEqual(4);
  });

  it('gives an id to every node of the scope that has none, which the layer keys it by', () => {
    const doc = parseFlow('A\n  -> B\n\nB\n');
    const styling = styleByRoles(doc, doc.items, emptyCanvasLayer(), new Map([[nodeNamed(doc, 'B'), 'end' as const]]));
    expect(styling.flowChanged).toBe(true);
    expect(allNodes(doc).every((node) => node.id)).toBe(true);
  });
});

describe('a shape and its text', () => {
  it('sizes a rectangle exactly as before shapes were taken into account', () => {
    expect(estimateNodeSize('Validate Cart', null)).toEqual({ w: 160, h: 88 });
    expect(estimateNodeSize('Validate Cart', null, 'rounded')).toEqual(estimateNodeSize('Validate Cart', null));
  });

  it('sizes a diamond so its text fits the box the diamond leaves for it', () => {
    const size = estimateNodeSize('Validate the shopping cart', null, 'diamond');
    expect(textCutOff('Validate the shopping cart', null, size, 'diamond')).toBe(false);
    expect(shapeTextBox('diamond', { x: 0, y: 0, ...size }).w).toBeLessThan(size.w);
  });

  it('tells a point in a diamond from one in its empty corner', () => {
    const rect = { x: 0, y: 0, w: 200, h: 100 };
    expect(shapeContainsPoint('diamond', rect, { x: 100, y: 50 })).toBe(true);
    expect(shapeContainsPoint('diamond', rect, { x: 10, y: 10 })).toBe(false);
    expect(shapeContainsPoint('rectangle', rect, { x: 10, y: 10 })).toBe(true);
    expect(shapeContainsPoint('ellipse', rect, { x: 5, y: 5 })).toBe(false);
  });
});

describe('grafd style', () => {
  async function workspaceWith(text: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'grafd-style-'));
    await writeFile(path.join(root, 'main.flow'), text);
    return root;
  }

  it('writes named and inferred roles into the canvas layer beside the file', async () => {
    const root = await workspaceWith(CHECKOUT);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runFlowStyle([path.join(root, 'main.flow'), '--infer', '--role=Receipt=io'])).toBe(0);
    const layer = parseCanvasLayer(await readFile(canvasLayerPathOf(path.join(root, 'main.flow')), 'utf8'));
    expect(nodeShapeOf(layer, 'receipt')).toBe('parallelogram');
    expect(nodeShapeOf(layer, 'pay')).toBe('diamond');
  });

  it('reads roles from a JSON file', async () => {
    const root = await workspaceWith(CHECKOUT);
    await writeFile(path.join(root, 'roles.json'), JSON.stringify({ Cart: 'event' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runFlowStyle([path.join(root, 'main.flow'), `--roles=${path.join(root, 'roles.json')}`])).toBe(0);
    const layer = parseCanvasLayer(await readFile(canvasLayerPathOf(path.join(root, 'main.flow')), 'utf8'));
    expect(nodeShapeOf(layer, 'cart')).toBe('ellipse');
  });

  it('refuses a node or a role that does not exist, writing nothing', async () => {
    const root = await workspaceWith(CHECKOUT);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runFlowStyle([path.join(root, 'main.flow'), '--role=Nowhere=end'])).toBe(1);
    expect(await runFlowStyle([path.join(root, 'main.flow'), '--role=Cart=spaceship'])).toBe(1);
    await expect(readFile(canvasLayerPathOf(path.join(root, 'main.flow')), 'utf8')).rejects.toThrow();
  });

  it('leaves a layer it cannot read alone', async () => {
    const root = await workspaceWith(CHECKOUT);
    const layerFile = canvasLayerPathOf(path.join(root, 'main.flow'));
    await writeFile(layerFile, 'not json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runFlowStyle([path.join(root, 'main.flow'), '--infer'])).toBe(1);
    expect(await readFile(layerFile, 'utf8')).toBe('not json');
  });

  it('needs something to apply', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runFlowStyle(['main.flow'])).toBe(2);
  });

  it('settles the nodes it placed once their shapes have grown them, and moves no placed node', async () => {
    const root = await workspaceWith(DECISION_ADDED_TO_A_PLACED_FLOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const roles = ['MFA Enabled?', 'Code Valid?', 'Tries Left?'].map((name) => `--role=${name}=decision`);
    expect(await runFlowStyle([path.join(root, 'main.flow'), ...roles, '--role=Enter TOTP Code=io'])).toBe(0);
    const text = await readFile(path.join(root, 'main.flow'), 'utf8');
    const layer = parseCanvasLayer(await readFile(canvasLayerPathOf(path.join(root, 'main.flow')), 'utf8'));
    const [body] = scoreDocumentText(text, layer);
    expect(body.current.counts.crowded + body.current.counts.overlap).toBe(0);
    expect(nodeNamed(parseFlow(text), 'Generate Token').pos).toEqual({ x: 672, y: 136, w: 210, h: 88 });
  });
});

// A login laid out by hand, with an MFA check added after "Authenticate": the new diamonds grow
// once styled, into the room placement left between them as rectangles.
const DECISION_ADDED_TO_A_PLACED_FLOW = `---
name: Login Flow
---

Validate Input
  id: validate
  pos: 80, 232, 200, 88
  -> Authenticate : "input valid"

Authenticate
  id: authenticate
  pos: 368, 224, 200, 96
  -> MFA Enabled? : "credentials valid"
  -> Return Auth Error : "credentials invalid"

MFA Enabled?
  -> Enter TOTP Code : "yes"
  -> Generate Token : "no"

Enter TOTP Code
  description: "Authenticator code, 3 tries max"
  -> Code Valid?

Code Valid?
  -> Generate Token : "valid"
  -> Tries Left? : "invalid"

Tries Left?
  -> Enter TOTP Code : "retry"
  -> Return MFA Error : "no"

Generate Token
  id: generate
  pos: 672, 136, 210, 88
  -> Return Success

Return Success
  id: success
  pos: 320, 72, 180, 72

Return Auth Error
  id: auth-error
  pos: 680, 360, 190, 72

Return MFA Error
`;
