// A touchpad two-finger swipe and a mouse wheel notch are the same event, so everything here
// is about the delta shapes real devices emit: Chrome's ±100 notch, Firefox's line mode, a
// touchpad's fractional two-axis glide, and the small integer deltas a glide decays into.

import { describe, expect, it } from 'vitest';
import { WheelIntentReader, ZOOM_STEP_FACTOR } from '../src/client/canvas/wheel-intent.js';

function wheel(overrides: Partial<Parameters<WheelIntentReader['read']>[0]> = {}) {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides };
}

describe('WheelIntentReader', () => {
  it('zooms in on an upward mouse-wheel notch', () => {
    const reader = new WheelIntentReader();
    expect(reader.read(wheel({ deltaY: -100 }), 0)).toEqual({ kind: 'zoom', factor: ZOOM_STEP_FACTOR });
  });

  it('zooms out on a downward mouse-wheel notch', () => {
    const reader = new WheelIntentReader();
    expect(reader.read(wheel({ deltaY: 100 }), 0)).toEqual({ kind: 'zoom', factor: 1 / ZOOM_STEP_FACTOR });
  });

  // Page zoom divides the notch — at 110% Chrome reports 100/1.1 — so a fractional delta says
  // nothing about the device, and reading it as one made every mouse wheel pan.
  it('zooms on a mouse notch shrunk to a fraction by page zoom', () => {
    const reader = new WheelIntentReader();
    expect(reader.read(wheel({ deltaX: -0, deltaY: 90.90908893868948 }), 0))
      .toEqual({ kind: 'zoom', factor: 1 / ZOOM_STEP_FACTOR });
  });

  it('treats line-mode deltas as a mouse wheel however small they are', () => {
    const reader = new WheelIntentReader();
    expect(reader.read(wheel({ deltaY: 3, deltaMode: 1 }), 0).kind).toBe('zoom');
  });

  it('pans on a fractional two-axis touchpad glide', () => {
    const reader = new WheelIntentReader();
    expect(reader.read(wheel({ deltaX: 12.5, deltaY: -4.25 }), 0)).toEqual({ kind: 'pan', dx: 12.5, dy: -4.25 });
  });

  it('pans on a small vertical touchpad delta', () => {
    const reader = new WheelIntentReader();
    expect(reader.read(wheel({ deltaY: 8 }), 0)).toEqual({ kind: 'pan', dx: 0, dy: 8 });
  });

  it('maps shift+wheel onto horizontal panning', () => {
    const reader = new WheelIntentReader();
    expect(reader.read(wheel({ deltaY: 8, shiftKey: true }), 0)).toEqual({ kind: 'pan', dx: 8, dy: 0 });
  });

  it('zooms smoothly on ctrl+wheel, the touchpad pinch', () => {
    const reader = new WheelIntentReader();
    const zoomIn = reader.read(wheel({ deltaY: -10, ctrlKey: true }), 0);
    const zoomOut = reader.read(wheel({ deltaY: 10, ctrlKey: true }), 0);
    expect(zoomIn.kind).toBe('zoom');
    expect(zoomIn).toMatchObject({ factor: expect.closeTo(1 / (zoomOut as { factor: number }).factor, 10) });
    expect((zoomIn as { factor: number }).factor).toBeGreaterThan(1);
  });

  it('pinches without latching the device, so a mouse notch after it still zooms by a step', () => {
    const reader = new WheelIntentReader();
    reader.read(wheel({ deltaY: -2.5, ctrlKey: true }), 0);
    expect(reader.read(wheel({ deltaY: -100 }), 10)).toEqual({ kind: 'zoom', factor: ZOOM_STEP_FACTOR });
  });

  it('keeps panning as a glide decays into deltas that look like a wheel', () => {
    const reader = new WheelIntentReader();
    reader.read(wheel({ deltaX: 9, deltaY: 40 }), 0);
    expect(reader.read(wheel({ deltaY: 60 }), 50).kind).toBe('pan');
    expect(reader.read(wheel({ deltaY: 100 }), 120).kind).toBe('pan');
  });

  it('reclassifies once the streak has gone quiet', () => {
    const reader = new WheelIntentReader();
    reader.read(wheel({ deltaX: 9, deltaY: 40 }), 0);
    expect(reader.read(wheel({ deltaY: 100 }), 5000).kind).toBe('zoom');
  });
});
