// In-place editing of a node's title: an input overlaid on the canvas exactly where the
// title is drawn, opened by double-clicking that title. Enter or losing focus commits,
// Escape reverts. The canvas suppresses its own painted title for the duration so the two
// never show through each other.
//
// The node is held by id and re-resolved on every access, because undo/redo and external
// file updates reparse the document and replace the node objects.

import type { FlowNode } from '../shared/flow-format.js';
import type { CanvasView } from './canvas/canvas-view.js';
import { positionInlineTitleInput } from './inline-title-overlay.js';

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
    context.view.hiddenTitles.nodeId = node.id;
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
    context.view.hiddenTitles.nodeId = null;
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

    positionInlineTitleInput(input, context.view, placement);
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
