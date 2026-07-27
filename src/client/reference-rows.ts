// The editable list behind a `references:` block, shared by the node editor overlay and the
// graph panel's preamble form.
//
// As with the edge editor's data rows, the DOM is the source of truth while the user is
// typing: a row with an empty target is legitimate mid-edit, and refilling from the document
// would discard it. Rows are therefore reloaded only when the document's own entries differ
// from what the rows currently say.

import { formatReference, type Reference } from '../shared/flow-format.js';
import { normalizeReferences } from './flow-doc.js';
import { openUrlForReference, type LinkContext } from './reference-link.js';

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

export function createReferenceRows(options: ReferenceRowsOptions): ReferenceRows {
  function fill(references: Reference[]): void {
    if (signature(read()) === signature(references)) return;
    options.rows.replaceChildren(...references.map(createRow));
  }

  function read(): Reference[] {
    return [...options.rows.querySelectorAll('.reference-row')].map((row) => {
      const inputs = row.querySelectorAll('input');
      return { label: inputs[0].value.trim() || null, target: inputs[1].value };
    });
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
    const label = createInput('label (optional)', reference.label ?? '');
    const target = createInput('src/file.ts:42 or https://…', reference.target);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'row-open';
    open.textContent = '↗';
    open.addEventListener('click', () => openReference(target.value));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'row-remove';
    remove.title = 'Remove reference';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      row.remove();
      commit();
    });

    const targetLine = document.createElement('div');
    targetLine.className = 'reference-target';
    targetLine.append(target, open, remove);
    row.append(label, targetLine);
    return row;
  }

  function createInput(placeholder: string, value: string): HTMLInputElement {
    const input = document.createElement('input');
    input.placeholder = placeholder;
    input.value = value;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
    });
    return input;
  }

  // A file target is only openable when an editor scheme and an absolute project root are
  // both known, so copying the target is the fallback rather than an error.
  function openReference(target: string): void {
    if (target.trim() === '') return;
    const url = openUrlForReference(target, options.linkContext());
    if (url) window.open(url, '_blank', 'noopener');
    else void navigator.clipboard?.writeText(target.trim());
  }

  function setDisabled(disabled: boolean): void {
    options.addButton.disabled = disabled;
    for (const field of options.rows.querySelectorAll('input, button')) {
      (field as HTMLInputElement | HTMLButtonElement).disabled = disabled;
    }
  }

  options.addButton.addEventListener('click', () => {
    const row = createRow({ label: null, target: '' });
    options.rows.append(row);
    row.querySelector('input')?.focus();
    options.afterRowAdded?.();
  });

  return { fill, read, commitPending, setDisabled };
}

function signature(references: Reference[]): string {
  return normalizeReferences(references).map(formatReference).join('\n');
}
