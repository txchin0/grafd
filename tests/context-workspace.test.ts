// Workspace-wide context rename and inherits sync — the async paths that used to live only
// inside main.ts. Exercised here with injected deps so a re-parse mid-flight or a multi-host
// expand can be asserted without standing up the full app shell.

import { describe, expect, it, vi } from 'vitest';
import {
  getPreambleField,
  getProp,
  parseFlow,
  parseListValue,
  type FlowDocument,
} from '../src/shared/flow-format.js';
import * as FlowDoc from '../src/client/flow-doc.js';
import type { DocumentOwner } from '../src/client/canvas/expansion.js';
import type { ActionContinuation } from '../src/client/edit-session.js';
import type { MenuItem } from '../src/client/context-menu.js';
import type { Point } from '../src/client/geometry.js';
import type { RegionTarget } from '../src/client/canvas/canvas-view.js';
import {
  createContextOrchestration,
  readableContextsForChildPath,
  renameContextAcrossWorkspace,
  syncInheritsForMember,
  syncInheritsForPath,
  type ContextOrchestrationOptions,
  type InheritsSyncDeps,
  type WorkspaceRenameDeps,
} from '../src/client/context/index.js';

function owner(path: string, text: string): DocumentOwner {
  return { path, doc: parseFlow(text) };
}

// Stands in for the session's continuation: work that resumes after the documents it described
// were replaced is abandoned. Which undo step the writes land in is EditSession's own test.
function continuationFrom(generation: () => number): ActionContinuation {
  const captured = generation();
  return { resume: (body) => (generation() === captured ? body() : undefined) };
}

function liveContinuation(): ActionContinuation {
  return continuationFrom(() => 1);
}

function inheritsOf(doc: FlowDocument): string[] {
  return parseListValue(getPreambleField(doc, 'inherits'));
}

function updatesOf(doc: FlowDocument, nodeName: string): string[] {
  const node = FlowDoc.nodesIn(doc.items).find((candidate) => candidate.name === nodeName)!;
  return parseListValue(getProp(node, 'updates'));
}

describe('renameContextAcrossWorkspace', () => {
  it('rewrites inherits and updates in every other loaded file', async () => {
    const declaring = owner('main.flow', `---
name: Main
---

context: Auth
  nodes:
    - Login

Login
  expand: [Login](auth/login.flow)
`);
    const child = owner('auth/login.flow', `---
name: Login
inherits: [Auth]
---

Validate
  updates: Auth
`);
    const docs = [declaring, child];
    let generation = 1;
    const deps: WorkspaceRenameDeps = {
      suspendAction: () => continuationFrom(() => generation),
      loadEveryWorkspaceDocument: async () => {},
      knownDocuments: () => docs,
      applyToDoc: (_entry, mutation) => { mutation(); },
    };

    FlowDoc.renameContextBlock(declaring.doc, FlowDoc.contextBlockNamed(declaring.doc, 'Auth')!, 'Session');
    await renameContextAcrossWorkspace(deps, declaring, 'Auth', 'Session');

    expect(inheritsOf(child.doc)).toEqual(['Session']);
    expect(updatesOf(child.doc, 'Validate')).toEqual(['Session']);
  });

  it('abandons the rewrite when the documents are replaced during the workspace load', async () => {
    const declaring = owner('main.flow', `---
name: Main
---

context: Auth
  nodes:
    - Login

Login
  expand: [Login](auth/login.flow)
`);
    const child = owner('auth/login.flow', `---
name: Login
inherits: [Auth]
---

Validate
`);
    const docs = [declaring, child];
    let generation = 1;
    const deps: WorkspaceRenameDeps = {
      suspendAction: () => continuationFrom(() => generation),
      loadEveryWorkspaceDocument: async () => { generation += 1; },
      knownDocuments: () => docs,
      applyToDoc: (_entry, mutation) => { mutation(); },
    };

    await renameContextAcrossWorkspace(deps, declaring, 'Auth', 'Session');
    expect(inheritsOf(child.doc)).toEqual(['Auth']);
  });

  it('leaves a file alone when it declares its own provider of the same name', async () => {
    const declaring = owner('main.flow', `---
name: Main
---

context: Auth
  nodes:
    - Host

Host
`);
    const other = owner('other.flow', `---
name: Other
---

context: Auth
  nodes:
    - Local

Local
  updates: Auth
`);
    const docs = [declaring, other];
    const deps: WorkspaceRenameDeps = {
      suspendAction: liveContinuation,
      loadEveryWorkspaceDocument: async () => {},
      knownDocuments: () => docs,
      applyToDoc: (_entry, mutation) => { mutation(); },
    };

    await renameContextAcrossWorkspace(deps, declaring, 'Auth', 'Session');
    expect(FlowDoc.contextBlockNamed(other.doc, 'Auth')).toBeTruthy();
    expect(updatesOf(other.doc, 'Local')).toEqual(['Auth']);
  });
});

