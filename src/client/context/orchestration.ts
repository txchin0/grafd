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
import type { ActionContinuation, CommitTiming } from '../edit-session.js';
import type { RenameRegion } from '../region-name-editor.js';
import { syncInheritsForMembers, syncInheritsForPath, type InheritsSyncDeps } from './inherits.js';
import { renameContextAcrossWorkspace, type WorkspaceRenameDeps } from './workspace-rename.js';

// A region drawn or grouped into being is named on the spot; a provider with a placeholder name
// helps nobody, and the name is what every other file refers to it by.
export const NEW_REGION_NAME = 'Region';

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
  runAction<T>(body: () => T): T;
  suspendAction(): ActionContinuation;
  selectRegion(name: string): void;
  clearSelection(): void;
  // `rename` is passed when the naming still belongs to an action already under way — the
  // creation gesture that opened the editor (R12).
  openRegionNameEditor(region: RegionTarget, rename?: RenameRegion): void;
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
  // The multi-region half of a mixed selection delete: `deleteRegions` owns its action, and
  // `writeRegionDeletions` runs inside an action the caller opened, so deleting nodes and
  // regions together lands as one undo step. Neither asks for confirmation — that is
  // `confirmRegionDeletions`, which menu paths call first.
  deleteRegions(regions: RegionTarget[]): void;
  writeRegionDeletions(regions: RegionTarget[]): void;
  confirmRegionDeletions(regions: RegionTarget[], at: Point, proceed: () => void): void;
  readableContexts(node: FlowNode): { name: string; inherited: boolean }[];
  regionMenuItems(region: RegionTarget, at: Point): MenuItem[];
  syncInheritsForMembers(owner: DocumentOwner, members: Iterable<FlowNode>): void;
  syncInheritsForExpansionPaths(owner: DocumentOwner, paths: Iterable<string>): void;
}

