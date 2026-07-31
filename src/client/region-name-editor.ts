// Naming a region in place: an input overlaid on the canvas at the label the painter draws in the
// region's top-left corner. Enter or losing focus commits, Escape reverts — the same shape as the
// node title editor, and for the same reason: the name belongs to the picture, not to a dialog.
//
// A refused name keeps the editor open and says why. Silently suffixing it the way a node name is
// uniquified would be wrong here: two regions are two providers, and a user who typed a name that
// is already taken meant the one that exists.

import type { Rect } from '../shared/flow-format.js';
import type { CanvasView, RegionTarget } from './canvas/canvas-view.js';

export interface RegionNameEditorContext {
  view: CanvasView;
  /** The region's rectangle in world coordinates, or null once it is gone from the canvas. */
  rectOf(region: RegionTarget): Rect | null;
  /** Applies the name, or reports in one sentence why it cannot be used. */
  renameRegion(region: RegionTarget, requestedName: string): { rejected: string } | null;
}

export interface RegionNameEditor {
  open(region: RegionTarget): void;
  close(options?: { commit?: boolean; insist?: boolean }): void;
  reposition(): void;
  isOpen(): boolean;
}

// The label is drawn at a fixed offset inside the region's corner; the overlay sits on it rather
// than scaling with the canvas, so a name stays typable at any zoom.
const LABEL_INSET = { x: 6, y: 4 };

export function createRegionNameEditor(context: RegionNameEditorContext): RegionNameEditor {
  const panel = document.getElementById('region-name-editor') as HTMLDivElement;
  const input = document.getElementById('region-name-input') as HTMLInputElement;
  const error = document.getElementById('region-name-error') as HTMLSpanElement;
  let editing: RegionTarget | null = null;

  function isOpen(): boolean {
    return editing != null;
  }

  function open(region: RegionTarget): void {
    close({ commit: false });
    editing = region;
    input.value = region.block.name;
    panel.classList.remove('hidden');
    showRejection(null);
    reposition();
    input.focus();
    input.select();
  }

  // Clearing the editing state first keeps the commit's re-render — and the blur it triggers —
  // from re-entering here.
  // `insist` holds the editor open on a refused name so the user can see why and fix it. Leaving
  // the box by clicking elsewhere does not: reopening under a stray click would trap the focus.
  function close({ commit = true, insist = false }: { commit?: boolean; insist?: boolean } = {}): void {
    const region = editing;
    editing = null;
    panel.classList.add('hidden');
    showRejection(null);
    if (!region || !commit) return;
    const outcome = context.renameRegion(region, input.value);
    if (outcome && insist) reopenWithRejection(region, outcome.rejected);
  }

  function reopenWithRejection(region: RegionTarget, reason: string): void {
    const typed = input.value;
    open(region);
    input.value = typed;
    showRejection(reason);
  }

  function showRejection(reason: string | null): void {
    error.textContent = reason ?? '';
    panel.classList.toggle('rejected', reason != null);
  }

  function reposition(): void {
    if (!editing) return;
    const rect = editing && context.rectOf(editing);
    if (!rect) {
      close({ commit: false });
      return;
    }
    const screen = context.view.worldRectToScreen(rect);
    panel.style.left = `${screen.x + LABEL_INSET.x}px`;
    panel.style.top = `${screen.y + LABEL_INSET.y}px`;
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') close({ insist: true });
    else if (event.key === 'Escape') close({ commit: false });
    event.stopPropagation();
  });
  input.addEventListener('blur', () => close());

  return { open, close, reposition, isOpen };
}
