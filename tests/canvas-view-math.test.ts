import { describe, expect, it } from 'vitest';
import {
  cameraLinkFromInlineTransform,
  cameraLinkFromRect,
  childViewLinkedTo,
  parentViewLinkedTo,
  interpolateView,
  transformFromCameraLink,
  type CameraLink,
  type View,
} from '../src/client/canvas/camera-transition.js';
import { composeTransforms } from '../src/client/canvas/expansion.js';

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

  // Diving into a frame nested inside another frame anchors on the composed transform; the
  // dive must still start exactly where the subgraph already sits on screen.
  it('inline-anchored link reproduces a twice-composed frame transform', () => {
    const outer = { scale: 0.4, tx: 180, ty: 90 };
    const inner = { scale: 0.5, tx: 60, ty: 25 };
    const contentCenter = { x: 900, y: 600 };
    const heldView: View = { x: 40, y: -20, scale: 1.5 };

    const link = cameraLinkFromInlineTransform(contentCenter, composeTransforms(outer, inner));

    const onScreen: View = {
      scale: heldView.scale * outer.scale * inner.scale,
      x: heldView.scale * (outer.scale * inner.tx + outer.tx) + heldView.x,
      y: heldView.scale * (outer.scale * inner.ty + outer.ty) + heldView.y,
    };
    expectViewsClose(childViewLinkedTo(heldView, link), onScreen);
  });
});

describe('transformFromCameraLink', () => {
  it('round-trips an inline-anchored link', () => {
    const transform = { scale: 0.3, tx: 220, ty: 130 };
    const recovered = transformFromCameraLink(
      cameraLinkFromInlineTransform({ x: 900, y: 600 }, transform),
    );
    expect(recovered.scale).toBeCloseTo(transform.scale, 8);
    expect(recovered.tx).toBeCloseTo(transform.tx, 8);
    expect(recovered.ty).toBeCloseTo(transform.ty, 8);
  });

  it('places a rect-anchored graph centered inside the node it dives from', () => {
    const contentBounds = { x: 0, y: 0, w: 800, h: 600 };
    const nodeRect = { x: 100, y: 80, w: 200, h: 80 };
    const transform = transformFromCameraLink(cameraLinkFromRect(contentBounds, nodeRect));

    const placed = {
      x: contentBounds.x * transform.scale + transform.tx,
      y: contentBounds.y * transform.scale + transform.ty,
      w: contentBounds.w * transform.scale,
      h: contentBounds.h * transform.scale,
    };
    expect(placed.w).toBeLessThanOrEqual(nodeRect.w + 1e-9);
    expect(placed.h).toBeLessThanOrEqual(nodeRect.h + 1e-9);
    expect(placed.x + placed.w / 2).toBeCloseTo(nodeRect.x + nodeRect.w / 2, 8);
    expect(placed.y + placed.h / 2).toBeCloseTo(nodeRect.y + nodeRect.h / 2, 8);
  });

  // Two crumbs jumped at once compose into the single motion the two steps would have played.
  it('composes two hops into the placement of the deeper graph in the outer one', () => {
    const outerNode = { x: 100, y: 80, w: 200, h: 80 };
    const middleContent = { x: 0, y: 0, w: 800, h: 600 };
    const middleNode = { x: 300, y: 200, w: 180, h: 90 };
    const deepContent = { x: -50, y: 0, w: 400, h: 400 };

    const outerHop = transformFromCameraLink(cameraLinkFromRect(middleContent, outerNode));
    const innerHop = transformFromCameraLink(cameraLinkFromRect(deepContent, middleNode));
    const composed = composeTransforms(outerHop, innerHop);

    const deepCenter = { x: deepContent.x + deepContent.w / 2, y: deepContent.y + deepContent.h / 2 };
    const middleNodeCenter = { x: middleNode.x + middleNode.w / 2, y: middleNode.y + middleNode.h / 2 };
    const throughBothHops = {
      x: (middleNodeCenter.x * outerHop.scale) + outerHop.tx,
      y: (middleNodeCenter.y * outerHop.scale) + outerHop.ty,
    };
    expect(deepCenter.x * composed.scale + composed.tx).toBeCloseTo(throughBothHops.x, 8);
    expect(deepCenter.y * composed.scale + composed.ty).toBeCloseTo(throughBothHops.y, 8);
    expect(composed.scale).toBeCloseTo(outerHop.scale * innerHop.scale, 8);
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
