import { describe, expect, it } from 'vitest';
import {
  copyFlowPath,
  extractedFlowPath,
  findExistingFile,
  folderOf,
  kebabFileName,
  nextUntitledFlowName,
  normalizeFlowPath,
} from '../src/client/flow-paths.js';

describe('folderOf', () => {
  it('returns the folder a path sits in, empty at the root', () => {
    expect(folderOf('auth/login.flow')).toBe('auth');
    expect(folderOf('a/b/c.flow')).toBe('a/b');
    expect(folderOf('main.flow')).toBe('');
  });
});

describe('normalizeFlowPath', () => {
  it('implies the extension and accepts backslashes as separators', () => {
    expect(normalizeFlowPath('login')).toBe('login.flow');
    expect(normalizeFlowPath('auth/login.flow')).toBe('auth/login.flow');
    expect(normalizeFlowPath('auth\\login')).toBe('auth/login.flow');
    expect(normalizeFlowPath('  padded  ')).toBe('padded.flow');
  });

  it('returns empty for a name with nothing in it', () => {
    expect(normalizeFlowPath('')).toBe('');
    expect(normalizeFlowPath('   ')).toBe('');
  });
});

describe('findExistingFile', () => {
  const files = ['main.flow', 'auth/Login.flow'];

  it('matches regardless of case, since the target file system may not distinguish', () => {
    expect(findExistingFile(files, 'auth/login.flow')).toBe('auth/Login.flow');
    expect(findExistingFile(files, 'MAIN.FLOW')).toBe('main.flow');
  });

  it('returns undefined when nothing matches', () => {
    expect(findExistingFile(files, 'other.flow')).toBeUndefined();
  });
});

describe('nextUntitledFlowName', () => {
  it('skips names already taken, in any case', () => {
    expect(nextUntitledFlowName([])).toBe('untitled-1.flow');
    expect(nextUntitledFlowName(['a.flow', 'b.flow', 'Untitled-3.flow'])).toBe('untitled-4.flow');
  });
});

describe('copyFlowPath', () => {
  it('numbers past copies that already exist', () => {
    expect(copyFlowPath(['main.flow'], 'main.flow')).toBe('main copy.flow');
    expect(copyFlowPath(['main.flow', 'main copy.flow'], 'main.flow')).toBe('main copy 2.flow');
    expect(copyFlowPath(['main.flow', 'main copy.flow', 'main copy 2.flow'], 'main.flow'))
      .toBe('main copy 3.flow');
  });

  it('keeps the folder the original sits in', () => {
    expect(copyFlowPath(['auth/login.flow'], 'auth/login.flow')).toBe('auth/login copy.flow');
  });
});

describe('kebabFileName', () => {
  it('slugs a graph name into a file name', () => {
    expect(kebabFileName('Login Flow')).toBe('login-flow.flow');
    expect(kebabFileName('Check  Session!!')).toBe('check-session.flow');
  });

  it('falls back when a name slugs away to nothing', () => {
    expect(kebabFileName('!!!')).toBe('subgraph.flow');
    expect(kebabFileName('')).toBe('subgraph.flow');
  });
});

describe('extractedFlowPath', () => {
  it('lands beside the file that owns the node', () => {
    expect(extractedFlowPath([], 'auth/main.flow', 'Login Flow')).toBe('auth/login-flow.flow');
    expect(extractedFlowPath([], 'main.flow', 'Login Flow')).toBe('login-flow.flow');
  });

  it('numbers past a name already taken, keeping the folder', () => {
    const files = ['auth/main.flow', 'auth/login-flow.flow'];
    expect(extractedFlowPath(files, 'auth/main.flow', 'Login Flow')).toBe('auth/login-flow-2.flow');
  });

  it('treats a differently-cased existing file as taken', () => {
    const files = ['main.flow', 'Login-Flow.flow'];
    expect(extractedFlowPath(files, 'main.flow', 'Login Flow')).toBe('login-flow-2.flow');
  });
});
