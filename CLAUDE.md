# Grafd — .flow canvas editor

A freeform web canvas editor for the `.flow` diagram format defined in [FLOW-SPEC.md](FLOW-SPEC.md).

The app runs in two hosting modes with identical features:

- **Self-hosted** — `npm start` (builds, then serves), then open http://localhost:3103. The
  server watches `.grafd/` by default for `*.flow` files (override with a path argument to
  `node dist/server/server-main.js`), pushes changes to the browser over WebSocket, and writes
  canvas edits straight back to disk.
- **Serverless** — `npm run build:site` assembles a fully static build in `site/` for any
  static host. The client probes `./api/files` at boot; with no server answering it stores
  files in IndexedDB (synced across tabs via BroadcastChannel).

In either mode the user can open a local folder through the File System Access API
(Chromium); a polling watcher keeps edits synchronized with other tools writing to the same
folder. Any workspace can be exported from the UI as a .zip containing the .flow files,
`grafd.manifest.json`, and `SAVE-GUIDE.md` (the guide AI agents read to work in an exported
workspace — keep it in sync with the format implementation).

The codebase is TypeScript, compiled by `tsc` alone — no bundler. `npm run build` emits
`src/` to `dist/` (which is served, never edited); `npm run watch` recompiles on change
(pair it with a running server; only server-side edits need a restart). `npm run typecheck`
checks everything including tests without emitting, and `npm test` runs the Vitest unit
tests in `tests/`.

## Linting .flow files

`npm run lint:flow` builds, then lints every `.flow` file in `.grafd/` (pass one or more
workspace directories to lint elsewhere; `--strict` also fails on warnings, `--format=json`
emits machine-readable output). It compiles into a scratch `.lint-build/` directory rather
than `dist/`, so it is safe to run alongside `npm run dev` without killing the server.
**Run it after editing any `.flow` file.**

The parser is deliberately tolerant — it never reports an error and silently discards any
line it does not recognize. Since the editor round-trips every file it opens (parse →
serialize → write), a malformed file loses content permanently on the next save; an
unterminated preamble, for instance, discards the entire body. The linter exists to catch
that before it happens: `error` means content is dropped or misread, `warning` means the
file parses but probably does not say what was meant.

## Deviation from FLOW-SPEC.md

Layout lives inside the `.flow` file itself, via the editor-owned properties `id: <uuid>`
(stable node identity) and `pos: x, y, w, h` (the canvas rectangle, also carried by a
`context:` block). This is spec'd — see FLOW-SPEC.md §11; there is no `.flow.meta` file and
the spec no longer describes one.

The one thing outside the spec is that each workspace has a `grafd.manifest.json` at its root
(`src/shared/manifest.ts`): the workspace `entrypoint`, its `flowVersion` (the format version
this workspace conforms to, defined as `FLOW_FORMAT_VERSION` in `flow-format.ts`), its
`display` settings (canvas roughness and font), plus UI state (active flow, per-flow cameras).
It is editor-owned, ignored by agents apart from `entrypoint` and `flowVersion`, and travels
through the same read/write path as .flow files.

Everything else follows the spec. `src/shared/flow-format.ts` is the single
parser/serializer, used by both the server and the browser, and defines the shared domain
types (`FlowDocument`, `FlowNode`, `EdgeSpec`, `Rect`, …).

## Architecture

- `src/server/server.ts` — express static host + REST read endpoints, WebSocket
  write/broadcast, chokidar file watcher (own writes are suppressed by content hash).
  Serves `public/` (static shell), `dist/client` at `/js`, `dist/shared` at `/shared`, and
  rough.js at `/vendor/roughjs` (mapped to the bare `roughjs` specifier by the import map
  in `public/index.html`). Watches `.grafd/` by default (override via CLI path argument), and
  reports the project root that node references resolve against — the launch directory,
  overridable with `--project-root=<path>` — over `/api/project-root`.
