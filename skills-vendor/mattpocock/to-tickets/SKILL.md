---
name: to-tickets
description: Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker — edges as text in one file per ticket locally, or native blocking links on a real tracker.
disable-model-invocation: true
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet
vertical slices, each declaring the tickets that **block** it.

The issue tracker and triage label vocabulary should have been provided to you.
If not, tell the user to run `/setup-matt-pocock-skills`.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a
reference (a spec path, issue number or URL), fetch it and read its full body
and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current
state. Ticket titles and descriptions should use the project's domain glossary
and respect ADRs in the area being changed.

Look for prefactoring opportunities that make implementation easier. Make the
change easy, then make the easy change.

### 3. Draft vertical slices

Break the work into **tracer-bullet** tickets:

- each slice cuts a narrow but complete path through every required layer;
- each completed slice is demoable or verifiable on its own;
- each slice fits in a single fresh implementation context;
- prefactoring is sequenced before the slices that need it.

Wide mechanical refactors are the exception. Sequence them expand → migrate in
green batches → contract, with each migration ticket blocked by the expand
ticket and the contract ticket blocked by every migration batch.

Give every ticket its **blocking edges**. A ticket with no blockers can start
immediately.

### 4. Validate the breakdown with the user

Present the proposed breakdown as a numbered list. For each ticket show:

- **Title**: short descriptive name;
- **Blocked by**: tickets that genuinely gate it;
- **What it delivers**: the end-to-end behavior it makes work.

Ask whether the granularity is too coarse or too fine, whether the blocking
edges are correct, and whether tickets should be merged or split. Iterate until
the user approves the breakdown. This validation is part of planning, not a
substitute for the later reviewer.

### 5. Publish the planning artefacts

Publish the approved tickets to the configured tracker. With the local tracker,
write one file per ticket under `.scratch/<feature-slug>/issues/`, numbered from
`01` in dependency order, blockers first. Do not create one combined ticket
file and do not close or modify a parent issue.

Yano integration rule: these Markdown tickets are the human-readable planning
artefact. After approval, the planner must translate each file into exactly one
SQLite `ticket_create` record, preserving title, acceptance criteria,
`depends_on`, phase and required role/capability. SQLite/DAG is the only runtime
source of truth for claims, readiness, progress, recovery and completion; the
Markdown files are not a second scheduler.

Work the dependency frontier: tickets whose blockers are all complete are
ready, while blocked tickets remain blocked until their SQLite dependencies are
satisfied.

## Local ticket template

```markdown
# <NN> — <Ticket title>

**What to build:** the end-to-end behavior this ticket makes work.

**Blocked by:** the numbers/titles of gating tickets, or "None — can start immediately".

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
```

Avoid specific file paths or code snippets in ticket prose because they go
stale. Include a precise state machine, schema or type shape only when it
captures a decision that prose cannot express clearly.
