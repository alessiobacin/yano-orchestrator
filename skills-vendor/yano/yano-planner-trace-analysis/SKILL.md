---
name: yano-planner-trace-analysis
description: Use this skill whenever a Yano agent must inspect trace evidence, operate the trace CLI, record or investigate a task-round failure, or help the planner decide whether to modify an agent, prompt, tool, playbook, or create a new specialist. It is loaded for planner, coder, reviewer, and specialist workers.
compatibility: Requires the global `yano` CLI and its `trace` subcommands. Trace data stays in Yano's global temp store; do not read hidden model chain of thought or invent unavailable telemetry.
---

# Yano trace analysis

Use Yano's trace CLI as the durable bridge between the user's verdict and the
next correction or planning decision. The purpose is not to blame an agent: it
is to find repeatable failure modes in routing, role instructions, capability
coverage, verification, state management, environment setup, or the user's
acceptance criteria.

## CLI contract

Run these commands from the project root. Always use the installed `yano`
binary; if it is not on `PATH`, report that fact and use the repository's
documented development fallback rather than guessing a path.

```text
yano trace status
yano trace feedback --status accepted|partial|rejected --text "<verbatim user verdict>" [--run <id>] [--round <n>] [--task <slug>]
yano trace context --run <id> --round <n> --limit 120 --json
yano trace overview --all-projects --json
yano trace index --project <nome> --run <id> --batch-size 32
yano trace consolidate --project <nome> --run <id> --round <n> --json
yano trace plan --project <nome> --run <id> --query "timeout nella migrazione" --budget 6000 --json
yano trace search --project <nome> --run <id> --query "timeout nella migrazione" --mode hybrid --limit 10 --explain --json
yano trace search --project <nome> --run <id> --query "timeout" --memory-only --limit 8 --json
yano trace opinion --text "<analysis>" --summary "..." --root-cause "..." --recommendation "..." --change existing-agent|new-agent|prompt|tool|playbook|none --confidence low|medium|high --roles planner,coder [--run <id>] [--round <n>] [--task <slug>]
yano trace export --project <nome> --run <id> --output ./trace-bundle.json
yano trace import --project <nome> --input ./trace-bundle.json --reindex
yano pause --project <nome> --run <id> --yes
yano resume --project <nome> --run <id> --yes
yano recovery status --project <nome>
```

Expected behavior:

- `status` reports the active mode and the global trace directory.
- `feedback` appends a durable user verdict and creates a deterministic
  round snapshot. It does not modify source code or task state.
- `context` returns a compact, filtered evidence bundle. Filter by run,
  round and task before reasoning; do not load every project's raw trace into
  the prompt.
- `overview --all-projects` aggregates user verdicts, recurring feedback
  patterns, delegation/timeouts, stalls, orphaned agents, tool failures and
  merge conflicts across projects.
- `index` incrementally embeds the observable trace records selected by the
  filters into Yano's global SQLite semantic index. It uses local Ollama and
  does not replace the JSONL source of truth. Use `--force` after changing the
  embedding model or when deliberately rebuilding a scope.
- `search` embeds only the query, then ranks matching indexed records with
  hybrid semantic/lexical scoring by default (`--mode keyword|semantic|hybrid`).
  Filter by project, run, round, task, instance, type or time window so the
  planner receives only relevant evidence. `--memory-only` searches the
  consolidated layer; `--explain` exposes the semantic, lexical, recency and
  salience components. The compact result omits the stored payload by default;
  add `--include-payload` only when exact event fields are needed. If the index
  is stale or absent, run `index` first. Hybrid mode falls back to keyword
  ranking if Ollama is temporarily unavailable; semantic mode reports the
  embedding error instead.
- `consolidate` derives typed, provenance-preserving memories from raw JSONL:
  episodic summaries, observations, failures and planner opinions, plus
  systemic `trace_pattern` memories when a signal recurs. It writes evidence
  links and compact projections under `temp/traces/<project-key>/projections/`.
  It is deterministic and excludes generated summaries from its input, so it
  can be safely repeated. It requires the configured local embedding model.
- `plan` reports the available raw/memory scope, suggested commands and an
  estimated raw token cost. Use its budget to decide what to retrieve before
  placing trace data in a model context; it does not claim to prove causality.
- `export` creates a portable JSON bundle containing raw records and derived
  index data. `import` restores only raw records as authoritative, skips known
  IDs, and optionally runs `index`; run `consolidate` afterwards to rebuild
  destination-scoped memories and links.
- `opinion` stores the planner's analysis so later planners can compare the
  hypothesis with future outcomes. It is an observation, not an automatic
  authorization to change Yano.
- `pause` creates a non-destructive recovery snapshot under Yano's global
  `temp/recovery/` directory before sending graceful `terminate` messages. It
  preserves the SQLite run/ticket state, Git worktrees, branches, presence
  cards and the filtered observable trace. Without `--yes` it only saves the
  checkpoint and does not stop agents; it never means `end` and never marks a
  run completed.
- `resume` reads the latest snapshot and the durable ticket assignments,
  compares them with the current MQTT presence, and relaunches only missing
  instances. With `--yes` it starts them exclusively in the active Herdr
  workspace and wakes the planner with `--continue`; if Herdr is unavailable
  it stops with an actionable prerequisite error. Without `--yes` it prints
  the exact Herdr launch plan. It does not recreate tickets or delete/reset
  worktrees. Use `--dry-run` for an explicit preview.
- `recovery status` lists available checkpoints. If a project was created with
  an older workspace layout, the command resolves its existing project
  database instead of creating a second one.

Do not use `yano trace clear` during diagnosis. Destructive cleanup is an
operator action and requires explicit `--yes`; preserve evidence until the
investigation is complete.

## Pause/resume protocol

