// Floating DOM overlays for editing a node (title, description, advanced properties) and an
// edge (label, subgraph refinements, data schema). Overlays anchor to canvas geometry and are repositioned after every render.
// Field changes mutate the document immediately through the context callbacks; external file
// updates refresh unfocused fields only, so in-progress typing is never clobbered.

import {
  getProp,
  setProp,
  quoteValue,
  collapseToSingleLine,
  parseListValue,
  formatListValue,
  type EdgeDataField,
  type EdgeSpec,
  type FlowNode,
  type Rect,
  type Reference,
} from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import type { ModelEdge } from './flow-doc.js';
import type { CanvasView, RegionTarget } from './canvas/canvas-view.js';
import { createTitleEditor } from './title-editor.js';
import { createReferenceRows } from './reference-rows.js';
import type { LinkContext } from './reference-link.js';

export interface EditorContext {
  view: CanvasView;
  regionDescriptionOf(region: RegionTarget): string;
  applyRegionDescriptionEdit(region: RegionTarget, text: string): void;
  regionReferencesOf(region: RegionTarget): Reference[];
  applyRegionReferencesEdit(region: RegionTarget, references: Reference[]): void;
  // A member entry is a way back to the node on canvas, never a way to change the list (R17/R35).
  selectMember(region: RegionTarget, memberName: string): void;
  deleteRegion(region: RegionTarget): void;
  // Every provider this node may read, and whether it arrives from the graph above (R37).
  readableContexts(node: FlowNode): { name: string; inherited: boolean }[];
  findNode(nodeId: string): FlowNode | null;
  findEdge(spec: EdgeSpec): ModelEdge | null;
  renameNode(node: FlowNode, requestedName: string): string;
  applyEdit(node: FlowNode, mutation: () => void): void;
  applyEditNow(node: FlowNode, mutation: () => void): void;
  // Editing `expand` can rename the target block rather than repoint the node, so the shell
  // decides and reports back the value that was actually written.
  applyExpandEdit(node: FlowNode, requestedValue: string): string;
  expandOptions(node: FlowNode): string[];
  // External expand targets store description and references in the target file's preamble.
  descriptionOf(node: FlowNode): string;
  applyDescriptionEdit(node: FlowNode, text: string): void;
  referencesOf(node: FlowNode): Reference[];
  applyReferencesEdit(node: FlowNode, references: Reference[]): void;
  linkContext(): LinkContext;
  ensureExpandTarget(node: FlowNode): Promise<void>;
  ensureInnerTargets(edge: ModelEdge): Promise<void>;
  ensureInnerSources(edge: ModelEdge): Promise<void>;
  openExpand(node: FlowNode): void;
  toggleExpand(node: FlowNode): void;
  deleteNodes(nodes: FlowNode[]): void;
  innerTargetOptions(edge: ModelEdge): string[];
  innerSourceOptions(edge: ModelEdge): string[];
}

