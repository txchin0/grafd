// Dresses a view-model in its file's canvas layer: which shape each node draws as, which
// colour each edge takes, and the strokes drawn in the model's graph scope. Resolved per model build, like traits, so painting and edge layout
// read answers rather than re-deriving edge keys every frame.

import {
  documentIdentities,
  edgeColorOf,
  nodeShapeOf,
  type CanvasLayer,
  type DocumentIdentities,
  type Drawing,
} from '../shared/canvas-layer.js';
import { strokesInScope, type Stroke } from '../shared/canvas-drawings.js';
import { drawingGroupsOf, type Group } from '../shared/canvas-groups.js';
import type { FlowDocument } from '../shared/flow-format.js';
import type { FlowModel, ModelEdge, ModelVisuals } from './flow-doc.js';

export function dressModel(model: FlowModel, layer: CanvasLayer | null): FlowModel {
  model.visuals = visualsFor(model, layer);
  return model;
}

function visualsFor(model: FlowModel, layer: CanvasLayer | null): ModelVisuals {
  // Edge keys need the whole document (a target resolves in its own scope), so they are only
  // derived once something actually asks for an edge colour.
  let identities: DocumentIdentities | null = null;
  const keyOf = (edge: ModelEdge): string | null => {
    identities ??= documentIdentities(model.sourceDoc);
    return edgeKeyIn(identities, edge);
  };
  return {
    shapeOf: (node) => nodeShapeOf(layer, node.id),
    edgeColorOf: (edge) => (layer ? edgeColorOf(layer, keyOf(edge)) : null),
    strokes: strokeReaderFor(layer, model.sourceScope),
    strokeGroupOf: strokeGroupReaderFor(layer),
  };
}

// Kept like the strokes are, until a layer edit replaces the `groups` list.
function strokeGroupReaderFor(layer: CanvasLayer | null): (strokeId: string) => string[] {
  let readFrom: Group[] | null = null;
  let groupOf = new Map<string, string[]>();
  return (strokeId) => {
    if (layer && layer.groups !== readFrom) {
      readFrom = layer.groups;
      groupOf = drawingGroupsOf(layer);
    }
    return groupOf.get(strokeId) ?? [strokeId];
  };
}

// Strokes are read on every frame, so the parse is kept until the list changes. Every layer edit
// replaces the `drawings` array rather than editing it, which is what makes identity enough.
function strokeReaderFor(layer: CanvasLayer | null, scope: string | null): () => Stroke[] {
  let readFrom: Drawing[] | null = null;
  let strokes: Stroke[] = [];
  return () => {
    if (!layer) return [];
    if (layer.drawings !== readFrom) {
      readFrom = layer.drawings;
      strokes = strokesInScope(layer, scope);
    }
    return strokes;
  };
}

// The key an edge's visuals are filed under in the canvas layer of `doc`, the document that
// declares it.
export function edgeLayerKey(doc: FlowDocument, edge: ModelEdge): string | null {
  return edgeKeyIn(documentIdentities(doc), edge);
}

function edgeKeyIn(identities: DocumentIdentities, edge: ModelEdge): string | null {
  return identities.edgeKeys.get(edge.kind === 'error' ? edge.from : edge.spec) ?? null;
}
