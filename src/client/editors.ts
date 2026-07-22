// Floating DOM overlays for editing a node (title, description, advanced properties) and an
// edge label. Overlays anchor to canvas geometry and are repositioned after every render.
// Field changes mutate the document immediately through the context callbacks; external file
// updates refresh unfocused fields only, so in-progress typing is never clobbered.

import {
  getProp,
  setProp,
  quoteValue,
  collapseToSingleLine,
  parseListValue,
  formatListValue,
  type EdgeSpec,
  type FlowNode,
  type Rect,
} from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import type { ModelEdge } from './flow-doc.js';
import type { CanvasView } from './canvas-view.js';

export interface EditorContext {
  view: CanvasView;
  findNode(nodeId: string): FlowNode | null;
  findEdge(spec: EdgeSpec): ModelEdge | null;
  renameNode(node: FlowNode, requestedName: string): string;
  applyEdit(node: FlowNode, mutation: () => void): void;
  applyEditNow(node: FlowNode, mutation: () => void): void;
  // External expand targets store description in the target file's preamble.
  descriptionOf(node: FlowNode): string;
  applyDescriptionEdit(node: FlowNode, text: string): void;
  ensureExpandTarget(node: FlowNode): Promise<void>;
  ensureInnerTargets(edge: ModelEdge): Promise<void>;
  canOpen(node: FlowNode): boolean;
  openExpand(node: FlowNode): void;
  toggleExpand(node: FlowNode): void;
  deleteNodes(nodes: FlowNode[]): void;
  innerTargetOptions(edge: ModelEdge): string[];
}

export interface Editors {
  openNodeEditor(node: FlowNode, options?: { focusTitle?: boolean }): void;
  openEdgeEditor(edge: ModelEdge): void;
  closeAll(): void;
  reposition(): void;
  refreshFromDoc(): void;
  editingNode(): FlowNode | null;
}

const EDITOR_GAP = 14;

