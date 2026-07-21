# .flow Format Guide (flow/1)

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
  graf.manifest.json     # editor state: entrypoint + UI state (not for you)
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
---

<node declarations>
```

## Nodes

Declared as a bare name at column 0. Properties indented 2 spaces. Names are unique per graph. Names never contain `: ` (colon-space).

```
Node Name
  id: 6f2a…-uuid                # editor-owned, preserve as-is
  pos: 120, 80, 200, 88         # editor-owned, preserve as-is
  description: "optional guidance"
  expand: <local name> | [Label](path.flow)
  on_error: -> Target Node
  updates: [ContextName]
  entrypoint: true
  -> Target Node : "optional label"
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
2. The file's preamble defines the expanded node — put node-definition fields there (`description`, and the target's own `context` / `inherits`), not on the referencing node.
3. Its body contains the child nodes.
4. Apply all rules recursively.

Paths are relative to the referencing file. The referencing node keeps parent-scoped role fields — edges, `entrypoint`, `on_error`, `updates`, and editor-owned `id` / `pos` — because they describe its role in the *parent* graph. Do not strip those when moving node-definition fields into the target preamble.

## Reserved Keywords

`name`, `description`, `context`, `inherits`, `on_error`, `expand`, `updates`, `entrypoint`, `data`, `graph`, `id`, `pos`

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
| `id` / `pos` | Editor assigns them on next open |
| Edge label | Sequential connection |
| Edge `data` | Infer payload from context |
| Fan-out strategy | You decide parallel vs sequential |

## Grammar (EBNF-ish)

```
file        := preamble body
preamble    := "---" NL field+ "---" NL
field       := key ": " (value | list) NL
list        := "[" name ("," name)* "]"

body        := (node | graph_block | comment | blank)*

node        := name NL (indent property)*
property    := (key ": " value) | edge
edge        := "-> " target (" : " quoted_label)? NL (indent data_block)?
data_block  := "data:" NL (indent key ": " type NL)+

graph_block := "graph: " name NL (node)*

comment     := "#" any NL
indent      := "  "    # 2 spaces, no tabs
```

`id` and `pos` are ordinary properties syntactically; `pos` takes four comma-separated integers (`x, y, w, h`).

## Writing .flow Files

When you create or edit `.flow` files, follow the editor's canonical style so files round-trip cleanly:

- 2-space indentation, never tabs.
- One blank line between top-level items (nodes, `graph:` blocks, the preamble).
- Per-node line order: `id`, `pos`, other properties, then edges.
- Quoted values use double quotes. The format has **no escape sequences** — a `"` character can never appear inside a label or quoted value.
- Node names are unique within their graph and never contain `: ` (colon-space).

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
- Respect `context`/`inherits` as available state, `updates` as mutations.
- Respect `on_error` as the error flow.
