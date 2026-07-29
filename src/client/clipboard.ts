// Copy, cut, paste and duplicate for canvas nodes.
//
// The clipboard is session-local and holds detached node copies alongside the path and
// `graph:` scope they came from, so paste can route back into the .flow file that owns them —
// which for nodes selected inside an inline-expanded frame is not the open file. Cloning at
// copy time means later edits to (or deletion of) the originals never disturb a later paste.

import type { FlowNode } from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import type { Point } from './geometry.js';
import type { DocumentOwner } from './canvas/expansion.js';
import type { OpenFlow } from './open-flow.js';

// How far a duplicate lands from its original, and where a paste with no pointer position goes.
const DUPLICATE_STEP = 24;

interface ClipboardGroup {
  path: string;
  scope: string | null;
  nodes: FlowNode[];
}

export interface ClipboardOptions {
  openFlow(): OpenFlow | null;
  selection(): FlowNode[];
  select(nodes: FlowNode[]): void;
  ownerOf(node: FlowNode): DocumentOwner;
  // Resolves a path this session has loaded, so a paste can reach a frame's own document.
  documentAt(path: string): DocumentOwner | null;
  applyToDoc(owner: DocumentOwner, mutation: () => void): void;
  deleteSelection(): void;
}

export interface Clipboard {
  copy(): void;
  cut(): void;
  paste(world?: Point): void;
  duplicateSelection(): void;
  duplicate(nodes: FlowNode[], offset: Point): FlowNode[];
  hasNodes(): boolean;
}

export function createClipboard(options: ClipboardOptions): Clipboard {
  let groups: ClipboardGroup[] = [];

  function copy(): void {
    const selection = options.selection();
    if (selection.length === 0) return;
    const byScope = new Map<string, ClipboardGroup>();
    for (const node of selection) {
      const owner = options.ownerOf(node);
      const scope = FlowDoc.containingGraphBlockName(owner.doc, node);
      // NUL separates the two halves so a path containing the scope's text cannot collide.
      const key = `${owner.path}\0${scope ?? ''}`;
      let group = byScope.get(key);
      if (!group) {
        group = { path: owner.path, scope, nodes: [] };
        byScope.set(key, group);
      }
      group.nodes.push(node);
    }
    groups = [...byScope.values()].map((group) => ({
      path: group.path,
      scope: group.scope,
      nodes: FlowDoc.cloneNodesDetached(group.nodes),
    }));
  }

  function cut(): void {
    if (options.selection().length === 0) return;
    copy();
    options.deleteSelection();
  }

  function hasNodes(): boolean {
    return groups.some((group) => group.nodes.length > 0);
  }

  // Routes through the same owner→items grouping as deleting, so nodes selected inside an
  // inline-expanded frame land back in the .flow file that actually owns them.
  function duplicate(nodes: FlowNode[], offset: Point): FlowNode[] {
    const copies: FlowNode[] = [];
    for (const { owner, itemGroups } of FlowDoc.groupNodesByOwner(nodes, options.ownerOf)) {
      options.applyToDoc(owner, () => {
        for (const { items, nodes: group } of itemGroups) {
          copies.push(...FlowDoc.duplicateNodes(items, group, offset));
        }
      });
    }
    return copies;
  }

  function duplicateSelection(): void {
    const nodes = options.selection();
    if (nodes.length === 0) return;
    const copies = duplicate(nodes, { x: DUPLICATE_STEP, y: DUPLICATE_STEP });
    if (copies.length > 0) options.select(copies);
  }

  // Paste at the pointer places the first positioned node under it and keeps the rest in
  // formation around it; with no pointer position it offsets like a duplicate instead.
  function offsetToward(world: Point | undefined): Point {
    const anchor = groups.flatMap((group) => group.nodes).find((node) => node.pos)?.pos;
    if (!world || !anchor) return { x: DUPLICATE_STEP, y: DUPLICATE_STEP };
    return { x: Math.round(world.x - anchor.x), y: Math.round(world.y - anchor.y) };
  }

  function paste(world?: Point): void {
    const flow = options.openFlow();
    if (!flow || !hasNodes()) return;
    // A group whose original document is no longer loaded falls back to the open flow, where
    // the user can at least see what they pasted.
    const fallback: DocumentOwner = { doc: flow.doc, path: flow.path };
    const offset = offsetToward(world);
    const pasted: FlowNode[] = [];
    for (const group of groups) {
      const resolved = options.documentAt(group.path);
      const owner = resolved ?? fallback;
      const scope = resolved ? group.scope : flow.scope;
      const items = FlowDoc.scopeItems(owner.doc, scope);
      options.applyToDoc(owner, () => {
        pasted.push(...FlowDoc.duplicateNodes(items, group.nodes, offset));
      });
    }
    if (pasted.length > 0) options.select(pasted);
  }

  return { copy, cut, paste, duplicateSelection, duplicate, hasNodes };
}
