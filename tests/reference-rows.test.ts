import { describe, expect, it } from 'vitest';
import { settleEditedReference } from '../src/client/reference-rows.js';

const previous = { label: 'Login form', target: 'src/login.tsx:42' };

describe('settleEditedReference', () => {
  it('saves a markdown or bare target on commit', () => {
    expect(settleEditedReference('[Docs](https://example.com)', previous, true)).toEqual({
      kind: 'save',
      reference: { label: 'Docs', target: 'https://example.com' },
    });
    expect(settleEditedReference('https://example.com', previous, true)).toEqual({
      kind: 'save',
      reference: { label: null, target: 'https://example.com' },
    });
  });

  it('discards an empty or invalid value on commit, including clearing an existing row', () => {
    expect(settleEditedReference('', previous, true)).toEqual({ kind: 'discard' });
    expect(settleEditedReference('[Label]()', previous, true)).toEqual({ kind: 'discard' });
  });

  it('reverts an existing row on cancel and discards a new empty row', () => {
    expect(settleEditedReference('typed-then-escaped', previous, false)).toEqual({ kind: 'revert' });
    expect(settleEditedReference('', { label: null, target: '' }, false)).toEqual({ kind: 'discard' });
  });
});
