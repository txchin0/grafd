import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOW_FORMAT_VERSION } from '../src/shared/flow-format.js';

// The exported .zip embeds SAVE-GUIDE.md fetched from the deployed app's static assets
// (src/client/export.ts), so a stale build can ship a guide that claims a different format
// version than the manifest's flowVersion. Both are derived from this one file — the test
// keeps the guide's header pinned to the code's version constant.
describe('SAVE-GUIDE.md', () => {
  it('declares the same format version as FLOW_FORMAT_VERSION', () => {
    const guide = readFileSync(new URL('../SAVE-GUIDE.md', import.meta.url), 'utf8');
    expect(guide.split('\n')[0]).toBe(`# .flow Format Guide (${FLOW_FORMAT_VERSION})`);
  });
});
