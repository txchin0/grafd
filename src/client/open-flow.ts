// The flow on screen, as the app shell and the panels around it name it.
//
// The four parts are only ever meaningful together — a path with no document, or a document
// with no model, is not a state the app can render — so they travel as one value rather than as
// four independently nullable fields, and `null` means no flow is open at all.

import type { FlowDocument } from '../shared/flow-format.js';
import type { FlowModel } from './flow-doc.js';

export interface OpenFlow {
  path: string;
  doc: FlowDocument;
  // The `graph:` block the canvas is narrowed to, null for the file's top level.
  scope: string | null;
  model: FlowModel;
}
