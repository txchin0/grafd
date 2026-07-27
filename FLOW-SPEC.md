# .flow Format Specification

**Version:** flow/1.3
**Status:** Draft

## Revision History

| Version  | Change                                                                              |
| -------- | ----------------------------------------------------------------------------------- |
| flow/1   | Initial draft.                                                                      |
| flow/1.1 | Edges may target a node inside a subgraph via an optional `{Inner Node}` suffix. |
| flow/1.2 | Edges may originate from a node inside a subgraph via an optional `{Inner Source}` prefix. |
| flow/1.3 | Nodes and preambles may carry a `references` block linking to related source files, documents, and URLs. Indented blocks are generalized: a block belongs to the line directly above it. |

---

## 1. Overview

The `.flow` format is a text-based diagram language designed for solution design. Users create diagrams visually in a frontend editor and export them as `.flow` files that LLM agents read, interpret, and implement as code.

### Core Philosophy

- **Implicit over explicit** — The format infers meaning from structure and natural language. No rigid type systems or verbose annotations.
- **Recursive depth, user-controlled specificity** — Any node can be expanded into a graph with more detail. The user controls how deep the specification goes.
- **Leaf nodes = LLM decides** — Nodes without expansion are intentionally abstract. The LLM makes implementation decisions.
- **Expanded nodes = LLM follows** — Nodes with an `expand` property have user-defined internals. The LLM follows the specification.
- **Everything is a node** — There is no distinction between "node" and "graph." A graph is simply a node that has been expanded.

---

## 2. File System

### 2.1 File Types

Each graph produces two files:


| File          | Consumer        | Contains                                                 |
| ------------- | --------------- | -------------------------------------------------------- |
| `*.flow`      | LLM agent       | Semantic content: nodes, edges, properties, descriptions |
| `*.flow.meta` | Frontend editor | Visual metadata: positions, colors, canvas state         |


The `.flow` file is the **source of truth** for what exists in the graph. The `.flow.meta` file decorates it with layout information. The LLM never reads `.flow.meta` files.

### 2.2 File Splitting

Complex graphs are split into separate `.flow` files. The exporter applies a heuristic to split automatically, but the user has final say and can merge or split further after export.

**Rule:** The `.flow` file owns the graph. The `.flow.meta` file decorates it.

### 2.3 Project Structure

A `.flow` project has a root file and optionally many referenced graph files:

```
project/
  SPEC.flow              # Format spec (read by LLM agent first)
  main.flow              # Root graph (entry point)
  main.flow.meta         # Visual metadata for root graph
  auth/
    login.flow           # Referenced graph
    login.flow.meta
    logout.flow
    logout.flow.meta
  checkout/
    payment.flow
    payment.flow.meta
```

### 2.4 Spec File

Every project includes a `SPEC.flow` file (or equivalent) at the root. This contains the format guide and the format version for the LLM agent. The agent reads it once at the start of a session before processing any `.flow` files. Individual `.flow` files do not embed the spec or the format version — the spec file is the single source of truth for which version of the format applies to the entire project.

---

## 3. File Format

### 3.1 Preamble

Every `.flow` file starts with a YAML-style preamble enclosed in `---` fences:

```
---
name: Checkout Flow
description: "Handles cart validation through payment confirmation"
---
```

#### Preamble as Node Definition

A `.flow` file is the expanded body of a node. The preamble **is** that node's definition. It supports the same properties as any inline node, plus graph-scoping properties.

#### Required Fields


| Field  | Description                            |
| ------ | -------------------------------------- |
| `name` | Human-readable name of this node/graph |


#### Optional Fields — Node Properties

These are the same properties available on any inline node:


