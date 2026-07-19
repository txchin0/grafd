# Graf — .flow canvas editor

A freeform web canvas editor for the `.flow` diagram format defined in [FLOW-SPEC.md](FLOW-SPEC.md).

Run with `npm start`, then open http://localhost:4600. The server scans the project tree for
`*.flow` files, watches them, and pushes changes to the browser over WebSocket; edits made on
the canvas are written straight back to disk. Example diagrams live in `flows/`.

## Deviation from FLOW-SPEC.md

There is **no `.flow.meta` file**. Layout lives inside the `.flow` file itself via two
editor-owned node properties:

- `id: <uuid>` — stable node identity
- `pos: x, y, w, h` — the node's canvas rectangle

Everything else follows the spec. `shared/flow-format.js` is the single parser/serializer,
used by both the server and the browser.

## Architecture

- `server/server.js` — express static host + REST read endpoints, WebSocket write/broadcast,
  chokidar file watcher (own writes are suppressed by content hash).
- `shared/flow-format.js` — parse/serialize `.flow` text, format helpers. No DOM, no Node APIs.
- `public/js/flow-doc.js` — document mutations (add/rename/delete nodes and edges), scope
  resolution for `graph:` blocks, auto-layout for nodes missing `pos`, view-model building.
- `public/js/canvas-view.js` — rough.js rendering plus all pointer interaction (pan, zoom,
  tool modes, drag-create, move, resize, port-drag edge creation, marquee select) and
  camera animations for subgraph navigation.
- `public/js/expansion.js` — session-local inline subgraph expansion: which nodes are
  unfolded, open/close animation, external .flow fetching, frame geometry, the warp
  displacement of surrounding nodes (view-only; never written to disk), and the loci map
  that lets nodes inside frames be edited in place (mutations are routed to the .flow file
  that owns them).
- `public/js/editors.js` — floating DOM overlays for node and edge editing.
- `public/js/main.js` — app state, WebSocket sync, undo/redo, sidebar, keyboard shortcuts.

No frameworks and no graph libraries — rough.js is the only rendering dependency.

## Code style — self-documenting code (required)

All code in this repository must be self-documenting. This applies to every agent and
contributor working here:

- Express intent through naming and structure: full-word variable names, functions named as
  verb phrases that state what they do, small functions whose bodies read as a sequence of
  named steps. If a block needs a comment to be understood, extract it into a well-named
  function instead.
- Comments are reserved for what code *cannot* say: non-obvious constraints, format/protocol
  invariants, and the reason a surprising choice is correct ("why", never "what").
- Never write narration comments ("increment the counter", "call the parser"), section
  banners that restate the function name, or comments that describe the change you just made
  (that belongs in review threads, not the code).
- Magic values get named constants. Conditions with more than two clauses get extracted into
  a named predicate.