- `src/server/flow-files.ts` — path safety (`.flow`-only, root-confined), portable path
  conversion, recursive `.flow` discovery, content hashing.
- `src/shared/flow-format.ts` — parse/serialize `.flow` text, format helpers. No DOM, no
  Node APIs.
- `src/client/workspace.ts` — the `Workspace` interface the app shell talks to; backends:
  `workspace-server.ts` (WebSocket/REST against the Grafd server, plus the boot-time server
  probe), `workspace-browser.ts` (IndexedDB + BroadcastChannel), `workspace-folder.ts`
  (File System Access API + polling watcher).
- `src/client/zip.ts` / `src/client/export.ts` — dependency-free stored-method ZIP writer
  and the workspace .zip export (.grafd + manifest + SAVE-GUIDE.md).
- `src/client/file-tree.ts` — pure folder-tree builder behind the sidebar's collapsible
  file tree (rendering and delete interaction live in main.ts).
- `src/shared/manifest.ts` — `grafd.manifest.json` types, tolerant parsing, startup-flow
  choice.
- `src/shared/flow-scan.ts` — the linter's positioned re-walk of the line grammar: mirrors
  `parseFlow`'s branch structure but keeps line numbers and records every line the parser
  would drop. `flow-diagnostics.ts` (severities), `flow-lint-syntax.ts` (structure),
  `flow-lint-semantics.ts` (name resolution, behind an `ExpansionLookup` seam),
  `flow-lint.ts` (single file) and `flow-lint-workspace.ts` (cross-file: expand links,
  cycles, reachability) build on it; `src/tools/flow-lint.ts` is the CLI.
- `scripts/build-site.mjs` — assembles the static `site/` build (`npm run build:site`).
- `src/client/flow-doc.ts` — document mutations (add/rename/delete nodes and edges), scope
  resolution for `graph:` blocks, auto-layout for nodes missing `pos`, view-model building
  (`FlowModel` and its types). Expansion references are also walked in reverse
  (`hostsOfExpansion`), which is what lets a rename ripple: a `graph:` block with exactly one
  host node whose name it already matches is renamed together with that node, in either
  direction. The pairing is derived from the current names on every call rather than stored —
  a block deliberately named something else is simply unpaired, and the format has nowhere to
  record editor state on a block anyway.
- `src/client/geometry.ts` — pure point/rect math (centres, containment, unions, bounds,
  interpolation) shared by every canvas module. No DOM, no AST. Owns the `Point` type.
- `src/client/canvas/` — everything that draws or drives the canvas. The split inside it is by
  what each part is allowed to know:
  - `canvas-view.ts` — the interactive surface: camera, tool modes, hit-testing, pointer
    gestures (drag-create, move, resize, port-drag edge creation, marquee), subgraph camera
    animations, and the editing chrome (selection outlines, ports, marquee, in-flight edge).
    Owns the edge-geometry map that hit-testing reads.
  - `scene-painter.ts` — draws a `FlowModel` in that model's own coordinates. Knows nothing
    about the camera, viewport, selection rectangle or gestures. Built fresh per render pass
    from explicit inputs, which is how an export renders the same scene with different
    settings (no hidden title, its own geometry map) without the view mutating itself.
  - `edge-layout.ts` — where each edge runs: border points, the bow that fans parallel edges
    apart, self-loops, and redirection onto a node inside an unfolded frame. Pure — the shape
    of an edge is settled before anything is drawn, so it is testable without a renderer.
  - `node-metrics.ts` — text measurement: title/description wrapping and the title band. The
    inline title editor overlays the band this computes while the painter fills it, so both go
    through here or the overlay drifts off the ink.
  - `node-badges.ts` — where the expand/collapse affordances sit and what they show. The
    contract between painting and hit-testing, so neither owns it.
  - `region-hit-test.ts` / `region-gestures.ts` / `resize-handles.ts` — what a press lands on in
    a context region (border band and name label only — the interior belongs to the marquee) and
    the move/resize math once it has. Pure, so the view stays the only thing holding a gesture.
  - `wheel-intent.ts` — whether a wheel event means zoom or pan. A touchpad two-finger swipe
    and a mouse-wheel notch arrive as the same event, so the device is inferred from the delta
    shape and latched for the rest of a streak; ctrl+wheel (what a touchpad pinch sends) is
    always a smooth zoom. Owns `ZOOM_STEP_FACTOR`, the one discrete zoom step.
  - `pinch-gesture.ts` — the camera during a two-finger gesture. Pan and zoom fall out of one
    calculation: the world point under the fingers' midpoint when they landed is held under
    their current midpoint. Scale limits are passed in, so the view stays the only place that
    decides how far it may zoom.
