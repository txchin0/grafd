// Copy, cut, paste and duplicate for canvas nodes, context regions and drawn strokes.
//
// The clipboard is session-local and holds detached copies grouped by the graph they came from —
// a file and a `graph:` scope, which for nodes selected inside an inline-expanded frame is not the
// open file. Cloning at copy time means later edits to (or deletion of) the originals never
// disturb a later paste. Regions and strokes ride the same groups, in the same scope coordinates
// as the nodes beside them, so a paste keeps them where they were relative to those nodes. The
// canvas visuals of nodes and regions are captured with them, positionally, since a copy shares no
// id or name with its source.
//
// A paste goes into whichever graph the caller names — the one under the pointer — not back to
// where the copy came from. Pasted into another graph, a copy is adapted to it first
// (paste-transplant.ts): edges to nodes left behind are dropped, and pasted into another file, its
// `expand` links are respelled and the local subgraphs it expands into are carried along, captured
// at copy time like everything else.

import { drawingAnchorPoints, type CarriedDrawings } from '../shared/canvas-drawings.js';
import { textDrawingOf } from '../shared/canvas-text.js';
import type { CapturedRegionVisuals, CapturedVisuals } from '../shared/canvas-layer.js';
import type { ContextBlock, FlowDocument, FlowItem, FlowNode } from '../shared/flow-format.js';
import * as FlowDoc from './flow-doc.js';
import type { Point } from './geometry.js';
import type { DocumentOwner } from './canvas/expansion.js';
import type { RegionTarget } from './canvas/canvas-view.js';
import type { DrawingSelection, StoredDrawing } from './canvas/drawing-selection.js';
import type { CopiedDrawings, CreationTarget } from './drawing-ops.js';
import {
  assignSubgraphNames,
  expansionOf,
  expansionReaches,
  keepEdgesWithinCopy,
  localSubgraphNames,
  rebaseExpandLinks,
  renameLocalExpands,
  renameUpdatedRegions,
  sameGraph,
  type GraphUnit,
} from './paste-transplant.js';

// How far a duplicate lands from its original, and how far each repeated keyboard paste steps on.
const DUPLICATE_STEP = 24;
const IN_PLACE: Point = { x: 0, y: 0 };

// `at-point` puts the top-left of what was copied at the point. `beside-originals` steps away from
// the originals like a duplicate when pasting back into the graph they came from, and is at the
// point otherwise — the originals' coordinates mean nothing in another graph.
export type PastePlacement = 'at-point' | 'beside-originals';

export interface PasteRequest {
  target: CreationTarget;
  // In the target graph's own coordinates.
  point: Point;
  placement: PastePlacement;
}

interface ClipboardGroup {
  source: GraphUnit;
  nodes: FlowNode[];
  regions: ContextBlock[];
  visuals: CapturedVisuals | null;
  regionVisuals: CapturedRegionVisuals | null;
  drawings: CarriedDrawings;
}

interface CopiedGroup {
  owner: DocumentOwner;
  scope: string | null;
  nodes: FlowNode[];
  regions: ContextBlock[];
  drawings: CarriedDrawings;
}

// A `graph:` block a copied node expands into, carried whole so a paste into another file can
// write it there.
interface CarriedSubgraph {
  name: string;
  nodes: FlowNode[];
  regions: ContextBlock[];
  visuals: CapturedVisuals | null;
  regionVisuals: CapturedRegionVisuals | null;
  drawings: CarriedDrawings;
}

export interface ClipboardOptions {
  selection(): FlowNode[];
  selectedRegions(): RegionTarget[];
  selectedDrawings(): DrawingSelection[];
  select(nodes: FlowNode[], regions: ContextBlock[], drawings: StoredDrawing[]): void;
  ownerOf(node: FlowNode): DocumentOwner;
  ownerOfRegion(region: RegionTarget): DocumentOwner;
  // Resolves a path this session has loaded, so a paste can tell whether it would put a node
  // inside its own expansion.
  documentAt(path: string): FlowDocument | null;
  applyToDoc(owner: DocumentOwner, mutation: () => void): void;
  deleteSelection(): void;
  captureVisuals(owner: DocumentOwner, nodes: FlowNode[]): CapturedVisuals | null;
  // Runs inside the mutation that made the copies, so its layer write joins that edit's commit.
  applyCapturedVisuals(owner: DocumentOwner, copies: FlowNode[], visuals: CapturedVisuals | null): void;
  captureRegionVisuals(owner: DocumentOwner, regions: readonly ContextBlock[]): CapturedRegionVisuals | null;
  // Like applyCapturedVisuals, runs inside the mutation that made the copies.
  applyRegionVisuals(owner: DocumentOwner, copies: readonly ContextBlock[], visuals: CapturedRegionVisuals | null): void;
  copyDrawings(selections: DrawingSelection[]): CopiedDrawings[];
  // Every drawing filed under one graph, for a subgraph carried whole.
  copyDrawingsInScope(owner: DocumentOwner, scope: string): CarriedDrawings;
  pasteDrawings(target: CreationTarget, drawings: CarriedDrawings, offset: Point): StoredDrawing[];
  // Cut, paste and duplicate each write several documents; this makes each one undo step.
  runAction(body: () => void): void;
  // Says why a paste wrote nothing.
  notify(text: string): void;
}

