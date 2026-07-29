# .flow Format Guide (flow/1.3)

You are reading a `.flow` workspace. This guide defines how to parse, interpret, and edit `.flow` files. Read once, then apply to every `.flow` file in the workspace.

## Core Rules

1. A `.flow` file describes a graph. The preamble **is** the node definition for that graph; the body is its expanded content.
2. **Leaf nodes (no `expand`) = you decide the implementation.**
3. **Expanded nodes (has `expand`) = you follow the referenced graph.**
4. Everything is a node. A graph is a node that has been expanded.
5. `graf.manifest.json` is the editor's workspace state file. Read its `entrypoint` field to find the root graph; ignore everything else in it and do not edit it.
6. Nodes may carry the editor-owned properties `id` and `pos`. They are visual/identity metadata, not semantics — see [Editor-Owned Properties](#editor-owned-properties).

## Workspace Layout

```
workspace/
  graf.manifest.json     # editor state: entrypoint + display and UI state (not for you)
  SAVE-GUIDE.md          # this guide
  main.flow              # root graph (whatever the manifest's entrypoint names)
  auth/
    login.flow           # referenced graphs, organized freely in subfolders
```

Start reading at the manifest's `entrypoint`. If there is no manifest, start at `main.flow` or the only root-level file.

## File Structure

```
---
name: <graph name>            # required
description: <free-form text> # optional: constraints, style, tech stack, guidance
context: [A, B]               # optional: context providers this graph declares
inherits: [A, B]              # auto-generated: context from parent graphs
on_error: -> Target           # optional: graph-level error handler
updates: [A]                  # optional: context this graph mutates
entrypoint: true              # optional: explicit trigger override
references:                   # optional: links to related code, docs, URLs
  - [Label](src/file.ts:12-40)
---

<node declarations>
```

## Nodes

Declared as a bare name at column 0. Properties indented 2 spaces. Names are unique per graph. Names never contain `: ` (colon-space) or curly braces `{` `}` (braces appear only on edges: a trailing `{Inner}` on an edge target names a node inside the target subgraph; a leading `{Inner Source}` prefix names a node inside the owning subgraph that the edge leaves from).

```
Node Name
  id: 6f2a…-uuid                # editor-owned, preserve as-is
  pos: 120, 80, 200, 88         # editor-owned, preserve as-is
  description: "optional guidance"
  expand: <local name> | [Label](path.flow)
  on_error: -> Target Node
  updates: [ContextName]
  entrypoint: true
  references:                   # optional: links to related code, docs, URLs
    - [Label](src/file.ts:12-40)
    - https://example.com/spec
  -> Target Node : "optional label"
  -> Subgraph {Inner Node} : "optional label"  # enter subgraph at Inner Node
  {Inner Source} -> Target Node : "optional label"  # leave subgraph from Inner Source
```

All properties are optional. A node with no properties is a valid leaf.

### Editor-Owned Properties

The canvas editor stores its visual metadata directly on nodes (there is no separate metadata file):

- `id: <uuid>` — stable node identity across renames.
- `pos: x, y, w, h` — the node's rectangle on the canvas.

When editing a `.flow` file:

- **Preserve** existing `id` and `pos` lines on nodes you keep (renaming a node? keep its `id` — that is what makes it a rename instead of a delete-and-create).
- **Omit** both on nodes you add. The editor assigns an id and auto-layouts missing positions.
- **Never** copy an `id` onto a second node; ids are unique per workspace file.
- **Ignore** both when interpreting the graph — they carry no semantic meaning.

### Inference Rules

- No incoming edges → entry point / trigger
- Multiple labeled outgoing edges → decision node
- No `expand` → leaf, you implement freely
- Has `expand` → follow the referenced graph
- Purpose inferred from title + structure + description

### References

A node (or a preamble) may carry a `references` block pointing at the material it corresponds to — the code that implements it, a design doc, an external spec:

```
Show Login
  description: "Email and password form"
  references:
    - [Login form](src/client/login.tsx:42-88)
    - [Session cookie decision](docs/decisions/0007-session-cookies.md)
    - https://stripe.com/docs/auth
  -> Submit Credentials
```

One entry per line, indented one level under `references:`, prefixed with `- `. Each entry is either `[Label](target)` or a bare `target`; the label is optional free text saying why the target matters.

**Target kinds are inferred:** a URI scheme (`https:`, `mailto:`, …) means an external link; anything else is a file path with an optional `:line` or `:startLine-endLine` suffix.

**File paths resolve against the project root** — the directory you are working in — *not* the containing `.flow` file. This differs from `expand` paths, which are file-relative.

How to treat them:

- **Read** them for context before implementing or changing a node. A reference to existing code tells you where the node already lives.
- **Preserve** them when editing a file.
- **Update or add** them once you implement a node, so the diagram keeps pointing at the real code.
- **Do not** treat them as control flow or as expansion. A reference to a `.flow` file is a plain link, not an `expand`.

## Edges

Inline on the owning node. Syntax: `-> Target : "label"`. Label is optional and free-form natural language.

```
Node A
  -> Node B                       # sequential, unlabeled
  -> Node C : "if valid"          # conditional
  -> Node D : "on timeout"        # error/event
```

### Edge Semantics from Labels

Interpret the label contextually. Examples:
- `"if X"`, `"when X"`, `"X valid"` → condition
- `"on success"`, `"on error"`, `"on timeout"` → event/outcome
- `"retry, max 3"`, `"until valid"` → loop termination
- No label → sequential

### Fan-Out Without Labels

Multiple unlabeled outgoing edges = execution strategy unspecified. You decide parallel vs sequential based on node semantics.

### Edge Data (optional)

```
Node A
  -> Node B : "label"
    data:
      fieldName: type
      fieldName: type
```

If `data` present, match that schema. If absent, infer from context and labels.

### Loops

Backward edges (pointing to earlier-declared nodes) are cycles. Implement loop/retry logic. Termination conditions come from edge labels or descriptions.

### Targeting a Node Inside a Subgraph

An edge may optionally name a node inside the target subgraph with a `{Inner Node}` suffix:

```
Validate Cart
  -> Process Payment {Charge Card} : "cart valid"

Process Payment
  expand: Payment Steps

graph: Payment Steps
  Charge Card
    -> Send Receipt
  Send Receipt
```

- The name before `{...}` is the subgraph node (resolved in the current scope); it must have `expand`.
- The name inside `{...}` is the inner node, resolved against the top-level scope of that expansion (local `graph:` block or external file body). Single-level only — nested paths are not supported.
- **Semantics:** control enters the subgraph at that inner node instead of its inferred entry point.

### Originating an Edge From a Node Inside a Subgraph

An edge declared under a subgraph node may optionally carry a `{Inner Source}` prefix before `->`:

```
Process Payment
  expand: Payment Steps
  {Charge Card} -> Notify Admin : "charged"

graph: Payment Steps
  Charge Card
    -> Send Receipt
  Send Receipt
```

- The name inside `{...}` is resolved against the top-level scope of the owning node's expansion (local `graph:` block or external file body). Single-level only — nested paths are not supported.
- The target may still take its own `{Inner}` suffix (`{A} -> Sub {B}`).
- **Semantics:** control leaves the subgraph at that inner node instead of its inferred exit.

## Expansion

A node with `expand` delegates its internals to another graph.

```
Node Name
  expand: Local Graph Name              # inline graph: block in same file
  expand: [Label](relative/path.flow)   # external file
```

### Local `graph:` Blocks

```
graph: Graph Name
  Child Node A
    -> Child Node B
  Child Node B
```

Graph blocks can be referenced by multiple nodes (reuse).

When exactly one node expands a block, the block is that node's definition, so give the two the
same name and rename them together — the editor keeps the pair in step and the linter warns
when they drift apart. A block several nodes share has no single owner and keeps its own name.

### Expansion Is Recursive

A node inside an expanded graph can itself have `expand`. Rule applies at every level.

## Error Handling

`on_error` appears on nodes or graphs (preamble). Bubbles up:

1. Node's `on_error` catches node-specific failures.
2. If node has no `on_error`, the graph's `on_error` catches it.
3. If graph has no `on_error`, parent graph's `on_error` catches it.
4. Continues up the expansion tree.

```
on_error: -> Target Node
on_error: -> Target Node : "context about failure"
on_error: [Handler](path.flow)
```

## Context Providers

Shared state available to all nodes in a graph (auth, session, config, etc.).

- **Declared** at graph level via `context: [Name1, Name2]` in the preamble.
- **Inherited** by child graphs via auto-generated `inherits: [...]` in their preamble.
- **Read access is implicit** — no annotation needed. Any node in a graph can read its declared or inherited context.
- **Write access is explicit** — a node that mutates context declares `updates: [Name]`.

```
---
name: Payment Flow
context: [Cart]
inherits: [Auth]          # available from parent
---

Charge Card
  updates: [Cart]          # this node mutates Cart
```

## Comments

Lines starting with `#` are comments. Ignore them when interpreting; preserve them when editing.

## Cross-File Resolution

When you encounter `expand: [Label](path.flow)`:
1. Read the referenced file.
2. The file's preamble defines the expanded node — put node-definition fields there (`description`, `references`, and the target's own `context` / `inherits`), not on the referencing node.
3. Its body contains the child nodes.
4. Apply all rules recursively.

