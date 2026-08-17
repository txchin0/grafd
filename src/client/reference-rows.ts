// The list behind a `references:` block, shared by the node editor, region editor, and the
// graph panel's preamble form.
//
// The file stores one entry per row — `[label](target)` or a bare target — so the row is one
// field: view shows the label (or target) as a link, edit types the same markdown the file
// uses. Display and input are siblings; `.is-editing` toggles which one is shown.
//
// As with the edge editor's data rows, the DOM is the source of truth while the user is
// typing: a row with an empty target is legitimate mid-edit, and refilling from the document
// would discard it. Rows are therefore reloaded only when the document's own entries differ
// from what the rows currently say, and never while a row is being edited.

import { formatReference, parseReference, type Reference } from '../shared/flow-format.js';
import { normalizeReferences } from './flow-doc.js';
import {
  bindReferenceAnchor,
  presentReference,
  type LinkContext,
  type ReferencePresentation,
} from './reference-link.js';

export interface ReferenceRowsOptions {
  rows: HTMLElement;
  addButton: HTMLButtonElement;
  linkContext(): LinkContext;
  commit(references: Reference[]): void;
  afterRowAdded?(): void;
}

export interface ReferenceRows {
  fill(references: Reference[]): void;
  read(): Reference[];
  commitPending(references: Reference[]): void;
  setDisabled(disabled: boolean): void;
}

const EDIT_PLACEHOLDER = '[text](link) or src/file.ts:42';

export type ReferenceEditSettlement =
  | { kind: 'save'; reference: Reference }
  | { kind: 'discard' }
  | { kind: 'revert' };

export function settleEditedReference(
  text: string,
  previous: Reference,
  commitEdit: boolean,
): ReferenceEditSettlement {
  if (!commitEdit) return previous.target === '' ? { kind: 'discard' } : { kind: 'revert' };
  const parsed = parseReference(text);
  return parsed ? { kind: 'save', reference: parsed } : { kind: 'discard' };
}

export function createReferenceRows(options: ReferenceRowsOptions): ReferenceRows {
  const stored = new WeakMap<HTMLElement, Reference>();

  function fill(references: Reference[]): void {
    if (isEditingThisList()) return;
    if (signature(read()) === signature(references)) return;
    options.rows.replaceChildren(...references.map(createRow));
  }

  function read(): Reference[] {
    return [...options.rows.querySelectorAll('.reference-row')].map(readRow);
  }

  function commit(): void {
    options.commit(read());
  }

  function commitPending(references: Reference[]): void {
    if (signature(read()) === signature(references)) return;
    commit();
  }

  function createRow(reference: Reference): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'reference-row';
    stored.set(row, reference);

    const display = document.createElement('div');
    display.className = 'reference-display';

    const input = document.createElement('input');
    input.className = 'reference-editor';
    input.placeholder = EDIT_PLACEHOLDER;
    input.value = formatReference(reference);
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('blur', () => leaveEdit(row, true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        leaveEdit(row, false);
      }
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'row-edit';
    edit.title = 'Edit reference';
    edit.textContent = '✎';
    edit.addEventListener('click', () => enterEdit(row));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'row-remove';
    remove.title = 'Remove reference';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      row.remove();
      commit();
    });

    row.append(display, input, edit, remove);
    fillDisplay(row);
    return row;
  }

  function fillDisplay(row: HTMLDivElement): void {
    const reference = stored.get(row) ?? { label: null, target: '' };
    const presented = presentReference(reference, options.linkContext());
    const display = displayOf(row);
    display.title = presented.title;
    display.replaceChildren(
      presented.href ? createLink(presented, reference.target) : createPlainText(presented),
    );
  }

  function createLink(presented: ReferencePresentation, target: string): HTMLAnchorElement {
    const anchor = document.createElement('a');
    anchor.className = 'reference-link';
    anchor.title = presented.title;
    anchor.textContent = presented.text;
    bindReferenceAnchor(anchor, target, options.linkContext());
    return anchor;
  }

  function createPlainText(presented: ReferencePresentation): HTMLSpanElement {
    const text = document.createElement('span');
    text.className = 'reference-text';
    text.textContent = presented.text;
    return text;
  }

  function enterEdit(row: HTMLDivElement): void {
    const input = editorOf(row);
    input.value = formatReference(stored.get(row) ?? { label: null, target: '' });
    row.classList.add('is-editing');
    input.focus();
    input.select();
  }

  function leaveEdit(row: HTMLDivElement, commitEdit: boolean): void {
    if (!row.classList.contains('is-editing')) return;
    const input = editorOf(row);
    const previous = stored.get(row) ?? { label: null, target: '' };
    const settlement = settleEditedReference(input.value, previous, commitEdit);
    switch (settlement.kind) {
      case 'save':
        stored.set(row, settlement.reference);
        fillDisplay(row);
        input.value = formatReference(settlement.reference);
        row.classList.remove('is-editing');
        if (signature([previous]) !== signature([settlement.reference])) commit();
        return;
      case 'discard':
        row.remove();
        if (commitEdit && previous.target !== '') commit();
        return;
      case 'revert':
        input.value = formatReference(previous);
        row.classList.remove('is-editing');
        return;
      default: {
        const _never: never = settlement;
        return _never;
      }
    }
  }

  function readRow(row: Element): Reference {
    const element = row as HTMLElement;
    if (element.classList.contains('is-editing')) {
      const input = editorOf(element);
      return parseReference(input.value) ?? { label: null, target: input.value.trim() };
    }
    return stored.get(element) ?? { label: null, target: '' };
  }

  function isEditingThisList(): boolean {
    return options.rows.querySelector('.reference-row.is-editing') != null;
  }

  function setDisabled(disabled: boolean): void {
    options.addButton.disabled = disabled;
    options.rows.classList.toggle('is-disabled', disabled);
    for (const field of options.rows.querySelectorAll('input, button')) {
      (field as HTMLInputElement | HTMLButtonElement).disabled = disabled;
    }
  }

  options.addButton.addEventListener('click', () => {
    const row = createRow({ label: null, target: '' });
    options.rows.append(row);
    enterEdit(row);
    options.afterRowAdded?.();
  });

  return { fill, read, commitPending, setDisabled };
}

function editorOf(row: HTMLElement): HTMLInputElement {
  return row.querySelector('.reference-editor') as HTMLInputElement;
}

function displayOf(row: HTMLElement): HTMLElement {
  return row.querySelector('.reference-display') as HTMLElement;
}

function signature(references: Reference[]): string {
  return normalizeReferences(references).map(formatReference).join('\n');
}
