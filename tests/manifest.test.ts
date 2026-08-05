import { describe, expect, it } from 'vitest';
import { FLOW_FORMAT_VERSION } from '../src/shared/flow-format.js';
import {
  DEFAULT_CANVAS_FONT,
  DEFAULT_ROUGHNESS,
  MANIFEST_FORMAT,
  MAX_ROUGHNESS,
  MIN_ROUGHNESS,
  chooseStartupFlow,
  defaultEntrypoint,
  emptyManifest,
  parseManifest,
  serializeManifest,
} from '../src/shared/manifest.js';

describe('parseManifest', () => {
  it('round-trips a serialized manifest', () => {
    const manifest = emptyManifest();
    manifest.flowVersion = 'flow/1.4';
    manifest.entrypoint = 'main.flow';
    manifest.ui.activeFlow = 'auth/login.flow';
    manifest.ui.cameras['main.flow'] = { x: 10, y: -20, scale: 1.5 };
    manifest.ui.expansions['main.flow'] = ['node-a', 'node-b'];
    manifest.display.roughness = 2.5;
    manifest.display.font = 'playpen';
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  it('returns null for missing or unparseable text', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('')).toBeNull();
    expect(parseManifest('not json')).toBeNull();
    expect(parseManifest('42')).toBeNull();
  });

  it('fills defaults for missing fields and drops malformed cameras', () => {
    const parsed = parseManifest('{"ui": {"cameras": {"a.flow": {"x": 1}, "b.flow": {"x": 1, "y": 2, "scale": 3}}}}');
    expect(parsed).toEqual({
      format: MANIFEST_FORMAT,
      flowVersion: FLOW_FORMAT_VERSION,
      entrypoint: null,
      display: { roughness: DEFAULT_ROUGHNESS, font: DEFAULT_CANVAS_FONT },
      ui: { activeFlow: null, cameras: { 'b.flow': { x: 1, y: 2, scale: 3 } }, expansions: {} },
    });
  });

  it('defaults roughness when it is missing or not a finite number', () => {
    const roughnessOf = (display: unknown) => parseManifest(JSON.stringify({ display }))?.display.roughness;
    expect(roughnessOf(undefined)).toBe(DEFAULT_ROUGHNESS);
    expect(roughnessOf(null)).toBe(DEFAULT_ROUGHNESS);
    expect(roughnessOf('rough')).toBe(DEFAULT_ROUGHNESS);
    expect(roughnessOf({})).toBe(DEFAULT_ROUGHNESS);
    expect(roughnessOf({ roughness: '2' })).toBe(DEFAULT_ROUGHNESS);
    // JSON has no literal for these, so they serialize to null and must not survive as one.
    expect(roughnessOf({ roughness: Number.NaN })).toBe(DEFAULT_ROUGHNESS);
    expect(roughnessOf({ roughness: Number.POSITIVE_INFINITY })).toBe(DEFAULT_ROUGHNESS);
  });

  it('defaults font when it is missing or not a known id', () => {
    const fontOf = (display: unknown) => parseManifest(JSON.stringify({ display }))?.display.font;
    expect(fontOf(undefined)).toBe(DEFAULT_CANVAS_FONT);
    expect(fontOf({})).toBe(DEFAULT_CANVAS_FONT);
    expect(fontOf({ font: 'comic-sans' })).toBe(DEFAULT_CANVAS_FONT);
    expect(fontOf({ font: 'playpen' })).toBe('playpen');
  });

  it('clamps roughness into the supported range', () => {
    const roughnessOf = (roughness: number) =>
      parseManifest(JSON.stringify({ display: { roughness } }))?.display.roughness;
    expect(roughnessOf(-3)).toBe(MIN_ROUGHNESS);
    expect(roughnessOf(999)).toBe(MAX_ROUGHNESS);
    expect(roughnessOf(0)).toBe(0);
    expect(roughnessOf(4.5)).toBe(4.5);
  });

  it('reads expansions and drops malformed entries', () => {
    const parsed = parseManifest(
      JSON.stringify({
        ui: {
          expansions: {
            'main.flow': ['open-1', '', 42, 'open-2'],
            'bad.flow': 'not-an-array',
            'ok.flow': ['only-this'],
          },
        },
      }),
    );
    expect(parsed?.ui.expansions).toEqual({
      'main.flow': ['open-1', 'open-2'],
      'ok.flow': ['only-this'],
    });
  });
});

describe('defaultEntrypoint', () => {
  it('prefers main.flow, then root-level files, then anything', () => {
    expect(defaultEntrypoint(['a.flow', 'main.flow', 'sub/x.flow'])).toBe('main.flow');
    expect(defaultEntrypoint(['sub/x.flow', 'a.flow'])).toBe('a.flow');
    expect(defaultEntrypoint(['sub/x.flow'])).toBe('sub/x.flow');
    expect(defaultEntrypoint([])).toBeNull();
  });
});

describe('chooseStartupFlow', () => {
  it('prefers the last active flow, then the entrypoint, then the default', () => {
    const manifest = emptyManifest();
    manifest.entrypoint = 'main.flow';
    manifest.ui.activeFlow = 'sub/x.flow';
    const files = ['main.flow', 'sub/x.flow', 'a.flow'];
    expect(chooseStartupFlow(manifest, files)).toBe('sub/x.flow');

    manifest.ui.activeFlow = 'deleted.flow';
    expect(chooseStartupFlow(manifest, files)).toBe('main.flow');

    manifest.entrypoint = 'also-deleted.flow';
    expect(chooseStartupFlow(manifest, files)).toBe('main.flow');
    expect(chooseStartupFlow(emptyManifest(), [])).toBeNull();
  });
});
