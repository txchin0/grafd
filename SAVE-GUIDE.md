# .flow Format Guide (flow/1)

You are reading a `.flow` project. This guide defines how to parse and interpret `.flow` files. Read once, then apply to every `.flow` file in the project.

## Core Rules

1. A `.flow` file describes a graph. The preamble **is** the node definition for that graph; the body is its expanded content.
2. **Leaf nodes (no `expand`) = you decide the implementation.**
3. **Expanded nodes (has `expand`) = you follow the referenced graph.**
4. Everything is a node. A graph is a node that has been expanded.
5. Ignore `.flow.meta` files — they are visual metadata for the frontend, not for you.

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
  description: "optional guidance"
  expand: <local name> | [Label](path.flow)
  on_error: -> Target Node
  updates: [ContextName]
  entrypoint: true
  -> Target Node : "optional label"
```

All properties are optional. A node with no properties is a valid leaf.

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

Graph blocks can be referenced by multiple nodes (reuse). Same properties as preambles (context, inherits, on_error, description, etc.) may appear on a `graph:` block.

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

- **Declared** at graph level via `context: [Name1, Name2]` in the preamble or `graph:` block.
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

Lines starting with `#` are comments. Ignore them.

## Cross-File Resolution

When you encounter `expand: [Label](path.flow)`:
1. Read the referenced file.
2. The file's preamble defines the expanded node.
3. Its body contains the child nodes.
4. Apply all rules recursively.

Paths are relative to the referencing file.

## Reserved Keywords

`name`, `description`, `context`, `inherits`, `on_error`, `expand`, `updates`, `entrypoint`, `data`, `graph`

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
