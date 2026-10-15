import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/client/flow-doc.js';
import { placeAroundPinned } from '../src/shared/anchored-placement.js';
import { parseFlow, type Rect } from '../src/shared/flow-format.js';
import { scoreDocumentText } from '../src/shared/document-score.js';
import { NODE_GAP } from '../src/shared/layered-coordinates.js';
import { layOutLayered, RANK_GAP, rankGapFor } from '../src/shared/layered-layout.js';
import { CANVAS_SNAP, padRect, rectCenter, regionRectFrom } from '../src/shared/rect-math.js';
import { arbitraryGraph, overlaps, rectsByName } from './layout-fixtures.js';

const middleOf = (rect: Rect): number => rectCenter(rect).y;

describe('a new node beside placed ones', () => {
  it('follows the node it comes after, a rank on and level with it', () => {
    const rects = rectsByName('A\n  pos: 400, 400, 200, 88\n  -> B\n\nB\n');
    const b = rects.get('B')!;
    expect(b.x).toBe(400 + 200 + RANK_GAP);
    expect(middleOf(b)).toBe(400 + 44);
  });

  it('leaves room for the label of the edge it follows', () => {
    const label = 'the user fills the form and taps the login button';
    const rects = rectsByName(`A\n  pos: 400, 400, 200, 88\n  -> B : "${label}"\n\nB\n`);
    expect(rects.get('B')!.x).toBe(400 + 200 + rankGapFor([label], 'LR'));
  });

  it('comes a rank before the node it leads to', () => {
    const rects = rectsByName('B\n  -> A\n\nA\n  pos: 800, 400, 200, 88\n');
    const b = rects.get('B')!;
    expect(b.x + b.w + RANK_GAP).toBe(800);
    expect(middleOf(b)).toBe(400 + 44);
  });

  it('takes the column after its predecessor even when it also has a successor', () => {
    const rects = rectsByName('A\n  pos: 0, 0, 200, 88\n  -> B\n\nB\n  -> C\n\nC\n  pos: 1000, 0, 200, 88\n');
    const b = rects.get('B')!;
    expect(b.x).toBe(200 + RANK_GAP);
    expect(b.y).toBe(0);
  });

  it('keeps to the column grid when its successor stands in the very next column', () => {
    const rects = rectsByName('A\n  pos: 0, 0, 200, 88\n  -> B\n\nB\n  -> C\n\nC\n  pos: 296, 0, 200, 88\n');
    const b = rects.get('B')!;
    expect(b.x).toBe(296);
    expect(overlaps(b, rects.get('C')!)).toBe(false);
  });

  it('slides across the flow when its spot is taken, keeping a full gap', () => {
    const rects = rectsByName('A\n  pos: 0, 0, 200, 88\n  -> B\n\nB\n\nC\n  pos: 296, 0, 200, 88\n');
    const b = rects.get('B')!;
    expect(b.x).toBe(296);
    expect(overlaps(padRect(b, NODE_GAP / 2), padRect(rects.get('C')!, NODE_GAP / 2))).toBe(false);
  });

  it('runs down the page when the placed graph does', () => {
    const rects = rectsByName('A\n  pos: 0, 0, 200, 88\n  -> C\n\nC\n  pos: 0, 296, 200, 88\n  -> D\n\nD\n');
    const d = rects.get('D')!;
    expect(d.y).toBe(296 + 88 + RANK_GAP);
    expect(Math.abs(rectCenter(d).x - 100)).toBeLessThanOrEqual(CANVAS_SNAP / 2);
  });

  it('brings a chain of new nodes as one laid-out block', () => {
    const rects = rectsByName('A\n  pos: 0, 0, 200, 88\n  -> B\n\nB\n  -> C\n\nC\n');
    const [b, c] = ['B', 'C'].map((name) => rects.get(name)!);
    expect(b.y).toBe(0);
    expect(c.y).toBe(0);
    expect(c.x).toBe(b.x + b.w + RANK_GAP);
  });
});

describe('a new node and the regions', () => {
  it('stays out of a region it is not a member of', () => {
    const text = 'context: Cart\n  pos: 0, 0, 800, 400\n  nodes:\n    - A\n\nA\n  pos: 0, 0, 200, 88\n  -> B\n\nB\n';
    const rects = rectsByName(text);
    expect(overlaps(rects.get('B')!, { x: 0, y: 0, w: 800, h: 400 })).toBe(false);
  });

  it('grows its own region only where no outsider stands', () => {
    const text = [
      'context: Cart\n  nodes:\n    - A\n    - B',
      'A\n  pos: 0, 0, 200, 88',
      'Outsider\n  pos: 0, 200, 200, 88',
      'P\n  pos: 0, 400, 200, 88\n  -> B',
      'B',
    ].join('\n\n');
    const rects = rectsByName(text);
    const cart = regionRectFrom(null, [rects.get('A')!, rects.get('B')!])!;
    expect(overlaps(cart, rects.get('Outsider')!)).toBe(false);
  });
});

