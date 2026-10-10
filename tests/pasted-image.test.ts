// An image off the system clipboard, end to end through the real editor core: where a paste puts
// it, and what an in-app copy leaves on the system clipboard so that the latest copy wins a paste.

import { afterEach, describe, expect, it } from 'vitest';
import { canvasLayerPathOf, parseCanvasLayer } from '../src/shared/canvas-layer.js';
import { createHeadlessEditor, disposeHeadlessEditor } from './editor-harness.js';
import { SESSION_FLOW_PATH, sessionWorkspaceFiles } from './session-fixtures.js';
import { PASTED_IMAGES } from './session-actions.js';

afterEach(() => disposeHeadlessEditor());

async function openSession() {
  return createHeadlessEditor(sessionWorkspaceFiles(), { open: SESSION_FLOW_PATH });
}

describe('pasting an image', () => {
  it('lands centred on the point, selected, in one undo step', async () => {
    const editor = await openSession();
    const before = parseCanvasLayer(editor.workspace.file(canvasLayerPathOf(SESSION_FLOW_PATH))).drawings.length;
    await editor.pasteImage(PASTED_IMAGES[0], { x: -500, y: -400 });
    const drawings = parseCanvasLayer(editor.workspace.file(canvasLayerPathOf(SESSION_FLOW_PATH))).drawings;
    expect(drawings).toHaveLength(before + 1);
    const pasted = drawings.at(-1)!;
    const [x, y, w, h] = pasted.box as number[];
    expect({ kind: pasted.kind, centre: { x: x + w / 2, y: y + h / 2 }, proportion: w / h }).toEqual({ kind: 'image', centre: { x: -500, y: -400 }, proportion: 1.5 });
    expect(editor.core.view.selectedDrawings.map((drawing) => drawing.id)).toEqual([pasted.id]);
    editor.core.runCommand('undo');
    await editor.settle();
    expect(parseCanvasLayer(editor.workspace.file(canvasLayerPathOf(SESSION_FLOW_PATH))).drawings).toHaveLength(before);
  });
});

describe('what a copy leaves on the system clipboard', () => {
  it('is the names of the nodes copied', async () => {
    const editor = await openSession();
    const { view } = editor.core;
    view.setSelection(view.model.nodes.filter((node) => node.name === 'Alpha' || node.name === 'Gamma'));
    expect(editor.core.runCommand('copy')).toBe(true);
    expect(editor.core.clipboard.plainText()).toBe('Alpha\nGamma');
  });

  it('is never empty, even for drawings with no words', async () => {
    const editor = await openSession();
    await editor.pasteImage(PASTED_IMAGES[0], { x: -500, y: -400 });
    expect(editor.core.runCommand('copy')).toBe(true);
    expect(editor.core.clipboard.plainText()).toBe('1 drawing');
  });
});
