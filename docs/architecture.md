# Yano Orchestrator Architecture

This document is the human-readable companion to [`architecture.mmd`](./architecture.mmd), the Mermaid source diagram for the current system.

## Purpose

Yano Orchestrator coordinates independent `pi` processes working on one project. The planner owns decomposition, phase progression and final integration. Workers operate in isolated Git worktrees and communicate through a project-scoped MQTT 5 namespace.

## Runtime boundaries

```text
User
  │
  ▼
yano CLI ── scaffolding / launch / diagnostics / dashboard
  │
  ▼
pi planner ── reads prompts + agents/roles.yaml
  │
  ├── MQTT broker: presence, commands, responses, events
  ├── SQLite: runs, specs, tickets, dependencies, holds, evidence, outbox
  ├── Git: per-task worktrees, commits and reviewed merges
  └── optional adapters: WhatsApp, MCP, effect delivery, browser tooling
```

Every instance has an `instance`, `role`, `project` and `team` identity. MQTT topics are scoped as `pi/<project>/...`, so two projects sharing a broker remain isolated unless the operator deliberately passes the same `--project` value. `yano start` resolves the root identity and passes the derived scope explicitly to the child `pi` process, so an auto-loaded extension from a different installation cannot silently choose a shared/default namespace. The runtime also validates both the status topic and the `project` field in every retained presence card before adding it to the roster. An explicit scope override is reported at startup when it differs from the scope derived by the current project root; all instances that must collaborate must use the same value.

## Main flow

1. `yano init` validates Node, Pi-facing prerequisites, MCP configuration and broker availability before writing a scaffold. Older projects whose roster is still under `.pi/agents/` remain launchable; the launcher selects that directory explicitly instead of assuming the modern root `agents/` layout.
2. `yano start` launches any configured role. The trace-analysis skill is attached to every worker; planner-only vendor skills remain restricted to the planner, and browser skills remain restricted to frontend roles.
3. The planner creates or reuses a Git worktree, initializes the persistent workspace and declares a phase plan.
4. `agent_send` routes work by instance or role. Presence is advisory but immediately warns when no live target is available. Structured phase gates can refuse sends to locked phases.
5. Coder, reviewer and specialists append evidence to the task report. File claims prevent simultaneous edits to the same shared file.
6. Ticket/DAG and Playbook state are persisted in SQLite. Generation fencing, idempotency keys and the effect outbox make retries resumable.
7. The planner advances phases and runs the mandatory closing evidence checklist before `worktree_finalize` merges the reviewed branch.

## Persistence model

The workspace lives under `.pi/extensions/yano-orchestrator/`:

- `orchestratorStorage/orchestrator.db`: SQLite state and audit history;
- `config/project.json`: project identity and schema metadata;
- `reports/`: task reports and round evidence;
- `<yano-install>/temp/traces/<project-key>/events/`: global per-instance trace JSONL, outside the project checkout;
- `specs/`, `playbooks/`, `diagrams/`, `knowledge/`, `policies/`, `artifacts/`: project-scoped working artifacts.

The database is intentionally local to a project. MQTT provides fast coordination, while SQLite is the durable source for recovery, status, evidence and outbox state.

### Global tracing

Yano's forensic trace is stored under `temp/` in the installed Yano package,
not under the project. `YANO_DATA_DIR` (or `YANO_TEMP_DIR`) can override this
location when the global package directory is read-only. The CLI controls the
capture policy:

```text
yano trace status
yano trace enable --mode events|standard|full
yano trace disable
yano trace feedback --status rejected --text "<verdetto utente>" --run <id> --round <n> --task <slug>
yano trace context --run <id> --round <n> --task <slug> --json
yano trace index --project <name> --run <id>
yano trace consolidate --project <name> --run <id> --round <n>
yano trace plan --run <id> --query "<problema>" --budget 6000 --json
yano trace search --project <name> --run <id> --query "<problema>" --json
yano trace export --run <id> --output ./trace-bundle.json
yano trace import --input ./trace-bundle.json --reindex
yano trace opinion --text "<analisi planner>" --change prompt --confidence medium
yano trace overview --all-projects --json
yano trace clear --run <run-id> --yes
yano trace clear --all --yes
```

The project key is derived from the canonical workspace path, while human
project names and MQTT scope overrides are aliases. Legacy name-scoped trace
directories remain readable after upgrades. `yano start` defaults to `full` and
records a preflight event with the expected/actual trace mode, data directory
and runtime version.

