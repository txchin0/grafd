# Grafd

<img width="1369" height="812" alt="image" src="https://github.com/user-attachments/assets/cd0f635f-8be0-4551-b371-6b7e8714e21c" />

**Grafd** is a freeform web canvas editor for `.flow` files — a text-based diagram
format for solution design. You sketch graphs visually in the browser; the same `.flow`
files are read, interpreted, and implemented by AI agents, so the diagram is the spec.

The format is defined in [FLOW-SPEC.md](FLOW-SPEC.md) and the editor is built to round-trip
it exactly: canvas layout travels inside the file as editor-owned `id` and `pos`
properties, with no sidecar metadata. A workspace is plain files on disk — open it in any
editor, share it, diff it, or hand it to an agent.

## Features

- **Freeform canvas editing** — nodes, edges, labels, regions, pan/zoom, marquee
selection, inline editing, and action-based undo/redo on a rough.js hand-drawn canvas.
- **Subgraph expansion** — unfold any `expand` reference inline on the canvas, edit inside
the frame, and have changes routed to the `.flow` file that owns the node.
- **Two deployment modes** — a self-hosted Node server with WebSocket live sync and direct
disk writes, or a fully static build that runs entirely in the browser.
- **Local folder workspaces** — open a folder through the File System Access API
(Chromium) and stay in sync with other tools editing the same files.
- **Workspace export** — download a workspace as a `.zip` containing the `.flow` files,
`grafd.manifest.json`, and `SAVE-GUIDE.md`, the guide AI agents read to work in the
workspace.
- **References** — link any node to project files (with line ranges) or URLs, and jump
from the canvas to the referenced file.
- **Themes** — several built-in themes, imported automatically from VS Code color themes
via `npm run import:theme`.
- **PNG export** — render the active graph to a PNG at up to 4x resolution.
- **Format linter** — a CLI that catches files the parser would silently drop or misread
before a save destroys them, including cross-file checks.

## Use cases

- **Solution design** — sketch the intended flow before writing code, then hand the
diagram off to an agent as the working spec. Because `.flow` files are plain text, the
design stays reviewable, diffable, and easy to update alongside the implementation.
- **Visual understanding** — turn a codebase into a diagram to see its architecture at a
glance. Map services, data flows, and dependencies, then trace how a change would ripple
through the system before making it.
- **Agent-driven implementation** — give agents the same `.flow` file the editor uses.  
They can read it as the spec, propose updates to the diagram, or implement the design  
directly, keeping the conversation anchored to one source of truth.
- **Collaborative design** — share a workspace on disk and edit the same `.flow` files with 
teammates or agents; changes sync live, so the canvas always reflects the latest decisions.



## Quick start

