---
name: yano-cli
description: Use this skill whenever a Pi/Yano agent must understand, explain, inspect, or execute the Yano CLI. It maps natural-language requests to safe commands for project initialization, Herdr launches, global active-project counts, agent inventories, watcher/architect/debugger/auto-improver/suggester status, trace analysis, recovery, repair, playbooks, global configuration, data migration, diagnostics, and dashboards.
compatibility: Requires the globally installed `yano` CLI and a project root when a command is project-scoped. Herdr is the supported workspace and terminal runtime for Yano agents.
---

# Yano CLI

This skill teaches an agent how to turn a semantic request into an observable,
scoped Yano CLI operation. It is shared by every Yano role. The role prompt,
not this skill, still decides whether the agent may modify code, start a
worker, change configuration, or ask the user for approval.

## First rules

1. Interpret the user's intent before choosing a command. State the project
   root, the operation, and whether the command is read-only or mutating.
2. Use the installed `yano` executable. If a flag or subcommand is uncertain,
   run `yano --help` and then the relevant `<command> --help`; never invent a
   command from memory.
3. Run from the project root or pass `--project-root <absolute-path>`. Keep
   the derived project scope consistent across all collaborating agents.
4. Prefer `--json` for evidence that another agent must parse. In a report,
   preserve the command, exit status, relevant JSON fields, and timestamps.
5. Read-only inspection is safe to perform proactively. Before starting,
   repairing, changing global configuration, importing/removing playbooks, or
   deleting trace data, obtain explicit user authorization unless it was
   already given in the current request.
6. Never print, copy, or include secret values in a prompt or report. Use
   `yano config set KEY --stdin` for tokens and API keys; `yano config list`
   masks secret values.
7. Yano agents must not infer hidden model reasoning. Use visible responses,
   tool metadata, MQTT events, Herdr state, reports, and trace records as the
   evidence boundary.
8. External observer agents are read-only with respect to the watched
   application. They may report findings to the planner, but must not edit the
   application, create its operational tickets, commit, or deploy.

## Semantic intent map

Use the smallest command that answers the request. Typical translations are:

| User intent | Command | What to inspect |
| --- | --- | --- |
| How many Yano projects are active right now? | `yano projects --json` | `project_count`, `projects`, `herdr_reachable` |
| Is the watcher active for this project? | `yano watcher projects --project-root "$PWD" --json` | `active_projects`, `status`, `instance`, `workspace`, `tab_id` |
| Which projects does the watcher control? | `yano watcher projects --all --json` | `projects`; `--all` includes registered/offline records |
| Which external workers are active? | `yano architect projects`, `yano watcher projects`, `yano debugger projects`, `yano auto-improve projects`, `yano suggester projects` | Herdr-live rows are authoritative; registrations are context |
| What agents are live in this project? | `yano fleet --project-root "$PWD" --json` | live MQTT/Herdr agents; stale retained cards are excluded |
| Open the Gantt for this project | `yano gantt --project-root "$PWD" --persistent --open` | URL and automatically selected free port in `10000-19999` |
| Recover the current or all persistent Gantt links | `yano gantt --link --json` or `yano gantt --links --json` | registered URL, project root and live/stopped status |
| Is Yano ready? | `yano doctor --network` and `yano deps --json` | broker, Git, Pi, CLI, credentials and capability checks |
| Initialize a new or existing repository | `yano init --name "<name>"` (or `--no-git` for a conversation-only folder) | Existing application files are preserved; only missing Yano infrastructure is added |
| Initialize and open Herdr with planner | `yano init --name "<name>" --herdr` | Herdr workspace, root pane, and `planner-01` launch |
| Start an agent | `yano start --instance <id> --role <role>` | composed Pi command, role, trace mode, project scope |
| Check or change trace capture | `yano trace status`, `yano trace enable --mode full` | global per-user data root and effective mode |
| Investigate a specific failure | `yano trace context ... --json`, then `yano trace search ... --mode hybrid --json` | filtered evidence before broad history |
| Pause and resume work | `yano pause ... --yes`, then `yano resume ... --yes` | checkpoint, assignments, missing agents; never use `end` as pause |
| Reconcile stale or missing agents | `yano repair --dry-run`, then `yano repair --yes` | proposed snapshot/restart/cleanup plan before applying it |
| Apply a Yano update to live instances | `yano update --reload --dry-run`, then `yano update --reload --yes` | controlled checkpoint restart, not in-process hot reload |
| Find or inspect a playbook | `yano playbook list`, `show`, `candidates`, `agent show` | catalog source, requirements, roles and missing credentials |
| Configure a missing requirement | `yano config set <KEY> <value>` or `... --stdin` | global per-user config path, never application `.env` for global installs |
| Check/install this skill in local harnesses | `yano skills status --json`, then `yano skills install` | Claude Code/Codex/Pi catalogs and Pi's shared discovery roots |

