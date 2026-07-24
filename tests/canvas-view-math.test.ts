import { describe, expect, it } from 'vitest';
import {
  cameraLinkFromInlineTransform,
  cameraLinkFromRect,
  childViewLinkedTo,
  parentViewLinkedTo,
  interpolateView,
  type CameraLink,
  type View,
} from '../src/client/camera-transition.js';

const BOUNDS = { width: 1280, height: 800 };

const LINK: CameraLink = {
  growth: 4,
  nodeCenter: { x: 250, y: 140 },
  contentCenter: { x: 900, y: 600 },
};

function expectViewsClose(actual: View, expected: View) {
  expect(actual.scale).toBeCloseTo(expected.scale, 8);
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
}

describe('camera link', () => {
  it('keeps the child content center pinned to the node center on screen', () => {
    const parent: View = { x: 40, y: -20, scale: 1.5 };
    const child = childViewLinkedTo(parent, LINK);
    const nodeCenterScreen = {
      x: LINK.nodeCenter.x * parent.scale + parent.x,
      y: LINK.nodeCenter.y * parent.scale + parent.y,
    };
    const contentCenterScreen = {
      x: LINK.contentCenter.x * child.scale + child.x,
      y: LINK.contentCenter.y * child.scale + child.y,
    };
    expect(contentCenterScreen.x).toBeCloseTo(nodeCenterScreen.x, 8);
    expect(contentCenterScreen.y).toBeCloseTo(nodeCenterScreen.y, 8);
    expect(child.scale).toBeCloseTo(parent.scale / LINK.growth, 8);
  });

  it('childViewLinkedTo and parentViewLinkedTo are inverses', () => {
    const parent: View = { x: 123, y: -45, scale: 0.8 };
    expectViewsClose(parentViewLinkedTo(childViewLinkedTo(parent, LINK), LINK), parent);

    const child: View = { x: -300, y: 90, scale: 0.25 };
    expectViewsClose(childViewLinkedTo(parentViewLinkedTo(child, LINK), LINK), child);
  });

  it('cameraLinkFromRect scales content to fill the node rect', () => {
    const nodeRect = { x: 100, y: 80, w: 200, h: 80 };
    const contentBounds = { x: 0, y: 0, w: 800, h: 600 };
    const link = cameraLinkFromRect(contentBounds, nodeRect);
    expect(link.growth).toBeCloseTo(7.5, 8);
    expect(link.nodeCenter).toEqual({ x: 200, y: 120 });
    expect(link.contentCenter).toEqual({ x: 400, y: 300 });
  });

  it('inline-anchored link reproduces the on-screen frame transform', () => {
    const inlineTransform = { scale: 0.3, tx: 220, ty: 130 };
    const contentCenter = { x: 900, y: 600 };
    const heldView: View = { x: 40, y: -20, scale: 1.5 };

    const link = cameraLinkFromInlineTransform(contentCenter, inlineTransform);

    const composed: View = {
      scale: heldView.scale * inlineTransform.scale,
      x: heldView.scale * inlineTransform.tx + heldView.x,
      y: heldView.scale * inlineTransform.ty + heldView.y,
    };
    expectViewsClose(childViewLinkedTo(heldView, link), composed);
  });
});

describe('interpolateView', () => {
  const from: View = { x: 0, y: 0, scale: 1 };
  const to: View = { x: -500, y: 200, scale: 2.5 };

  it('matches the endpoints at t=0 and t=1', () => {
    expectViewsClose(interpolateView(from, to, 0, BOUNDS), from);
    expectViewsClose(interpolateView(from, to, 1, BOUNDS), to);
  });

  it('interpolates scale logarithmically', () => {
    const mid = interpolateView(from, to, 0.5, BOUNDS);
    expect(mid.scale).toBeCloseTo(Math.sqrt(from.scale * to.scale), 8);
  });
});
