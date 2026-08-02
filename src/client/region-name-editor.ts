// Naming a region in place: an input overlaid on the canvas at the label the painter draws in the
// region's top-left corner. Enter or losing focus commits, Escape reverts — the same shape as the
// node title editor, and for the same reason: the name belongs to the picture, not to a dialog.
//
// A refused name keeps the editor open and says why. Silently suffixing it the way a node name is
// uniquified would be wrong here: two regions are two providers, and a user who typed a name that
// is already taken meant the one that exists.

import type { CanvasView, RegionTarget } from './canvas/canvas-view.js';
import { positionInlineTitlePanel } from './inline-title-overlay.js';

/** Applies the name, reports why it cannot be used, or `undefined` when the edit was abandoned. */
export type RenameRegion = (
  region: RegionTarget,
  requestedName: string,
) => { rejected: string } | null | undefined;

export interface RegionNameEditorContext {
  view: CanvasView;
  renameRegion: RenameRegion;
}

export interface RegionNameEditor {
  // A caller that opened this as part of a wider gesture passes its own `rename`, which keeps
  // the name it takes inside that gesture's undo step (R12).
  open(region: RegionTarget, rename?: RenameRegion): void;
  close(options?: { commit?: boolean; insist?: boolean }): void;
  reposition(): void;
  refreshFromDoc(): void;
  isOpen(): boolean;
}

export function createRegionNameEditor(context: RegionNameEditorContext): RegionNameEditor {
  const panel = document.getElementById('region-name-editor') as HTMLDivElement;
  const input = document.getElementById('region-name-input') as HTMLInputElement;
  const error = document.getElementById('region-name-error') as HTMLSpanElement;
  let editing: RegionTarget | null = null;
  let applyName: RenameRegion = context.renameRegion;

  function isOpen(): boolean {
    return editing != null;
  }

  function open(region: RegionTarget, rename: RenameRegion = context.renameRegion): void {
    close({ commit: false });
    editing = region;
    applyName = rename;
    context.view.hiddenTitles.regionName = region.block.name;
    input.value = region.block.name;
    panel.classList.remove('hidden');
    showRejection(null);
    reposition();
    input.focus();
    input.select();
    context.view.requestRender();
  }

  // Clearing the editing state first keeps the commit's re-render — and the blur it triggers —
  // from re-entering here.
  // `insist` holds the editor open on a refused name so the user can see why and fix it. Leaving
  // the box by clicking elsewhere does not: reopening under a stray click would trap the focus.
  function close({ commit = true, insist = false }: { commit?: boolean; insist?: boolean } = {}): void {
    if (!isOpen()) return;
    const region = editing;
    const rename = applyName;
    const requestedName = input.value;
    editing = null;
    context.view.hiddenTitles.regionName = null;
    panel.classList.add('hidden');
    showRejection(null);
    context.view.requestRender();
    if (!region || !commit) return;
    const outcome = rename(region, requestedName);
    if (outcome === undefined) {
      open(region, rename);
      return;
    }
    if (outcome && insist) reopenWithRejection(region, rename, outcome.rejected);
  }

  // The second attempt at a refused name is still the same naming, so it keeps the caller's
  // `rename` rather than falling back to the standalone one.
  function reopenWithRejection(region: RegionTarget, rename: RenameRegion, reason: string): void {
    const typed = input.value;
    open(region, rename);
    input.value = typed;
    showRejection(reason);
  }

  function showRejection(reason: string | null): void {
    error.textContent = reason ?? '';
    panel.classList.toggle('rejected', reason != null);
  }

  function reposition(): void {
    if (!editing) return;
    const placement = context.view.regionTitlePlacementOfTarget(editing);
    if (!placement) {
      close({ commit: false });
      return;
    }

    positionInlineTitlePanel(panel, input, context.view, placement);
  }

  function refreshFromDoc(): void {
    if (!editing) return;
    if (!context.view.regionTitlePlacementOfTarget(editing)) close({ commit: false });
    else reposition();
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      close({ insist: true });
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