Paths are relative to the referencing file. The referencing node keeps parent-scoped role fields — edges, `entrypoint`, `on_error`, `updates`, and editor-owned `id` / `pos` — because they describe its role in the *parent* graph. Do not strip those when moving node-definition fields into the target preamble.

## Reserved Keywords

`name`, `description`, `context`, `inherits`, `on_error`, `expand`, `updates`, `entrypoint`, `references`, `data`, `graph`, `id`, `pos`

All other identifiers are user-defined node names or context names.

## Implicit Defaults (when field is omitted)

| Missing | Behavior |
|---|---|
| `description` | Infer purpose from title and structure |
| `expand` | Leaf node — you decide implementation |
| `on_error` | Error bubbles up to parent graph |
| `updates` | Node is read-only with respect to context |
| `entrypoint` | Inferred: no incoming edges = entry point |
| `context` | Graph declares no new context |
| `inherits` | Graph inherits nothing (root or isolated) |
| `references` | No known related code or documents — locate them yourself, and add them once you implement the node |
| `id` / `pos` | Editor assigns them on next open |
| Edge label | Sequential connection |
| Edge `data` | Infer payload from context |
| no `{...}` refinement | Edge enters the subgraph at its inferred entry point |
| no `{...}` prefix | Edge originates at the subgraph's inferred exit |
| Fan-out strategy | You decide parallel vs sequential |

