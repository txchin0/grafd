// The inline title editors commit when focus is lost to a canvas click: main.ts wires
// canvasClicked to editors.closeAll(), which runs during pointerdown — before the browser
// fires the input's blur — so the close itself must commit or the typed name is silently
// dropped and the canvas redraws the old one.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFlow, type ContextItem, type FlowNode, type Rect } from '../src/shared/flow-format.js';
import { nodesIn } from '../src/client/flow-doc.js';
import type { CanvasView, RegionTarget } from '../src/client/canvas/canvas-view.js';
import { createEditors, type EditorContext, type Editors } from '../src/client/editors.js';

const FLOW = `---
name: Demo
---

context: Zone
  pos: 0, 0, 800, 600
  nodes:
    - A

A
  id: a-1
  pos: 100, 100, 200, 88
`;

const PLACEMENT = { rect: { x: 0, y: 0, w: 100, h: 20 }, fontPx: 13, align: 'center', color: '#000', screenScale: 1 };

interface ElementHarness {
  element: Record<string, any>;
  listeners: Record<string, (event: any) => void>;
}

function createElementHarness(): ElementHarness {
  const listeners: Record<string, (event: any) => void> = {};
  return {
    listeners,
    element: {
      value: '',
      checked: false,
      textContent: '',
      style: {},
      classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
      addEventListener: vi.fn((type: string, handler: (event: any) => void) => {
        listeners[type] = handler;
      }),
      focus: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
      append: vi.fn(),
      replaceChildren: vi.fn(),
      querySelectorAll: vi.fn(() => []),
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        toJSON: () => ({}),
      }),
      offsetWidth: 200,
      offsetHeight: 100,
    },
  };
}

const ELEMENT_IDS = [
  'canvas-container',
  'node-editor',
  'ne-title',
  'ne-description',
  'ne-expand',
  'ne-on-error',
  'ne-updates',
  'ne-entrypoint',
  'ne-expand-options',
  'ne-reference-rows',
  'ne-add-reference',
  'ne-open-expand',
  'ne-inline-expand',
  'ne-delete',
  'ne-updates-options',
  'ne-updates-error',
  'ne-contexts',
  'region-editor',
  're-name',
  're-description',
  're-reference-rows',
  're-add-reference',
  're-member-list',
  're-delete',
  'edge-editor',
  'ee-label',
  'ee-inner-source',
  'ee-inner-target',
  'ee-data',
  'ee-data-rows',
  'ee-add-field',
  'ee-delete',
  'title-editor',
  'region-name-editor',
  'region-name-input',
  'region-name-error',
];

let harnesses: Map<string, ElementHarness>;
let editors: Editors;
let context: ReturnType<typeof createContextStub>;
let node: FlowNode;
let region: RegionTarget;

function createContextStub() {
  const view = {
    hiddenTitles: { nodeId: null, regionName: null },
    titlePlacementOf: vi.fn(() => PLACEMENT),
    regionTitlePlacementOfTarget: vi.fn(() => PLACEMENT),
    worldRectToScreen: vi.fn((rect: Rect) => ({ ...rect })),
    requestRender: vi.fn(),
  };
  return {
    view,
    findNode: vi.fn((nodeId: string) => (nodeId === node?.id ? node : null)),
    renameNode: vi.fn((_node: FlowNode, requestedName: string) => requestedName),
    renameRegion: vi.fn(() => null),
    applyEdit: vi.fn(),
    applyEditNow: vi.fn(),
    applyExpandEdit: vi.fn((_node: FlowNode, value: string) => value),
    expandOptions: vi.fn(() => []),
    descriptionOf: vi.fn(() => ''),
    applyDescriptionEdit: vi.fn(),
    referencesOf: vi.fn(() => []),
    applyReferencesEdit: vi.fn(),
    linkContext: vi.fn(() => ({ projectRoot: null, editorLinkScheme: 'none' })),
    ensureExpandTarget: vi.fn(async () => {}),
    ensureInnerTargets: vi.fn(async () => {}),
    ensureInnerSources: vi.fn(async () => {}),
    openExpand: vi.fn(),
    toggleExpand: vi.fn(),
    deleteNodes: vi.fn(),
    innerTargetOptions: vi.fn(() => []),
    innerSourceOptions: vi.fn(() => []),
    readableContexts: vi.fn(() => []),
    selectMember: vi.fn(),
    deleteRegion: vi.fn(),
    regionDescriptionOf: vi.fn(() => ''),
    applyRegionDescriptionEdit: vi.fn(),
    regionReferencesOf: vi.fn(() => []),
    applyRegionReferencesEdit: vi.fn(),
  } as unknown as EditorContext;
}

beforeEach(() => {
  harnesses = new Map(ELEMENT_IDS.map((id) => [id, createElementHarness()]));
  vi.stubGlobal('document', {
    getElementById: (id: string) => harnesses.get(id)?.element ?? null,
  });
  context = createContextStub();
  editors = createEditors(context);

  const doc = parseFlow(FLOW);
  node = nodesIn(doc.items)[0];
  const block = (doc.items.find((item) => item.kind === 'context') as ContextItem).block;
  region = { block, doc, path: null };
});

function harness(id: string): ElementHarness {
  return harnesses.get(id)!;
}

describe('inline title editor commit on canvas click', () => {
  it('commits a typed node title when the canvas click closes the editor', () => {
    editors.openTitleEditor(node);
    harness('title-editor').element.value = 'Renamed Node';
    editors.closeAll();
    expect(context.renameNode).toHaveBeenCalledWith(node, 'Renamed Node');
  });

  it('commits a typed region name when the canvas click closes the editor', () => {
    editors.openRegionNameEditor(region);
    harness('region-name-input').element.value = 'Renamed Zone';
    editors.closeAll();
    expect(context.renameRegion).toHaveBeenCalledWith(region, 'Renamed Zone');
  });

  it('commits exactly once when the input blur lands after the close', () => {
    editors.openTitleEditor(node);
    const input = harness('title-editor');
    input.element.value = 'Renamed Node';
    editors.closeAll();
    input.listeners.blur({});
    expect(context.renameNode).toHaveBeenCalledTimes(1);
    expect(context.renameNode).toHaveBeenCalledWith(node, 'Renamed Node');
  });

  it('commits on a plain blur when no canvas click closed the editor', () => {
    editors.openTitleEditor(node);
    const input = harness('title-editor');
    input.element.value = 'Renamed Node';
    input.listeners.blur({});
    expect(context.renameNode).toHaveBeenCalledWith(node, 'Renamed Node');
  });

  it('still reverts on Escape instead of committing', () => {
    editors.openTitleEditor(node);
    const input = harness('title-editor');
    input.element.value = 'Renamed Node';
    input.listeners.keydown({ key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(context.renameNode).not.toHaveBeenCalled();
  });

  it('dismisses a refused region name without reopening it under the stray click', () => {
    const renameRegion = vi.fn(() => ({ rejected: 'taken' }));
    editors.openRegionNameEditor(region, renameRegion);
    harness('region-name-input').element.value = 'Taken Zone';
    editors.closeAll();
    expect(renameRegion).toHaveBeenCalledTimes(1);
    const panel = harness('region-name-editor').element;
    expect(panel.classList.add).toHaveBeenCalledWith('hidden');
    expect(panel.classList.remove).toHaveBeenCalledTimes(1);
  });
});
