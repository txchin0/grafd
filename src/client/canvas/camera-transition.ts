import type { Rect } from '../../shared/flow-format.js';
import { displayRects, type FlowModel } from '../flow-doc.js';
import { boundsOfRects } from '../../shared/rect-math.js';
import { lerp, rectCenter, type Point } from '../geometry.js';
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

// A model with nothing in it still has to be framed by something.
const EMPTY_MODEL_SIZE = { w: 400, h: 300 };

export function modelContentBounds(model: FlowModel): Rect {
  return boundsOfRects(displayRects(model)) ?? { x: 0, y: 0, ...EMPTY_MODEL_SIZE };
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

// A camera link is a similarity mapping child coordinates into parent coordinates; this is
// that map on its own, so links of either flavor can be composed with frame transforms.
export function transformFromCameraLink(link: CameraLink): FrameTransform {
  const scale = 1 / link.growth;
  return {
    scale,
    tx: link.nodeCenter.x - link.contentCenter.x * scale,
    ty: link.nodeCenter.y - link.contentCenter.y * scale,
  };
}

export function cameraLinkFittingModelIntoRect(model: FlowModel, nodeRect: Rect): CameraLink {
  return cameraLinkFromRect(modelContentBounds(model), nodeRect);
}

export function fitTransformIntoRect(model: FlowModel, nodeRect: Rect): FrameTransform {
  return transformFromCameraLink(cameraLinkFittingModelIntoRect(model, nodeRect));
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
