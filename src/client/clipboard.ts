// Copy, cut, paste and duplicate for canvas nodes, context regions and drawn strokes.
//
// The clipboard is session-local and holds detached node copies alongside the path and
// `graph:` scope they came from, so paste can route back into the .flow file that owns them —
// which for nodes selected inside an inline-expanded frame is not the open file. Cloning at
// copy time means later edits to (or deletion of) the originals never disturb a later paste.
// Regions ride the same groups: a region belongs to the graph scope that declares it, so a
// paste whose target is a `graph:` block writes the block into that scope. The nodes' canvas
// visuals are captured with them, positionally, since a copy shares no id with its source.
// Strokes ride the same groups too, in the same scope coordinates as the nodes beside them, so a
// paste keeps a stroke where it was drawn relative to them.

import { strokePointsOf, type CarriedDrawings } from '../shared/canvas-drawings.js';
import type { CapturedVisuals } from '../shared/canvas-layer.js';
import type { ContextBlock, FlowNode } from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import type { Point } from './geometry.js';
import type { DocumentOwner } from './canvas/expansion.js';
import type { RegionTarget } from './canvas/canvas-view.js';
import type { DrawingSelection, StoredDrawing } from './canvas/drawing-selection.js';
import type { CopiedDrawings, CreationTarget } from './drawing-ops.js';
import type { OpenFlow } from './open-flow.js';

// How far a duplicate lands from its original, and where a paste with no pointer position goes.
const DUPLICATE_STEP = 24;

interface ClipboardGroup {
  path: string;
  scope: string | null;
  nodes: FlowNode[];
  regions: ContextBlock[];
  visuals: CapturedVisuals | null;
  drawings: CarriedDrawings;
}

interface CopiedGroup extends Omit<ClipboardGroup, 'visuals'> {
  owner: DocumentOwner;
}

export interface ClipboardOptions {
  openFlow(): OpenFlow | null;
  selection(): FlowNode[];
  selectedRegions(): RegionTarget[];
  selectedDrawings(): DrawingSelection[];
  select(nodes: FlowNode[], regions: ContextBlock[], drawings: StoredDrawing[]): void;
  ownerOf(node: FlowNode): DocumentOwner;
  ownerOfRegion(region: RegionTarget): DocumentOwner;
  // Resolves a path this session has loaded, so a paste can reach a frame's own document.
  documentAt(path: string): DocumentOwner | null;
  applyToDoc(owner: DocumentOwner, mutation: () => void): void;
  deleteSelection(): void;
  captureVisuals(owner: DocumentOwner, nodes: FlowNode[]): CapturedVisuals | null;
  // Runs inside the mutation that made the copies, so its layer write joins that edit's commit.
  applyCapturedVisuals(owner: DocumentOwner, copies: FlowNode[], visuals: CapturedVisuals | null): void;
  copyDrawings(selections: DrawingSelection[]): CopiedDrawings[];
  pasteDrawings(target: CreationTarget, drawings: CarriedDrawings, offset: Point): StoredDrawing[];
  // Cut, paste and duplicate each write several documents; this makes each one undo step.
  runAction(body: () => void): void;
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

  function groupFor(byScope: Map<string, CopiedGroup>, owner: DocumentOwner, scope: string | null): CopiedGroup {
    const { path } = owner;
    // NUL separates the two halves so a path containing the scope's text cannot collide.
    const key = `${path}\0${scope ?? ''}`;
    let group = byScope.get(key);
    if (!group) {
      group = { owner, path, scope, nodes: [], regions: [], drawings: { drawings: [], groups: [] } };
      byScope.set(key, group);
    }
    return group;
  }

  function hasSelection(): boolean {
    return options.selection().length > 0 || options.selectedRegions().length > 0 || options.selectedDrawings().length > 0;
  }

  function copy(): void {
    if (!hasSelection()) return;
    const selection = options.selection();
    const selectedRegions = options.selectedRegions();
    const byScope = new Map<string, CopiedGroup>();
    for (const node of selection) {
      const owner = options.ownerOf(node);
      const scope = FlowDoc.containingGraphBlockName(owner.doc, node);
      groupFor(byScope, owner, scope).nodes.push(node);
    }
    for (const region of selectedRegions) {
      const owner = options.ownerOfRegion(region);
      const scope = FlowDoc.containingGraphBlockNameForContext(owner.doc, region.block);
      groupFor(byScope, owner, scope).regions.push(structuredClone(region.block));
    }
    for (const { owner, scope, carried } of options.copyDrawings(options.selectedDrawings())) {
      groupFor(byScope, owner, scope).drawings = carried;
    }
    groups = [...byScope.values()].map((group) => ({
      path: group.path,
      scope: group.scope,
      nodes: FlowDoc.cloneNodesDetached(group.nodes),
      regions: group.regions,
      visuals: options.captureVisuals(group.owner, group.nodes),
      drawings: group.drawings,
    }));
  }