describe('syncInheritsForMember', () => {
  it('writes the union of readable contexts from every host that expands the same child', async () => {
    const parent = owner('main.flow', `---
name: Main
---

context: Auth
  nodes:
    - Login Host

context: Cart
  nodes:
    - Checkout Host

Login Host
  expand: [Login](auth/login.flow)

Checkout Host
  expand: [Login](auth/login.flow)
`);
    const child = owner('auth/login.flow', `---
name: Login
---

Validate
`);
    const docs = new Map<string, FlowDocument>([
      [parent.path, parent.doc],
      [child.path, child.doc],
    ]);
    const deps: InheritsSyncDeps = {
      suspendAction: liveContinuation,
      expandTargetDoc: (path) => docs.get(path) ?? null,
      ensureDocument: async (path) => docs.get(path) ?? null,
      applyToDoc: (_entry, mutation) => { mutation(); },
    };

    await syncInheritsForMember(deps, parent, 'Login Host');
    expect(inheritsOf(child.doc).sort()).toEqual(['Auth', 'Cart']);
  });

  it('abandons the write when the documents are replaced during ensureDocument', async () => {
    const parent = owner('main.flow', `---
name: Main
---

context: Auth
  nodes:
    - Login Host

Login Host
  expand: [Login](auth/login.flow)
`);
    const child = owner('auth/login.flow', `---
name: Login
---

Validate
`);
    let generation = 1;
    const deps: InheritsSyncDeps = {
      suspendAction: () => continuationFrom(() => generation),
      expandTargetDoc: () => null,
      ensureDocument: async () => {
        generation += 1;
        return child.doc;
      },
      applyToDoc: vi.fn((_entry, mutation) => { mutation(); }),
    };

    await syncInheritsForMember(deps, parent, 'Login Host');
    expect(deps.applyToDoc).not.toHaveBeenCalled();
    expect(getPreambleField(child.doc, 'inherits')).toBeNull();
  });

  it('clears inherits when no host can read any context', async () => {
    const parent = owner('main.flow', `---
name: Main
---

Login Host
  expand: [Login](auth/login.flow)
`);
    const child = owner('auth/login.flow', `---
name: Login
inherits: [Auth]
---

Validate
`);
    const deps: InheritsSyncDeps = {
      suspendAction: liveContinuation,
      expandTargetDoc: () => child.doc,
      ensureDocument: async () => child.doc,
      applyToDoc: (_entry, mutation) => { mutation(); },
    };

    await syncInheritsForMember(deps, parent, 'Login Host');
    expect(getPreambleField(child.doc, 'inherits')).toBeNull();
  });

  it('strips unreadable updates in the child when inherits loses a provider', async () => {
    const parent = owner('main.flow', `---
name: Main
---

context: Cart
  nodes:
    - Login Host

Login Host
  expand: [Login](auth/login.flow)
`);
    const child = owner('auth/login.flow', `---
name: Login
inherits: [Auth]
---

Validate
  updates: [Auth, Cart]

Checkout
  updates: Auth
`);
    const deps: InheritsSyncDeps = {
      suspendAction: liveContinuation,
      expandTargetDoc: () => child.doc,
      ensureDocument: async () => child.doc,
      applyToDoc: (_entry, mutation) => { mutation(); },
    };

    await syncInheritsForMember(deps, parent, 'Login Host');
    expect(inheritsOf(child.doc)).toEqual(['Cart']);
    expect(updatesOf(child.doc, 'Validate')).toEqual(['Cart']);
    expect(updatesOf(child.doc, 'Checkout')).toEqual([]);
  });

  it('ripples an inherits loss down the expansion chain, stripping updates at every level', async () => {
    const root = owner('main.flow', `---
name: Main
---

Child Host
  expand: [Child](child.flow)
`);
    const child = owner('child.flow', `---
name: Child
inherits: [Auth]
---

Grandchild Host
  expand: [Grandchild](grandchild.flow)

Child Worker
  updates: Auth
`);
    const grandchild = owner('grandchild.flow', `---
name: Grandchild
inherits: [Auth]
---

Leaf Worker
  updates: Auth
`);
    const docs = new Map<string, FlowDocument>([
      [root.path, root.doc],
      [child.path, child.doc],
      [grandchild.path, grandchild.doc],
    ]);
    const deps: InheritsSyncDeps = {
      suspendAction: liveContinuation,
      expandTargetDoc: (path) => docs.get(path) ?? null,
      ensureDocument: async (path) => docs.get(path) ?? null,
      applyToDoc: (_entry, mutation) => { mutation(); },
    };

    await syncInheritsForMember(deps, root, 'Child Host');
    expect(getPreambleField(child.doc, 'inherits')).toBeNull();
    expect(updatesOf(child.doc, 'Child Worker')).toEqual([]);
    expect(getPreambleField(grandchild.doc, 'inherits')).toBeNull();
    expect(updatesOf(grandchild.doc, 'Leaf Worker')).toEqual([]);
  });

  it('ripples an inherits loss through a nested expand host', async () => {
    const root = owner('main.flow', `---
name: Main
---

Child Host
  expand: [Child](child.flow)
`);
    const child = owner('child.flow', `---
name: Child
inherits: [Auth]
---

Outer
  expand: Nested

graph: Nested
  Grandchild Host
    expand: [Grandchild](grandchild.flow)
`);
    const grandchild = owner('grandchild.flow', `---
name: Grandchild
inherits: [Auth]
---

Leaf Worker
  updates: Auth
`);
    const docs = new Map<string, FlowDocument>([
      [root.path, root.doc],
      [child.path, child.doc],
      [grandchild.path, grandchild.doc],
    ]);
    const deps: InheritsSyncDeps = {
      suspendAction: liveContinuation,
      expandTargetDoc: (path) => docs.get(path) ?? null,
      ensureDocument: async (path) => docs.get(path) ?? null,
      applyToDoc: (_entry, mutation) => { mutation(); },
    };

    await syncInheritsForMember(deps, root, 'Child Host');
    expect(getPreambleField(child.doc, 'inherits')).toBeNull();
    expect(getPreambleField(grandchild.doc, 'inherits')).toBeNull();
    expect(updatesOf(grandchild.doc, 'Leaf Worker')).toEqual([]);
  });

  it('terminates when expansions form a cycle', async () => {
    const root = owner('main.flow', `---
name: Main
---

context: Cart
  nodes:
    - A Host

A Host
  expand: [Child](child.flow)
`);
    const child = owner('child.flow', `---
name: Child
inherits: [Auth]
---

B Host
  expand: [Root](main.flow)
`);
    const docs = new Map<string, FlowDocument>([
      [root.path, root.doc],
      [child.path, child.doc],
    ]);
    const deps: InheritsSyncDeps = {
      suspendAction: liveContinuation,
      expandTargetDoc: (path) => docs.get(path) ?? null,
      ensureDocument: async (path) => docs.get(path) ?? null,
      applyToDoc: (_entry, mutation) => { mutation(); },
    };

    await syncInheritsForMember(deps, root, 'A Host');
    expect(inheritsOf(child.doc)).toEqual(['Cart']);
    expect(getPreambleField(root.doc, 'inherits')).toBeNull();
  });

  it('syncInheritsForPath recomputes from the hosts that remain after a delete', async () => {
    const parent = owner('main.flow', `---
name: Main
---

Survivor Host
  expand: [Login](auth/login.flow)
`);
    const child = owner('auth/login.flow', `---
name: Login
inherits: [Auth]
---

Validate
  updates: Auth
`);
    const deps: InheritsSyncDeps = {
      suspendAction: liveContinuation,
      expandTargetDoc: () => child.doc,
      ensureDocument: async () => child.doc,
      applyToDoc: (_entry, mutation) => { mutation(); },
    };

    await syncInheritsForPath(deps, parent, 'auth/login.flow', new Set());
    expect(getPreambleField(child.doc, 'inherits')).toBeNull();
    expect(updatesOf(child.doc, 'Validate')).toEqual([]);
  });
});

