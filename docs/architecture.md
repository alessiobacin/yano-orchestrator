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

Every instance has an `instance`, `role`, `project` and `team` identity. MQTT topics are scoped as `pi/<project>/...`, so two projects sharing a broker remain isolated unless the operator deliberately passes the same `--project` value.

## Main flow

1. `yano init` validates Node, Pi-facing prerequisites, MCP configuration and broker availability before writing a scaffold.
2. `yano start` launches any configured role. Planner-only vendor skills are attached only to the planner; browser skills are attached only to frontend roles.
3. The planner creates or reuses a Git worktree, initializes the persistent workspace and declares a phase plan.
4. `agent_send` routes work by instance or role. Presence is advisory but immediately warns when no live target is available. Structured phase gates can refuse sends to locked phases.
5. Coder, reviewer and specialists append evidence to the task report. File claims prevent simultaneous edits to the same shared file.
6. Ticket/DAG and Playbook state are persisted in SQLite. Generation fencing, idempotency keys and the effect outbox make retries resumable.
7. The planner advances phases and runs the mandatory closing evidence checklist before `worktree_finalize` merges the reviewed branch.

## Persistence model

The workspace lives under `.pi/extensions/multiAgentOrchestrator/`:

- `orchestratorStorage/orchestrator.db`: SQLite state and audit history;
- `config/project.json`: project identity and schema metadata;
- `reports/`: task reports and round evidence;
- `logs/`: per-instance diagnostic JSONL;
- `specs/`, `playbooks/`, `diagrams/`, `knowledge/`, `policies/`, `artifacts/`: project-scoped working artifacts.

The database is intentionally local to a project. MQTT provides fast coordination, while SQLite is the durable source for recovery, status, evidence and outbox state.

Tickets may declare `required_playbook`. When present, `ticket_create` checks it
against the immutable run binding and `ticket_claim` checks both the binding and
the claiming role's playbook mapping. This keeps mixed-role runs possible while
making explicitly playbook-scoped work fail closed on a wrong worker.

## Failure and recovery

- MQTT presence uses retained status plus LWT; stale peers are removed locally.
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
