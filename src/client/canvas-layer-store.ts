// The loaded canvas layers of a workspace, one per .flow path, beside the expansion layer's
// cache of the documents themselves. A layer is decoration, so a missing file loads as an empty
// layer rather than as an error. A file that could not be read, or is not a layer, settles as
// unreadable instead: drawn with defaults like a missing one, but offering no layer to edit, so
// nothing overwrites it until a readable version arrives (adopt).
//
// The edit session tracks the layers an edit has touched and publishes every layer it parses
// back here (adopt), so the layer a model draws from and the layer an edit mutates are always
// the same object — the same parse-identity rule the session keeps for .flow documents.

import {
  canvasLayerIsUnreadable,
  canvasLayerPathOf,
  emptyCanvasLayer,
  parseCanvasLayer,
  type CanvasLayer,
} from '../shared/canvas-layer.js';

const UNREADABLE = Symbol('unreadable layer');

interface LayerEntry {
  layer?: CanvasLayer | typeof UNREADABLE;
  loading?: Promise<CanvasLayer | null>;
  // The path the entry is currently filed under, so a load that settles after a rename lands
  // under the new path rather than resurrecting the old one.
  key: string;
}

export interface CanvasLayerStoreOptions {
  readFile(path: string): Promise<string | null>;
  // A layer finished loading after something had already been drawn without it.
  onLoaded(): void;
}

export class CanvasLayerStore {
  private readonly entries = new Map<string, LayerEntry>();
  private readonly readFile: (path: string) => Promise<string | null>;
  private readonly onLoaded: () => void;

  constructor({ readFile, onLoaded }: CanvasLayerStoreOptions) {
    this.readFile = readFile;
    this.onLoaded = onLoaded;
  }

  // The layer of `flowPath` once loaded. Null while it loads, so a caller drawing before then
  // draws defaults and is redrawn through onLoaded — and null for an unreadable layer.
  layerFor(flowPath: string | null): CanvasLayer | null {
    if (flowPath == null) return null;
    const entry = this.entries.get(flowPath);
    if (!entry) void this.ensure(flowPath).then(() => this.onLoaded());
    return editableLayerOf(entry);
  }

  ensure(flowPath: string): Promise<CanvasLayer | null> {
    const entry = this.entries.get(flowPath);
    if (entry?.loading) return entry.loading;
    if (entry) return Promise.resolve(editableLayerOf(entry));
    const loadingEntry: LayerEntry = { key: flowPath };
    loadingEntry.loading = this.readFile(canvasLayerPathOf(flowPath))
      .then(layerOrUnreadable, (): typeof UNREADABLE => UNREADABLE)
      .then((layer) => this.settle(loadingEntry, layer));
    this.entries.set(flowPath, loadingEntry);
    return loadingEntry.loading;
  }

  // An adopt (an undo, a watcher push) may have replaced the entry while the read was in
  // flight; the live replacement wins.
  private settle(entry: LayerEntry, layer: CanvasLayer | typeof UNREADABLE): CanvasLayer | null {
    const current = this.entries.get(entry.key);
    if (current !== entry) return editableLayerOf(current);
    entry.layer = layer;
    entry.loading = undefined;
    return editableLayerOf(entry);
  }

  adopt(flowPath: string, layer: CanvasLayer): void {
    this.entries.set(flowPath, { layer, key: flowPath });
  }

  // A watcher push of text that is not a layer: the file is left as it is until fixed.
  adoptUnreadable(flowPath: string): void {
    this.entries.set(flowPath, { layer: UNREADABLE, key: flowPath });
  }

  // A .flow created by this editor: its layer is known without reading anything.
  adoptEmpty(flowPath: string): CanvasLayer {
    const layer = emptyCanvasLayer();
    this.adopt(flowPath, layer);
    return layer;
  }

  retarget(from: string, to: string): void {
    const entry = this.entries.get(from);
    if (!entry) return;
    this.entries.delete(from);
    entry.key = to;
    this.entries.set(to, entry);
  }

  forget(flowPath: string): void {
    this.entries.delete(flowPath);
  }

  // Settled, readable or not: an unreadable layer still takes the watcher push that repairs it.
  isLoaded(flowPath: string): boolean {
    return this.entries.get(flowPath)?.layer != null;
  }

  reset(): void {
    this.entries.clear();
  }
}

function layerOrUnreadable(text: string | null): CanvasLayer | typeof UNREADABLE {
  return canvasLayerIsUnreadable(text) ? UNREADABLE : parseCanvasLayer(text);
}

function editableLayerOf(entry: LayerEntry | undefined): CanvasLayer | null {
  return entry?.layer == null || entry.layer === UNREADABLE ? null : entry.layer;
}