describe('readableContextsForChildPath', () => {
  it('unions membership across co-hosts of one expand path', () => {
    const parent = owner('main.flow', `---
name: Main
---

context: Auth
  nodes:
    - A

context: Cart
  nodes:
    - B

A
  expand: [Login](auth/login.flow)

B
  expand: [Login](auth/login.flow)
`);
    expect(readableContextsForChildPath(parent, 'auth/login.flow').sort()).toEqual(['Auth', 'Cart']);
  });

  it('includes a nested host that reads the provider through its local-graph host', () => {
    const parent = owner('main.flow', `---
name: Main
---

context: Auth
  nodes:
    - Host

Host
  expand: Steps

graph: Steps
  Inner
    expand: [Login](auth/login.flow)
`);
    expect(readableContextsForChildPath(parent, 'auth/login.flow')).toEqual(['Auth']);
  });
});

const DELETION_FLOW = `---
name: Main
---

context: Auth
  nodes:
    - Login

context: Cart
  nodes:
    - Checkout

Login
  id: l-1
  updates: Auth

Checkout
  id: c-1
`;

function deletionHarness() {
  const doc = parseFlow(DELETION_FLOW);
  const confirmMenus: MenuItem[][] = [];
  const inherits: InheritsSyncDeps = {
    suspendAction: liveContinuation,
    expandTargetDoc: () => null,
    ensureDocument: async () => null,
    applyToDoc: (_entry, mutation) => { mutation(); },
  };
  const options: ContextOrchestrationOptions = {
    openFlowDoc: () => ({ doc, path: 'main.flow' }),
    ownerOf: () => ({ doc, path: 'main.flow' }),
    creationTargetFor: () => null,
    extractionTargetForSelection: () => null,
    applyToDoc: (_entry, mutation) => { mutation(); },
    runAction: (body) => body(),
    suspendAction: liveContinuation,
    selectRegion: () => {},
    clearSelection: () => {},
    openRegionNameEditor: () => {},
    openRegionEditor: () => {},
    openConfirmMenu: (items) => { confirmMenus.push(items); },
    inherits,
    workspaceRename: {
      suspendAction: liveContinuation,
      loadEveryWorkspaceDocument: async () => {},
      knownDocuments: () => [],
      applyToDoc: (_entry, mutation) => { mutation(); },
    },
  };
  const ops = createContextOrchestration(options);
  const targetOf = (name: string): RegionTarget => ({
    block: FlowDoc.contextBlockNamed(doc, name)!,
    doc,
    path: 'main.flow',
  });
  return { doc, ops, targetOf, confirmMenus };
}

