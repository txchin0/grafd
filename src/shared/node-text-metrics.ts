// How a node's text is set at the medium text size, and how it wraps. The painter measures with
// the canvas (client/canvas/node-metrics.ts) while the layout, which runs where there is no
// canvas, can only estimate (node-size-estimate.ts); both wrap through here, so a layout sized
// for some number of lines is sized for the lines the painter will actually draw.

export const NODE_TEXT_SIDE_PADDING = 13;
export const TITLE_FONT_PX = 15;
export const TITLE_LINE_HEIGHT = 20;
export const DESCRIPTION_FONT_PX = 12.5;
export const DESCRIPTION_LINE_HEIGHT = 16;
export const TITLE_DESCRIPTION_GAP = 6;
export const TITLE_MAX_LINES = 2;
export const DESCRIPTION_MAX_LINES = 4;

// Greedy word wrap. A word wider than the line still gets a line of its own, and text that runs
// past `maxLines` ends its last line in an ellipsis.
export function wrapTextLines(
  text: string,
  maxWidth: number,
  maxLines: number,
  widthOf: (run: string) => number,
): string[] {
  if (maxLines <= 0) return [];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (widthOf(candidate) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '…');
  }
  return lines;
}
