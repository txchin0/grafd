import { describe, expect, it } from 'vitest';
import { parseFlow, type FlowNode } from '../src/shared/flow-format.js';
import { layOutNodeText, nodeTypography, titleBandOf, titleFont } from '../src/client/canvas/node-metrics.js';

const NODE: FlowNode = parseFlow('Check the order\n  pos: 0, 0, 200, 88\n').items
  .flatMap((item) => (item.kind === 'node' ? [item.node] : []))[0];
const RECT = { x: 0, y: 0, w: 200, h: 88 };
const LONG_DESCRIPTION = 'Every word of this description wraps onto a line of its own once the text is large enough';

// Each character as wide as half the font size, read back from the font string the layout set.
function proportionalContext(): CanvasRenderingContext2D {
  const context = {
    font: '',
    measureText(text: string) {
      const fontPx = Number(/([\d.]+)px/.exec(context.font)![1]);
      return { width: text.length * fontPx * 0.5 };
    },
  };
  return context as unknown as CanvasRenderingContext2D;
}

describe('node text sizes', () => {
  it('scales the title font and the band the inline title editor overlays', () => {
    const medium = layOutNodeText(proportionalContext(), NODE, RECT, null, nodeTypography('medium'));
    const large = layOutNodeText(proportionalContext(), NODE, RECT, null, nodeTypography('large'));
    expect(titleFont(large.typography)).toContain(`${nodeTypography('large').titleFontPx}px`);
    expect(titleBandOf(RECT, large).h).toBeGreaterThan(titleBandOf(RECT, medium).h);
  });

  it('fits fewer description lines into the same node as the text grows', () => {
    const small = layOutNodeText(proportionalContext(), NODE, RECT, LONG_DESCRIPTION, nodeTypography('small'));
    const extraLarge = layOutNodeText(proportionalContext(), NODE, RECT, LONG_DESCRIPTION, nodeTypography('x-large'));
    expect(extraLarge.descriptionLines.length).toBeLessThan(small.descriptionLines.length);
  });
});
