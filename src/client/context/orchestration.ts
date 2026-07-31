// Context-block (region) lifecycle: create, group, rename, delete, menus, and the inherits
// ripple those mutations trigger. The canvas calls these regions; the format calls them
// context blocks. Session, view, and editors arrive as callbacks so this module never imports
// main.ts — same factory shape as clipboard.ts.

import {
  getPreambleField,
  getProp,
  parseListValue,
  sanitizeName,
  type ContextBlock,
  type FlowDocument,
  type FlowItem,
  type FlowNode,
  type Rect,
} from '../../shared/flow-format.js';
import * as FlowDoc from '../flow-doc.js';
import type { Point } from '../geometry.js';
import type { DocumentOwner } from '../canvas/expansion.js';
import type { RegionTarget } from '../canvas/canvas-view.js';
import type { MenuItem } from '../context-menu.js';
import type { CommitTiming } from '../edit-session.js';
import { syncInheritsForMembers, type InheritsSyncDeps } from './inherits.js';
import { renameContextAcrossWorkspace, type WorkspaceRenameDeps } from './workspace-rename.js';

// A region drawn or grouped into being is named on the spot; a provider with a placeholder name
// helps nobody, and the name is what every other file refers to it by.
export const NEW_REGION_NAME = 'Context';

export interface CreationTarget {
  owner: DocumentOwner;
  scope: string | null;
}

export interface ExtractionTarget {
  owner: DocumentOwner;
  items: FlowItem[];
  nodes: FlowNode[];
}

export interface ContextOrchestrationOptions {
  openFlowDoc(): { doc: FlowDocument; path: string } | null;
  ownerOf(node: FlowNode): DocumentOwner;
  creationTargetFor(frameHost: FlowNode | null): CreationTarget | null;
  extractionTargetForSelection(): ExtractionTarget | null;
  applyToDoc(owner: DocumentOwner, mutation: () => void, options?: { commit?: CommitTiming }): void;
  selectRegion(name: string): void;
  clearSelection(): void;
  openRegionNameEditor(region: RegionTarget): void;
  openRegionEditor(region: RegionTarget): void;
  openConfirmMenu(items: MenuItem[], at: Point): void;
  inherits: InheritsSyncDeps;
  workspaceRename: WorkspaceRenameDeps;
}

export interface ContextOrchestration {
  ownerOfRegion(region: RegionTarget): DocumentOwner;
  createRegionAndName(rect: Rect, frameHost: FlowNode | null, memberNames: string[]): void;
  canGroupSelectionIntoContext(): boolean;
  groupSelectionIntoContext(): void;
  renameRegion(region: RegionTarget, requestedName: string): { rejected: string } | null;
  deleteRegion(region: RegionTarget): void;
  readableContexts(node: FlowNode): { name: string; inherited: boolean }[];
  regionMenuItems(region: RegionTarget, at: Point): MenuItem[];
  syncInheritsForMembers(owner: DocumentOwner, memberNames: Iterable<string>): void;
}