function elementById<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export function createEditors(context: EditorContext): Editors {
  const elements = {
    container: elementById<HTMLDivElement>('canvas-container'),
    nodeEditor: elementById<HTMLDivElement>('node-editor'),
    title: elementById<HTMLInputElement>('ne-title'),
    description: elementById<HTMLTextAreaElement>('ne-description'),
    expand: elementById<HTMLInputElement>('ne-expand'),
    onError: elementById<HTMLInputElement>('ne-on-error'),
    updates: elementById<HTMLInputElement>('ne-updates'),
    entrypoint: elementById<HTMLInputElement>('ne-entrypoint'),
    openExpand: elementById<HTMLButtonElement>('ne-open-expand'),
    inlineExpand: elementById<HTMLButtonElement>('ne-inline-expand'),
    deleteNode: elementById<HTMLButtonElement>('ne-delete'),
    edgeEditor: elementById<HTMLDivElement>('edge-editor'),
    edgeLabel: elementById<HTMLInputElement>('ee-label'),
    edgeInnerTarget: elementById<HTMLSelectElement>('ee-inner-target'),
    deleteEdge: elementById<HTMLButtonElement>('ee-delete'),
  };

  let editingNodeId: string | null = null;
  let editingEdgeSpec: EdgeSpec | null = null;

  function editingNode(): FlowNode | null {
    return editingNodeId ? context.findNode(editingNodeId) : null;
  }

  function editingEdge(): ModelEdge | null {
    return editingEdgeSpec ? context.findEdge(editingEdgeSpec) : null;
  }

  function openNodeEditor(node: FlowNode, { focusTitle = false }: { focusTitle?: boolean } = {}): void {
    closeEdgeEditor();
    editingNodeId = node.id;
    fillNodeFields(node);
    elements.nodeEditor.classList.remove('hidden');
    reposition();
    void context.ensureExpandTarget(node).then(() => {
      if (editingNodeId === node.id) fillNodeFields(node);
    });
    if (focusTitle) {
      elements.title.focus();
      elements.title.select();
    }
  }

  function fillNodeFields(node: FlowNode): void {
    setUnlessFocused(elements.title, node.name);
    setUnlessFocused(elements.description, context.descriptionOf(node));
    setUnlessFocused(elements.expand, getProp(node, 'expand') ?? '');
    setUnlessFocused(elements.onError, getProp(node, 'on_error') ?? '');
    setUnlessFocused(elements.updates, parseListValue(getProp(node, 'updates')).join(', '));
    elements.entrypoint.checked = getProp(node, 'entrypoint') === 'true';
    const lacksExpand = !getProp(node, 'expand');
    elements.openExpand.classList.toggle('hidden', lacksExpand || !context.canOpen(node));
    elements.inlineExpand.classList.toggle('hidden', lacksExpand);
  }

  function setUnlessFocused(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    if (document.activeElement !== field) field.value = value;
  }

  function openEdgeEditor(edge: ModelEdge): void {
    closeNodeEditor();
    editingEdgeSpec = edge.spec;
    elements.edgeLabel.value = edge.spec.label ?? '';
    fillInnerTargetSelect(edge);
    elements.edgeEditor.classList.remove('hidden');
    reposition();
    elements.edgeLabel.focus();
    elements.edgeLabel.select();
    void context.ensureInnerTargets(edge).then(() => {
      if (editingEdgeSpec === edge.spec) fillInnerTargetSelect(edge);
    });
  }

  function fillInnerTargetSelect(edge: ModelEdge): void {
    const options = edge.kind === 'flow' ? context.innerTargetOptions(edge) : [];
    const select = elements.edgeInnerTarget;
    select.replaceChildren();
    const current = edge.spec.innerTarget;
    if (options.length === 0 && !current) {
      select.classList.add('hidden');
      return;
    }
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '(entry point)';
    select.append(blank);
    const names = current && !options.includes(current) ? [...options, current] : options;
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.append(option);
    }
    select.value = current ?? '';
    select.classList.remove('hidden');
  }

  // Closing must flush fields that commit on 'change': a click on the canvas closes the
  // editor before the browser fires blur/change, which would silently drop the edit.
  function closeNodeEditor(): void {
    commitPendingNodeFields();
    editingNodeId = null;
    elements.nodeEditor.classList.add('hidden');
  }

  function commitPendingNodeFields(): void {
    const node = editingNode();
    if (!node) return;
    const titleChanged = Boolean(elements.title.value.trim()) && elements.title.value !== node.name;
    const expandChanged = elements.expand.value.trim() !== (getProp(node, 'expand') ?? '');
    const onErrorChanged = elements.onError.value.trim() !== (getProp(node, 'on_error') ?? '');
    const updatesEntries = elements.updates.value.split(',').map((entry) => entry.trim()).filter(Boolean);
    const updatesChanged = updatesEntries.join(', ') !== parseListValue(getProp(node, 'updates')).join(', ');
    if (titleChanged) {
      elements.title.value = context.renameNode(node, elements.title.value);
    }
    if (!expandChanged && !onErrorChanged && !updatesChanged) return;
    context.applyEdit(node, () => {
      if (expandChanged) setProp(node, 'expand', elements.expand.value.trim() || null);
      if (onErrorChanged) setProp(node, 'on_error', elements.onError.value.trim() || null);
      if (updatesChanged) setProp(node, 'updates', updatesEntries.length ? formatListValue(updatesEntries) : null);
    });
  }

  function closeEdgeEditor(): void {
    const edge = editingEdge();
    if (edge && (elements.edgeLabel.value.trim() || null) !== (edge.spec.label ?? null)) {
      context.applyEdit(edge.from, () => FlowDoc.setEdgeLabel(edge, elements.edgeLabel.value));
    }
    editingEdgeSpec = null;
    elements.edgeEditor.classList.add('hidden');
  }

  function closeAll(): void {
    closeNodeEditor();
    closeEdgeEditor();
  }

  function reposition(): void {
    const node = editingNode();
    if (node) positionBesideRect(elements.nodeEditor, context.view.worldRectToScreen(context.view.rect(node)));
    const edge = editingEdge();
    if (edge?.geometry) {
      const mid = context.view.worldToScreen(context.view.edgeAnchor(edge));
      positionBesideRect(elements.edgeEditor, { x: mid.x, y: mid.y, w: 0, h: 0 });
    }
  }

  function positionBesideRect(editorElement: HTMLElement, screenRect: Rect): void {
    const containerBounds = elements.container.getBoundingClientRect();
    const editorWidth = editorElement.offsetWidth || 264;
    const editorHeight = editorElement.offsetHeight || 180;

    let left = screenRect.x + screenRect.w + EDITOR_GAP;
    if (left + editorWidth > containerBounds.width - 8) {
      left = screenRect.x - editorWidth - EDITOR_GAP;
    }
    left = Math.max(8, Math.min(left, containerBounds.width - editorWidth - 8));
    const top = Math.max(8, Math.min(screenRect.y, containerBounds.height - editorHeight - 8));
    editorElement.style.left = `${Math.round(left)}px`;
    editorElement.style.top = `${Math.round(top)}px`;
  }

  function refreshFromDoc(): void {
    const node = editingNode();
    if (editingNodeId && !node) {
      closeNodeEditor();
    } else if (node) {
      fillNodeFields(node);
    }
    if (editingEdgeSpec && !editingEdge()) closeEdgeEditor();
    else if (editingEdge()) fillInnerTargetSelect(editingEdge()!);
    reposition();
  }

  function applyToNode(mutate: (node: FlowNode) => void): void {
    const node = editingNode();
    if (!node) return;
    context.applyEdit(node, () => mutate(node));
  }

  elements.title.addEventListener('change', () => {
    const node = editingNode();
    if (!node) return;
    elements.title.value = context.renameNode(node, elements.title.value);
  });
  elements.title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') elements.description.focus();
  });

  elements.description.addEventListener('input', () => {
    const node = editingNode();
    if (!node) return;
    context.applyDescriptionEdit(node, collapseToSingleLine(elements.description.value));
  });

  elements.expand.addEventListener('change', () => {
    applyToNode((node) => {
      setProp(node, 'expand', elements.expand.value.trim() || null);
      elements.openExpand.classList.toggle('hidden', !elements.expand.value.trim());
    });
  });

  elements.onError.addEventListener('change', () => {
    applyToNode((node) => setProp(node, 'on_error', elements.onError.value.trim() || null));
  });

  elements.updates.addEventListener('change', () => {
    applyToNode((node) => {
      const entries = elements.updates.value.split(',').map((entry) => entry.trim()).filter(Boolean);
      setProp(node, 'updates', entries.length ? formatListValue(entries) : null);
    });
  });

  elements.entrypoint.addEventListener('change', () => {
    applyToNode((node) => setProp(node, 'entrypoint', elements.entrypoint.checked ? 'true' : null));
  });

  elements.openExpand.addEventListener('click', () => {
    const node = editingNode();
    if (node) context.openExpand(node);
  });

  elements.inlineExpand.addEventListener('click', () => {
    const node = editingNode();
    if (node) context.toggleExpand(node);
  });

  elements.deleteNode.addEventListener('click', () => {
    const node = editingNode();
    if (!node) return;
    closeNodeEditor();
    context.deleteNodes([node]);
  });

  function commitEdgeLabel(): void {
    const edge = editingEdge();
    if (!edge) return;
    context.applyEdit(edge.from, () => FlowDoc.setEdgeLabel(edge, elements.edgeLabel.value));
  }

  elements.edgeLabel.addEventListener('change', commitEdgeLabel);
  elements.edgeLabel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      commitEdgeLabel();
      closeEdgeEditor();
    }
  });

  elements.edgeInnerTarget.addEventListener('change', () => {
    const edge = editingEdge();
    if (!edge) return;
    const value = elements.edgeInnerTarget.value || null;
    context.applyEdit(edge.from, () => FlowDoc.setEdgeInnerTarget(edge, value));
  });

  elements.deleteEdge.addEventListener('click', () => {
    const edge = editingEdge();
    if (!edge) return;
    closeEdgeEditor();
    context.applyEditNow(edge.from, () => FlowDoc.deleteEdge(edge));
  });

  for (const editorElement of [elements.nodeEditor, elements.edgeEditor]) {
    editorElement.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAll();
      event.stopPropagation();
    });
  }

  return { openNodeEditor, openEdgeEditor, closeAll, reposition, refreshFromDoc, editingNode };
}
