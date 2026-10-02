// Dresses a view-model in its file's canvas layer: which shape each node draws as and which
// colour each edge takes. Resolved per model build, like traits, so painting and edge layout
// read answers rather than re-deriving edge keys every frame.

import {
  documentIdentities,
  edgeColorOf,
  nodeShapeOf,
  type CanvasLayer,
  type DocumentIdentities,
} from '../shared/canvas-layer.js';
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
