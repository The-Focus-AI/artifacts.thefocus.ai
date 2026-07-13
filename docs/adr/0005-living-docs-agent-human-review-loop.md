# Living Docs are a first-class collaborative entity, not a kind of Publication

## Status

proposed

## Decision

We are adding **Living Docs**: collaborative Markdown documents an agent publishes so a
human (a **Reviewer**) can edit and comment on them, and the agent can pull that feedback
back to continue the work. A Living Doc is a new first-class domain entity with its own
tables and its own opaque URLs — it is **not** modelled as a variant of Publication.
Publications remain read-only, immutable, static Artifacts; Living Docs are mutable,
versioned, and two-party. Overloading Publication with a `kind` column would have muddied
a concept the glossary deliberately defines as read-only static output.

## The loop

1. An agent publishes a Markdown file as a Living Doc and receives two opaque URLs: a
   read-only **View Link** and a capability **Review Link**.
2. The Reviewer opens the Review Link (no login) and edits the Markdown directly and/or
   attaches **Comments** to spans. Editing is **continuous and autosaved** — there is no
   "submit" step.
3. The agent **pulls** feedback on its next turn via the CLI. Each pull **cuts an immutable
   Version** (numbered snapshot), and returns JSON: the current Markdown, a diff versus the
   previous Version, and the open Comments (each with its anchored span).
4. The agent responds by posting **Suggestions** (span-anchored changes) and Comment
   replies. Suggestions are **never auto-applied**; the Reviewer accepts or rejects each one
   in the editor. Then the loop repeats.

## Considered options and why they were rejected

- **Round-trip mechanism — agent pulls on demand.** Chosen over a server-push/webhook model
  and over full live co-editing (CRDT). An "LLM request" is ephemeral, so feedback must be
  routed into a *new* agent turn; making the agent fetch on its next run matches how agents
  actually execute and needs no live/wakeable endpoint. Push and CRDT can come later without
  changing the data model.
- **Reviewer access — a separate capability Review Link, pseudonymous.** Chosen over
  Publisher-only auth (defeats sharing with a client), invited guest accounts (a whole
  identity subsystem this repo lacks), and making the single URL world-editable (any past
  viewer could edit). The Review Link is a bearer capability, distinct from the View Link.
- **Reconciliation — agent edits land as accept/reject Suggestions, not auto-merged.** Chosen
  over a three-way merge engine (owns hard edge cases) and over freezing the Reviewer's
  editor during a round (breaks continuous editing). The human edits their live doc directly;
  the agent only proposes. This keeps the human in control and means we ship no merge
  algorithm in v1. The asymmetry (human edits directly, agent suggests) is deliberate.
- **Agent contract — CLI subcommands emitting JSON.** `artifacts doc publish|pull|respond`.
  Chosen over an MCP-server-first approach because the product is already CLI-first and
  distributed via npx with token auth; the agent shells out. An MCP wrapper over the same
  API is a later, additive surface.
- **Editor UI — a self-contained static CodeMirror 6 bundle.** Chosen over a React + rich
  structured editor (Tiptap/ProseMirror) SPA, which would introduce a framework and build
  pipeline the repo does not have. The static bundle (CodeMirror + markdown-it preview +
  comment sidebar) fits the existing static-serve-plus-serverless model; tracked-change
  Suggestions are hand-rolled on top.

## Consequences

- New relational data in Neon: a Living Doc, its ordered Versions, its Comments, and its
  Suggestions. Markdown snapshots are small text and can live in Postgres rather than Blob.
- The Review Link is a bearer capability: anyone holding it can edit. Abuse/rate-limiting and
  Reviewer attribution beyond an optional display name are explicitly out of scope for v1.
- Living Docs reuse the existing opaque-URL scheme and Removal concept, but not the Revision
  Window (which is a Publication update-coalescing mechanism and does not apply here).
