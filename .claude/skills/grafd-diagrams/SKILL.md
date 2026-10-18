---
name: grafd-diagrams
description: Create or edit Grafd `.flow` diagrams that read well at a glance — process flows, user journeys, state machines, system architecture, decision trees. Use whenever asked to diagram, map, chart or visualize a flow, system or process as a .flow file, or to add to or restructure an existing .flow graph. Works in any repo: it sets up a Grafd workspace when there is none.
---

# Grafd diagrams

You write the meaning; the `grafd` tools do all the geometry. Never hand-place nodes.

`grafd` = `npx --yes grafd-ai` (inside the grafd repo itself: `node dist/cli-main.js`). A workspace is
the folder holding `grafd.manifest.json` (usually `.grafd/`). `lint`, `layout` and `score` take the
workspace folder; `style` and `render` take a file. You need nothing else: don't read
SAVE-GUIDE.md, FLOW-SPEC.md or any `.canvas.json`.

## Setup (no workspace yet)

If neither `.grafd/` nor the repo root holds a `grafd.manifest.json`, run `grafd init` from the
repo root; the workspace `W` is then `.grafd`. Its `main.flow` is a placeholder (`name: My Flow`,
one `Start` node) and the file the editor opens first: write the first diagram over it, and give
later diagrams their own files. When done, tell the user `grafd start --open` shows it in the editor.

## The loop (new graph)

1. **Write the `.flow`** — semantics only, no `id`/`pos` lines (format and rules below).
2. **One command** does the rest (`&&`-chained so it stops at the first failure):
   ```
   grafd lint W && grafd style F --infer --role="Orders DB=datastore" --role="Stripe=external" && grafd layout W --all && grafd score W
   ```
   Add `--graph="<block>"` to a second `style` call for each `graph:` block. Add
   `--direction=TB` to `layout` for decision trees and layered architecture.
3. **Read the score.** Aim for ≥ 90 on every graph. Findings after `--all` mean the *structure*
   is tangled — fix the graph (fewer back edges, a split, a better order), not coordinates.
4. **Look once:** `grafd render F --theme=grafd-light --out=<tmp>/x.png` (add `--graph=<block>`
   for a subgraph), then view the image. Check it tells the story: clear start, readable main path,
   sensible shapes. Fix what's wrong and re-run step 2.

Done = lint 0 errors, every graph scores ≥ 90, render looked at. Then stop: don't chase the last
few points, keep variants or back up files. Report the file path, not the file contents.

## Format essentials

```
---
name: Checkout
description: "Web checkout, from cart to confirmed order"
---

context: Session
  description: "Signed-in customer and their cart"
  nodes:
    - Review Cart
    - Cart Valid?
    - Fix Cart
    - Enter Shipping

Review Cart
  -> Cart Valid?

Cart Valid?
  -> Enter Shipping : "yes"
  -> Fix Cart : "no"

Fix Cart
  -> Review Cart

Enter Shipping
  -> Take Payment

Take Payment
  expand: Take Payment
  on_error: -> Payment Failed
  -> Create Order

Create Order
  -> Orders DB
  -> Send Receipt

Send Receipt

Orders DB

Payment Failed
  -> Take Payment : "retry"

graph: Take Payment
  Choose Method
    -> Authorize Card

  Authorize Card
    -> Approved?

  Approved?
    -> Capture Funds : "yes"
    -> Choose Method : "declined"

  Capture Funds
```

- A node is a name at column 0 (or 2 inside a `graph:` block); properties and edges indented 2
  more. Edge: `-> Target` or `-> Target : "label"`. One blank line between nodes.
- Names are unique per graph and never contain `: `, `"`, `{` or `}`, or start with `#`.
- `expand: Block` points at a `graph:` block in the same file, named like the node (or
  `expand: [Label](other.flow)` for another file). The node draws as a box you can open.
- `on_error: -> Node` sends any failure of that node to Node (in the preamble: the whole graph).
- `context:` blocks list member nodes of the same graph; they draw as a frame around them. Never
  give a `context:` block a `pos`.
- Every edge target must exist in the same graph. Declare leaf nodes too (`Send Receipt`).

## Design rules — what makes it read well