  function cut(): void {
    if (!hasSelection()) return;
    copy();
    options.runAction(() => options.deleteSelection());
  }

  function hasContent(): boolean {
    return groups.some((group) => group.nodes.length > 0 || group.regions.length > 0 || group.drawings.drawings.length > 0);
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
          const visuals = options.captureVisuals(owner, group);
          const groupCopies = FlowDoc.duplicateNodes(items, group, offset);
          options.applyCapturedVisuals(owner, groupCopies, visuals);
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
        const items = FlowDoc.containingItemsForContext(owner.doc, region.block);
        const nested = items !== owner.doc.items;
        regionCopies.push(...FlowDoc.duplicateContextBlocks(
          items,
          [region.block],
          offset,
          renamedByPath.get(owner.path) ?? new Map(),
          FlowDoc.inheritedContextNames(owner.doc),
          FlowDoc.allContextBlocks(owner.doc).map((block) => block.name),
          nested ? 'before-nodes' : 'end',
        ));
      });
    }
    return { nodes: copies, regions: regionCopies };
  }

  function duplicateSelection(): void {
    if (!hasSelection()) return;
    const offset = { x: DUPLICATE_STEP, y: DUPLICATE_STEP };
    options.runAction(() => {
      const copies = duplicateCluster(options.selection(), options.selectedRegions(), offset);
      const drawingCopies = options.copyDrawings(options.selectedDrawings())
        .flatMap(({ owner, scope, carried }) => options.pasteDrawings({ owner, scope }, carried, offset));
      selectIfAny(copies.nodes, copies.regions, drawingCopies);
    });
  }

  function selectIfAny(nodes: FlowNode[], regions: ContextBlock[], drawings: StoredDrawing[]): void {
    if (nodes.length + regions.length + drawings.length > 0) options.select(nodes, regions, drawings);
  }

  // Paste at the pointer puts the top-left corner of everything copied under it, the rest kept in
  // formation — whatever order it was selected in; with no pointer position it offsets like a
  // duplicate instead.
  function offsetToward(world: Point | undefined): Point {
    const corners = groups
      .flatMap((group) => [
        ...group.nodes.map((node) => node.pos),
        ...group.regions.map((region) => region.pos),
        ...group.drawings.drawings.flatMap((drawing) => strokePointsOf(drawing.points) ?? []),
      ])
      .filter((pos): pos is Point => pos != null);
    if (!world || corners.length === 0) return { x: DUPLICATE_STEP, y: DUPLICATE_STEP };
    const topLeft = { x: Math.min(...corners.map((corner) => corner.x)), y: Math.min(...corners.map((corner) => corner.y)) };
    return { x: Math.round(world.x - topLeft.x), y: Math.round(world.y - topLeft.y) };
  }

  function paste(world?: Point): void {
    const flow = options.openFlow();
    if (!flow || !hasContent()) return;
    options.runAction(() => pasteInto(flow, world));
  }

  function pasteInto(flow: OpenFlow, world: Point | undefined): void {
    // A group whose original document is no longer loaded falls back to the open flow, where
    // the user can at least see what they pasted.
    const fallback: DocumentOwner = { doc: flow.doc, path: flow.path };
    const offset = offsetToward(world);
    const pastedNodes: FlowNode[] = [];
    const pastedRegions: ContextBlock[] = [];
    const pastedDrawings: StoredDrawing[] = [];
    for (const group of groups) {
      const resolved = options.documentAt(group.path);
      const owner = resolved ?? fallback;
      const scope = resolved ? group.scope : flow.scope;
      const items = FlowDoc.scopeItems(owner.doc, scope);
      options.applyToDoc(owner, () => {
        const copies = FlowDoc.duplicateNodes(items, group.nodes, offset);
        options.applyCapturedVisuals(owner, copies, group.visuals);
        pastedNodes.push(...copies);
        const renamedMembers = new Map(group.nodes.map((source, index) => [source.name, copies[index].name]));
        const nested = items !== owner.doc.items;
        pastedRegions.push(...FlowDoc.duplicateContextBlocks(
          items,
          group.regions,
          offset,
          renamedMembers,
          FlowDoc.inheritedContextNames(owner.doc),
          FlowDoc.allContextBlocks(owner.doc).map((block) => block.name),
          nested ? 'before-nodes' : 'end',
        ));
      });
      pastedDrawings.push(...options.pasteDrawings({ owner, scope }, group.drawings, offset));
    }
    selectIfAny(pastedNodes, pastedRegions, pastedDrawings);
  }

  return { copy, cut, paste, duplicateSelection, hasContent };
}