export function createContextOrchestration(options: ContextOrchestrationOptions): ContextOrchestration {
  function ownerOfRegion(region: RegionTarget): DocumentOwner {
    if (region.path != null) return { doc: region.doc, path: region.path };
    const open = options.openFlowDoc();
    if (!open) throw new Error('ownerOfRegion: no flow is open');
    return { doc: open.doc, path: open.path };
  }

  function openRegionName(region: RegionTarget, rename?: RenameRegion): void {
    options.selectRegion(region.block.name);
    options.openRegionNameEditor(region, rename);
  }

  function syncMembers(owner: DocumentOwner, members: Iterable<FlowNode>): void {
    syncInheritsForMembers(options.inherits, owner, members);
  }

  // A block lists nodes of its own scope by name; names are unique within that scope, so the
  // nodes the list refers to are exactly the scope's nodes carrying those names.
  function membersNamed(items: FlowItem[], names: Iterable<string>): FlowNode[] {
    const wanted = new Set(names);
    return FlowDoc.nodesIn(items).filter((node) => wanted.has(node.name));
  }

  // For edits that remove the host a path was reached through: the file keeps its `inherits`
  // derived from the hosts that remain — possibly none — with stale `updates:` stripped.
  function syncExpansionPaths(owner: DocumentOwner, paths: Iterable<string>): void {
    for (const path of new Set(paths)) void syncInheritsForPath(options.inherits, owner, path, new Set());
  }

  // A region is written into the graph scope the drawing landed in — the file body, a local
  // `graph:` block the canvas is narrowed to, or the subgraph an unfolded frame is showing.
  function createRegionAndName(rect: Rect, frameHost: FlowNode | null, memberNames: string[]): void {
    const target = options.creationTargetFor(frameHost);
    if (!target) return;
    const items = FlowDoc.ensureScopeItems(target.owner.doc, target.scope);
    createContextBlockAndPromptName(target.owner, items, rect, memberNames, target.scope != null);
  }

  function canGroupSelectionIntoContext(): boolean {
    return options.extractionTargetForSelection() != null;
  }

  // The user expressed membership, not an area, so the block gets no `pos`: its region is the
  // bounding box of the nodes they picked, and stays so as they move (R3, R10).
  function groupSelectionIntoContext(): void {
    const target = options.extractionTargetForSelection();
    if (!target) return;
    const nested = target.items !== target.owner.doc.items;
    createContextBlockAndPromptName(target.owner, target.items, null, target.nodes.map((node) => node.name), nested);
  }

  // Naming is the second half of the creation gesture rather than an edit of what it produced,
  // so the action stays open across the name box and the two land in one undo step (R12).
  function createContextBlockAndPromptName(
    owner: DocumentOwner,
    items: FlowItem[],
    rect: Rect | null,
    memberNames: string[],
    nested: boolean,
  ): void {
    let block: ContextBlock | null = null;
    const naming = options.runAction(() => {
      options.applyToDoc(owner, () => {
        block = FlowDoc.addContextBlock(
          items,
          NEW_REGION_NAME,
          rect,
          memberNames,
          FlowDoc.allContextBlocks(owner.doc).map((existing) => existing.name),
          nested ? 'before-nodes' : 'end',
        );
      }, { commit: 'now' });
      if (!block) return null;
      syncMembers(owner, membersNamed(items, memberNames));
      return options.suspendAction();
    });
    if (!block || !naming) return;
    openRegionName(
      { block, doc: owner.doc, path: owner.path },
      (region, requestedName) => naming.resume(() => renameRegion(region, requestedName)),
    );
  }

  // A provider is declared in exactly one place, so a name already taken in this file names
  // another provider — suffixing it the way a node name is uniquified would silently declare a
  // second one.
  function renameRegion(region: RegionTarget, requestedName: string): { rejected: string } | null {
    const name = sanitizeName(requestedName);
    if (!name) return { rejected: 'A region needs a name.' };
    if (name === region.block.name) return null;
    if (FlowDoc.allContextBlocks(region.doc).some((other) => other !== region.block && other.name === name)) {
      return { rejected: `This file already declares a region called "${name}".` };
    }
    if (parseListValue(getPreambleField(region.doc, 'inherits')).includes(name)) {
      return { rejected: `"${name}" is inherited from the graph above, and is already readable here.` };
    }
    const owner = ownerOfRegion(region);
    const oldName = region.block.name;
    // The declaring file, every file that names the provider, and the `inherits` of everything
    // the members expand into are one rename (R43, R44a).
    options.runAction(() => {
      options.applyToDoc(owner, () => FlowDoc.renameContextBlock(owner.doc, region.block, name), { commit: 'now' });
      void renameContextAcrossWorkspace(options.workspaceRename, owner, oldName, name);
      const items = FlowDoc.containingItemsForContext(owner.doc, region.block);
      syncMembers(owner, membersNamed(items, region.block.members));
    });
    options.selectRegion(name);
    return null;
  }

  // Deleting a region removes the provider and nothing else: its members are ordinary nodes that
  // happened to be listed by it (R32). The `updates:` claims that named it go with it, since a
  // provider nobody declares can be read by nobody (R33, R40c).
  function deleteRegion(region: RegionTarget): void {
    deleteRegions([region]);
  }

  function deleteRegions(regions: RegionTarget[]): void {
    options.clearSelection();
    options.runAction(() => writeRegionDeletions(regions));
  }

  function writeRegionDeletions(regions: RegionTarget[]): void {
    for (const region of regions) {
      const owner = ownerOfRegion(region);
      // Resolve the members to their nodes before the block leaves the document: once it is
      // deleted, containingItemsForContext falls back to the file body, which would look for a
      // nested region's members in the wrong scope.
      const items = FlowDoc.containingItemsForContext(owner.doc, region.block);
      const orphanedMembers = membersNamed(items, region.block.members);
      options.applyToDoc(owner, () => {
        FlowDoc.deleteContextBlock(items, region.block);
        FlowDoc.removeUnreadableUpdates(owner.doc);
      }, { commit: 'now' });
      syncMembers(owner, orphanedMembers);
    }
  }

  // Every member declaring `updates:` on one of these providers is about to lose that claim — the
  // deletion strips it — so the user is told what the delete will remove before it happens (R33).
  function confirmRegionDeletions(regions: RegionTarget[], at: Point, proceed: () => void): void {
    const writers = regions.flatMap((region) => membersUpdatingRegion(region));
    if (writers.length === 0) {
      proceed();
      return;
    }
    const names = regions.map((region) => region.block.name);
    options.openConfirmMenu([
      {
        label: `${writers.join(', ')} updates ${names.join(', ')} — deleting removes those updates.`,
        danger: true,
        onSelect: proceed,
      },
      { label: 'Cancel', onSelect: () => {} },
    ], at);
  }

  // What the node editor shows and what its `updates` field accepts: the regions listing this
  // node plus everything its file inherits, which is exactly what the linter resolves.
  function readableContexts(node: FlowNode): { name: string; inherited: boolean }[] {
    const owner = options.ownerOf(node);
    const inherited = new Set(FlowDoc.inheritedContextNames(owner.doc));
    return FlowDoc.contextNamesReadableBy(owner.doc, node)
      .map((name) => ({ name, inherited: inherited.has(name) }));
  }

  // A member declaring `updates:` on this provider is about to lose that claim — the deletion
  // strips it — so the user is told what the delete will remove before it happens (R33).
  function regionMenuItems(region: RegionTarget, at: Point): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'Edit', onSelect: () => options.openRegionEditor(region) },
      { label: 'Rename', onSelect: () => openRegionName(region) },
    ];
    return [...items, ...deleteRegionMenuItems(region, at)];
  }

  function deleteRegionMenuItems(region: RegionTarget, at: Point): MenuItem[] {
    return [{
      label: 'Delete region (keeps its nodes)',
      danger: true,
      onSelect: () => confirmRegionDeletions([region], at, () => deleteRegion(region)),
    }];
  }

  return {
    ownerOfRegion,
    createRegionAndName,
    canGroupSelectionIntoContext,
    groupSelectionIntoContext,
    renameRegion,
    deleteRegion,
    deleteRegions,
    writeRegionDeletions,
    confirmRegionDeletions,
    readableContexts,
    regionMenuItems,
    syncInheritsForMembers: syncMembers,
    syncInheritsForExpansionPaths: syncExpansionPaths,
  };
}

export function membersUpdatingRegion(region: RegionTarget): string[] {
  // Members resolve in the block's own scope, not file-wide: a same-named node in another
  // scope is a different node and must not be credited with (or blamed for) its updates.
  const items = FlowDoc.containingItemsForContext(region.doc, region.block);
  const byName = new Map(FlowDoc.nodesIn(items).map((node) => [node.name, node]));
  return region.block.members.filter((name) => {
    const node = byName.get(name);
    return node != null && parseListValue(getProp(node, 'updates')).includes(region.block.name);
  });
}