- **Size.** 4–10 nodes per graph, 12 at most, and a main path of at most 7 steps (a longer one
  renders as an unreadable strip). Beyond that, fold each phase into one node with `expand:` and a
  `graph:` block. Hierarchy beats sprawl.
- **Order.** Declare nodes in the order the flow runs, the happy path first, branches after the
  node they leave. The layout reads your order.
- **Names.** 1–3 words. Steps are verb + noun ("Charge Card"); things are nouns ("Orders DB",
  "Stripe"); decisions are short questions ("Card Valid?"). No numbering, no "Step 1".
- **Labels.** Label every edge leaving a decision, in 1–2 words ("yes"/"no", "valid"/"expired").
  Leave sequential edges unlabelled. Label a loop with why it loops ("retry").
- **Descriptions** are drawn inside the node and make it bigger. Leave them out unless the name
  can't carry something essential; then ≤ 8 words.
- **Outcomes vs failures.** An expected outcome the flow handles — card declined, check failed,
  consent denied — is a decision with labelled exits. `on_error` is only for unexpected failures
  (timeouts, crashes, provider down), and never alongside a labelled edge to the same node.
- **Loops.** At most two back edges per graph. More loops mean the graph wants a split.
- **Shared exits.** At most two edges from different steps converge on one node. An exit most
  steps share — any step can fail, any user can drop off, any order can be cancelled — is not
  drawn from each. Draw it from the one or two steps where it matters most, and say in the graph's
  `description` that it applies throughout — or give the steps it applies to a `context:` region
  whose description names the exit.
- **Stores and outside systems** are leaves hanging off the step that uses them; the main path
  never runs *through* a database.
- **Regions** (`context:`) only for real shared state over a *consecutive* stretch of the flow,
  at most two per graph. Non-consecutive members break the main path apart.
- **Endings.** Every path ends somewhere meaningful: an end node per outcome, never a dangling
  step.

## Per diagram type

| Type | `layout` | Nodes | Edges and labels | Roles to name |
|---|---|---|---|---|
| Process, journey, pipeline | default (LR) | steps; decisions as questions | label decision exits only | `io` for what a user enters or sees, `event` for the trigger |
| State machine | `--direction=TB` | states, in lifecycle order (nouns/adjectives) | every edge labelled with its event | `--role=<state>=process` for each state with several exits, or `--infer` draws it as a diamond |
| Architecture | `--direction=TB` | components: clients top, services middle, stores bottom | label each with the kind of traffic ("HTTPS", "reads", "publishes") | `external` clients and third parties, `datastore` DBs, caches, queues |
| Decision tree | `--direction=TB` | questions, then outcomes as leaves | one labelled exit per answer | none: `--infer` does it |
| Runbook, long process | default | top graph = phases (4–8), each `expand:`ed | label loops between phases | as for a process |

Point repeated outcomes at one shared leaf rather than copying it.

## Roles

`--infer` reads start, end, decision, error and process off the structure. Name the rest yourself
with `--role="Name=role"`: `datastore` (cylinder: DB, cache, queue, file), `external` (hexagon:
a third-party system or actor), `io` (parallelogram: user input or output), `event` (ellipse: a
trigger such as "Order Placed"). Explicit roles always win; `--infer` never overrides a shape
already chosen.

## Editing an existing graph

The user's layout and styling are theirs. Never change a `pos:` or `id:` line that was there
before you started, and never restyle their nodes.

- Add new nodes without `id`/`pos`; keep everything else as written (renaming keeps the id).
  Removing a node: delete it and every edge to it.
- Then: `grafd lint W && grafd style F --role="New Node=decision" … && grafd layout W && grafd score W`.
  Style **only the new nodes, by explicit `--role`** — no `--infer`, which would reshape the
  user's nodes too. Plain `layout` places the new nodes beside what they connect to, already
  stepped clear of edges and labels; don't position them by hand.
- Never `layout --all` unless the user asks to re-arrange, whatever `score` suggests.
- Findings between the user's own nodes were there before you; leave them. If a new node is still
  in a finding, restructure (order, a merged step) rather than nudging coordinates.

## Cost discipline

- Write the whole file in one go; change it with targeted edits, not rewrites.
- The tools rewrite the file (ids, positions). Re-read it only when you must edit it next.
- Read the plain-text `score` output; don't use `--format=json`.
- Render and look once at the end, plus once after a fix if the first look found a problem.
