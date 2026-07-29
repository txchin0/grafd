// What a wheel event means for the camera. A touchpad two-finger swipe and a mouse wheel
// notch arrive as the same `wheel` event, so the device has to be inferred from the shape of
// the deltas: touchpads report small, often fractional, frequently horizontal pixel deltas,
// while a mouse wheel reports one large quantized step at a time along a single axis.
//
// Pure apart from the clock, which is passed in — the streak latch is the only state.

export type WheelIntent =
  | { kind: 'zoom'; factor: number }
  | { kind: 'pan'; dx: number; dy: number };

// The subset of WheelEvent the reader looks at, so tests need no DOM.
export interface WheelSignal {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

type WheelDevice = 'mouse' | 'touchpad';

// How far one mouse-wheel notch zooms. Shared with the toolbar buttons and keyboard shortcuts
// so every discrete zoom moves by the same amount.
export const ZOOM_STEP_FACTOR = 1.1;

const DOM_DELTA_PIXEL = 0;
// A touchpad pinch reaches the page as ctrl+wheel; this turns its delta into a smooth factor
// rather than the discrete notch a mouse wheel gets.
const PINCH_ZOOM_SENSITIVITY = 0.01;
// Chrome sends ±100 per notch and Safari ±40, both divided by the page zoom; anything smaller
// than a heavily zoomed notch is a touchpad glide.
const MOUSE_WHEEL_MIN_DELTA_PX = 30;
// A touchpad glide decelerates into small integer deltas with no horizontal component, which
// on their own look exactly like a mouse wheel. Holding the verdict for the rest of the
// streak keeps a single flick from changing meaning half-way through.
const WHEEL_STREAK_TIMEOUT_MS = 400;

export function pinchZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * PINCH_ZOOM_SENSITIVITY);
}

export class WheelIntentReader {
  private streakDevice: WheelDevice | null = null;
  private streakEndsAt = -Infinity;

  read(signal: WheelSignal, now: number): WheelIntent {
    // Never latched on: the modifier says zoom outright, whichever device sent it.
    if (signal.ctrlKey || signal.metaKey) {
      return { kind: 'zoom', factor: pinchZoomFactor(signal.deltaY) };
    }
    if (this.deviceOf(signal, now) === 'mouse') {
      return { kind: 'zoom', factor: signal.deltaY < 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR };
    }
    return panFromWheel(signal);
  }

  private deviceOf(signal: WheelSignal, now: number): WheelDevice {
    const device = this.streakDevice != null && now < this.streakEndsAt
      ? this.streakDevice
      : detectWheelDevice(signal);
    this.streakDevice = device;
    this.streakEndsAt = now + WHEEL_STREAK_TIMEOUT_MS;
    return device;
  }
}

function panFromWheel(signal: WheelSignal): WheelIntent {
  return signal.shiftKey && signal.deltaX === 0
    ? { kind: 'pan', dx: signal.deltaY, dy: 0 }
    : { kind: 'pan', dx: signal.deltaX, dy: signal.deltaY };
}

function detectWheelDevice(signal: WheelSignal): WheelDevice {
  // Line and page deltas only ever come from a wheel; a touchpad always reports pixels.
  if (signal.deltaMode !== DOM_DELTA_PIXEL) return 'mouse';
  return hasTouchpadDeltaShape(signal) ? 'touchpad' : 'mouse';
}

// Magnitude and axis are the only trustworthy signals. Whether the delta is a round number is
// not one of them: page zoom divides the notch, so at 110% a mouse reports 100/1.1 = 90.909.
function hasTouchpadDeltaShape(signal: WheelSignal): boolean {
  return signal.deltaX !== 0 || Math.abs(signal.deltaY) < MOUSE_WHEEL_MIN_DELTA_PX;
}