describe('multi-region deletion', () => {
  it('removes every block, strips unreadable updates, and keeps the members (R32)', () => {
    const { doc, ops, targetOf } = deletionHarness();
    ops.deleteRegions([targetOf('Auth'), targetOf('Cart')]);

    expect(FlowDoc.contextBlocksIn(doc.items)).toHaveLength(0);
    const login = FlowDoc.nodesIn(doc.items).find((node) => node.name === 'Login')!;
    expect(parseListValue(getProp(login, 'updates'))).toEqual([]);
    expect(FlowDoc.nodesIn(doc.items).map((node) => node.name)).toEqual(['Login', 'Checkout']);
  });

  it('writeRegionDeletions runs inside a caller-owned action', () => {
    const { doc, ops, targetOf } = deletionHarness();
    let calls = 0;
    const runAction = (body: () => void) => { calls += 1; body(); };
    // A mixed selection delete composes this inside its own runAction; here we just prove the
    // writer performs the deletions without opening an action of its own.
    runAction(() => ops.writeRegionDeletions([targetOf('Auth'), targetOf('Cart')]));
    expect(calls).toBe(1);
    expect(FlowDoc.contextBlocksIn(doc.items)).toHaveLength(0);
  });

  it('confirmRegionDeletions warns once for every writer, then proceeds', () => {
    const { ops, targetOf, confirmMenus } = deletionHarness();
    let proceeded = false;
    ops.confirmRegionDeletions([targetOf('Auth')], { x: 0, y: 0 } satisfies Point, () => { proceeded = true; });

    expect(proceeded).toBe(false);
    expect(confirmMenus).toHaveLength(1);
    const [proceedItem, cancelItem] = confirmMenus[0] as unknown as [{ onSelect: () => void }, { label: string }];
    expect(cancelItem.label).toBe('Cancel');
    proceedItem.onSelect();
    expect(proceeded).toBe(true);
  });

  it('confirmRegionDeletions proceeds directly when nobody updates the providers', () => {
    const { ops, targetOf } = deletionHarness();
    let proceeded = false;
    ops.confirmRegionDeletions([targetOf('Cart')], { x: 0, y: 0 } satisfies Point, () => { proceeded = true; });
    expect(proceeded).toBe(true);
  });
});