When the agent is already running from the project directory, the shorter
equivalent is `yano gantt --persistent --open`. The explicit
`--project-root "$PWD"` form is preferable when a command is launched from a
different directory.

For a complete command and option reference, read
`references/command-reference.md` only after the intent is known. This keeps
normal prompts small while retaining the full CLI contract for unusual cases.

### Global active-project inventory

For the question “quanti progetti Yano sono attivi adesso?”, use exactly:

```text
yano projects --json
```

This is a read-only Herdr inventory. `project_count` counts distinct project
roots that currently have at least one live Pi/Yano agent; `projects` lists the
deduplicated roots and their live agents. It includes normal project agents
such as planners, coders and reviewers, as well as external workers, but it
does not count stale/offline panes, retained MQTT cards, or a Codex/other
non-Pi terminal merely because it is open. If `herdr_reachable` is false, the
count is unknown and must not be reported as zero.

Do not substitute `yano watcher projects`, `yano architect projects`, or the
other `*_projects` commands: those are intentionally limited to one external
worker role. Do not substitute `yano repair --all-projects` either: repair is a
reconciliation preflight and may include roots that are repair candidates,
not a live-project count.

## Global harness installation

The package installs this skill through the deterministic installer during a
global npm installation and repeats the check during `yano init` and `yano
update`. The installer detects Claude Code, Codex and Pi from their executable
and user configuration directories. It uses one copy per independent catalog:

- Claude Code: `~/.claude/skills/yano-cli`;
- Codex: `~/.codex/skills/yano-cli` (or `$CODEX_HOME/skills/yano-cli`);
- Pi: `~/.pi/agent/skills/yano-cli` only when Pi does not already discover one
  of the other selected catalogs through `settings.json`.

Use `yano skills status --json` to inspect the plan. `yano skills install
--dry-run --json` previews it. Identical duplicate copies in a Pi-discovered
root are moved to the Yano data-root backup; unmanaged or locally modified
copies are reported as conflicts and are never removed automatically.

## External worker status

The canonical status commands are:

```text
yano architect projects [--all] [--project-root <dir>] [--json]
yano watcher projects [--all] [--project-root <dir>] [--json]
yano debugger projects [--all] [--project-root <dir>] [--json]
yano auto-improve projects [--all] [--project-root <dir>] [--json]
yano suggester projects [--all] [--project-root <dir>] [--json]
```

Interpret the result carefully:

- `active_projects` contains workers whose live Herdr/Pi presence is
  currently observed.
- `registered_projects` may include an offline, paused, stopped, or proposal
  record. It is not proof that a process is running.
- `status: idle` means the worker process is alive but not currently using
  model work; for Watcher, the zero-token polling process may still be alive.
- Herdr reachability is reported by `herdr_reachable`. If it is false, state
  that live activity cannot be confirmed instead of claiming that no worker
  exists.
- `workspace`, `tab_id`, `pane_id`, and `instance` identify where a user can
  inspect the worker. The canonical external tabs are named
  `<role>-<project-name>`.

## Safe execution protocol

For every semantic request, produce this compact record before or alongside
the command result:

```text
Intent interpreted: <what the user wants>
Project: <absolute root and derived project name, if applicable>
Operation: read-only | reversible action | destructive action
Command: <exact command>
Evidence: <JSON fields, event IDs, paths, timestamps>
Result: <what actually happened>
Next safe step: <only if useful>
```

If the request says “controllare”, “verificare”, “dove”, “quali”, or “è
attivo”, begin with a read-only command. If it says “avviare”, “riparare”,
“aggiornare”, “configurare”, “importare”, or “promuovere”, show the planned
mutation and ask for confirmation if authorization is not explicit.

## Common workflows

### Existing repository

An existing `package.json`, source tree, or Git repository does not mean the
repository is already initialized for Yano. From that repository:

```text
yano init --name "my-project"
yano doctor --network
yano trace enable --mode full
yano start --instance planner-01 --role planner
```

Use `yano init --herdr` when the user wants the workspace and planner opened
automatically. `--target` is for scaffolding another directory; in-place
initialization is the normal path for a non-empty existing repository.
For a conversation-only test folder, use `yano init --name "conversation-test"
--no-git`: Yano configuration is scaffolded, but no Git repository is created;
this mode must not be used for a later worktree-based delivery.

### Diagnose a worker or routing problem

