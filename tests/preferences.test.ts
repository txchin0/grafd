import { describe, expect, it } from 'vitest';
import { defaultPreferences, parsePreferences } from '../src/client/preferences.js';

describe('parsePreferences', () => {
  it('reads stored values', () => {
    expect(parsePreferences('{"showCanvasGrid":false}')).toEqual({ showCanvasGrid: false });
  });

  it('falls back to defaults for missing fields', () => {
    expect(parsePreferences('{}')).toEqual(defaultPreferences());
  });

  it('falls back to defaults for values of the wrong type', () => {
    expect(parsePreferences('{"showCanvasGrid":"no"}')).toEqual(defaultPreferences());
  });

  it('drops unknown fields', () => {
    expect(parsePreferences('{"showCanvasGrid":false,"whatever":1}')).toEqual({ showCanvasGrid: false });
  });

  it('falls back to defaults for unparseable, empty, and absent text', () => {
    for (const text of ['not json', '[]', 'null', '', null, undefined]) {
      expect(parsePreferences(text)).toEqual(defaultPreferences());
    }
  });
});
