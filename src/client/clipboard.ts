// Copy, cut, paste and duplicate for canvas nodes and context regions.
//
// The clipboard is session-local and holds detached node copies alongside the path and
// `graph:` scope they came from, so paste can route back into the .flow file that owns them —
// which for nodes selected inside an inline-expanded frame is not the open file. Cloning at
// copy time means later edits to (or deletion of) the originals never disturb a later paste.
//
// Regions ride the same groups but live only at the top level: a region belongs to the body of
// the document that declares it, so a paste whose target resolves to a `graph:` scope drops the
// regions rather than writing a block the format forbids (R5/R45).

import type { ContextBlock, FlowNode, Rect } from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import type { Point } from './geometry.js';
import type { DocumentOwner } from './canvas/expansion.js';
import type { RegionTarget } from './canvas/canvas-view.js';
import type { OpenFlow } from './open-flow.js';

// How far a duplicate lands from its original, and where a paste with no pointer position goes.
const DUPLICATE_STEP = 24;

interface ClipboardGroup {
  path: string;
  scope: string | null;
  nodes: FlowNode[];
  regions: ContextBlock[];
}

export interface ClipboardOptions {
  openFlow(): OpenFlow | null;
  selection(): FlowNode[];
  selectedRegions(): RegionTarget[];
  select(nodes: FlowNode[], regions?: ContextBlock[]): void;
  ownerOf(node: FlowNode): DocumentOwner;
  ownerOfRegion(region: RegionTarget): DocumentOwner;
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
  hasContent(): boolean;
}

export function createClipboard(options: ClipboardOptions): Clipboard {
  let groups: ClipboardGroup[] = [];

  function groupFor(byScope: Map<string, ClipboardGroup>, path: string, scope: string | null): ClipboardGroup {
    // NUL separates the two halves so a path containing the scope's text cannot collide.
    const key = `${path}\0${scope ?? ''}`;
    let group = byScope.get(key);
    if (!group) {
      group = { path, scope, nodes: [], regions: [] };
      byScope.set(key, group);
    }
    return group;
  }

  function copy(): void {
    const selection = options.selection();
    const selectedRegions = options.selectedRegions();
    if (selection.length === 0 && selectedRegions.length === 0) return;
    const byScope = new Map<string, ClipboardGroup>();
    for (const node of selection) {
      const owner = options.ownerOf(node);
      const scope = FlowDoc.containingGraphBlockName(owner.doc, node);
      groupFor(byScope, owner.path, scope).nodes.push(node);
    }
    for (const region of selectedRegions) {
      const owner = options.ownerOfRegion(region);
      groupFor(byScope, owner.path, null).regions.push(structuredClone(region.block));
    }
    groups = [...byScope.values()].map((group) => ({
      path: group.path,
      scope: group.scope,
      nodes: FlowDoc.cloneNodesDetached(group.nodes),
      regions: group.regions,
    }));
  }

  function cut(): void {
    if (options.selection().length === 0 && options.selectedRegions().length === 0) return;
    copy();
    options.deleteSelection();
  }

  function hasContent(): boolean {
    return groups.some((group) => group.nodes.length > 0 || group.regions.length > 0);
  }

  // Duplicates nodes and regions of a selection as one cluster, per owning document. A region
  // lists only the duplicated nodes that were part of the same cluster, under their new names;
  // members that were not duplicated are dropped, since claiming them would point at nodes this
  // operation did not create.
  function duplicateCluster(
    nodes: FlowNode[],
    regions: RegionTarget[],
    offset: Point,
  ): { nodes: FlowNode[]; regions: ContextBlock[] } {
    const copies: FlowNode[] = [];
    const regionCopies: ContextBlock[] = [];
    const renamedByPath = new Map<string, Map<string, string>>();
    for (const { owner, itemGroups } of FlowDoc.groupNodesByOwner(nodes, options.ownerOf)) {
      options.applyToDoc(owner, () => {
        for (const { items, nodes: group } of itemGroups) {
          const groupCopies = FlowDoc.duplicateNodes(items, group, offset);
          copies.push(...groupCopies);
          let renamed = renamedByPath.get(owner.path);
          if (!renamed) {
            renamed = new Map();
            renamedByPath.set(owner.path, renamed);
          }
          for (let index = 0; index < group.length; index += 1) {
            renamed.set(group[index].name, groupCopies[index].name);
          }
        }
      });
    }
    for (const region of regions) {
      const owner = options.ownerOfRegion(region);
      options.applyToDoc(owner, () => {
        regionCopies.push(...FlowDoc.duplicateContextBlocks(
          owner.doc.items,
          [region.block],
          offset,
          renamedByPath.get(owner.path) ?? new Map(),
          FlowDoc.inheritedContextNames(owner.doc),
        ));
      });
    }
    return { nodes: copies, regions: regionCopies };
  }

  function duplicateSelection(): void {
    const nodes = options.selection();
    const regions = options.selectedRegions();
    if (nodes.length === 0 && regions.length === 0) return;
    const copies = duplicateCluster(nodes, regions, { x: DUPLICATE_STEP, y: DUPLICATE_STEP });
    if (copies.nodes.length + copies.regions.length > 0) options.select(copies.nodes, copies.regions);
  }

  // Paste at the pointer places the first positioned item under it and keeps the rest in
  // formation around it; with no pointer position it offsets like a duplicate instead.
  function offsetToward(world: Point | undefined): Point {
    const anchor = groups
      .flatMap((group) => [...group.nodes.map((node) => node.pos), ...group.regions.map((region) => region.pos)])
      .find((pos): pos is Rect => pos != null);
    if (!world || !anchor) return { x: DUPLICATE_STEP, y: DUPLICATE_STEP };
    return { x: Math.round(world.x - anchor.x), y: Math.round(world.y - anchor.y) };
  }

  function paste(world?: Point): void {
    const flow = options.openFlow();
    if (!flow || !hasContent()) return;
    // A group whose original document is no longer loaded falls back to the open flow, where
    // the user can at least see what they pasted.
    const fallback: DocumentOwner = { doc: flow.doc, path: flow.path };
    const offset = offsetToward(world);
    const pastedNodes: FlowNode[] = [];
    const pastedRegions: ContextBlock[] = [];
    for (const group of groups) {
      const resolved = options.documentAt(group.path);
      const owner = resolved ?? fallback;
      const scope = resolved ? group.scope : flow.scope;
      const items = FlowDoc.scopeItems(owner.doc, scope);
      options.applyToDoc(owner, () => {
        const copies = FlowDoc.duplicateNodes(items, group.nodes, offset);
        pastedNodes.push(...copies);
        // Regions are body-level blocks: they paste only when the container is the document
        // body, so a fallback into an open `graph:` scope never gains one.
        if (items !== owner.doc.items) return;
        const renamedMembers = new Map(group.nodes.map((source, index) => [source.name, copies[index].name]));
        pastedRegions.push(...FlowDoc.duplicateContextBlocks(
          items,
          group.regions,
          offset,
          renamedMembers,
          FlowDoc.inheritedContextNames(owner.doc),
        ));
      });
    }
    if (pastedNodes.length + pastedRegions.length > 0) options.select(pastedNodes, pastedRegions);
  }

  return { copy, cut, paste, duplicateSelection, hasContent };
}