```text
yano fleet --project-root <dir> --json
yano watcher projects --project-root <dir> --all --json
yano trace events --project <name> --instance <instance> --since <ISO> --limit 100 --json
yano trace context --project <name> --run <id> --round <n> --task <slug> --limit 120 --json
yano repair --project-root <dir> --dry-run
```

Use `yano repair --yes` only after reviewing the dry-run. It saves a recovery
snapshot and reconciles canonical agents; it does not repair application
logic. If the project database is absent and the user explicitly asks to
prepare it, `yano repair --yes --init-db` is idempotent and non-destructive.

### Watcher validation

`--lookback-ms` is the history window inspected by a scan; it is not the
polling interval. `--interval-ms` controls repeated scans. `--once` performs
one bounded scan and exits; it is the preferred test mode.

`--help` is read-only for `yano watch` and for every `yano watcher` registry
subcommand: it prints usage before opening the broker or changing the registry.
On a freshly scaffolded project without `orchestrator.db`, an ordinary
continuous watcher records a `waiting` scan with reason `not_initialized` and
stays alive for the next polling interval without raising a validation error.
An explicit validation context (`--validation-run`, `--playbook-proposal`,
`--playbook-id`, round or checksum) records `blocked` and follows the
validation escalation path. Neither mode should be mistaken for a dead Herdr
worker.

```text
yano watch --project-root <dir> --lookback-ms 3600000 --once
yano watch --project-root <dir> --lookback-ms 3600000 --interval-ms 600000 --away --context-compact-ratio 0.82
yano trace events --project <name> --instance yano-watcher --type yano_watcher_scan --limit 20 --json
```

The `yano_watcher_scan` event records start/end timestamps, duration, status,
lookback, interval, findings, stalls, and live-agent counts. A quiet scan is
not evidence that the worker tab is absent; inspect the event and Herdr status.
Each agent trace also records bounded `context_usage` metadata (effective
tokens/window/ratio, serialized size and entry count). Above the configured
ratio (default `0.82`, override with `--context-compact-ratio` or
`YANO_WATCH_CONTEXT_COMPACT_RATIO`) the watcher sends a control request to the
agent, which invokes Pi native `ctx.compact()` and records
`context_compaction_completed` or `context_compaction_failed`. This is
playbook-agnostic and preserves Yano's SQLite state while the session resumes.

When a conversation trace contains a planner consultation with
`conversation-researcher`, the watcher also performs a deterministic policy
check. It records `yano_watcher_conversation_check` with `status: healthy` or
`violation`, flags forbidden delivery tools, mutating shell commands, and
failed specialist launches as `conversation_policy_violation`, then routes a
deduplicated corrective notice to a live planner (or Telegram). Read-only
commands such as `curl`, `grep`, `git status`, and `yano trace` are accepted.

When the trace contains an explicit `debate`/`dibattito` intent, the watcher
applies a separate `debate` contract check. It records
`yano_watcher_debate_check` and raises `debate_policy_violation` when the
planner delegates to `conversation-researcher`, completes without at least
two `debater` instances, or completes without a `yano model-advisor recommend`
proposal. A debate trace is not reported as a healthy conversation trace just
because the unrelated researcher stayed read-only; the debate-specific finding
is routed to the live planner (or the configured escalation path).

The planner must call `orchestrator_init` before any debate framing or agent
launch. If a debate trace exists while `orchestrator.db` is missing, the
watcher records `missing-orchestrator-init` instead of treating the project as
an ordinary uninitialized conversation. A `yano model-advisor` `pinned_id`
such as `z-ai/glm-5.3-flash@openrouter-glm` is an llmProxy catalog pin, not a Pi
provider: launch Pi with `--provider llmproxy --model
'z-ai/glm-5.3-flash@openrouter-glm'`, never `--provider openrouter-glm`.
If the trace contains a 4xx/5xx from the pinned model, the watcher also emits
`model-runtime-fallback`; the planner must report and verify the fallback.

The debate playbook has a human gate before launch: the planner must present
the topic, roster, stance and exact `model@provider-id` for every debater, ask for
confirmation, and apply any requested roster/model changes before starting
agents. The planner must not call `yano start`, `herdr agent start`,
`agent_send` or `agent_await` before that confirmation. When a legitimate
specialist is offline, `agent_list` is only the live-presence check; inspect
the project-scoped Pi sessions and use a supported `--session`/`--continue`/
`--resume` option when available, otherwise launch a fresh compatible session.

### Delegation liveness and recovery