| Field         | Description                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `description` | Free-form description. Can include tech stack, style preferences, constraints, or any guidance for the LLM                      |
| `on_error`    | Error handler for this graph. Catches unhandled errors from any node within. See [Section 7: Error Handling](#7-error-handling) |
| `updates`     | Lists context providers this graph as a whole modifies. See [Section 8: Context Providers](#8-context-providers)                |
| `entrypoint`  | Boolean. Marks this graph as an explicit entry point/trigger. See [Section 4.4: Entry Points](#44-entry-points)                 |
| `references`  | Block of links to the material this graph corresponds to — source files, documents, URLs. See [Section 4.5: References](#45-references) |


#### Optional Fields — Graph-Scoping Properties

These are specific to the preamble because they relate to the graph's scope:


| Field      | Description                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `context`  | Explicit list of context providers this graph declares. See [Section 8: Context Providers](#8-context-providers) |
| `inherits` | **Auto-generated on export.** Lists context providers available from parent graphs. Not manually authored        |


#### Note on `expand`

The `expand` property does not appear in the preamble — the file itself *is* the expansion. `expand` is only used on inline nodes to reference a graph definition.

### 3.2 Syntax Rules

- **Indentation:** 2-space indentation. Tabs are forbidden.
- **Indented blocks:** A property may take a block of lines indented one level deeper than itself. The block belongs to the line directly above it — `data:` under an edge ([Section 5.5](#55-edge-data)), `references:` under a node or in a preamble ([Section 4.5](#45-references)).
- **Encoding:** UTF-8.
- **Comments:** Lines starting with `#` are comments. The LLM ignores them.
- **Node names:** Cannot contain `:`  (colon followed by space). Enforced by the frontend. Node names must also not contain `{` or `}` — braces appear only on edges: a trailing `{Inner Node}` on an edge target names a node inside the target subgraph (see [Section 5.7](#57-targeting-a-node-inside-a-subgraph)), and a leading `{Inner Source}` prefix names a node inside the owning subgraph that the edge leaves from (see [Section 5.8](#58-originating-an-edge-from-a-node-inside-a-subgraph)).
- **Node uniqueness:** Node names must be unique within a single graph. Enforced by the frontend.
- **Blank lines:** Optional. Used for visual separation between nodes. No semantic meaning.

---

## 4. Nodes

### 4.1 Declaration

A node is declared as a bare name at root indentation (column 0). Properties are indented beneath it with 2-space indentation:

```
Validate Cart
  description: "Ensures cart has items and valid quantities"
```

A node with no properties is valid — it's a leaf node with an inferred purpose:

```
Clear Session
```

### 4.2 Node Properties

All properties are optional. A node can have any combination:


| Property      | Description                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description` | Free-form text providing detail, constraints, or guidance for the LLM                                                                                       |
| `expand`      | References another graph that defines this node's internals. See [Section 6: Expansion](#6-expansion)                                                       |
| `on_error`    | Error handler for this specific node. See [Section 7: Error Handling](#7-error-handling)                                                                    |
| `updates`     | Lists context providers this node modifies. See [Section 8: Context](#8-context-providers)                                                                  |
| `entrypoint`  | Boolean. Marks this node as an explicit entry point/trigger. See [Section 4.4: Entry Points](#44-entry-points)                                              |
| `context`     | Declares context providers. Only applicable when the node is a graph (preamble or `graph:` block). See [Section 8: Context Providers](#8-context-providers) |
| `inherits`    | **Auto-generated.** Lists context from parent graphs. Only applicable when the node is a graph. See [Section 8: Context Providers](#8-context-providers)    |
| `references`  | Block of links to the material this node corresponds to — source files, documents, URLs. See [Section 4.5: References](#45-references)                      |


A node and a graph preamble share the same property set. The only difference is that a preamble uses `name:` instead of a bare name at column 0, and the `expand` property is not used in preambles (the file *is* the expansion).

Example inline node with multiple properties:

```
Process Payment
  description: "Charges the customer via payment gateway"
  expand: [Payment Processing](checkout/payment.flow)
  on_error: -> Show Payment Error
  updates: [Cart]
```

Example preamble (same properties, different format):

```
---
name: Payment Processing
description: "Charges the customer via payment gateway"
on_error: -> Show Payment Error
updates: [Cart]
inherits: [Auth]
---
```

### 4.3 Inferred Purpose

Nodes do not have explicit types. The LLM infers a node's purpose from:

1. **Title** — `Clear Session` implies clearing session data. `Is Authenticated?` implies a decision.
2. **Structure** — A node with multiple labeled outgoing edges is a decision. A node with no incoming edges is an entry point.
3. **Description** — Additional detail narrows the LLM's interpretation.
4. **Expansion** — If the node has `expand`, the referenced graph defines its internals.

### 4.4 Entry Points

Entry points (triggers) are inferred from structure: **a node with no incoming edges is treated as an entry point.** This is the default behavior.

To explicitly mark a node as an entry point (overriding the inference, e.g., when the graph is called from another graph), use the `entrypoint` property:

```
Handle Webhook
  entrypoint: true
  description: "Triggered by Stripe webhook POST"
  -> Validate Signature
```

### 4.5 References

A node can point at the material it corresponds to — the source files that implement it, a design document, an external API spec. This is the `references` block:

```
Show Login
  description: "Email and password form"
  references:
    - [Login form](src/client/login.tsx:42-88)
    - [Session cookie decision](docs/decisions/0007-session-cookies.md)
    - https://stripe.com/docs/auth
  -> Submit Credentials : "user taps login"
```

Each entry sits on its own line under `references:`, indented one level deeper and prefixed with `- `. An entry takes one of two forms:


| Form              | Example                                          |
| ----------------- | ------------------------------------------------ |
| `[Label](target)` | `- [Login form](src/client/login.tsx:42-88)`     |
| `target`          | `- https://stripe.com/docs/auth`                 |


The label is free-form human text saying why the target is relevant. It is optional — a bare target is a valid entry.

#### Target Kinds

Kinds are inferred, never declared:

- A target with a URI scheme (`https:`, `mailto:`, …) is an external link.
- Anything else is a file path, optionally suffixed with `:line` or `:startLine-endLine`.

```
- src/auth/session.ts              # whole file
- src/auth/session.ts:112          # single line
- src/auth/session.ts:112-140      # line range
```

#### Path Resolution

**File targets resolve relative to the project root** — the directory the agent is working in — not relative to the containing `.flow` file. This deliberately differs from `expand` paths ([Section 10.1](#101-external-graph-references)), which are file-relative: referenced code normally lives outside the `.flow` workspace, and anchoring to the project root keeps references stable no matter how deeply the `.flow` files are nested.

#### References in the Preamble

The preamble is a node definition, so it takes `references` on the same terms, with entries indented one level under the key:

```
---
name: Login Flow
description: "Handles credential validation and token generation"
references:
  - [Auth service](src/server/auth-service.ts)
  - https://jwt.io/introduction
---
```

#### Semantics for Agents

References are **pointers, not instructions**. They say what a node corresponds to; they never alter control flow, and they are not a substitute for `expand`. An agent:

- Reads them for context before implementing or modifying a node.
- Preserves existing entries when editing the file.
- May add or update entries once it has implemented a node, so the diagram keeps pointing at the real code.

Referenced files are not part of the `.flow` graph. A reference to a `.flow` file is an ordinary link, not an expansion.

---

## 5. Edges

### 5.1 Declaration

Edges are declared inline on the owning node, indented beneath it. The syntax is:

```
-> Target Node : "label"
```

The label is optional. An unlabeled edge is a simple sequential connection:

```
-> Target Node
```

An edge may optionally name a node inside the target subgraph with `-> Subgraph {Inner}` — see [Section 5.7](#57-targeting-a-node-inside-a-subgraph).

Examples:

```
Validate Cart
  -> Process Payment : "cart is valid"
  -> Show Error : "cart is empty"

Process Payment
  -> Send Confirmation
```

### 5.2 Edge Labels

Labels are free-form natural language enclosed in double quotes. The LLM infers the edge semantics from the label:

- **Conditions:** `"if authenticated"`, `"cart is valid"`, `"user confirmed"`
- **Events:** `"on success"`, `"on timeout"`, `"on 4xx/5xx"`
- **Descriptions:** `"passes order details"`, `"with sanitized input"`
- **Loops/Retries:** `"retry, max 3 attempts"`, `"user corrects and resubmits"`

There are no reserved edge types or keywords. The LLM interprets the label contextually.

### 5.3 Decision Nodes

A decision node is inferred from structure: **a node with multiple labeled outgoing edges is a decision.** No special syntax is needed:

```
Is Authenticated?
  -> Load Dashboard : "yes"
  -> Redirect to Login : "no"
```

### 5.4 Parallel / Fan-Out

When a node has multiple outgoing edges without conditions, the execution strategy is unspecified. The LLM decides whether to implement them as parallel, sequential, or otherwise based on context:

```
Initialize App
  -> Load Config
  -> Fetch User Data
  -> Setup Analytics
```

If the user wants explicit ordering, they chain the nodes sequentially. If the user wants explicit parallelism, they label the edges accordingly.

### 5.5 Edge Data

Edges can optionally carry a `data` block that specifies the schema of data passed between nodes. This is indented beneath the edge:

```
Validate Cart -> Process Payment : "cart is valid"
  data:
    cartId: string
    items: array
    totalAmount: number
```

If no `data` block is present, the LLM infers what data flows between nodes based on context and labels. If a `data` block is present, the LLM matches the specified schema.

This follows the same implicit-to-explicit pattern: no schema = LLM decides, schema present = LLM follows.

### 5.6 Loops and Cycles

Backward edges (edges pointing to a node declared earlier in the file) represent loops. No special syntax is needed:

```
Submit Form
  -> Validate Input

Validate Input
  -> Process Submission : "valid"
  -> Show Errors : "invalid"

Show Errors
  -> Submit Form : "user corrects and resubmits"
```

The LLM recognizes this as a cycle and implements appropriate loop/retry logic. If termination conditions matter, the user includes them in the edge label or node description.

### 5.7 Targeting a Node Inside a Subgraph

An edge target may optionally carry a `{Inner Node}` suffix naming a node inside the target subgraph's expansion. Curly braces are unused elsewhere in the format, so there is no collision with the `[Label](path)` markdown-link convention used by `expand`/`on_error`.

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

- `-> Target : "label"` — unchanged, ordinary edge.
- `-> Subgraph Node {Inner Node} : "label"` — optional form. The label remains optional and always trails the whole target.

**Resolution & constraints:**

1. The name **before** `{...}` is the **subgraph node**. It is resolved in the current scope exactly like any edge target, and it **must** be a node that has `expand` (a subgraph).
2. The name **inside** `{...}` is the **inner node**. It is resolved against the top-level scope of the graph that the subgraph node's `expand` references (the local `graph:` block or the external file's body).
3. The edge continues to point at the subgraph node — the inner name only refines *where inside it* control enters. This is single-level: the inner node lives directly in the subgraph node's expansion (nested paths are out of scope for this version).
4. **Semantics for agents:** control flow enters the subgraph directly at the named inner node, bypassing the subgraph's normal (inferred) entry point.
5. **Fallback:** if the subgraph node has no `expand`, or the inner node isn't found in the expansion, treat it as a plain edge to the subgraph node (the `{...}` refinement is ignored).

### 5.8 Originating an Edge From a Node Inside a Subgraph

An edge declared under a subgraph node may optionally carry a `{Inner Source}` prefix before `->`, naming the node inside that subgraph's expansion that the edge leaves from. This is the mirror of [Section 5.7](#57-targeting-a-node-inside-a-subgraph)'s target-side `{Inner Node}` suffix. Curly braces are unused elsewhere in the format, so there is no collision with the `[Label](path)` markdown-link convention used by `expand`/`on_error`.

```
Process Payment
  expand: Payment Steps
  {Charge Card} -> Notify Admin : "charged"

graph: Payment Steps
  Charge Card
    -> Send Receipt
  Send Receipt
```

- `{Inner Source} -> Target` — optional form. The edge is declared under the subgraph node; the prefix refines where inside it control leaves.
- The target may still take its own §5.7 `{Inner}` suffix (`{A} -> Sub {B}`), so an edge from an inner node to an inner node of another subgraph falls out for free.

**Resolution & constraints:**

1. The prefix is only meaningful when the **owning node** (the node the edge is declared under) has `expand`.
2. The name inside `{...}` is resolved against the top-level scope of the owning node's expansion (the local `graph:` block or the external file's body).
3. The edge continues to belong to / be declared under the subgraph node — the prefix only refines *where inside it* control leaves. This is single-level: the inner source lives directly in the owning node's expansion (nested paths are out of scope for this version).
4. **Semantics for agents:** control flow leaves the subgraph directly from the named inner node, bypassing the subgraph's normal (inferred) exit.

---

## 6. Expansion

### 6.1 Concept

Any node can be expanded into a graph with more detail. This is the core mechanism for recursive depth. A node with `expand` has user-defined internals; a node without `expand` is a leaf where the LLM decides the implementation.

### 6.2 Expansion Targets

The `expand` property references a graph definition. There are two forms:

#### Local Reference (same file)

References a `graph:` block defined in the same file:

```
Process Payment
  expand: Payment Steps
```

#### External Reference (separate file)

References a graph in another `.flow` file using markdown-style link syntax:

```
Process Payment
  expand: [Payment Processing](checkout/payment.flow)
```

### 6.3 Local Graph Blocks

A `graph:` block defines a reusable graph within the same file. It is the target of a local `expand` reference:

```
Validate Cart
  -> Process Payment : "valid"

Process Payment
  expand: Payment Steps

graph: Payment Steps
  Charge Card
    -> Send Receipt
  Send Receipt
```

Graph blocks can be referenced by multiple nodes within the same file, enabling reuse:

```
Create Account
  expand: Input Validation

Update Profile
  expand: Input Validation

graph: Input Validation
  Check Required Fields
    -> Sanitize Input
  Sanitize Input
```

### 6.4 External Graph Files

When a graph is complex enough to warrant its own file, it is defined in a separate `.flow` file with its own preamble:

```
---
name: Payment Processing
inherits: [Auth, Cart]
description: "Handles card charging and receipt generation"
---

Charge Card
  description: "Calls Stripe SDK to charge the card"
  on_error: -> Handle Charge Failure
  -> Send Receipt

Send Receipt
  description: "Emails order confirmation to customer"

Handle Charge Failure
  -> Retry Charge : "transient error, max 3 attempts"
  -> Escalate to Support : "permanent failure"

Retry Charge
  -> Charge Card
```

### 6.5 Expansion Depth

Expansion is recursive to arbitrary depth. A node inside an expanded graph can itself have an `expand` property, pointing to yet another graph. The implicit rule applies at every level: leaf nodes = LLM decides, expanded nodes = LLM follows.

---

## 7. Error Handling

### 7.1 Concept

Error handling uses the `on_error` property, which can appear on individual nodes or at the graph level in the preamble.

### 7.2 Node-Level Error Handling

A node's `on_error` catches failures specific to that node:

```
Charge Card
  on_error: -> Handle Payment Failure
  -> Send Receipt
```

### 7.3 Graph-Level Error Handling

A graph's `on_error` (in the preamble) catches any unhandled error from any node within the graph:

```
---
name: Payment Processing
on_error: -> Show Generic Error
---

Charge Card
  on_error: -> Handle Payment Failure
  -> Send Receipt

Send Receipt
```

In this example, if `Charge Card` fails, it goes to `Handle Payment Failure` (node-level). If `Send Receipt` fails, it goes to `Show Generic Error` (graph-level fallback).

### 7.4 Bubbling

Error handling bubbles up through graph nesting:

1. If a node has `on_error`, that handles the error.
2. If not, the containing graph's `on_error` handles it.
3. If not, the parent graph's `on_error` handles it.
4. This continues up the expansion tree.

### 7.5 Error Edge Targets

The `on_error` value uses edge syntax:

```
on_error: -> Target Node
on_error: -> Target Node : "with context about the failure"
on_error: [Error Handler](error-handling.flow)
```

---

## 8. Context Providers

### 8.1 Concept

Context providers represent shared state available to nodes within a graph — authentication tokens, user sessions, configuration, etc. They solve the problem of many unrelated nodes needing access to the same data without drawing edges between all of them.

### 8.2 Declaration

Context is declared explicitly at the graph level using the `context` tag in the preamble:

```
---
name: Checkout Flow
context: [Auth, Cart]
description: "Handles checkout"
---
```

Each context name in the list is a provider that all nodes in this graph can read. The `description` field is not used for context declaration — `context` is the single, structured source of truth for what's available.

### 8.3 Inheritance

When a graph is nested inside another (via `expand`), the child graph inherits the parent's context. The exporter auto-generates an `inherits` field in the child's preamble:

```
---
name: Payment Processing
inherits: [Auth, Cart]
---
```

This is **auto-generated on export** — the user does not maintain it. The exporter walks up the graph tree and computes which contexts are available. This ensures the LLM always sees available context at the top of every graph file, even when reading the file in isolation.

### 8.4 Reading Context

All nodes within a graph (and its child graphs) implicitly have read access to inherited context. No explicit `uses` annotation is needed.

### 8.5 Writing Context

If a node **modifies** a context provider, this must be explicitly declared with `updates`:

```
Invalidate Token
  updates: [Auth]
  description: "Revokes the current JWT and clears the session"
```

This is explicit because side effects are important for the LLM to know about — it affects implementation (mutation logic, state management, event dispatching).

---

## 9. Comments

Lines starting with `#` are comments. The LLM ignores them:

```
# This flow handles the main checkout process
# TODO: Review error handling with the team

Validate Cart
  -> Process Payment : "valid"
```

Comments can appear anywhere in the file: before the preamble, between nodes, or after properties. They carry no semantic meaning.

---

## 10. Cross-File References

### 10.1 External Graph References

External `.flow` files are referenced using markdown-style link syntax:

```
expand: [Label](relative/path/to/file.flow)
```

The label is the human-readable name. The path is relative to the current file.

### 10.2 Local Graph References

Local `graph:` blocks are referenced by name:

```
expand: Payment Steps
```

### 10.3 Resolution

When the LLM encounters an `expand` reference:

1. **Local name** — look for a `graph:` block with that name in the current file.
2. **Link syntax** — read the referenced `.flow` file.

---

## 11. `.flow.meta` File Format

The `.flow.meta` file is a JSON file consumed only by the frontend editor. It stores visual metadata that has no semantic meaning for the LLM.

### 11.1 Structure

```json
{
  "canvas": {
    "zoom": 1.0,
    "offsetX": 0,
    "offsetY": 0,
    "theme": "dark"
  },
  "nodes": {
    "Validate Cart": {
      "x": 200,
      "y": 100,
      "color": "#4A90D9",
      "width": 180,
      "height": 60
    },
    "Process Payment": {
      "x": 450,
      "y": 100,
      "color": "#50C878",
      "width": 200,
      "height": 60
    }
  },
  "edges": {
    "Validate Cart -> Process Payment": {
      "waypoints": [[300, 130], [400, 130]],
      "style": "curved"
    }
  }
}
```

### 11.2 Reconciliation

The `.flow` file is the source of truth for what exists. The frontend reconciles `.flow` and `.flow.meta` using structural matching:

1. **Exact name match** — Node name in `.flow` matches key in `.flow.meta` → same node, keep metadata.
2. **Edge-pattern match** — If a name changed but the node has identical incoming/outgoing edges as an orphaned `.flow.meta` entry → likely a rename, transfer metadata.
3. **Orphan detection** — A `.flow.meta` entry with no match in `.flow` and a `.flow` node with no match in `.flow.meta` → pair them if edges match.
4. **Unresolvable** — New nodes get auto-positioned by the frontend. Orphaned metadata entries are cleaned up.

This enables round-trip editing: the LLM can rename nodes, add nodes, or restructure the graph, and the frontend preserves layout where possible.

---

## 12. Complete Example

### 12.1 Root File: `main.flow`

```
---
name: User Authentication App
context: [Auth]
description: "Simple app with login, dashboard, and logout"
---

# Entry point — user opens the app
Open App
  -> Check Session

Check Session
  description: "Reads token from secure storage"
  -> Load Dashboard : "session valid"
  -> Show Login : "no session"

Show Login
  -> Submit Credentials : "user fills form and taps login"

Submit Credentials
  expand: [Login Flow](auth/login.flow)
  -> Load Dashboard : "login success"
  -> Show Login Error : "login failed"

Show Login Error
  description: "Displays error message with retry option"
  -> Show Login : "user retries"

Load Dashboard
  expand: [Dashboard](dashboard.flow)

Logout
  entrypoint: true
  expand: [Logout Flow](auth/logout.flow)
  -> Show Login
```

### 12.2 Referenced File: `auth/login.flow`

```
---
name: Login Flow
description: "Handles credential validation and token generation"
references:
  - [Auth service](src/server/auth-service.ts)
---

Validate Input
  description: "Check email format and password length"
  references:
    - [Credential validators](src/shared/validators.ts:18-64)
  -> Authenticate : "input valid"
  -> Return Validation Error : "input invalid"

Authenticate
  description: "Calls auth API with credentials"
  on_error: -> Return Auth Error
  references:
    - [POST /auth/login handler](src/server/routes/auth.ts:31-77)
    - https://jwt.io/introduction
  -> Generate Token : "credentials valid"
  -> Return Auth Error : "credentials invalid"

Generate Token
  description: "Creates JWT and stores in secure storage"
  -> Return Success
  updates: [Auth]

Return Success

Return Validation Error

Return Auth Error
```

### 12.3 Referenced File: `auth/logout.flow`

```
---
name: Logout Flow
inherits: [Auth]
on_error: -> Force Clear
---

Invalidate Token
  description: "Calls auth API to revoke the token"
  updates: [Auth]
  -> Clear Local Storage

Clear Local Storage
  -> Clear Cookies

Clear Cookies

Force Clear
  description: "Fallback: clears all local state even if API call failed"
  updates: [Auth]
```

### 12.4 Local Graph Example: `dashboard.flow`

```
---
name: Dashboard
inherits: [Auth]
---

Fetch User Profile
  -> Render Dashboard

Fetch Notifications
  -> Render Dashboard

Render Dashboard
  description: "Displays profile, notifications, and quick actions"
  -> Handle Logout Button : "user taps logout"

Handle Logout Button
  expand: Logout Confirmation

graph: Logout Confirmation
  Show Confirmation Dialog
    -> Confirm Logout : "user confirms"
    -> Dismiss : "user cancels"

  Confirm Logout

  Dismiss
```

### 12.5 Edge Data Example

```
---
name: Order Processing
---

Receive Order
  -> Validate Order : "new order submitted"
    data:
      orderId: string
      items: array
      customerEmail: string

Validate Order
  -> Process Payment : "order valid"
  -> Reject Order : "order invalid"

Process Payment
  -> Send Confirmation : "payment success"
    data:
      transactionId: string
      amount: number

Send Confirmation

Reject Order
  description: "Notifies customer with rejection reason"
```

---

## 13. Grammar Summary

```
file          := preamble newline body
preamble      := "---" newline fields newline "---"
fields        := field (newline field)*
field         := key ": " value | key ": " list | preamble_reference_block
preamble_reference_block := "references:" newline (indent "- " reference newline)+
list          := "[" name ("," name)* "]"

body          := (node | graph_block | comment | blank_line)*

node          := name newline (property | edge)*
name          := <text at column 0, no ": " allowed>

property      := indent key ": " value newline | reference_block
reference_block := indent "references:" newline (indent indent "- " reference newline)+
reference     := "[" label "](" target ")" | target
target        := url | path (":" line_range)?
line_range    := number ("-" number)?
edge          := indent ("{" inner_source "}" " ")? "-> " target_node ("{" inner_target "}")? (" : " quoted_label)? newline (edge_data)?
inner_source  := name
inner_target  := name
target_node   := name
edge_data     := indent indent "data:" newline (indent indent indent key ": " type newline)+

graph_block   := "graph: " name newline (node)*

comment       := "#" <any text> newline
blank_line    := newline

indent        := "  " (2 spaces)
quoted_label  := '"' <any text> '"'
```

---

## 14. Reserved Keywords

The format has a minimal set of reserved keywords:


| Keyword       | Where                  | Purpose                                                        |
| ------------- | ---------------------- | -------------------------------------------------------------- |
| `name`        | Preamble               | Node/graph name (preamble equivalent of bare name at column 0) |
| `description` | Preamble, Node         | Free-form guidance text                                        |
| `on_error`    | Preamble, Node         | Error handler reference                                        |
| `expand`      | Node                   | References an expanded graph (not used in preambles)           |
| `updates`     | Preamble, Node         | Lists contexts this node modifies                              |
| `entrypoint`  | Preamble, Node         | Marks node as explicit entry point                             |
| `context`     | Preamble, Node (graph) | Explicit list of context providers this graph declares         |
| `inherits`    | Preamble, Node (graph) | Auto-generated context inheritance from parent graphs          |
| `references`  | Preamble, Node         | Block of links to related source files, documents, and URLs    |
| `data`        | Edge                   | Schema of data passed on this edge                             |
| `graph`       | Body                   | Defines a local reusable graph block                           |


---

## 15. Design Decisions Reference


| Decision          | Choice                                                                            | Rationale                                        |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| Abstraction model | Implicit recursive depth                                                          | Leaf = LLM decides, expanded = LLM follows       |
| Node types        | Inferred from title and structure                                                 | Minimal syntax, natural language                 |
| Entry points      | Inferred from no incoming edges + optional override                               | Structure tells the story                        |
| Edge semantics    | Inferred from labels                                                              | Natural language over symbolic types             |
| Execution order   | Unspecified fan-out = LLM decides                                                 | Consistent implicit philosophy                   |
| Subgraph nesting  | Flat with references                                                              | LLMs parse flat structures better                |
| File splitting    | Heuristic on export, user overrides                                               | Smart default, user control                      |
| Context providers | Explicit `context` tag in preamble, auto-generated `inherits`, explicit `updates` | Structured and parseable, avoids spaghetti edges |
| Error handling    | on_error at graph and node level, bubbles up                                      | Reuses existing concepts                         |
| Node identity     | Names, unique per graph                                                           | No IDs in .flow files                            |
| Visual metadata   | Separate .flow.meta file                                                          | Clean separation, no token waste                 |
| Sync strategy     | Structural reconciliation                                                         | No fragile ID contracts with LLM                 |
| Indentation       | YAML-style, 2-space                                                               | Familiar, shallow nesting                        |
| Edge syntax       | -> Target : "label"                                                               | Compact, colon-space forbidden in names          |
| Subgraph entry targeting | Optional `{Inner}` suffix on the edge target                               | Keeps the edge anchored to the subgraph node while refining the entry point; braces are unused elsewhere, so no new keyword and no collision with the `[](path)` link form |
| Subgraph exit origination | Optional `{Inner Source}` prefix on the edge | Keeps the edge on the parent graph under the subgraph node while refining the exit point; same brace convention as §5.7, no new keyword. |
| References        | `references:` block of `- [Label](target)` entries, one per line                  | Reads well at ten entries, not just one; labels and URLs carry commas, so an inline `[a, b]` list would need escaping. Kinds inferred from the target, keeping with implicit-over-explicit |
| Reference paths   | Relative to the project root, unlike file-relative `expand`                       | Referenced code lives outside the `.flow` workspace; project-relative paths stay stable regardless of `.flow` nesting depth |
| Comments          | # prefix                                                                          | Universal convention                             |
| Versioning        | Defined in spec file, not in individual .flow files                               | Single source of truth, no duplication           |
| Spec location     | Separate file, read once                                                          | No duplication across files                      |