When a terminal, laptop, broker or planner session must be stopped during an
active task, use the recovery protocol before closing the terminal:

```text
yano pause --project <nome> --all --yes
yano recovery status --project <nome>
yano resume --project <nome> --all --dry-run
yano resume --project <nome> --all --yes
```

The planner must treat `runs`, `tickets`, checkpoints and Git worktrees as the
source of truth. A ticket with status `done` is not sent again; a `running`
ticket whose assigned instance is absent is resumed by relaunching that exact
instance, while a pending unassigned ticket remains a planner decision. If a
snapshot is missing, reconstruct the minimal recovery set from active ticket
assignments and the roster, and state that the original presence snapshot was
not available. Never call `yano end` as a substitute for pause: `end` closes a
run and is intentionally irreversible at the orchestration layer.

For explicit operator cleanup, the supported forms are:

```text
yano trace clear --run <id> --yes
yano trace clear --instance <instance> --yes
yano trace clear --before <ISO-8601> --yes
yano trace clear --all --yes
```

`clear` removes matching raw records and derived index documents/memories.
`--all` removes the entire global Yano temp store, including the tracing
configuration; never suggest it as part of ordinary diagnosis.

## Worker protocol: coder, reviewer and specialists

Workers receive this skill to inspect the evidence relevant to their assigned
task and to make their report more diagnostic. They should:

1. use `yano trace context --run <id> --round <n> --task <slug> --json` when a
   correction, review disagreement, timeout or unexpected result needs context;
2. compare the observable events with the requested behavior and state exactly
   what was expected, what happened and which evidence supports the finding;
3. append the finding to the task report and send it to the next responsible
   role, including `run_id`, `round`, `task_slug` and relevant event IDs when
   available;
4. never invent a user verdict, rewrite trace records, delete evidence, or
   use `overview --all-projects` to draw a systemic conclusion on their own.

Only the planner records the cross-project `opinion` and decides whether a
recurring pattern warrants changing Yano. A worker may recommend a likely
cause or intervention in its report, but must label it as an observation and
leave the final systemic decision to the planner.

Workers may use `status`, `context`, `events`, scoped `index`, `search` and
`search --memory-only` to inspect the run they were assigned. They may also
use scoped `consolidate` when a compact report is needed, but should not run
`overview --all-projects` or `consolidate --all-projects` to claim a systemic
finding: cross-project interpretation belongs to the planner.

During a resumed task, coder/reviewer/specialist workers should use the same
skill to inspect the recovery evidence relevant to their ticket, but they must
not independently pause/resume the whole project, mark a run closed, or infer
that an absent retained card is proof that another agent never worked. Report
the observed ticket, worktree and trace evidence back to the planner.

## After a task round

When the user explicitly says the result is accepted, record:

```text
yano trace feedback --status accepted --text "<verbatim acceptance>" --run <run-id> --round <n> --task <slug>
```

When the user says the result is wrong, incomplete, or still broken:

1. Record the user's words as soon as possible with `--status rejected` or
   `--status partial`. Keep the text faithful; do not soften or reinterpret
   the complaint.
2. Run `yano trace context --run <id> --round <n> --task <slug> --json` and
   inspect the relevant tool, delegation, timeout, reviewer, test, worktree
   and response events.
3. Run `yano trace index --project <name> --run <id>` and then
   `yano trace search --project <name> --run <id> --query "<problema>" --json`
   when the filtered context is too broad or the relevant evidence is spread
   across several observable records.
4. Run `yano trace consolidate --run <id> --round <n> --json` after a round
   (or `--all-projects` for a cross-project analysis) to build typed memories,
   provenance links and recurring patterns. Then use `yano trace plan --run
   <id> --round <n> --query "<problema>" --budget <tokens> --json` before
   reading a large trace: start with consolidated memories and request raw
   records only when the evidence is insufficient.
5. Run `yano trace overview --all-projects --json` when the failure may be a
   recurring Yano problem. If the data set is large, use `--since` and
   `--limit` first, then widen the query deliberately.
6. Separate the user's product defect from an orchestration defect. Classify
   the hypothesis as one or more of:
   `requirements_missed`, `wrong_implementation`, `verification_gap`,
   `orchestration_gap`, `missing_capability`, `environment_or_tooling`.
7. Decide the smallest durable intervention:
   - modify an existing role prompt/playbook when the role had the right
     capability but followed an unclear or missing rule;
   - modify a tool, gate, schema or launcher when the system allowed an
     invalid state or hid a failure;
   - add a specialist only when the same distinct capability is repeatedly
     missing across independent projects/rounds and cannot be expressed as a
     rule or existing role responsibility;
   - do not create an agent merely because one worker made a one-off mistake.
8. Save the planner's opinion with `yano trace opinion`, including evidence,
   confidence, affected roles and the proposed intervention.
9. Continue the task using the existing worktree when it is the same task.
   Start a genuine correction cycle with `agent_send(..., new_round: true)`;
   do not hide the rejection by opening an unrelated task or silently
   finalizing the worktree.

## Cross-project learning

An overview is evidence for a change proposal, not proof of causality. Look
for all of the following before recommending a new agent or systemic change:

- the same failure signal appears in at least two tasks or projects;
- the affected role/capability is consistent;
- the failure survives ordinary retries or a reviewer correction;
- an existing prompt, playbook, gate or CLI behavior cannot address it more
  simply;
- the proposed change has a measurable acceptance criterion for a later
  round.

Prefer a short causal chain in the stored opinion:

```text
user verdict → observable trace evidence → failure class → likely Yano cause
→ smallest intervention → validation signal
```

Never claim to have inspected private chain of thought. Use only observable
messages, tool lifecycle, terminal-adapter events, MQTT, Git, SQLite and the
user's explicit feedback.
