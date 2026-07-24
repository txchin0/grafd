import type { Rect } from '../shared/flow-format.js';
import type { FlowModel, Point } from './flow-doc.js';
import { subModelBounds, transformPoint, type FrameTransform } from './expansion.js';

export interface View {
  x: number;
  y: number;
  scale: number;
}

export interface CameraLink {
  growth: number;
  nodeCenter: Point;
  contentCenter: Point;
}

export interface ViewportSize {
  width: number;
  height: number;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function modelContentBounds(model: FlowModel): Rect {
  const rects = [
    ...model.nodes.map((node) => model.display?.rects.get(node) ?? node.pos),
    ...model.ghosts.map((ghost) => ghost.pos),
  ].filter((rect): rect is Rect => rect != null);
  if (rects.length === 0) return { x: 0, y: 0, w: 400, h: 300 };
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function cameraLinkFromRect(contentBounds: Rect, nodeRect: Rect): CameraLink {
  const growth = Math.max(1.05, contentBounds.w / nodeRect.w, contentBounds.h / nodeRect.h);
  return { growth, nodeCenter: rectCenter(nodeRect), contentCenter: rectCenter(contentBounds) };
}

export function cameraLinkFromInlineTransform(contentCenter: Point, inlineTransform: FrameTransform): CameraLink {
  return {
    growth: 1 / inlineTransform.scale,
    nodeCenter: transformPoint(contentCenter, inlineTransform),
    contentCenter,
  };
}

export function cameraLinkFromInlineModel(childModel: FlowModel, inlineTransform: FrameTransform): CameraLink {
  return cameraLinkFromInlineTransform(rectCenter(subModelBounds(childModel)), inlineTransform);
}

function viewCenterWorld(view: View, bounds: ViewportSize): Point {
  return {
    x: (bounds.width / 2 - view.x) / view.scale,
    y: (bounds.height / 2 - view.y) / view.scale,
  };
}

export function interpolateView(fromView: View, toView: View, t: number, bounds: ViewportSize): View {
  const scale = Math.exp(lerp(Math.log(fromView.scale), Math.log(toView.scale), t));
  const fromCenter = viewCenterWorld(fromView, bounds);
  const toCenter = viewCenterWorld(toView, bounds);
  const centerX = lerp(fromCenter.x, toCenter.x, t);
  const centerY = lerp(fromCenter.y, toCenter.y, t);
  return { scale, x: bounds.width / 2 - centerX * scale, y: bounds.height / 2 - centerY * scale };
}

export function childViewLinkedTo(parentView: View, link: CameraLink): View {
  const scale = parentView.scale / link.growth;
  const nodeCenterScreen = {
    x: link.nodeCenter.x * parentView.scale + parentView.x,
    y: link.nodeCenter.y * parentView.scale + parentView.y,
  };
  return {
    scale,
    x: nodeCenterScreen.x - link.contentCenter.x * scale,
    y: nodeCenterScreen.y - link.contentCenter.y * scale,
  };
}

export function parentViewLinkedTo(childView: View, link: CameraLink): View {
  const scale = childView.scale * link.growth;
  const contentCenterScreen = {
    x: link.contentCenter.x * childView.scale + childView.x,
    y: link.contentCenter.y * childView.scale + childView.y,
  };
  return {
    scale,
    x: contentCenterScreen.x - link.nodeCenter.x * scale,
    y: contentCenterScreen.y - link.nodeCenter.y * scale,
  };
}
