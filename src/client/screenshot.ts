// PNG export of the active flow: a modal that previews a zoom-to-fit render of the whole
// graph and downloads it at a chosen resolution.
//
// The export viewport is the padded content bounds themselves, so the fitted camera always
// lands on scale 1 — the graph at 100% zoom, cropped tight. Resolution is therefore purely
// a device-pixel multiplier, and the preview differs from the downloaded file in nothing but
// that multiplier.

import type { CanvasView, ViewportSize } from './canvas-view.js';
import { downloadBlob } from './download.js';

export const SCALE_PRESETS = [1, 2, 3, 4];

// Chromium tolerates far more, but Safari and low-memory devices do not; a refused canvas
// silently yields a blank or null-blob export, so keep well inside every implementation.
export const MAX_SNAPSHOT_SIDE = 8192;
export const MAX_SNAPSHOT_PIXELS = 40_000_000;

const PREVIEW_BOX: ViewportSize = { width: 560, height: 340 };
const MIN_PREVIEW_SUPERSAMPLE = 3;
const DEFAULT_SCALE = 2;

// The canvas itself is transparent — the background a viewer sees is the page's, so the
// stylesheet stays the single source of truth for it.
function pageBackgroundColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#17191d';
}

export interface SnapshotPixelSize {
  width: number;
  height: number;
  pixelRatio: number;
}

export function pixelSizeForRatio(logical: ViewportSize, pixelRatio: number): SnapshotPixelSize {
  return {
    width: Math.max(1, Math.round(logical.width * pixelRatio)),
    height: Math.max(1, Math.round(logical.height * pixelRatio)),
    pixelRatio,
  };
}

export function pixelSizeForWidth(logical: ViewportSize, requestedWidth: number): SnapshotPixelSize {
  return pixelSizeForRatio(logical, Math.max(1, requestedWidth) / logical.width);
}

export function exceedsSnapshotLimits({ width, height }: SnapshotPixelSize): boolean {
  return width > MAX_SNAPSHOT_SIDE || height > MAX_SNAPSHOT_SIDE || width * height > MAX_SNAPSHOT_PIXELS;
}

export interface ScreenshotContext {
  view: CanvasView;
  fileStem(): string;
}

export interface ScreenshotDialog {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

function elementById<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The browser refused to encode a canvas this large.'))),
      'image/png',
    );
  });
}

export interface PreviewLayout {
  css: SnapshotPixelSize;
  device: SnapshotPixelSize;
}

// The preview's backing store is supersampled well past its CSS size: at 1:1 the rough.js
// strokes and hand font alias badly, and the point of the preview is to show how the file
// will look. MIN_PREVIEW_SUPERSAMPLE keeps it crisp even on non-HiDPI displays.
export function previewLayoutFor(logical: ViewportSize, displayPixelRatio: number): PreviewLayout {
  const fitRatio = Math.min(PREVIEW_BOX.width / logical.width, PREVIEW_BOX.height / logical.height, 1);
  const supersample = Math.max(MIN_PREVIEW_SUPERSAMPLE, displayPixelRatio);
  return {
    css: pixelSizeForRatio(logical, fitRatio),
    device: pixelSizeForRatio(logical, fitRatio * supersample),
  };
}

