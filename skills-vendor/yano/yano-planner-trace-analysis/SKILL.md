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
yano trace search --project <nome> --run <id> --query "timeout nella migrazione" --limit 10 --json
yano trace opinion --text "<analysis>" --summary "..." --root-cause "..." --recommendation "..." --change existing-agent|new-agent|prompt|tool|playbook|none --confidence low|medium|high --roles planner,coder [--run <id>] [--round <n>] [--task <slug>]
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
  cosine similarity. Filter by project, run, round, task, instance, type or
  time window so the planner receives only relevant evidence. The compact
  result omits the stored payload by default; add `--include-payload` only
  when exact event fields are needed. If the index is stale or absent, run
  `index` first.
- `opinion` stores the planner's analysis so later planners can compare the
  hypothesis with future outcomes. It is an observation, not an automatic
  authorization to change Yano.

Do not use `yano trace clear` during diagnosis. Destructive cleanup is an
operator action and requires explicit `--yes`; preserve evidence until the
investigation is complete.

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
4. Run `yano trace overview --all-projects --json` when the failure may be a
   recurring Yano problem. If the data set is large, use `--since` and
   `--limit` first, then widen the query deliberately.
5. Separate the user's product defect from an orchestration defect. Classify
   the hypothesis as one or more of:
   `requirements_missed`, `wrong_implementation`, `verification_gap`,
   `orchestration_gap`, `missing_capability`, `environment_or_tooling`.
6. Decide the smallest durable intervention:
   - modify an existing role prompt/playbook when the role had the right
     capability but followed an unclear or missing rule;
   - modify a tool, gate, schema or launcher when the system allowed an
     invalid state or hid a failure;
   - add a specialist only when the same distinct capability is repeatedly
     missing across independent projects/rounds and cannot be expressed as a
     rule or existing role responsibility;
   - do not create an agent merely because one worker made a one-off mistake.
7. Save the planner's opinion with `yano trace opinion`, including evidence,
   confidence, affected roles and the proposed intervention.
8. Continue the task using the existing worktree when it is the same task.
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