export function createContextOrchestration(options: ContextOrchestrationOptions): ContextOrchestration {
  function ownerOfRegion(region: RegionTarget): DocumentOwner {
    if (region.path != null) return { doc: region.doc, path: region.path };
    const open = options.openFlowDoc();
    if (!open) throw new Error('ownerOfRegion: no flow is open');
    return { doc: open.doc, path: open.path };
  }

  function openRegionName(region: RegionTarget): void {
    options.selectRegion(region.block.name);
    options.openRegionNameEditor(region);
  }

  function syncMembers(owner: DocumentOwner, memberNames: Iterable<string>): void {
    syncInheritsForMembers(options.inherits, owner, memberNames);
  }

  // A region is written into the body of the document the drawing landed in — a `graph:` block
  // has no body of its own, so nothing is created while the canvas is scoped to one or inside a
  // local frame (R45/R5). Drawn inside an unfolded external frame, it belongs to that file.
  function createRegionAndName(rect: Rect, frameHost: FlowNode | null, memberNames: string[]): void {
    const target = options.creationTargetFor(frameHost);
    if (!target || target.scope != null) return;
    createContextBlockAndPromptName(target.owner, rect, memberNames);
  }

  // Only a selection that is entirely top-level in one document can become a block: membership
  // lists name nodes declared at column 0 in the file the block lives in (spec §8.2 rule 6).
  function canGroupSelectionIntoContext(): boolean {
    const target = options.extractionTargetForSelection();
    return target != null && target.items === target.owner.doc.items;
  }

  // The user expressed membership, not an area, so the block gets no `pos`: its region is the
  // bounding box of the nodes they picked, and stays so as they move (R3, R10).
  function groupSelectionIntoContext(): void {
    const target = options.extractionTargetForSelection();
    if (!target || target.items !== target.owner.doc.items) return;
    createContextBlockAndPromptName(target.owner, null, target.nodes.map((node) => node.name));
  }

  function createContextBlockAndPromptName(
    owner: DocumentOwner,
    rect: Rect | null,
    memberNames: string[],
  ): void {
    let block: ContextBlock | null = null;
    options.applyToDoc(owner, () => {
      block = FlowDoc.addContextBlock(owner.doc.items, NEW_REGION_NAME, rect, memberNames);
    }, { commit: 'now' });
    if (!block) return;
    syncMembers(owner, memberNames);
    openRegionName({ block, doc: owner.doc, path: owner.path });
  }

  // A provider is declared in exactly one place, so a name already taken in this file names
  // another provider — suffixing it the way a node name is uniquified would silently declare a
  // second one.
  function renameRegion(region: RegionTarget, requestedName: string): { rejected: string } | null {
    const name = sanitizeName(requestedName);
    if (!name) return { rejected: 'A context needs a name.' };
    if (name === region.block.name) return null;
    if (FlowDoc.contextBlocksIn(region.doc.items).some((other) => other !== region.block && other.name === name)) {
      return { rejected: `This file already declares a context called "${name}".` };
    }
    if (parseListValue(getPreambleField(region.doc, 'inherits')).includes(name)) {
      return { rejected: `"${name}" is inherited from the graph above, and is already readable here.` };
    }
    const owner = ownerOfRegion(region);
    const oldName = region.block.name;
    options.applyToDoc(owner, () => FlowDoc.renameContextBlock(owner.doc, region.block, name), { commit: 'now' });
    void renameContextAcrossWorkspace(options.workspaceRename, owner, oldName, name);
    syncMembers(owner, region.block.members);
    options.selectRegion(name);
    return null;
  }

  // Deleting a region removes the provider and nothing else: its members are ordinary nodes that
  // happened to be listed by it (R32).
  function deleteRegion(region: RegionTarget): void {
    const owner = ownerOfRegion(region);
    const orphanedMembers = [...region.block.members];
    options.clearSelection();
    options.applyToDoc(owner, () => FlowDoc.deleteContextBlock(owner.doc.items, region.block), { commit: 'now' });
    syncMembers(owner, orphanedMembers);
  }

  // What the node editor shows and what its `updates` field accepts: the regions listing this
  // node plus everything its file inherits, which is exactly what the linter resolves.
  function readableContexts(node: FlowNode): { name: string; inherited: boolean }[] {
    const owner = options.ownerOf(node);
    const inherited = new Set(FlowDoc.inheritedContextNames(owner.doc));
    return FlowDoc.contextNamesReadableBy(owner.doc, node.name)
      .map((name) => ({ name, inherited: inherited.has(name) }));
  }

  // A member declaring `updates:` on this provider would be left naming a context nothing
  // declares, so that deletion asks twice and says why (R33).
  function regionMenuItems(region: RegionTarget, at: Point): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'Edit', onSelect: () => options.openRegionEditor(region) },
      { label: 'Rename', onSelect: () => openRegionName(region) },
    ];
    return [...items, ...deleteRegionMenuItems(region, at)];
  }

  function deleteRegionMenuItems(region: RegionTarget, at: Point): MenuItem[] {
    const writers = membersUpdatingRegion(region);
    if (writers.length === 0) {
      return [{ label: 'Delete context (keeps its nodes)', danger: true, onSelect: () => deleteRegion(region) }];
    }
    return [{
      label: 'Delete context (keeps its nodes)',
      danger: true,
      onSelect: () => options.openConfirmMenu([
        {
          label: `${writers.join(', ')} still updates ${region.block.name} — delete anyway?`,
          danger: true,
          onSelect: () => deleteRegion(region),
        },
        { label: 'Cancel', onSelect: () => {} },
      ], at),
    }];
  }

  return {
    ownerOfRegion,
    createRegionAndName,
    canGroupSelectionIntoContext,
    groupSelectionIntoContext,
    renameRegion,
    deleteRegion,
    readableContexts,
    regionMenuItems,
    syncInheritsForMembers: syncMembers,
  };
}

export function membersUpdatingRegion(region: RegionTarget): string[] {
  const byName = new Map(FlowDoc.allNodes(region.doc).map((node) => [node.name, node]));
  return region.block.members.filter((name) => {
    const node = byName.get(name);
    return node != null && parseListValue(getProp(node, 'updates')).includes(region.block.name);
  });
}