- `src/client/canvas/edge-path.ts` — the shape of a drawn edge. `EdgeGeometry` carries the points the
  spline passes through plus that spline flattened to a polyline, and every consumer (hit
  testing, label anchor, edit-popup anchor, arrowhead tangent) measures against the polyline
  rather than re-deriving the curve. The flattening mirrors rough.js's cardinal spline exactly,
  so its constants belong to rough.js and must not be tuned on their own; the oracle test in
  `tests/canvas-view-edge-hit.test.ts` fails if the two ever drift. Routing an edge through more
  waypoints needs no change here beyond passing a longer point list.
- `src/client/canvas/expansion.ts` — session-local inline subgraph expansion: which nodes are
  unfolded, open/close animation, external .flow fetching, frame geometry, the warp
  displacement of surrounding nodes (view-only; never written to disk), and the loci map
  that lets nodes inside frames be edited in place (mutations are routed to the .flow file
  that owns them).
- `src/client/edit-session.ts` — the edit pipeline every document goes through: tracked
  documents and their committed text, the commit debounce, the writes, and the undo history.
  The unit of undo is the *action*, not the commit: `runAction` groups every write an action
  makes into one step, and `suspendAction` hands the rest of an action to work that resumes
  after an await (see `docs/undo-atomicity.md`).
- `src/client/context/` — context-block (region) lifecycle behind the canvas's regions:
  create/group/rename/delete (`orchestration.ts`), the `inherits` the editor generates for a
  member's expansion (`inherits.ts`), and the workspace-wide rename a provider's name forces
  (`workspace-rename.ts`). Regions are specified in `docs/context-ui.md`.
- `src/client/editors.ts` — floating DOM overlays for node, edge and region editing.
- `src/client/reference-rows.ts` / `reference-link.ts` — the editable `references:` list shared by
  the node editor and the graph panel, plus target classification (URL vs project-root-relative
  path with an optional line range) and the editor deep link it opens.
- `src/client/modal.ts` — the scrim/panel shell shared by the full-screen dialogs
  (`screenshot.ts`, `preferences-dialog.ts`).
- `src/client/preferences.ts` / `preferences-dialog.ts` — user-level display options, stored in
  localStorage (not the manifest: they describe this browser, not the workspace) and edited in
  the Preferences modal reached from the sidebar's workspace menu.
- `src/client/theme.ts` / `public/themes.css` — the theme registry and the colour tokens.
  `themes.css` is the single source of truth for every colour, one `:root[data-theme="…"]`
  block per theme; DOM chrome reads the tokens directly, and `resolveCanvasPalette` resolves
  the `--canvas-*` ones into the palette `scene-painter.ts` draws from, refilled on each theme
  change. Adding a theme means a new block plus one entry in `THEMES` — nothing else —
  and `npm run import:theme -- path/to/theme.color-theme.json` (src/tools/theme-import.ts)
  does both from a VS Code color theme.
- `src/client/main.ts` — app state, WebSocket sync, sidebar, keyboard shortcuts, and the action
  boundaries around edits that reach more than one document (`edit-session.ts` owns the history
  itself).
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