export function createScreenshotDialog(context: ScreenshotContext): ScreenshotDialog {
  const elements = {
    modal: elementById<HTMLDivElement>('screenshot-modal'),
    panel: elementById<HTMLDivElement>('screenshot-panel'),
    preview: elementById<HTMLCanvasElement>('screenshot-preview'),
    presets: elementById<HTMLDivElement>('screenshot-scale-presets'),
    width: elementById<HTMLInputElement>('screenshot-width'),
    dimensions: elementById<HTMLSpanElement>('screenshot-dimensions'),
    background: elementById<HTMLInputElement>('screenshot-background'),
    grid: elementById<HTMLInputElement>('screenshot-grid'),
    error: elementById<HTMLParagraphElement>('screenshot-error'),
    close: elementById<HTMLButtonElement>('screenshot-close'),
    download: elementById<HTMLButtonElement>('screenshot-download'),
  };

  let logicalSize: ViewportSize = { width: 1, height: 1 };
  let pixelRatio = DEFAULT_SCALE;

  function currentSize(): SnapshotPixelSize {
    return pixelSizeForRatio(logicalSize, pixelRatio);
  }

  function drawInto(canvas: HTMLCanvasElement, size: SnapshotPixelSize): void {
    canvas.width = size.width;
    canvas.height = size.height;
    context.view.renderSnapshot({
      canvas,
      viewport: logicalSize,
      pixelRatio: size.pixelRatio,
      background: elements.background.checked ? pageBackgroundColor() : null,
      grid: elements.grid.checked,
    });
  }

  function renderPreview(): void {
    const { css, device } = previewLayoutFor(logicalSize, window.devicePixelRatio || 1);
    drawInto(elements.preview, device);
    elements.preview.style.width = `${css.width}px`;
    elements.preview.style.height = `${css.height}px`;
  }

  function showError(message: string): void {
    elements.error.textContent = message;
    elements.error.classList.remove('hidden');
  }

  function clearError(): void {
    elements.error.textContent = '';
    elements.error.classList.add('hidden');
  }

  const presetButtons = SCALE_PRESETS.map((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet-button';
    button.dataset.scale = String(preset);
    button.textContent = `${preset}×`;
    button.addEventListener('click', () => {
      pixelRatio = preset;
      renderResolutionControls();
    });
    elements.presets.append(button);
    return button;
  });

  function renderResolutionControls(): void {
    const size = currentSize();
    elements.dimensions.textContent = `${size.width} × ${size.height} px`;
    if (document.activeElement !== elements.width) elements.width.value = String(size.width);

    for (const button of presetButtons) {
      const preset = Number(button.dataset.scale);
      button.classList.toggle('active', Math.abs(preset - pixelRatio) < 0.001);
      button.disabled = exceedsSnapshotLimits(pixelSizeForRatio(logicalSize, preset));
    }

    const tooLarge = exceedsSnapshotLimits(size);
    elements.download.disabled = tooLarge;
    if (tooLarge) showError(`Too large to render — keep both sides under ${MAX_SNAPSHOT_SIDE} px.`);
    else clearError();
  }

  function open(): void {
    const bounds = context.view.snapshotBounds();
    logicalSize = { width: bounds.w, height: bounds.h };
    pixelRatio = DEFAULT_SCALE;
    elements.modal.classList.remove('hidden');
    renderPreview();
    renderResolutionControls();
  }

  function close(): void {
    elements.modal.classList.add('hidden');
  }

  function isOpen(): boolean {
    return !elements.modal.classList.contains('hidden');
  }

  async function download(): Promise<void> {
    const size = currentSize();
    if (exceedsSnapshotLimits(size)) return;
    try {
      const canvas = document.createElement('canvas');
      drawInto(canvas, size);
      downloadBlob(await canvasToPngBlob(canvas), `${context.fileStem()}.png`);
      close();
    } catch (error) {
      console.error('Image export failed', error);
      showError('Export failed — see the browser console for details.');
    }
  }

  elements.width.addEventListener('input', () => {
    const requested = Number(elements.width.value);
    if (!Number.isFinite(requested) || requested < 1) return;
    pixelRatio = pixelSizeForWidth(logicalSize, requested).pixelRatio;
    renderResolutionControls();
  });
  for (const checkbox of [elements.background, elements.grid]) {
    checkbox.addEventListener('change', renderPreview);
  }
  elements.close.addEventListener('click', close);
  elements.download.addEventListener('click', () => void download());
  // Clicks inside the panel must not reach the scrim's dismiss handler.
  elements.panel.addEventListener('click', (event) => event.stopPropagation());
  elements.modal.addEventListener('click', close);

  return { open, close, isOpen };
}