Before every `agent_send`, inspect the destination's live presence. Yano now
enforces this in the common transport: a live destination receives the command;
an offline destination is rerouted to a live planner. If no planner is live,
the message is retained on the project's watcher fallback channel. The
persistent watcher starts or reopens `planner-01`, then forwards the original
message while preserving the intended target, sender and assignment ID. A
watcher is registered only through an explicit watcher command for the
selected project/options; `yano start` does not start one implicitly. Agents
must not silently continue after a missing recipient: the routing result and
fallback path must be reported to the planner.
The same router is used by the `debugger`, `suggester` and `auto-improver`
registry services for their planner handoffs.
The global npm installation installs the one-minute external self-heal; it runs
`yano watcher supervise`, which checks every registered running watcher and
relaunches dead Herdr panes while respecting explicit pauses. Install or repair
it manually with `yano watcher cron install` and inspect it with `yano watcher
cron status`.

In persistent mode the watcher keeps its MQTT subscription open in addition to
polling at `--interval-ms`. A `run_completed` event or a planner's completed
turn triggers one extra `--once` scan immediately; this final scan is recorded
as a normal `yano_watcher_scan` with `once: true`, while the regular cadence
continues afterward.

### Trace investigation

Start narrow and expand only when needed:

```text
yano trace status
yano trace events --project <name> --since <ISO> --limit 50 --json
yano trace search --project <name> --query "<failure description>" --mode hybrid --limit 10 --explain --json
yano trace context --project <name> --run <id> --round <n> --task <slug> --json
yano trace overview --all-projects --json
```

Use `index` before semantic search when the index is absent or stale, and
`consolidate` when a compact memory/projection is needed. Use `feedback` only
for the user's actual verdict and `opinion` only for a clearly labelled
planner hypothesis. Never clear trace data during diagnosis.

### Playbook and capability requirements

```text
yano playbook list --json
yano playbook candidates --task "<user task>" --project-root <dir> --json
yano playbook show <id> --json
yano playbook show clean-repo --json  # verifica anche il contratto documentale
yano agent show <role> --json
yano playbook check <file> --json
```

Read `credential_checks` and `warnings`. If a required CLI, MCP, skill, token,
or API key is missing, tell the user exactly what is missing and show the
installation/configuration command returned by Yano. Do not claim that the
playbook is operational until its readiness gate passes. Import, provisioning,
and promotion are Architect-controlled operations.

### Global configuration and data

```text
yano config path
yano config list --all
yano config get YANO_DATA_DIR
yano config set YANO_TRACE_MODE full
printf '%s' "$TOKEN" | yano config set TELEGRAM_BOT_TOKEN --stdin
yano data path
yano data migrate --dry-run
```

`yano config` writes a per-user global file; it is not part of the npm package
and is independent of the development checkout. `YANO_DATA_DIR` is optional:
Yano selects the platform default when it is omitted. Do not use a project
`.env` as a substitute for the global config when documenting a global-only
installation.

## Role boundaries

- Planner: may inspect fleet, worker status, trace, catalog and recovery;
  coordinates user approval and delegates project changes.
- Architect: owns playbook/agent assessment, capability readiness, import,
  provisioning, revision and promotion.
- Watcher, debugger, auto-improver, suggester: inspect and report within their
  separate read-only contracts; they do not mutate the reference application.

`yano auto-improve` costruisce un evidence pack bounded: considera sia gli
script dichiarati sia i marker del repository per test/build/lint, quindi non
deduce l'assenza di test dalla sola mancanza di `package.json.scripts.test`.
Ogni audit richiede inoltre una valutazione 360° della capability principale
contro almeno tre alternative, con fonti ufficiali HTTPS, gap su feature,
UX, LLM/agent, tool/API, MCP, connettori e plugin; il worker usa per questo
`auto_improve_web_search` e `auto_improve_web_fetch` in sola lettura.
Ogni audit deve partire da un transcript Pi nuovo: la tab Herdr può essere
riusata, ma non si deve passare `--continue` a un auto-improver. Il launcher
deve anche usare la allow-list read-only con `auto_improve_complete` come unica
scrittura autorizzata del report globale, senza `bash`, `edit` o `write`.
- Coder/reviewer/specialists: use scoped trace evidence for their assigned
  task and do not make cross-project conclusions from raw history.

The CLI can be used by any role, but a command being documented here does not
grant that role permission to perform it. If the role cannot perform an
operation, report the exact command for the planner or user instead.

The watcher supervisor also reconciles registered project SQLite runs. After a
Herdr/process loss it recreates the workspace and `planner-01` for every
non-finalized run, then sends a recovery prompt with trace, ticket and worktree
context. Once all runs are finalized it closes that project's watcher tab.