Requirements: [Node.js](https://nodejs.org) 20+ and npm. A Chromium-based browser
(Chrome, Edge, Brave) is recommended for opening local folders.

```sh
npx grafd-ai init
npx grafd-ai start --open
```

`grafd-ai init` creates a `.grafd/` workspace with `main.flow`, `grafd.manifest.json`, and
`SAVE-GUIDE.md`. `grafd-ai start` then serves it at [http://localhost:3103](http://localhost:3103), binding to
`127.0.0.1` by default so CI and remote terminals never expose the editor unless you ask
for it. `--open` is opt-in; pass `--host 0.0.0.0` to serve on the network.

Teams that want reproducible versions install the package as a dev dependency instead of
relying on `npx`:

```sh
npm install --save-dev grafd-ai
npx grafd start --open
```

After installing, the command is still called `grafd` (`npx grafd` from the project, or
`grafd` when `node_modules/.bin` is on your path).

To run this repository directly, use `npm install && npm start` and open
[http://localhost:3103](http://localhost:3103). The server watches the `.grafd/` directory (the example workspace)
by default and writes every canvas edit straight back to disk. To serve a different
workspace:

```sh
node dist/server/server-main.js path/to/workspace
```

The port is configurable with `--port` (default `3103`), the `PORT` environment variable
takes precedence when `--port` is not passed, and the project root used to resolve file
references defaults to the launch directory (`--project-root=<path>` to override).

## npm CLI

The `grafd-ai` package ships one command with three subcommands. Use `npx grafd-ai` to run
it without installing; once the package is installed, use `npx grafd` (or `grafd` when
`node_modules/.bin` is on your path):

```sh
npx grafd-ai            # shorthand for npx grafd-ai start
npx grafd-ai init
npx grafd-ai start [workspace] [--port <n>] [--host <host>] [--open] [--project-root=<path>]
npx grafd-ai lint [workspace...] [--strict] [--format=json]
```

Running the command with no subcommand is shorthand for `start`. `start` and
`lint` use `.grafd/` when it exists, otherwise the current directory when it contains
`.flow` files, otherwise they exit with a hint to run `init`. `init` never overwrites an
existing `.grafd/` workspace.

## Hosting modes

Grafd ships the same app in two modes.

**Self-hosted** — `npm start` builds and runs the Node server. The server serves the
static shell, watches `*.flow` files with chokidar, and pushes changes to the browser over
WebSocket. Edits made in the canvas are written back to disk; edits made by other tools are
watched and reflected live.

**Serverless** — `npm run build:site` assembles a fully static build in `site/` that runs
on any static host (GitHub Pages, Netlify, S3, ...):

```sh
npm run build:site
npm run serve:site   # local preview at http://localhost:4601
```

At boot the client probes `./api/files`; with no server answering, it stores workspace
files in IndexedDB, synced across tabs via `BroadcastChannel`. Opening a local folder is
available in both modes through the File System Access API.

**GitHub Pages** — this repository publishes the serverless build automatically from
`main` via `.github/workflows/deploy-pages.yml`. The live editor is at
[https://txchin0.github.io/grafd/](https://txchin0.github.io/grafd/).

## Development

The codebase is plain TypeScript compiled by `tsc` — no bundler, no frontend framework.
`rough.js` is the only rendering dependency.

```sh
npm run dev          # tsc --watch + node --watch with live reload
npm run typecheck    # type-check src, tests, and config without emitting
npm test             # run the Vitest unit tests
npm run lint:flow    # lint every .flow file in .grafd/ (see below)
```

`npm run dev` rebuilds once so `dist/` exists, then recompiles on change in the background
while the server runs in live-reload mode. Only server-side edits need a restart; client
and shared recompiles reach the browser over the existing WebSocket.

### Linting `.flow` files

The parser is deliberately tolerant — it never reports an error and silently discards any
line it does not recognize. Because the editor round-trips every file it opens, a malformed
file can lose content permanently on the next save. `npm run lint:flow` catches that before
it happens:

```sh
npm run lint:flow                # lint .grafd/ (pass paths to lint other workspaces)
npm run lint:flow -- --strict    # fail on warnings too
npm run lint:flow -- --format=json
```

**Run it after editing any** `.flow` **file.** The linter compiles into a scratch `.lint-build/`
directory, so it is safe to run while a dev server is live.

## The `.flow` format

- [FLOW-SPEC.md](FLOW-SPEC.md) — the format specification (currently `flow/1.6`, draft).
- [SAVE-GUIDE.md](SAVE-GUIDE.md) — the guide embedded in every exported workspace that
tells AI agents how to parse, interpret, and edit `.flow` files.
- `grafd.manifest.json` — editor-owned workspace state: the entrypoint flow, the format
version, display settings, and UI state. Agents read `entrypoint` and `flowVersion`;
everything else is editor state.

The `.grafd/` directory in this repository is a working example workspace
(a user authentication app) you can open immediately.

## Project layout

```
src/
  shared/    Parser/serializer, linter, manifest, geometry — no DOM, no Node APIs
  server/    Express host, WebSocket sync, file watcher, path safety
  client/    Canvas, editors, workspace backends, theming, export
  tools/     flow-lint CLI, VS Code theme importer
scripts/     dev server, static build, site preview
tests/       Vitest unit tests (parser, canvas math, server logic, gestures)
.grafd/      Example .flow workspace
public/      Static shell, styles, themes, fonts
```



## Contributing

Contributions are welcome. Please open an issue for bugs or design questions, and submit a
pull request for changes. Before submitting:

1. Run `npm run typecheck` and `npm test`.
2. Run `npm run lint:flow` after touching any `.flow` file.
3. Follow the repository's self-documenting code style: intent expressed through naming and
  structure, comments reserved for constraints and "why" explanations.

The architecture guide in [CLAUDE.md](CLAUDE.md) explains how the editor is split — it is
written for coding agents, but it is the best map of the codebase for human contributors
too.

## License

Grafd is licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0);
see [LICENSE](LICENSE) for the full text.

Copyright (C) 2026 Grafd contributors
