// In-place editing of free text: a textarea laid over the canvas exactly where the text is drawn,
// opened by the text tool on bare canvas (a new text) or by double-clicking a text (an existing
// one). Enter starts a new line; Ctrl/Cmd+Enter, Escape and losing focus all commit, since a
// text in progress is never something the user expects to lose. The canvas hides the painted
// text while it is open so the two never show through each other.
//
// An existing text is held by where it is stored and re-found on every access, because each edit
// rebuilds the models that lay it out.

import type { CanvasView } from './canvas/canvas-view.js';
import type { StoredDrawing } from './canvas/drawing-selection.js';
import { transformRect, type FrameTransform } from './canvas/expansion.js';
import { drawingInkColor } from './canvas/stroke-painter.js';
import { textBoxFor, textFontAt, textLayout } from './canvas/text-drawing-layout.js';
import { TEXT_LINE_HEIGHT_RATIO } from '../shared/canvas-text.js';
import type { FlowNode } from '../shared/flow-format.js';
import type { Point } from './geometry.js';

// Deeply nested or zoomed-out text is drawn far too small to type into, so the overlay stops
// shrinking well before the canvas text does.
const MIN_FONT_PX = 11;
// Room past the last character for the caret, in ems, so typing never scrolls the textarea.
const CARET_ROOM_EM = 0.6;

export type TextEditRequest =
  // Points and sizes in the coordinate space of the graph that will own the text.
  | { kind: 'new'; frameHost: FlowNode | null; topLeft: Point; fontPx: number; color: string | null }
  | { kind: 'existing'; drawing: StoredDrawing };

export interface TextDrawingEditorContext {
  view: CanvasView;
  commitText(request: TextEditRequest, text: string): void;
}

export interface TextDrawingEditor {
  open(request: TextEditRequest): void;
  close(options?: { commit?: boolean }): void;
  reposition(): void;
  refreshFromDoc(): void;
  isOpen(): boolean;
}

// Where the text being edited starts, how large it is and the width it wraps to, if any, in its
// graph's own units.
interface TextPlacement {
  topLeft: Point;
  fontPx: number;
  wrapWidth: number | null;
  color: string | null;
  transform: FrameTransform;
}

export function createTextDrawingEditor(context: TextDrawingEditorContext): TextDrawingEditor {
  const textarea = document.getElementById('text-drawing-editor') as HTMLTextAreaElement;
  let editing: TextEditRequest | null = null;

  function isOpen(): boolean {
    return editing != null;
  }

  function open(request: TextEditRequest): void {
    close();
    editing = request;
    const placement = placementOf(request);
    if (!placement) {
      editing = null;
      return;
    }
    context.view.hiddenTitles.drawingId = request.kind === 'existing' ? request.drawing.id : null;
    textarea.value = request.kind === 'existing' ? context.view.laidOutText(request.drawing)!.text.text : '';
    textarea.classList.remove('hidden');
    reposition();
    textarea.focus();
    textarea.select();
    context.view.requestRender();
  }

  // Clearing the editing state before committing keeps the commit's re-render — and the blur it
  // triggers — from re-entering this function.
  function close({ commit = true }: { commit?: boolean } = {}): void {
    const request = editing;
    if (!request) return;
    const text = textarea.value;
    editing = null;
    context.view.hiddenTitles.drawingId = null;
    textarea.classList.add('hidden');
    if (commit) context.commitText(request, text);
    context.view.requestRender();
  }

  function placementOf(request: TextEditRequest): TextPlacement | null {
    if (request.kind === 'new') {
      const transform = context.view.graphTransformUnder(request.frameHost);
      return transform ? { topLeft: request.topLeft, fontPx: request.fontPx, wrapWidth: null, color: request.color, transform } : null;
    }
    const laidOut = context.view.laidOutText(request.drawing);
    if (!laidOut) return null;
    const { text, transform } = laidOut;
    const { fontPx } = textLayout(text, context.view.lineMeasurer());
    return { topLeft: text.box, fontPx, wrapWidth: text.wrap ? text.box.w : null, color: text.color, transform };
  }

  // The box grows with what has been typed, measured as the painter will measure it once it lands:
  // wider, or — for a text with a width to wrap to — taller, its lines wrapping where the canvas
  // wraps them.
  function reposition(): void {
    const placement = editing && placementOf(editing);
    if (!placement) {
      close({ commit: false });
      return;
    }
    const localBox = textBoxFor(textarea.value || ' ', placement.topLeft, placement.fontPx, context.view.lineMeasurer(), placement.wrapWidth);
    const screenBox = context.view.worldRectToScreen(transformRect(localBox, placement.transform));
    const drawnFontPx = placement.fontPx * placement.transform.scale * context.view.view.scale;
    const typingScale = Math.max(1, MIN_FONT_PX / drawnFontPx);
    const fontPx = drawnFontPx * typingScale;
    textarea.style.left = `${Math.round(screenBox.x)}px`;
    textarea.style.top = `${Math.round(screenBox.y)}px`;
    const caretRoom = placement.wrapWidth == null ? fontPx * CARET_ROOM_EM : 0;
    textarea.style.width = `${Math.ceil(screenBox.w * typingScale + caretRoom)}px`;
    textarea.style.whiteSpace = placement.wrapWidth == null ? 'pre' : 'pre-wrap';
    textarea.style.height = `${Math.ceil(screenBox.h * typingScale)}px`;
    textarea.style.font = textFontAt(fontPx);
    textarea.style.lineHeight = String(TEXT_LINE_HEIGHT_RATIO);
    textarea.style.color = drawingInkColor(placement.color);
  }

  function refreshFromDoc(): void {
    if (!editing) return;
    if (!placementOf(editing)) close({ commit: false });
    else reposition();
  }

  textarea.addEventListener('input', reposition);
  textarea.addEventListener('keydown', (event) => {
    const commits = event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey));
    if (commits) {
      event.preventDefault();
      close();
    }
    event.stopPropagation();
  });
  textarea.addEventListener('blur', () => close());
  textarea.addEventListener('pointerdown', (event) => event.stopPropagation());
  textarea.addEventListener('dblclick', (event) => event.stopPropagation());

  return { open, close, reposition, refreshFromDoc, isOpen };
}
