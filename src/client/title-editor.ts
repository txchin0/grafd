// In-place editing of a node's title: an input overlaid on the canvas exactly where the
// title is drawn, opened by double-clicking that title. Enter or losing focus commits,
// Escape reverts. The canvas suppresses its own painted title for the duration so the two
// never show through each other.
//
// The node is held by id and re-resolved on every access, because undo/redo and external
// file updates reparse the document and replace the node objects.

import type { FlowNode } from '../shared/flow-format.js';
import type { CanvasView } from './canvas/canvas-view.js';
import { handFontAt } from './canvas/node-metrics.js';

export interface TitleEditorContext {
  view: CanvasView;
  findNode(nodeId: string): FlowNode | null;
  renameNode(node: FlowNode, requestedName: string): string;
}

export interface TitleEditor {
  open(node: FlowNode): void;
  close(options?: { commit?: boolean }): void;
  reposition(): void;
  refreshFromDoc(): void;
  isOpen(): boolean;
}

// Deeply nested or zoomed-out titles are drawn far too small to type into, so the overlay
// stops shrinking well before the canvas text does.
const MIN_FONT_PX = 11;
const MIN_WIDTH_PX = 90;
const LINE_BOX_RATIO = 1.6;

export function createTitleEditor(context: TitleEditorContext): TitleEditor {
  const input = document.getElementById('title-editor') as HTMLInputElement;
  let editingNodeId: string | null = null;

  function editingNode(): FlowNode | null {
    return editingNodeId ? context.findNode(editingNodeId) : null;
  }

  function isOpen(): boolean {
    return editingNodeId != null;
  }

  function open(node: FlowNode): void {
    if (!node.id) return;
    close();
    editingNodeId = node.id;
    context.view.titleEditingNodeId = node.id;
    input.value = node.name;
    input.classList.remove('hidden');
    reposition();
    input.focus();
    input.select();
    context.view.requestRender();
  }

  // Clearing the editing state before committing keeps the rename's re-render — and the
  // blur it triggers — from re-entering this function.
  function close({ commit = true }: { commit?: boolean } = {}): void {
    if (!isOpen()) return;
    const node = editingNode();
    const requestedName = input.value;
    editingNodeId = null;
    context.view.titleEditingNodeId = null;
    input.classList.add('hidden');
    if (commit && node) context.renameNode(node, requestedName);
    context.view.requestRender();
  }

  function reposition(): void {
    const node = editingNode();
    if (!node) return;
    const placement = context.view.titlePlacementOf(node);
    if (!placement) {
      close();
      return;
    }

    const band = context.view.worldRectToScreen(placement.rect);
    const fontPx = Math.max(MIN_FONT_PX, placement.fontPx * placement.screenScale);
    const width = Math.max(band.w, MIN_WIDTH_PX);
    const height = Math.max(band.h, fontPx * LINE_BOX_RATIO);

    input.style.left = `${Math.round(band.x + band.w / 2 - width / 2)}px`;
    input.style.top = `${Math.round(band.y + band.h / 2 - height / 2)}px`;
    input.style.width = `${Math.round(width)}px`;
    input.style.height = `${Math.round(height)}px`;
    input.style.font = handFontAt(fontPx, 600);
    input.style.textAlign = placement.align;
    input.style.color = placement.color;
  }

  function refreshFromDoc(): void {
    if (!isOpen()) return;
    if (!editingNode()) close({ commit: false });
    else reposition();
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      close();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close({ commit: false });
    }
    event.stopPropagation();
  });
  input.addEventListener('blur', () => close());
  input.addEventListener('pointerdown', (event) => event.stopPropagation());
  input.addEventListener('dblclick', (event) => event.stopPropagation());

  return { open, close, reposition, refreshFromDoc, isOpen };
}