export interface Clipboard {
  copy(): void;
  cut(): void;
  paste(request: PasteRequest): void;
  duplicateSelection(): void;
  hasContent(): boolean;
  // What was copied as words, one name or text per line, for the system clipboard: another
  // program pastes something readable, and the copy displaces whatever image the system clipboard
  // held, so the most recent copy is the one a paste brings back.
  plainText(): string;
}

export function createClipboard(options: ClipboardOptions): Clipboard {
  let groups: ClipboardGroup[] = [];
  // Per source file, the subgraphs its copied nodes expand into.
  let subgraphsByPath = new Map<string, CarriedSubgraph[]>();
  // How many keyboard pastes this clipboard's content has had. Each lands one step further on
  // than the last, so repeated pastes cascade instead of stacking.
  let besidePasteCount = 0;

  function groupFor(byScope: Map<string, CopiedGroup>, owner: DocumentOwner, scope: string | null): CopiedGroup {
    const { path } = owner;
    // NUL separates the two halves so a path containing the scope's text cannot collide.
    const key = `${path}\0${scope ?? ''}`;
    let group = byScope.get(key);
    if (!group) {
      group = { owner, scope, nodes: [], regions: [], drawings: { drawings: [], groups: [] } };
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
    const copied = [...byScope.values()];
    groups = copied.map((group) => ({
      source: { path: group.owner.path, scope: group.scope },
      nodes: FlowDoc.cloneNodesDetached(group.nodes),
      regions: group.regions,
      visuals: options.captureVisuals(group.owner, group.nodes),
      regionVisuals: options.captureRegionVisuals(group.owner, group.regions),
      drawings: group.drawings,
    }));
    subgraphsByPath = carriedSubgraphsOf(copied);
    besidePasteCount = 0;
  }

  // Captured for every source file, though only a paste into another file writes them: by then
  // the originals may have been edited or deleted.
  function carriedSubgraphsOf(copied: CopiedGroup[]): Map<string, CarriedSubgraph[]> {
    const nodesByPath = new Map<string, { owner: DocumentOwner; nodes: FlowNode[] }>();
    for (const group of copied) {
      const entry = nodesByPath.get(group.owner.path) ?? { owner: group.owner, nodes: [] };
      entry.nodes.push(...group.nodes);
      nodesByPath.set(group.owner.path, entry);
    }
    const carried = new Map<string, CarriedSubgraph[]>();
    for (const [path, { owner, nodes }] of nodesByPath) {
      const subgraphs = localSubgraphNames(owner.doc, nodes).map((name) => carriedSubgraph(owner, name));
      if (subgraphs.length > 0) carried.set(path, subgraphs);
    }
    return carried;
  }

  // A block an `expand` names but nobody has written yet is carried empty, so the expand still
  // resolves where it lands.
  function carriedSubgraph(owner: DocumentOwner, name: string): CarriedSubgraph {
    const items: FlowItem[] = FlowDoc.graphBlockNames(owner.doc).includes(name) ? FlowDoc.scopeItems(owner.doc, name) : [];
    const nodes = FlowDoc.nodesIn(items);
    const regions = FlowDoc.contextBlocksIn(items);
    return {
      name,
      nodes: FlowDoc.cloneNodesDetached(nodes),
      regions: regions.map((region) => structuredClone(region)),
      visuals: options.captureVisuals(owner, nodes),
      regionVisuals: options.captureRegionVisuals(owner, regions),
      drawings: options.copyDrawingsInScope(owner, name),
    };
  }

  function cut(): void {
    if (!hasSelection()) return;
    copy();
    options.runAction(() => options.deleteSelection());
  }

  function hasContent(): boolean {
    return groups.some((group) => group.nodes.length > 0 || group.regions.length > 0 || group.drawings.drawings.length > 0);
  }

  // Never empty: an empty text might not displace an image the system clipboard holds, and a copy
  // of drawings alone has no words of its own.
  function plainText(): string {
    const words = groups.flatMap((group) => [
      ...group.nodes.map((node) => node.name),
      ...group.regions.map((region) => region.name),
      ...group.drawings.drawings.flatMap((drawing) => textDrawingOf(drawing)?.text ?? []),
    ]);
    if (words.length > 0) return words.join('\n');
    const drawingCount = groups.reduce((count, group) => count + group.drawings.drawings.length, 0);
    return drawingCount === 1 ? '1 drawing' : `${drawingCount} drawings`;
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
        const visuals = options.captureRegionVisuals(owner, [region.block]);
        const copiesOfRegion = FlowDoc.duplicateContextBlocks(
          items,
          [region.block],
          offset,
          renamedByPath.get(owner.path) ?? new Map(),
          FlowDoc.inheritedContextNames(owner.doc),
          FlowDoc.allContextBlocks(owner.doc).map((block) => block.name),
          nested ? 'before-nodes' : 'end',
        );
        options.applyRegionVisuals(owner, copiesOfRegion, visuals);
        regionCopies.push(...copiesOfRegion);
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

  // The top-left corner of everything copied lands where it is asked to, the rest kept in
  // formation — whatever order it was selected in.
  function pasteOffset({ target, point, placement }: PasteRequest): Point {
    if (placement === 'at-point') return offsetPlacingTopLeftAt(point) ?? IN_PLACE;
    besidePasteCount += 1;
    const stepsOn = DUPLICATE_STEP * besidePasteCount;
    const destination = unitOf(target);
    if (groups.every((group) => sameGraph(group.source, destination))) return { x: stepsOn, y: stepsOn };
    const atPoint = offsetPlacingTopLeftAt(point) ?? IN_PLACE;
    const stepsPastThePoint = stepsOn - DUPLICATE_STEP;
    return { x: atPoint.x + stepsPastThePoint, y: atPoint.y + stepsPastThePoint };
  }

  function offsetPlacingTopLeftAt(point: Point): Point | null {
    const corners = groups
      .flatMap((group) => [
        ...group.nodes.map((node) => node.pos),
        ...group.regions.map((region) => region.pos),
        ...group.drawings.drawings.flatMap(drawingAnchorPoints),
      ])
      .filter((pos): pos is Point => pos != null);
    if (corners.length === 0) return null;
    const topLeft = { x: Math.min(...corners.map((corner) => corner.x)), y: Math.min(...corners.map((corner) => corner.y)) };
    return { x: Math.round(point.x - topLeft.x), y: Math.round(point.y - topLeft.y) };
  }

  function paste(request: PasteRequest): void {
    if (!hasContent()) return;
    const refusal = expansionLoopRefusal(unitOf(request.target));
    if (refusal) {
      options.notify(refusal);
      return;
    }
    options.runAction(() => pasteInto(request));
  }

  // A node pasted inside its own expansion would unfold into itself forever.
  function expansionLoopRefusal(destination: GraphUnit): string | null {
    for (const group of groups) {
      for (const node of group.nodes) {
        const expansion = expansionOf(node, group.source.path);
        if (expansion && expansionReaches(expansion, destination, options.documentAt)) {
          return `Can't paste ${node.name} here: it expands into this graph`;
        }
      }
    }
    return null;
  }

  function pasteInto(request: PasteRequest): void {
    const { target } = request;
    const { owner } = target;
    const destination = unitOf(target);
    const offset = pasteOffset(request);
    const pastedNodes: FlowNode[] = [];
    const pastedRegions: ContextBlock[] = [];
    const pastedDrawings: StoredDrawing[] = [];
    const subgraphRenamesByPath = new Map<string, Map<string, string>>();
    const carriedDrawings: { scope: string; drawings: CarriedDrawings }[] = [];
    const subgraphsFromOtherFiles = [...subgraphsByPath].filter(([sourcePath]) => sourcePath !== owner.path);
    if (subgraphsFromOtherFiles.length > 0) {
      options.applyToDoc(owner, () => {
        for (const [sourcePath, subgraphs] of subgraphsFromOtherFiles) {
          const written = writeCarriedSubgraphs(owner, sourcePath, subgraphs);
          subgraphRenamesByPath.set(sourcePath, written.renames);
          carriedDrawings.push(...written.drawings);
        }
      });
    }
    for (const { scope, drawings } of carriedDrawings) options.pasteDrawings({ owner, scope }, drawings, IN_PLACE);
    for (const group of groups) {
      const crossesGraphs = !sameGraph(group.source, destination);
      const adapted = crossesGraphs ? keepEdgesWithinCopy(group.nodes, group.visuals) : { nodes: group.nodes, visuals: group.visuals };
      rebaseExpandLinks(adapted.nodes, group.source.path, owner.path);
      renameLocalExpands(adapted.nodes, subgraphRenamesByPath.get(group.source.path) ?? new Map());
      options.applyToDoc(owner, () => {
        const items = FlowDoc.ensureScopeItems(owner.doc, target.scope);
        const copies = FlowDoc.duplicateNodes(items, adapted.nodes, offset);
        options.applyCapturedVisuals(owner, copies, adapted.visuals);
        pastedNodes.push(...copies);
        const renamedMembers = new Map(adapted.nodes.map((source, index) => [source.name, copies[index].name]));
        const regionCopies = duplicateRegionsInto(owner.doc, items, group.regions, offset, renamedMembers);
        renameUpdatedRegions(copies, renamesOf(group.regions, regionCopies));
        options.applyRegionVisuals(owner, regionCopies, group.regionVisuals);
        pastedRegions.push(...regionCopies);
        if (crossesGraphs) FlowDoc.removeUnreadableUpdates(owner.doc, copies);
      });
      pastedDrawings.push(...options.pasteDrawings(target, group.drawings, offset));
    }
    selectIfAny(pastedNodes, pastedRegions, pastedDrawings);
  }

  // Writes the subgraphs copied out of `sourcePath` into the destination file, each under a name
  // no block there uses yet. Returns those names, which the pasted hosts' `expand` must follow, and
  // the drawings to file under them — written once the blocks exist.
  function writeCarriedSubgraphs(
    owner: DocumentOwner,
    sourcePath: string,
    subgraphs: CarriedSubgraph[],
  ): { renames: Map<string, string>; drawings: { scope: string; drawings: CarriedDrawings }[] } {
    const renames = assignSubgraphNames(FlowDoc.graphBlockNames(owner.doc), subgraphs.map((subgraph) => subgraph.name));
    const drawings: { scope: string; drawings: CarriedDrawings }[] = [];
    for (const subgraph of subgraphs) {
      const blockName = renames.get(subgraph.name)!;
      const nodes = FlowDoc.cloneNodesDetached(subgraph.nodes);
      rebaseExpandLinks(nodes, sourcePath, owner.path);
      renameLocalExpands(nodes, renames);
      const items = FlowDoc.ensureScopeItems(owner.doc, blockName);
      const copies = FlowDoc.duplicateNodes(items, nodes, IN_PLACE);
      options.applyCapturedVisuals(owner, copies, subgraph.visuals);
      const sameNames = new Map(nodes.map((node, index) => [node.name, copies[index].name]));
      const regionCopies = duplicateRegionsInto(owner.doc, items, subgraph.regions, IN_PLACE, sameNames);
      renameUpdatedRegions(copies, renamesOf(subgraph.regions, regionCopies));
      options.applyRegionVisuals(owner, regionCopies, subgraph.regionVisuals);
      FlowDoc.removeUnreadableUpdates(owner.doc, copies);
      drawings.push({ scope: blockName, drawings: subgraph.drawings });
    }
    return { renames, drawings };
  }

  function duplicateRegionsInto(
    doc: FlowDocument,
    items: FlowItem[],
    regions: readonly ContextBlock[],
    offset: Point,
    renamedMembers: ReadonlyMap<string, string>,
  ): ContextBlock[] {
    return FlowDoc.duplicateContextBlocks(
      items,
      regions,
      offset,
      renamedMembers,
      FlowDoc.inheritedContextNames(doc),
      FlowDoc.allContextBlocks(doc).map((block) => block.name),
      items !== doc.items ? 'before-nodes' : 'end',
    );
  }

  return { copy, cut, paste, duplicateSelection, hasContent, plainText };
}

function unitOf(target: CreationTarget): GraphUnit {
  return { path: target.owner.path, scope: target.scope };
}

function renamesOf(sources: readonly ContextBlock[], copies: readonly ContextBlock[]): Map<string, string> {
  return new Map(sources.map((source, index) => [source.name, copies[index].name]));
}