describe('a new region member', () => {
  it('grows its region only where it does not run into another region', () => {
    // B's own spot, beside A, is taken by X; sliding down would stretch Cart into Stock below.
    const text = [
      'context: Cart\n  nodes:\n    - A\n    - X\n    - B',
      'context: Stock\n  pos: 296, 200, 400, 200\n  nodes:\n    - S',
      'A\n  pos: 0, 0, 200, 88\n  -> B',
      'X\n  pos: 296, 0, 200, 88',
      'B',
      'S\n  pos: 400, 280, 160, 88',
    ].join('\n\n');
    const rects = rectsByName(text);
    const cart = regionRectFrom(null, ['A', 'X', 'B'].map((name) => rects.get(name)!))!;
    const stock = regionRectFrom({ x: 296, y: 200, w: 400, h: 200 }, [rects.get('S')!])!;
    expect(rects.get('B')!.y).toBeLessThan(0);
    expect(overlaps(cart, stock)).toBe(false);
  });

  it('is placed before a new node that belongs to no region takes its spot', () => {
    const text = [
      'context: Cart\n  nodes:\n    - A\n    - Member',
      'A\n  pos: 0, 0, 200, 88\n  -> Outsider\n  -> Member',
      'Outsider',
      'Member',
    ].join('\n\n');
    const rects = rectsByName(text);
    expect(rects.get('Member')!.y).toBe(0);
  });
});

// A login graph laid out by hand, with an MFA branch added after "Authenticate". Placed beside it
// as one block, the branch's edges ran through "Generate Token" and its retry loop's label lay on
// "Code Valid?".
const MFA_ADDED_TO_A_PLACED_LOGIN = `Validate Input
  pos: 80, 232, 200, 88
  -> Authenticate : "input valid"
  -> Return Validation Error : "input invalid"

Authenticate
  pos: 368, 224, 200, 96
  -> MFA Enabled? : "credentials valid"
  -> Return Auth Error : "credentials invalid"

MFA Enabled?
  -> Enter TOTP Code : "yes"
  -> Generate Token : "no"

Enter TOTP Code
  -> Code Valid?

Code Valid?
  -> Generate Token : "valid"
  -> Tries Left? : "invalid"

Tries Left?
  -> Enter TOTP Code : "retry"
  -> Return MFA Error : "no"

Generate Token
  pos: 672, 136, 210, 88
  -> Return Success

Return Success
  pos: 320, 72, 180, 72

Return Validation Error
  pos: 376, 448, 190, 72

Return Auth Error
  pos: 680, 360, 190, 72

Return MFA Error
`;

describe('new nodes polished among placed ones', () => {
  it('steps them aside until no edge of theirs runs through a node or a label lies on one', () => {
    const [body] = scoreDocumentText(MFA_ADDED_TO_A_PLACED_LOGIN, null);
    expect(body.current.counts['edge-through-node']).toBe(0);
    expect(body.current.findings.filter((finding) => finding.kind === 'label-collision' && finding.message.includes('Code Valid?'))).toEqual([]);
  });

  it('moves none of the placed nodes', () => {
    const rects = rectsByName(MFA_ADDED_TO_A_PLACED_LOGIN);
    expect(rects.get('Generate Token')).toEqual({ x: 672, y: 136, w: 210, h: 88 });
    expect(rects.get('Return Success')).toEqual({ x: 320, y: 72, w: 180, h: 72 });
  });
});

describe('placeAroundPinned on any graph', () => {
  const partlyPlaced = arbitraryGraph.chain((graph) =>
    fc.array(fc.boolean(), { minLength: graph.nodes.length, maxLength: graph.nodes.length }).map((keep) => {
      const laidOut = layOutLayered(graph, 'LR', { x: 80, y: 80 });
      return { ...graph, pins: laidOut.map((rect, node) => (keep[node] ? rect : null)), regionAreas: graph.regions.map(() => null) };
    }));

  it('never moves a placed node, and places every new one a full gap from every other', () => {
    fc.assert(fc.property(partlyPlaced, (graph) => {
      fc.pre(graph.pins.some((pin) => pin) && graph.pins.some((pin) => !pin));
      const rects = placeAroundPinned(graph);
      expect(placeAroundPinned(graph)).toEqual(rects);
      graph.pins.forEach((pin, node) => {
        if (pin) expect(rects[node]).toEqual(pin);
      });
      rects.forEach((rect, node) => {
        if (graph.pins[node]) return;
        rects.forEach((other, otherNode) => {
          if (otherNode !== node) expect(overlaps(padRect(rect, NODE_GAP / 2 - 1), padRect(other, NODE_GAP / 2 - 1))).toBe(false);
        });
      });
    }));
  });
});

describe('placeNodes in a partly laid-out file', () => {
  it('places nodes where the canvas does, read from the file the way the linter reads it', () => {
    const text = [
      '---\nname: Checkout\n---',
      'context: Payment\n  nodes:\n    - Charge Card\n    - Refund',
      'Cart\n  pos: 80, 80, 200, 88\n  -> Charge Card : "pay"',
      'Charge Card\n  pos: 376, 80, 200, 88\n  on_error: -> Refund\n  -> Receipt',
      'Receipt\n  description: "Emails the receipt"\n  -> Cart : "shop again"',
      'Refund',
      'Lost\n  -> Nowhere',
    ].join('\n\n');
    const model = buildModel(parseFlow(text), null);
    const linterRects = rectsByName(text);
    for (const node of model.nodes) expect(node.pos).toEqual(linterRects.get(node.name));
  });
});
