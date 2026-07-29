import {
  getProp,
  parseExpandLink,
  resolveLinkPath,
  type ExpandLink,
  type FlowDocument,
  type FlowNode,
  type Rect,
} from '../../shared/flow-format.js';
import * as FlowDoc from '../flow-doc.js';
import type { FlowModel } from '../flow-doc.js';
import type { View } from './canvas-view.js';
import { fitTransformIntoRect } from './camera-transition.js';
import { composeTransforms, transformRect, type FrameTransform } from './expansion.js';

export interface NavigationLevel {
  path: string;
  scope: string | null;
}

export interface TrailEntry extends NavigationLevel {
  nodeId: string | null;
  view: View;
}

export interface DiveTarget extends NavigationLevel {
  link: ExpandLink | null;
}

export interface DivePath {
  entries: TrailEntry[];
  destination: DiveTarget;
}

export interface BackOutAnchor {
  transform: FrameTransform;
  rect: Rect;
  // True only when every hop lands in an unfolded frame, so the destination scene draws the
  // graph being left behind at exactly the placement it shrinks into. When any hop is a
  // folded node the destination has nothing there and the leaving graph has to fade out.
  drawnByDestination: boolean;
}

export interface DiveNavigationContext {
  path: string;
  scope: string | null;
  doc: FlowDocument | null;
  model: FlowModel;
  liveView: View;
  fitViewForModel(model: FlowModel): View;
  ancestorHosts(node: FlowNode): FlowNode[];
  modelOf(node: FlowNode): FlowModel | null;
  documentAt(path: string): FlowDocument | null;
}

export function diveTargetOf(node: FlowNode, containingPath: string): DiveTarget | null {
  const expandValue = getProp(node, 'expand');
  if (!expandValue) return null;
  const link = parseExpandLink(expandValue);
  if (link) return { path: resolveLinkPath(containingPath, link.path), scope: null, link };
  return { path: containingPath, scope: expandValue, link: null };
}

// Walks from the level on screen down to `node`, producing one trail entry per level left
// behind and the target the dive lands on. Each level's expand link resolves against the
// document that level lives in, not the open one.
export function divePathTo(ctx: DiveNavigationContext, node: FlowNode): DivePath | null {
  const entries: TrailEntry[] = [];
  let level: DiveTarget = { path: ctx.path, scope: ctx.scope, link: null };
  for (const levelNode of [...ctx.ancestorHosts(node), node]) {
    entries.push({
      path: level.path,
      scope: level.scope,
      nodeId: levelNode.id,
      view: cameraForLevel(ctx, entries, levelNode),
    });
    const target = diveTargetOf(levelNode, level.path);
    if (!target) return null;
    level = target;
  }
  return { entries, destination: level };
}

// The level the user is looking at contributes its live camera; the skipped levels below it
// never had one, so they get the camera zoom-to-fit would have given them on arrival — which
// is where stepping back to that crumb animates to.
function cameraForLevel(ctx: DiveNavigationContext, entriesSoFar: TrailEntry[], levelNode: FlowNode): View {
  if (entriesSoFar.length === 0) return { ...ctx.liveView };
  const model = ctx.modelOf(levelNode);
  if (!model) return { ...ctx.liveView };
  return ctx.fitViewForModel(model);
}

// Levels the trail passed through are not on screen, so their geometry has to be rebuilt
// from the document they live in — already loaded, since navigating through the level read
// it. Null when that document is no longer available.
export function modelForLevel(
  ctx: Pick<DiveNavigationContext, 'path' | 'doc' | 'documentAt'>,
  level: NavigationLevel,
): FlowModel | null {
  const doc = level.path === ctx.path ? ctx.doc : ctx.documentAt(level.path);
  if (!doc) return null;
  const model = FlowDoc.buildModel(doc, level.scope);
  model.sourcePath = level.path;
  return model;
}

// Where the graph being left behind sits within the restored destination, and the rect it
// shrinks into. Each crumb dropped contributes one hop from a level to the graph one of its
// nodes expands into; hops compose, so a jump across several crumbs animates as the single
// zoom-out those steps would have played one after another.
//
// A hop lands either in an unfolded frame — the placement already on screen — or, when that
// node is not unfolded, in the placement a plain dive animates through: the child graph
// fitted into the node's rect. Both are similarities, which is what lets them compose.
export function backOutAnchorFor(
  ctx: DiveNavigationContext,
  dropped: TrailEntry[],
  leavingModel: FlowModel,
): BackOutAnchor | null {
  let model = ctx.model;
  let transform: FrameTransform = { scale: 1, tx: 0, ty: 0 };
  let rect: Rect | null = null;
  let everyHopUnfolded = true;
  for (const [hop, entry] of dropped.entries()) {
    const node = model.nodes.find((candidate) => candidate.id === entry.nodeId);
    const nodeRect = node && (model.display?.rects.get(node) ?? node.pos);
    if (!node || !nodeRect) return null;
    const isLastHop = hop === dropped.length - 1;
    const expansion = model.display?.expansions.get(node);
    const childModel = expansion?.subModel
      ?? (isLastHop ? leavingModel : modelForLevel(ctx, dropped[hop + 1]));
    if (!childModel) return null;

    if (!expansion) everyHopUnfolded = false;
    rect = transformRect(nodeRect, transform);
    transform = composeTransforms(transform, expansion?.transform ?? fitTransformIntoRect(childModel, nodeRect));
    model = childModel;
  }
  return rect ? { transform, rect, drawnByDestination: everyHopUnfolded } : null;
}
