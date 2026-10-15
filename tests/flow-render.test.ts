// `grafd render`: a graph drawn to a PNG with no browser, in a theme's colours read straight from
// themes.css.

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasPaletteFromTokens, PAGE_BACKGROUND_TOKEN, themeTokensFromCss } from '../src/client/theme.js';
import { runFlowRender } from '../src/tools/flow-render.js';

const THEMES_CSS = readFile(path.join(import.meta.dirname, '..', 'public', 'themes.css'), 'utf8');

const FLOW = `---
name: Checkout
---

context: Payment
  nodes:
    - Charge Card

Cart
  description: "Items the user picked"
  -> Charge Card : "pay"

Charge Card
  -> Receipt

Receipt

graph: Refunds
  Ask
    -> Refund

  Refund
`;

async function workspaceWith(text: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'grafd-render-'));
  await writeFile(path.join(root, 'main.flow'), text);
  return root;
}

// The share of an image's pixels that differ from its top-left corner, the background.
async function inkedShare(file: string): Promise<number> {
  const image = await loadImage(await readFile(file));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  let inked = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] !== data[0] || data[index + 1] !== data[1] || data[index + 2] !== data[2]) inked += 1;
  }
  return inked / (data.length / 4);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reading a theme from themes.css', () => {
  it('takes the default theme from the bare :root block and another from its own', async () => {
    const css = await THEMES_CSS;
    const dark = themeTokensFromCss(css, 'grafd-dark');
    const light = themeTokensFromCss(css, 'grafd-light');
    expect(dark.get(PAGE_BACKGROUND_TOKEN)).toBe('#17191d');
    expect(light.get(PAGE_BACKGROUND_TOKEN)).not.toBe(dark.get(PAGE_BACKGROUND_TOKEN));
  });

  it('resolves every canvas colour the theme declares', async () => {
    const palette = canvasPaletteFromTokens(themeTokensFromCss(await THEMES_CSS, 'grafd-light'));
    expect(palette.ink).toMatch(/^#|^rgb/);
    expect(palette.slots.red).toMatch(/^#|^rgb/);
  });
});

describe('grafd render', () => {
  it('draws the graph to a PNG framed around it', async () => {
    const root = await workspaceWith(FLOW);
    const out = path.join(root, 'main.png');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runFlowRender([path.join(root, 'main.flow'), `--out=${out}`])).toBe(0);
    const image = await loadImage(await readFile(out));
    expect(image.width).toBeGreaterThan(400);
    expect(image.height).toBeGreaterThan(100);
    expect(await inkedShare(out)).toBeGreaterThan(0.01);
  });

  it('draws a graph: block of the file when asked', async () => {
    const root = await workspaceWith(FLOW);
    const out = path.join(root, 'refunds.png');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runFlowRender([path.join(root, 'main.flow'), '--graph=Refunds', `--out=${out}`])).toBe(0);
    const whole = await loadImage(await readFile(out));
    expect(whole.width).toBeLessThan(800);
  });

  it('scales the image by --scale', async () => {
    const root = await workspaceWith(FLOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runFlowRender([path.join(root, 'main.flow'), `--out=${path.join(root, 'one.png')}`]);
    await runFlowRender([path.join(root, 'main.flow'), '--scale=2', `--out=${path.join(root, 'two.png')}`]);
    const [one, two] = await Promise.all(['one.png', 'two.png'].map(async (name) => loadImage(await readFile(path.join(root, name)))));
    expect(two.width).toBe(one.width * 2);
  });

  it('says so when the graph block does not exist', async () => {
    const root = await workspaceWith(FLOW);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((message: string) => errors.push(message));

    expect(await runFlowRender([path.join(root, 'main.flow'), '--graph=Nowhere'])).toBe(1);
    expect(errors.join('\n')).toContain('graph: Nowhere');
  });

  it('refuses an option it does not know, or no file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runFlowRender(['main.flow', '--sideways'])).toBe(2);
    expect(await runFlowRender([])).toBe(2);
  });
});