`events` records lifecycle and coordination metadata, `standard` also stores
visible assistant responses and tool metadata, and `full` stores the visible
session branch as well. Data is redacted before persistence and tracing is
best-effort: a logging failure must never stop the agent. Hidden model chain of
thought is not available to this system; the trace contains observable agent
messages, tool lifecycle and events supplied by MQTT, Git, filesystem and
terminal adapters when those adapters are active.
The operational SQLite database remains project-local because it is the
orchestrator's live state, not forensic trace data.

The optional semantic layer is stored at `<yano-install>/temp/semantic-index.sqlite`.
`yano trace index` incrementally embeds observable trace records through local
Ollama, and `yano trace search` retrieves a small ranked evidence set using
hybrid semantic/lexical ranking. The same SQLite database contains a derived
trace-memory layer: typed episodic observations/failures/opinions, systemic
recurring patterns, context metadata and explicit evidence links. `consolidate`
builds it deterministically from raw JSONL, so it is provenance-preserving and
idempotent; `plan` tells the planner which compact memories and raw filters to
read within a token budget. JSONL remains the source of truth; the SQLite index
and projections are rebuildable and are deleted or pruned together with
`yano trace clear`.

The feedback log stores the user's verdict verbatim. Each verdict also creates
a deterministic snapshot; the planner's evidence-based diagnosis is stored
separately as an opinion. `context` and `overview` return filtered or
aggregated JSON so a later planner can retrieve only one task, round or time
window instead of injecting the entire trace into its context. Consolidation
writes compact planner projections under
`traces/<project-key>/projections/` (`planner-context.json` and
`recurring-failures.md`). These are views, not an additional source of truth.
The bundled planner skill defines this protocol and is attached by the launcher
on every planner start. Yano deliberately stores observable messages, tool
lifecycle, user feedback and derived summaries, never private model
chain-of-thought.

Tickets may declare `required_playbook`. When present, `ticket_create` checks it
against the immutable run binding and `ticket_claim` checks both the binding and
the claiming role's playbook mapping. This keeps mixed-role runs possible while
making explicitly playbook-scoped work fail closed on a wrong worker.

## Failure and recovery

- MQTT presence uses retained status plus LWT; stale peers are removed locally. Each heartbeat reconciles the agent's `busy`/`idle` status and load from SQLite ticket ownership, so a planner completing a worker's ticket cannot leave a stale `busy` card behind. Presence publishes are serialized so an older transition cannot overwrite a newer one.
- `yano fleet` applies the same live-heartbeat rule to retained cards and does not report offline or stale agents as live; it reports their ignored-card count as a diagnostic.
- The planner watchdog detects stalled tickets, unfinalized runs and orphaned assignments.
- A dead worker is surfaced with a durable event/checkpoint and can be replaced without letting the planner silently claim worker work.
- External Playbook effects are claimed with leases, retried with bounded attempts and moved to a dead-letter outcome when delivery is exhausted.
- Human approvals are durable decision holds with generation fencing and idempotent answers.
- Merge conflicts preserve the worktree for manual recovery; the main checkout is not mutated by a failed merge.

## Security boundaries

The bundled Docker broker is local-development-only and binds its host port to loopback. Native Mosquitto uses [`mqtt/mosquitto.native.conf`](../mqtt/mosquitto.native.conf), which also binds to loopback. Any shared or remote broker must add TLS, authentication and project-scoped ACLs; anonymous MQTT is not a production configuration. For remote TLS, launch Pi with `--mqtt-tls-ca` (and optionally `--mqtt-tls-cert`/`--mqtt-tls-key` for mutual TLS); `--mqtt-allow-insecure` is intentionally an explicit development escape hatch.

MCP servers are currently project-wide because Pi does not scope MCP servers per role. Role prompts and capability checks limit intended usage, but this is not equivalent to a network security boundary.

## Verification surface

The repository's single entry point for verification is `npm test`. It runs syntax checks, Playbook lint, skill isolation, every `smoke-test-*.mjs` script and the full real-code E2E harness. The suite uses the local MQTT broker and the test-only `pi-tui` stub; a real `pi` process still needs a separate installation-level validation.

## Extension points

The stable seams for future work are:

- MQTT transport and presence;
- SQLite storage and migrations;
- Playbook/evidence transition engine;
- Git worktree integration;
- CLI/read-only dashboards;
- effect adapters and notifications.

New features should preserve project scoping, idempotency, durable audit events and explicit actor authorization at these boundaries.
