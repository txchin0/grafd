import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FORMAT,
  chooseStartupFlow,
  defaultEntrypoint,
  emptyManifest,
  parseManifest,
  serializeManifest,
} from '../src/shared/manifest.js';

describe('parseManifest', () => {
  it('round-trips a serialized manifest', () => {
    const manifest = emptyManifest();
    manifest.entrypoint = 'main.flow';
    manifest.ui.activeFlow = 'auth/login.flow';
    manifest.ui.cameras['main.flow'] = { x: 10, y: -20, scale: 1.5 };
    manifest.ui.expansions['main.flow'] = ['node-a', 'node-b'];
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
      entrypoint: null,
      ui: { activeFlow: null, cameras: { 'b.flow': { x: 1, y: 2, scale: 3 } }, expansions: {} },
    });
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