## Grammar (EBNF-ish)

```
file        := preamble body
preamble    := "---" NL field+ "---" NL
field       := (key ": " (value | list) NL) | reference_block
list        := "[" name ("," name)* "]"

body        := (node | graph_block | comment | blank)*

node        := name NL (indent property)*
property    := (key ": " value) | reference_block | edge
reference_block := "references:" NL (indent "- " reference NL)+
reference   := "[" label "](" target ")" | target
target      := url | path (":" line ("-" line)?)?
edge        := ("{" inner_source "}" " ")? "-> " target_node ("{" inner_target "}")? (" : " quoted_label)? NL (indent data_block)?
inner_source := name
inner_target := name
target_node := name
data_block  := "data:" NL (indent key ": " type NL)+

graph_block := "graph: " name NL (node)*

comment     := "#" any NL
indent      := "  "    # 2 spaces, no tabs
```

`id` and `pos` are ordinary properties syntactically; `pos` takes four comma-separated integers (`x, y, w, h`).

An indented block belongs to the line directly above it: `data:` under an edge, `references:` under a node or preamble field.

## Writing .flow Files

When you create or edit `.flow` files, follow the editor's canonical style so files round-trip cleanly:

- 2-space indentation, never tabs.
- One blank line between top-level items (nodes, `graph:` blocks, the preamble).
- Per-node line order: `id`, `pos`, other single-line properties, the `references:` block, then edges. Block-valued properties come last so the single-line ones stay in one column.
- An empty `references:` block is omitted entirely — write the key only when it has entries.
- Quoted values use double quotes. The format has **no escape sequences** — a `"` character can never appear inside a label or quoted value.
- Node names are unique within their graph and never contain `: ` (colon-space) or curly braces `{` `}`. An optional `-> Subgraph {Inner}` edge target enters the subgraph at that inner node; an optional `{Inner Source} -> Target` prefix leaves the subgraph from that inner node.

## Parsing Procedure

For each `.flow` file:

1. Parse preamble between `---` fences as the graph's node definition.
2. Parse body nodes top to bottom. Each bare-name line at column 0 begins a new node (or `graph:` block).
3. Properties and edges are indented 2 spaces under their owning node.
4. Resolve `expand` references by reading the target file or local `graph:` block.
5. Build the node-and-edge model. Apply inference rules to determine node roles.
6. For each leaf node, implement based on title, description, and surrounding context.
7. For each expanded node, recurse into the referenced graph.

## What You Are Generating

`.flow` files describe solution designs. Your job is to implement them as working code. The user controls specificity:

- If they sketched loosely, make sensible engineering decisions.
- If they specified precisely, respect the specification.
- Use `description` fields as primary guidance for tech stack, patterns, and constraints.
- Follow `references` to existing code and documents before writing anything new, and point them at the real code once you have implemented a node.
- Respect `context`/`inherits` as available state, `updates` as mutations.
- Respect `on_error` as the error flow.
