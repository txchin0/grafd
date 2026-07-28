// The sidebar's file tree and its inline "new flow" form. Presentation only: it renders the
// workspace's paths as a collapsible tree, owns which folders are collapsed and the two-step
// arming of the delete buttons, and reports what the user chose through the callbacks it was
// built with. It never reads or writes a .flow file itself.
//
// Neither the new-file form nor the delete confirmations use `prompt`/`confirm`: dialog boxes
// are suppressed in several embedded browser hosts, where they made the buttons appear dead.
// The name box is an inline input and deleting takes two clicks on the same control.

import { buildFileTree, type TreeFile, type TreeFolder } from './file-tree.js';
import { folderOf, nextUntitledFlowName, normalizeFlowPath } from './flow-paths.js';
import type { ContextMenu, MenuItem } from './context-menu.js';

const ROW_INDENT_PX = 14;
const ROW_BASE_PADDING_PX = 10;

export interface SidebarFilesOptions {
  fileList: HTMLUListElement;
  newFileButton: HTMLButtonElement;
  newFileInput: HTMLInputElement;
  newFileError: HTMLParagraphElement;
  contextMenu: ContextMenu;
  files(): string[];
  activePath(): string | null;
  openFile(path: string): void;
  deleteFile(path: string): void;
  duplicateFile(path: string): void;
  // Null when the flow was created, otherwise why it was not — shown beneath the name box.
  createFile(path: string): string | null;
}

export interface SidebarFiles {
  render(): void;
}

export function createSidebarFiles(options: SidebarFilesOptions): SidebarFiles {
  const { fileList, newFileButton, newFileInput, newFileError, contextMenu } = options;
  const collapsedFolders = new Set<string>();

  function render(): void {
    const rows: HTMLElement[] = [];
    appendFolderRows(buildFileTree(options.files()), 0, rows);
    fileList.replaceChildren(...rows);
  }

  function appendFolderRows(folder: TreeFolder, depth: number, rows: HTMLElement[]): void {
    for (const child of folder.folders) {
      rows.push(folderRow(child, depth));
      if (!collapsedFolders.has(child.path)) appendFolderRows(child, depth + 1, rows);
    }
    for (const file of folder.files) rows.push(fileRow(file, depth));
  }

  function applyTreeIndent(row: HTMLElement, depth: number): void {
    row.style.paddingLeft = `${ROW_BASE_PADDING_PX + depth * ROW_INDENT_PX}px`;
  }

  function folderRow(folder: TreeFolder, depth: number): HTMLElement {
    const row = document.createElement('li');
    row.className = 'folder-row';
    row.title = folder.path;
    applyTreeIndent(row, depth);
    const caret = document.createElement('span');
    caret.className = 'folder-caret';
    caret.textContent = collapsedFolders.has(folder.path) ? '▸' : '▾';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = folder.name;
    row.append(caret, name);
    row.addEventListener('click', () => {
      if (collapsedFolders.has(folder.path)) collapsedFolders.delete(folder.path);
      else collapsedFolders.add(folder.path);
      render();
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      contextMenu.open([
        { label: 'New flow here', onSelect: () => promptForNewFile(`${folder.path}/`) },
      ], { x: event.clientX, y: event.clientY });
    });
    return row;
  }

  function fileRow(file: TreeFile, depth: number): HTMLElement {
    const row = document.createElement('li');
    row.className = 'file-row';
    row.title = file.path;
    row.classList.toggle('active', file.path === options.activePath());
    applyTreeIndent(row, depth);
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    row.append(name, deleteButtonFor(file.path));
    row.addEventListener('click', () => options.openFile(file.path));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const at = { x: event.clientX, y: event.clientY };
      contextMenu.open(fileMenuItems(file, at), at);
    });
    return row;
  }

  function fileMenuItems(file: TreeFile, at: { x: number; y: number }): MenuItem[] {
    const folder = folderOf(file.path);
    return [
      { label: 'Open', onSelect: () => options.openFile(file.path) },
      { label: 'New flow here', onSelect: () => promptForNewFile(folder ? `${folder}/` : undefined) },
      { label: 'Duplicate', onSelect: () => options.duplicateFile(file.path) },
      { separator: true },
      { label: 'Delete', danger: true, onSelect: () => confirmDelete(file, at) },
    ];
  }

  // The menu reopens with an explicit confirm rather than deleting on first click — the same
  // two-step the ✕ button uses.
  function confirmDelete(file: TreeFile, at: { x: number; y: number }): void {
    contextMenu.open([
      { label: `Delete ${file.name}?`, danger: true, onSelect: () => options.deleteFile(file.path) },
      { label: 'Cancel', onSelect: () => {} },
    ], at);
  }

  function deleteButtonFor(path: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-delete';
    button.textContent = '✕';
    button.title = `Delete ${path}`;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!button.classList.contains('armed')) {
        button.classList.add('armed');
        button.textContent = 'sure?';
        return;
      }
      options.deleteFile(path);
    });
    button.addEventListener('mouseleave', () => {
      button.classList.remove('armed');
      button.textContent = '✕';
    });
    return button;
  }

  // A folder prefix (e.g. "auth/") seeds "New flow here" so the file lands inside the
  // right-clicked folder, with the caret left after the slash rather than selecting it.
  function promptForNewFile(prefill?: string): void {
    const value = prefill ?? nextUntitledFlowName(options.files());
    clearError();
    newFileButton.classList.add('hidden');
    newFileInput.classList.remove('hidden');
    newFileInput.value = value;
    newFileInput.focus();
    if (value.endsWith('/')) newFileInput.setSelectionRange(value.length, value.length);
    else newFileInput.select();
  }

  function hideInput(): void {
    newFileInput.classList.add('hidden');
    newFileButton.classList.remove('hidden');
    clearError();
  }

  function hasError(): boolean {
    return !newFileError.classList.contains('hidden');
  }

  function clearError(): void {
    newFileError.classList.add('hidden');
    newFileError.textContent = '';
    newFileInput.classList.remove('invalid');
  }

  function showError(message: string): void {
    newFileError.textContent = message;
    newFileError.classList.remove('hidden');
    newFileInput.classList.add('invalid');
    newFileInput.focus();
    newFileInput.select();
  }

  function submitNewFile(): void {
    // An empty box is nothing to do rather than something to complain about: the form stays
    // open and silent, and the blur that follows closes it.
    const path = normalizeFlowPath(newFileInput.value);
    if (!path) return;
    const error = options.createFile(path);
    if (error) showError(error);
    else hideInput();
  }

  newFileButton.addEventListener('click', () => promptForNewFile());
  newFileInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitNewFile();
    else if (event.key === 'Escape') hideInput();
    else clearError();
    event.stopPropagation();
  });
  // A rejected name keeps the input open and focused, so blur must not hide it.
  newFileInput.addEventListener('blur', () => {
    if (!hasError()) hideInput();
  });

  return { render };
}