export interface Editors {
  openNodeEditor(node: FlowNode, options?: { focusTitle?: boolean }): void;
  openEdgeEditor(edge: ModelEdge): void;
  openRegionEditor(region: RegionTarget): void;
  openTitleEditor(node: FlowNode): void;
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
    expandOptions: elementById<HTMLDataListElement>('ne-expand-options'),
    referenceRows: elementById<HTMLDivElement>('ne-reference-rows'),
    addReference: elementById<HTMLButtonElement>('ne-add-reference'),
    openExpand: elementById<HTMLButtonElement>('ne-open-expand'),
    inlineExpand: elementById<HTMLButtonElement>('ne-inline-expand'),
    deleteNode: elementById<HTMLButtonElement>('ne-delete'),
    updatesOptions: elementById<HTMLDataListElement>('ne-updates-options'),
    updatesError: elementById<HTMLParagraphElement>('ne-updates-error'),
    nodeContexts: elementById<HTMLParagraphElement>('ne-contexts'),
    regionEditor: elementById<HTMLDivElement>('region-editor'),
    regionName: elementById<HTMLParagraphElement>('re-name'),
    regionDescription: elementById<HTMLTextAreaElement>('re-description'),
    regionReferenceRows: elementById<HTMLDivElement>('re-reference-rows'),
    regionAddReference: elementById<HTMLButtonElement>('re-add-reference'),
    regionMembers: elementById<HTMLUListElement>('re-member-list'),
    regionDelete: elementById<HTMLButtonElement>('re-delete'),
    edgeEditor: elementById<HTMLDivElement>('edge-editor'),
    edgeLabel: elementById<HTMLInputElement>('ee-label'),
    edgeInnerSource: elementById<HTMLSelectElement>('ee-inner-source'),
    edgeInnerTarget: elementById<HTMLSelectElement>('ee-inner-target'),
    edgeData: elementById<HTMLDivElement>('ee-data'),
    edgeDataRows: elementById<HTMLDivElement>('ee-data-rows'),
    addDataField: elementById<HTMLButtonElement>('ee-add-field'),
    deleteEdge: elementById<HTMLButtonElement>('ee-delete'),
  };

  const titleEditor = createTitleEditor(context);

  const referenceRows = createReferenceRows({
    rows: elements.referenceRows,
    addButton: elements.addReference,
    linkContext: () => context.linkContext(),
    commit: (references) => {
      const node = editingNode();
      if (node) context.applyReferencesEdit(node, references);
    },
    afterRowAdded: () => reposition(),
  });

  const regionReferenceRows = createReferenceRows({
    rows: elements.regionReferenceRows,
    addButton: elements.regionAddReference,
    linkContext: () => context.linkContext(),
    commit: (references) => {
      if (editingRegion) context.applyRegionReferencesEdit(editingRegion, references);
    },
    afterRowAdded: () => reposition(),
  });

  let editingNodeId: string | null = null;
  let editingEdgeSpec: EdgeSpec | null = null;
  // Held as the target it was opened with rather than by name: the block object survives the
  // renders that replace the model, and a rename keeps editing the same block.
  let editingRegion: RegionTarget | null = null;

  function editingNode(): FlowNode | null {
    return editingNodeId ? context.findNode(editingNodeId) : null;
  }

  function editingEdge(): ModelEdge | null {
    return editingEdgeSpec ? context.findEdge(editingEdgeSpec) : null;
  }

  function openTitleEditor(node: FlowNode): void {
    closeNodeEditor();
    closeEdgeEditor();
    closeRegionEditor();
    titleEditor.open(node);
  }

  function openNodeEditor(node: FlowNode, { focusTitle = false }: { focusTitle?: boolean } = {}): void {
    titleEditor.close();
    closeEdgeEditor();
    closeRegionEditor();
    editingNodeId = node.id;
    elements.referenceRows.replaceChildren();
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
    fillExpandOptions(node);
    setUnlessFocused(elements.onError, getProp(node, 'on_error') ?? '');
    setUnlessFocused(elements.updates, parseListValue(getProp(node, 'updates')).join(', '));
    fillReadableContexts(node);
    elements.entrypoint.checked = getProp(node, 'entrypoint') === 'true';
    referenceRows.fill(context.referencesOf(node));
    const lacksExpand = !getProp(node, 'expand');
    elements.openExpand.classList.toggle('hidden', lacksExpand);
    elements.inlineExpand.classList.toggle('hidden', lacksExpand);
  }

  // Read access is implicit and not editable here: the regions listing this node, plus whatever
  // the file inherits (R37). An inherited provider is marked, since a member carrying `expand`
  // passes what it reads into its own expansion (R39).
  function fillReadableContexts(node: FlowNode): void {
    const readable = context.readableContexts(node);
    const named = readable.map((entry) => (entry.inherited ? `${entry.name} (inherited)` : entry.name));
    const passesDown = readable.length > 0 && getProp(node, 'expand') != null;
    elements.nodeContexts.textContent = readable.length === 0
      ? 'reads no context'
      : `reads ${named.join(', ')}${passesDown ? ' — its expansion inherits them' : ''}`;
    elements.updatesOptions.replaceChildren(...readable.map((entry) => {
      const option = document.createElement('option');
      option.value = entry.name;
      return option;
    }));
    reportUnreadableUpdates(node, readable.map((entry) => entry.name));
  }

  // A node may only update what it can read (spec §8.6). A value already in the file that names
  // something else is shown as the error it is, and the fix is membership — never widened here.
  function reportUnreadableUpdates(node: FlowNode, readableNames: string[]): void {
    const unreadable = parseListValue(getProp(node, 'updates')).filter((name) => !readableNames.includes(name));
    showUpdatesError(unreadable.length === 0
      ? null
      : `${unreadable.join(', ')} is not readable by "${node.name}". Drag the node into that region to give it access.`);
  }

  function showUpdatesError(message: string | null): void {
    elements.updatesError.textContent = message ?? '';
    elements.updatesError.classList.toggle('hidden', message == null);
  }

  function setUnlessFocused(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    if (document.activeElement !== field) field.value = value;
  }

  // Offering the file's `graph:` blocks is what separates the two intents behind an edit to
  // this field: picking a listed name repoints the node, typing an unlisted one renames.
  function fillExpandOptions(node: FlowNode): void {
    elements.expandOptions.replaceChildren(
      ...context.expandOptions(node).map((blockName) => {
        const option = document.createElement('option');
        option.value = blockName;
        return option;
      }),
    );
  }

  // A region has no title of its own here: the name is edited in place on the canvas, and `pos`
  // is not a field at all — an area is what the user drew, not a number to type (R36).
  function openRegionEditor(region: RegionTarget): void {
    titleEditor.close();
    closeNodeEditor();
    closeEdgeEditor();
    editingRegion = region;
    elements.regionReferenceRows.replaceChildren();
    fillRegionFields(region);
    elements.regionEditor.classList.remove('hidden');
    reposition();
  }

  function fillRegionFields(region: RegionTarget): void {
    elements.regionName.textContent = `context: ${region.block.name}`;
    setUnlessFocused(elements.regionDescription, context.regionDescriptionOf(region));
    regionReferenceRows.fill(context.regionReferencesOf(region));
    fillRegionMembers(region);
  }

  // A member naming a node that is not in the file is shown as the dangling entry it is rather
  // than hidden: the file says the provider reaches it, and only the file can say otherwise.
  function fillRegionMembers(region: RegionTarget): void {
    elements.regionMembers.replaceChildren(...region.block.members.map((memberName) => {
      const entry = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = memberName;
      const exists = FlowDoc.nodesIn(region.doc.items).some((node) => node.name === memberName);
      if (exists) button.addEventListener('click', () => context.selectMember(region, memberName));
      else {
        button.classList.add('missing');
        button.title = 'No node of this name is declared in this file';
      }
      entry.appendChild(button);
      return entry;
    }));
    if (region.block.members.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'field-note';
      empty.textContent = 'No nodes yet — nothing can read this context.';
      elements.regionMembers.appendChild(empty);
    }
  }

  function closeRegionEditor(): void {
    editingRegion = null;
    elements.regionEditor.classList.add('hidden');
  }

  function openEdgeEditor(edge: ModelEdge): void {
    titleEditor.close();
    closeNodeEditor();
    closeRegionEditor();
    editingEdgeSpec = edge.spec;
    elements.edgeLabel.value = edge.spec.label ?? '';
    elements.edgeDataRows.replaceChildren();
    fillRefinementSelects(edge);
    fillDataFields(edge);
    elements.edgeEditor.classList.remove('hidden');
    reposition();
    elements.edgeLabel.focus();
    elements.edgeLabel.select();
    void Promise.all([context.ensureInnerTargets(edge), context.ensureInnerSources(edge)]).then(() => {
      if (editingEdgeSpec === edge.spec) fillRefinementSelects(edge);
    });
  }

  function fillRefinementSelects(edge: ModelEdge): void {
    fillRefinementSelect(
      elements.edgeInnerSource,
      edge.kind === 'flow' ? context.innerSourceOptions(edge) : [],
      edge.spec.innerSource,
      '(exit point)',
    );
    fillRefinementSelect(
      elements.edgeInnerTarget,
      edge.kind === 'flow' ? context.innerTargetOptions(edge) : [],
      edge.spec.innerTarget,
      '(entry point)',
    );
  }

  function fillRefinementSelect(
    select: HTMLSelectElement,
    options: string[],
    current: string | null,
    blankLabel: string,
  ): void {
    select.replaceChildren();
    if (options.length === 0 && !current) {
      select.classList.add('hidden');
      return;
    }
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankLabel;
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

  function fillDataFields(edge: ModelEdge): void {
    const supportsData = FlowDoc.edgeSupportsData(edge);
    elements.edgeData.classList.toggle('hidden', !supportsData);
    if (!supportsData) return;
    // Rebuilding discards rows the user is still filling in (a blank row, a key typed but
    // not yet committed), so only reload when the document itself diverged from the rows.
    if (dataFieldsSignature(readDataFieldRows()) === dataFieldsSignature(edge.spec.data ?? [])) return;
    elements.edgeDataRows.replaceChildren(
      ...(edge.spec.data ?? []).map((field) => createDataFieldRow(field)),
    );
  }

  function createDataFieldRow(field: EdgeDataField): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'data-row';
    const key = createDataFieldInput('key', field.key);
    const type = createDataFieldInput('type', field.type);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'row-remove';
    remove.title = 'Remove field';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      row.remove();
      commitDataFields();
    });
    row.append(key, type, remove);
    return row;
  }

  function createDataFieldInput(placeholder: string, value: string): HTMLInputElement {
    const input = document.createElement('input');
    input.placeholder = placeholder;
    input.value = value;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('change', commitDataFields);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
    });
    return input;
  }

  function readDataFieldRows(): EdgeDataField[] {
    return [...elements.edgeDataRows.querySelectorAll('.data-row')].map((row) => {
      const inputs = row.querySelectorAll('input');
      return { key: inputs[0].value, type: inputs[1].value };
    });
  }

  function commitDataFields(): void {
    const edge = editingEdge();
    if (!edge || !FlowDoc.edgeSupportsData(edge)) return;
    context.applyEdit(edge.from, () => FlowDoc.setEdgeData(edge, readDataFieldRows()));
  }

  function dataFieldsSignature(fields: EdgeDataField[]): string {
    return FlowDoc.normalizeEdgeDataFields(fields).map((field) => `${field.key}: ${field.type}`).join('\n');
  }

  function commitPendingDataFields(edge: ModelEdge): void {
    if (!FlowDoc.edgeSupportsData(edge)) return;
    const edited = dataFieldsSignature(readDataFieldRows());
    if (edited === dataFieldsSignature(edge.spec.data ?? [])) return;
    commitDataFields();
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
    // Read before the title commit: renaming the node can rename the `graph:` block it mirrors,
    // and an untouched expand field still showing the old block name must not be written back.
    const expandBefore = getProp(node, 'expand') ?? '';
    const requestedExpand = elements.expand.value.trim();
    const onErrorChanged = elements.onError.value.trim() !== (getProp(node, 'on_error') ?? '');
    const updatesEntries = elements.updates.value.split(',').map((entry) => entry.trim()).filter(Boolean);
    const updatesChanged = updatesEntries.join(', ') !== parseListValue(getProp(node, 'updates')).join(', ');
    if (titleChanged) {
      elements.title.value = context.renameNode(node, elements.title.value);
    }
    referenceRows.commitPending(context.referencesOf(node));
    if (requestedExpand !== expandBefore) {
      elements.expand.value = context.applyExpandEdit(node, requestedExpand);
    }
    if (!onErrorChanged && !updatesChanged) return;
    context.applyEdit(node, () => {
      if (onErrorChanged) setProp(node, 'on_error', elements.onError.value.trim() || null);
      if (updatesChanged) setProp(node, 'updates', updatesEntries.length ? formatListValue(updatesEntries) : null);
    });
  }

  function closeEdgeEditor(): void {
    const edge = editingEdge();
    if (edge && (elements.edgeLabel.value.trim() || null) !== (edge.spec.label ?? null)) {
      context.applyEdit(edge.from, () => FlowDoc.setEdgeLabel(edge, elements.edgeLabel.value));
    }
    if (edge) commitPendingDataFields(edge);
    editingEdgeSpec = null;
    elements.edgeEditor.classList.add('hidden');
  }

  function closeAll(): void {
    titleEditor.close();
    closeNodeEditor();
    closeEdgeEditor();
    closeRegionEditor();
  }

  function reposition(): void {
    titleEditor.reposition();
    if (editingRegion) {
      const rect = context.view.regionRectOfBlock(editingRegion.block);
      if (rect) positionBesideRect(elements.regionEditor, context.view.worldRectToScreen(rect));
      else closeRegionEditor();
    }
    const node = editingNode();
    if (node) positionBesideRect(elements.nodeEditor, context.view.worldRectToScreen(context.view.rect(node)));
    const edge = editingEdge();
    if (edge && context.view.edgeGeometryOf(edge)) {
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
    titleEditor.refreshFromDoc();
    if (editingRegion) fillRegionFields(editingRegion);
    const node = editingNode();
    if (editingNodeId && !node) {
      closeNodeEditor();
    } else if (node) {
      fillNodeFields(node);
    }
    const edge = editingEdge();
    if (editingEdgeSpec && !edge) {
      closeEdgeEditor();
    } else if (edge) {
      fillRefinementSelects(edge);
      fillDataFields(edge);
    }
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
    const node = editingNode();
    if (!node) return;
    elements.expand.value = context.applyExpandEdit(node, elements.expand.value);
    // An edit inside an external frame document does not run the open file's refresh, so the
    // buttons that depend on the node having an expansion are reconciled here.
    fillNodeFields(node);
  });

  elements.onError.addEventListener('change', () => {
    applyToNode((node) => setProp(node, 'on_error', elements.onError.value.trim() || null));
  });

  // Typing a provider the node cannot read would be a claim the file cannot back, and membership
  // is the only thing that grants access — so the entry is refused and the fix is named (R38).
  elements.updates.addEventListener('change', () => {
    const node = editingNode();
    if (!node) return;
    const readableNames = context.readableContexts(node).map((entry) => entry.name);
    const entries = elements.updates.value.split(',').map((entry) => entry.trim()).filter(Boolean);
    const kept = entries.filter((name) => readableNames.includes(name));
    const refused = entries.filter((name) => !readableNames.includes(name));
    context.applyEdit(node, () => setProp(node, 'updates', kept.length ? formatListValue(kept) : null));
    elements.updates.value = kept.join(', ');
    showUpdatesError(refused.length === 0
      ? null
      : `${refused.join(', ')} is not readable by "${node.name}". Drag the node into that region to give it access.`);
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

  elements.edgeInnerSource.addEventListener('change', () => {
    const edge = editingEdge();
    if (!edge) return;
    const value = elements.edgeInnerSource.value || null;
    context.applyEdit(edge.from, () => FlowDoc.setEdgeInnerSource(edge, value));
  });

  elements.addDataField.addEventListener('click', () => {
    const row = createDataFieldRow({ key: '', type: '' });
    elements.edgeDataRows.append(row);
    row.querySelector('input')?.focus();
    reposition();
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

  elements.regionDescription.addEventListener('input', () => {
    if (editingRegion) {
      context.applyRegionDescriptionEdit(editingRegion, collapseToSingleLine(elements.regionDescription.value));
    }
  });

  elements.regionDelete.addEventListener('click', () => {
    const region = editingRegion;
    if (!region) return;
    closeRegionEditor();
    context.deleteRegion(region);
  });

  return { openNodeEditor, openEdgeEditor, openRegionEditor, openTitleEditor, closeAll, reposition, refreshFromDoc, editingNode };
}
