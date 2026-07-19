// Floating DOM overlays for editing a node (title, description, advanced properties) and an
// edge label. Overlays anchor to canvas geometry and are repositioned after every render.
// Field changes mutate the document immediately through the context callbacks; external file
// updates refresh unfocused fields only, so in-progress typing is never clobbered.

import { getProp, setProp, quoteValue, unquote, collapseToSingleLine, parseListValue, formatListValue } from '/shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';

const EDITOR_GAP = 14;

export function createEditors(context) {
  const elements = {
    container: document.getElementById('canvas-container'),
    nodeEditor: document.getElementById('node-editor'),
    title: document.getElementById('ne-title'),
    description: document.getElementById('ne-description'),
    expand: document.getElementById('ne-expand'),
    onError: document.getElementById('ne-on-error'),
    updates: document.getElementById('ne-updates'),
    entrypoint: document.getElementById('ne-entrypoint'),
    openExpand: document.getElementById('ne-open-expand'),
    deleteNode: document.getElementById('ne-delete'),
    edgeEditor: document.getElementById('edge-editor'),
    edgeLabel: document.getElementById('ee-label'),
    deleteEdge: document.getElementById('ee-delete'),
  };

  let editingNodeId = null;
  let editingEdgeSpec = null;

  function editingNode() {
    return editingNodeId ? FlowDoc.findNodeById(context.getDoc(), editingNodeId) : null;
  }

  function editingEdge() {
    return context.getModel()?.edges.find((edge) => edge.spec === editingEdgeSpec) ?? null;
  }

  function openNodeEditor(node, { focusTitle = false } = {}) {
    closeEdgeEditor();
    editingNodeId = node.id;
    fillNodeFields(node);
    elements.nodeEditor.classList.remove('hidden');
    reposition();
    if (focusTitle) {
      elements.title.focus();
      elements.title.select();
    }
  }

  function fillNodeFields(node) {
    setUnlessFocused(elements.title, node.name);
    setUnlessFocused(elements.description, unquote(getProp(node, 'description')));
    setUnlessFocused(elements.expand, getProp(node, 'expand') ?? '');
    setUnlessFocused(elements.onError, getProp(node, 'on_error') ?? '');
    setUnlessFocused(elements.updates, parseListValue(getProp(node, 'updates')).join(', '));
    elements.entrypoint.checked = getProp(node, 'entrypoint') === 'true';
    elements.openExpand.classList.toggle('hidden', !getProp(node, 'expand'));
  }

  function setUnlessFocused(field, value) {
    if (document.activeElement !== field) field.value = value;
  }

  function openEdgeEditor(edge) {
    closeNodeEditor();
    editingEdgeSpec = edge.spec;
    elements.edgeLabel.value = edge.spec.label ?? '';
    elements.edgeEditor.classList.remove('hidden');
    reposition();
    elements.edgeLabel.focus();
    elements.edgeLabel.select();
  }

  // Closing must flush fields that commit on 'change': a click on the canvas closes the
  // editor before the browser fires blur/change, which would silently drop the edit.
  function closeNodeEditor() {
    commitPendingNodeFields();
    editingNodeId = null;
    elements.nodeEditor.classList.add('hidden');
  }

  function commitPendingNodeFields() {
    const node = editingNode();
    if (!node) return;
    const titleChanged = elements.title.value.trim() && elements.title.value !== node.name;
    const expandChanged = elements.expand.value.trim() !== (getProp(node, 'expand') ?? '');
    const onErrorChanged = elements.onError.value.trim() !== (getProp(node, 'on_error') ?? '');
    const updatesEntries = elements.updates.value.split(',').map((entry) => entry.trim()).filter(Boolean);
    const updatesChanged = updatesEntries.join(', ') !== parseListValue(getProp(node, 'updates')).join(', ');
    if (!titleChanged && !expandChanged && !onErrorChanged && !updatesChanged) return;
    context.apply(() => {
      if (titleChanged) FlowDoc.renameNode(context.getScopeItems(), node, elements.title.value);
      if (expandChanged) setProp(node, 'expand', elements.expand.value.trim() || null);
      if (onErrorChanged) setProp(node, 'on_error', elements.onError.value.trim() || null);
      if (updatesChanged) setProp(node, 'updates', updatesEntries.length ? formatListValue(updatesEntries) : null);
    });
  }

  function closeEdgeEditor() {
    const edge = editingEdge();
    if (edge && (elements.edgeLabel.value.trim() || null) !== (edge.spec.label ?? null)) {
      context.apply(() => FlowDoc.setEdgeLabel(edge, elements.edgeLabel.value));
    }
    editingEdgeSpec = null;
    elements.edgeEditor.classList.add('hidden');
  }

  function closeAll() {
    closeNodeEditor();
    closeEdgeEditor();
  }

  function reposition() {
    const node = editingNode();
    if (node) positionBesideRect(elements.nodeEditor, context.view.worldRectToScreen(node.pos));
    const edge = editingEdge();
    if (edge?.geometry) {
      const mid = context.view.worldToScreen(edge.geometry.mid);
      positionBesideRect(elements.edgeEditor, { x: mid.x, y: mid.y, w: 0, h: 0 });
    }
  }

  function positionBesideRect(editorElement, screenRect) {
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

  function refreshFromDoc() {
    const node = editingNode();
    if (editingNodeId && !node) {
      closeNodeEditor();
    } else if (node) {
      fillNodeFields(node);
    }
    if (editingEdgeSpec && !editingEdge()) closeEdgeEditor();
    reposition();
  }

  function applyToNode(mutate) {
    const node = editingNode();
    if (!node) return;
    context.apply(() => mutate(node));
  }

  elements.title.addEventListener('change', () => {
    const node = editingNode();
    if (!node) return;
    context.apply(() => {
      const finalName = FlowDoc.renameNode(context.getScopeItems(), node, elements.title.value);
      elements.title.value = finalName;
    });
  });
  elements.title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') elements.description.focus();
  });

  elements.description.addEventListener('input', () => {
    applyToNode((node) => {
      const text = collapseToSingleLine(elements.description.value);
      setProp(node, 'description', text ? quoteValue(text) : null);
    });
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

  elements.deleteNode.addEventListener('click', () => {
    const node = editingNode();
    if (!node) return;
    closeNodeEditor();
    context.deleteNodes([node]);
  });

  function commitEdgeLabel() {
    const edge = editingEdge();
    if (!edge) return;
    context.apply(() => FlowDoc.setEdgeLabel(edge, elements.edgeLabel.value));
  }

  elements.edgeLabel.addEventListener('change', commitEdgeLabel);
  elements.edgeLabel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      commitEdgeLabel();
      closeEdgeEditor();
    }
  });

  elements.deleteEdge.addEventListener('click', () => {
    const edge = editingEdge();
    if (!edge) return;
    closeEdgeEditor();
    context.apply(() => FlowDoc.deleteEdge(edge));
  });

  for (const editorElement of [elements.nodeEditor, elements.edgeEditor]) {
    editorElement.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAll();
      event.stopPropagation();
    });
  }

  return { openNodeEditor, openEdgeEditor, closeAll, reposition, refreshFromDoc, editingNode };
}
