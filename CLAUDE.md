# Graf — .flow canvas editor

A freeform web canvas editor for the `.flow` diagram format defined in [FLOW-SPEC.md](FLOW-SPEC.md).

Run with `npm start` (builds, then serves), then open http://localhost:4600. The server scans
the project tree for `*.flow` files, watches them, and pushes changes to the browser over
WebSocket; edits made on the canvas are written straight back to disk. Example diagrams live
in `flows/`.

The codebase is TypeScript, compiled by `tsc` alone — no bundler. `npm run build` emits
`src/` to `dist/` (which is served, never edited); `npm run watch` recompiles on change
(pair it with a running server; only server-side edits need a restart). `npm run typecheck`
checks everything including tests without emitting, and `npm test` runs the Vitest unit
tests in `tests/`.

## Deviation from FLOW-SPEC.md

There is **no `.flow.meta` file**. Layout lives inside the `.flow` file itself via two
editor-owned node properties:

- `id: <uuid>` — stable node identity
- `pos: x, y, w, h` — the node's canvas rectangle

Everything else follows the spec. `src/shared/flow-format.ts` is the single
parser/serializer, used by both the server and the browser, and defines the shared domain
types (`FlowDocument`, `FlowNode`, `EdgeSpec`, `Rect`, …).

## Architecture

- `src/server/server.ts` — express static host + REST read endpoints, WebSocket
  write/broadcast, chokidar file watcher (own writes are suppressed by content hash).
  Serves `public/` (static shell), `dist/client` at `/js`, `dist/shared` at `/shared`, and
  rough.js at `/vendor/roughjs` (mapped to the bare `roughjs` specifier by the import map
  in `public/index.html`).
- `src/server/flow-files.ts` — path safety (`.flow`-only, root-confined), portable path
  conversion, recursive `.flow` discovery, content hashing.
- `src/shared/flow-format.ts` — parse/serialize `.flow` text, format helpers. No DOM, no
  Node APIs.
- `src/client/flow-doc.ts` — document mutations (add/rename/delete nodes and edges), scope
  resolution for `graph:` blocks, auto-layout for nodes missing `pos`, view-model building
  (`FlowModel` and its types).
- `src/client/canvas-view.ts` — rough.js rendering plus all pointer interaction (pan, zoom,
  tool modes, drag-create, move, resize, port-drag edge creation, marquee select) and
  camera animations for subgraph navigation.
- `src/client/expansion.ts` — session-local inline subgraph expansion: which nodes are
  unfolded, open/close animation, external .flow fetching, frame geometry, the warp
  displacement of surrounding nodes (view-only; never written to disk), and the loci map
  that lets nodes inside frames be edited in place (mutations are routed to the .flow file
  that owns them).
- `src/client/editors.ts` — floating DOM overlays for node and edge editing.
- `src/client/main.ts` — app state, WebSocket sync, undo/redo, sidebar, keyboard shortcuts.
- `tests/` — Vitest unit tests for the parser/serializer, document mutations, server file
  logic, expansion geometry, and camera math.

The browser runs the compiled output as native ES modules — client code imports shared code
relatively (`../shared/flow-format.js`), which resolves identically inside `dist/` and as
URLs. No frameworks and no graph libraries — rough.js is the only rendering dependency.

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
