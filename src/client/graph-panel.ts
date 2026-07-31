// The panel that edits the flow's own header: its name, the preamble fields, and the
// `references:` list. It reads whatever flow it is handed and reports edits through the
// callbacks it was built with — it never resolves documents or writes files itself.
//
// While the canvas is scoped to a `graph:` block, every preamble-backed control goes read-only.
// A local block has no preamble of its own, so there is nowhere for those values to live; only
// the name box stays live, and it renames the block.

import {
  collapseToSingleLine,
  getPreambleField,
  quoteValue,
  setPreambleField,
  setPreambleReferences,
  unquote,
  type FlowDocument,
  type GraphItem,
  type FlowNode,
  type Reference,
} from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import { createReferenceRows } from './reference-rows.js';
import type { LinkContext } from './reference-link.js';
import type { OpenFlow } from './open-flow.js';

// Each text-shaped preamble field is the same round trip — read the field out of the document
// to show it, write the box's text back on edit — differing only in the preamble key and how
// the value is spelled in the file. `name` is not here (it renames a `graph:` block when the
// canvas is scoped) and neither is `entrypoint` (a checkbox).
interface PreambleTextField {
  element: HTMLInputElement | HTMLTextAreaElement;
  key: string;
  // `description` is free text and commits as it is typed. The others parse back into structure,
  // so they wait for the field to be left rather than round-tripping half a list.
  commitOn: 'input' | 'change';
  display(doc: FlowDocument): string;
  store(text: string): string | null;
}

export interface GraphPanelElements {
  panel: HTMLDivElement;
  toggle: HTMLButtonElement;
  name: HTMLInputElement;
  description: HTMLTextAreaElement;
  onError: HTMLInputElement;
  entrypoint: HTMLInputElement;
  referenceRows: HTMLDivElement;
  addReference: HTMLButtonElement;
}

export interface GraphPanelOptions {
  elements: GraphPanelElements;
  // The flow currently on screen, or null when none is open.
  openFlow(): OpenFlow | null;
  // Runs a mutation against the open document and commits it. `now` skips the typing debounce.
  edit(mutation: () => void, options?: { commit?: 'debounce' | 'now' }): void;
  linkContext(): LinkContext;
  // A renamed block renames its sole host node with it; that node's name can be spelled in
  // `{Inner}` refinements anywhere in the workspace.
  hostRenamed(host: FlowNode, oldName: string): void;
}

export interface GraphPanel {
  render(flow: OpenFlow): void;
}

export function createGraphPanel(options: GraphPanelOptions): GraphPanel {
  const { elements } = options;

  const preambleTextFields: PreambleTextField[] = [
    {
      element: elements.description,
      key: 'description',
      commitOn: 'input',
      display: (doc) => unquote(getPreambleField(doc, 'description') ?? ''),
      store: (text) => {
        const line = collapseToSingleLine(text);
        return line ? quoteValue(line) : null;
      },
    },
    {
      element: elements.onError,
      key: 'on_error',
      commitOn: 'change',
      display: (doc) => getPreambleField(doc, 'on_error') ?? '',
      store: (text) => text.trim() || null,
    },
  ];

  const referenceRows = createReferenceRows({
    rows: elements.referenceRows,
    addButton: elements.addReference,
    linkContext: options.linkContext,
    commit: (references: Reference[]) => {
      const flow = unscopedFlow();
      if (!flow) return;
      options.edit(() => setPreambleReferences(flow.doc, FlowDoc.normalizeReferences(references)));
    },
  });

  // Preamble fields belong to the file, not to a `graph:` block, so they are only editable while
  // the canvas is at the file's top level.
  function unscopedFlow(): OpenFlow | null {
    const flow = options.openFlow();
    return flow && !flow.scope ? flow : null;
  }

  // Typing into a box that is being re-rendered underneath would fight the user mid-keystroke.
  function setUnlessFocused(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    if (document.activeElement !== field) field.value = value;
  }

  function render({ doc, path, scope }: OpenFlow): void {
    const displayName = scope ?? (unquote(getPreambleField(doc, 'name') ?? '') || path);
    const scoped = scope != null;
    elements.toggle.textContent = `☰ ${displayName}`;
    setUnlessFocused(elements.name, displayName);

    for (const field of preambleTextFields) {
      setUnlessFocused(field.element, scoped ? '' : field.display(doc));
      field.element.disabled = scoped;
    }
    elements.entrypoint.checked = !scoped && getPreambleField(doc, 'entrypoint') === 'true';
    elements.entrypoint.disabled = scoped;
    referenceRows.fill(scoped ? [] : (doc.preamble?.references ?? []));
    referenceRows.setDisabled(scoped);
  }

  function renameScopedBlock(flow: OpenFlow): void {
    const graphItem = flow.doc.items.find(
      (item): item is GraphItem => item.kind === 'graph' && item.name === flow.scope,
    );
    if (!graphItem) return;
    const mirroredHost = FlowDoc.mirroredHostOfGraphBlock(flow.doc, graphItem);
    const hostOldName = mirroredHost?.name ?? null;
    options.edit(() => {
      flow.scope = FlowDoc.renameGraphBlock(flow.doc, graphItem, elements.name.value, { path: flow.path });
    }, { commit: 'now' });
    if (mirroredHost && hostOldName && mirroredHost.name !== hostOldName) {
      options.hostRenamed(mirroredHost, hostOldName);
    }
  }

  elements.toggle.addEventListener('click', () => {
    elements.panel.classList.toggle('collapsed');
  });

  elements.name.addEventListener('change', () => {
    const flow = options.openFlow();
    if (!flow) return;
    if (flow.scope) renameScopedBlock(flow);
    else options.edit(() => setPreambleField(flow.doc, 'name', collapseToSingleLine(elements.name.value)));
  });

  for (const field of preambleTextFields) {
    field.element.addEventListener(field.commitOn, () => {
      const flow = unscopedFlow();
      if (!flow) return;
      options.edit(() => setPreambleField(flow.doc, field.key, field.store(field.element.value)));
    });
  }

  elements.entrypoint.addEventListener('change', () => {
    const flow = unscopedFlow();
    if (!flow) return;
    options.edit(() => setPreambleField(flow.doc, 'entrypoint', elements.entrypoint.checked ? 'true' : null));
  });

  return { render };
}
