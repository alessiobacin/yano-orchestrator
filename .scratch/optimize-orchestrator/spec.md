# Spec: orchestrazione multi-agente deterministica con `yano`

## Problem Statement

Come operatore, voglio poter descrivere un obiettivo e affidarlo a un sistema multi-agente che prosegua in modo affidabile dopo crash, offline, timeout, riavvii e risposte umane ritardate. Oggi il codice possiede già un bus MQTT, un control plane SQLite, ticket/DAG, watchdog, worktree condivisi, Playbook, decision hold e una CLI `yano`, ma questi elementi devono essere trattati come un unico contratto operativo coerente.

Il rischio principale non è la capacità del modello di produrre testo o codice: è che il runtime dichiari successo senza prove, perda lo stato, dispatchi capability non disponibili, bypassi il Playbook, duplichi effetti esterni o lasci un progetto inizializzato solo a metà. L’operatore deve sapere sempre quale stato è durevole, quale decisione è richiesta, quale recovery è stata tentata, perché un run è bloccato e come intervenire manualmente.

## Solution

Realizzare un orchestratore governato da Playbook versionati e immutabili per i run attivi. Il planner mantiene le decisioni qualitative e propone piano, DAG, ruoli e richieste di approvazione; il runtime applica in modo deterministico guardie, transizioni, fencing, retry, lease, capability gate, audit e recovery bounded.

Il runtime deve usare SQLite come fonte durevole del control plane, MQTT come trasporto best-effort/reattivo, outbox/inbox per gli effetti asincroni e worktree condivisi per l’isolamento del codice. Ogni operazione ripetibile usa una chiave di idempotenza; ogni worker scrive solo con la generation/lease corrente. Il watchdog riconcilia lo stato, rileva stall e istanze offline, applica le azioni consentite dal Playbook e sveglia il planner senza inventare un piano.

La CLI pubblica è esclusivamente `yano`. `yano init` esegue un preflight ripetibile, verifica configurazione, Node, Git, Pi, broker, skill, CLI, MCP e credenziali, avvia automaticamente il broker ufficiale quando Docker è già disponibile, chiede secret solo per configurazioni attive e fallisce prima delle scritture se non può completare il bootstrap. Gli asset distribuiti devono essere verificabili nel tarball installato.

## User Stories

1. As an operator, I want to start a project with `yano init`, so that the project has deterministic identity, roles, Playbooks and runtime configuration.
2. As an operator, I want `yano init` to verify prerequisites before writing, so that a failed setup never leaves a misleading partial scaffold.
3. As an operator, I want missing MCP credentials to be requested only when an active MCP configuration needs them, so that optional integrations do not block ordinary projects.
4. As an operator, I want non-interactive initialization to fail with exact manual instructions when a secret is missing, so that CI never hangs waiting for input.
5. As an operator, I want broker startup to use the package’s approved Compose definition when Docker is already available, so that local setup is repeatable without guessed commands.
6. As an operator, I want `yano doctor --json`, so that CI, installers and agents can consume prerequisite results without parsing human text.
7. As an operator, I want `yano` to be the only public CLI name, so that documentation, scripts and automation have one stable interface.
8. As a planner, I want to create a run with an objective and domain, so that all subsequent state is scoped to a durable orchestration container.
9. As a planner, I want to attach a canonical specification and tickets to a run, so that qualitative intent becomes an auditable execution graph.
10. As a planner, I want the Playbook to be the normative source of runtime transitions, so that prompts cannot bypass safety gates.
11. As a planner, I want plan phases and DAG readiness to be validated before dispatch, so that incomplete or contradictory work is blocked deterministically.
12. As a planner, I want coder/reviewer/frontend handoffs to be structurally enforced, so that a worker cannot declare a code task complete without the required review path.
13. As a planner, I want specialist roles to be consultative unless a Playbook explicitly promotes them, so that a specialist cannot silently become an executor.
14. As a planner, I want every dispatch to require verified capabilities, so that role declarations alone cannot create false confidence.
15. As a planner, I want skill, CLI, MCP and credential probes to produce evidence-backed capability cards, so that unavailable tools block dispatch with actionable diagnostics.
16. As a worker, I want a ticket claim to be fenced by instance and generation, so that an old or duplicated worker cannot overwrite current state.
17. As a worker, I want retries to reuse stable idempotency keys, so that repeated delivery does not duplicate commits, messages or state transitions.
18. As an operator, I want crashed or offline workers to be detected, so that a ticket cannot remain indefinitely in `running` without an explicit recovery decision.
19. As a planner, I want recovery budgets and failure classes to be enforced by code, so that retries are bounded and exhausted work becomes `blocked` with escalation.
20. As an operator, I want a fresh planner to resume from persisted state, so that a restart does not regenerate or silently discard the existing plan.
21. As a planner, I want startup reconciliation to record dangling tickets and open holds without auto-resolving them, so that recovery findings are durable while qualitative decisions remain mine.
22. As a planner, I want to create a decision hold with an owner, question, context, generation and expiry, so that human approval is a durable runtime state rather than a prompt convention.
23. As an authorized user, I want to answer or cancel a decision hold with generation fencing, so that stale or unauthorized responses cannot change a newer decision.
24. As an authorized user, I want answering the same hold with the same idempotency key to be a no-op, so that retries are safe.
25. As a planner, I want an answered hold to enqueue a durable resume request, so that the planner wakes after a restart and knows whether replanning is required.
26. As an operator, I want expired holds to become `expired` and escalate, so that an unanswered approval cannot silently permit or stall execution forever.
27. As an operator, I want `yano-status`, Gantt and run status to expose open holds, tickets, checkpoints and recent events, so that current state is inspectable without opening SQLite manually.
28. As a planner, I want the watchdog to re-trigger finalize follow-up when required, so that completed work cannot remain unreported or unverified.
29. As a planner, I want finalize to require real tests, version evidence, documentation sync, approvals, report and worktree evidence, so that “done” means verifiable completion.
30. As an operator, I want merge and push to remain separate idempotent actions, so that a local verified result is not published externally without an explicit gate.
31. As a coder, I want file claims and releases to be durable enough for concurrent worktree collaboration, so that parallel agents do not silently overwrite each other.
32. As an operator, I want worktree conflicts to preserve the worktree and leave the main checkout untouched, so that manual resolution remains possible.
33. As an operator, I want malformed or incompatible Playbooks to fail fast, so that the runtime never invents a transition for an unknown contract.
34. As a Playbook author, I want new Playbooks and roles proposed in a sandbox and reviewed before activation, so that meta-agents cannot silently expand runtime authority.
35. As a role-definition agent, I want required capabilities and isolation constraints recorded in the roster, so that new agents are reproducible and auditable.
36. As a package maintainer, I want Playbooks, prompts, skills, MCP examples and CLI assets included in the tarball, so that a fresh install behaves like the source checkout.
37. As a CI maintainer, I want black-box smoke tests for CLI, preflight, credentials, package distribution and runtime recovery, so that regressions are detected at the highest useful seam.
38. As an operator, I want every failure to include the problem, manual remedy, rollback status and retry guidance, so that I can recover without guessing.

## Implementation Decisions

- The public product identity is `yano-orchestrator`; the only public executable is `yano`. No compatibility alias for the retired CLI name is exposed.
- The runtime is an extension-driven control plane over MQTT 5 and SQLite. MQTT carries presence, commands and notifications; SQLite remains the durable source of truth.
- The domain model contains runs, specifications, tickets, dependencies, checkpoints, events, decision holds, idempotency operations and resume outbox entries.
- Decision holds use the states `open`, `answered`, `expired`, `cancelled` and `blocked`. Resolution requires the current generation and an idempotency key. Answers may carry `needs_replan`; answered holds enqueue a deduplicated resume request.
- The planner is the authority for qualitative plan decisions and process control. Runtime tools enforce role gates, Playbook guards, capability verification and state transitions.
- Reconciliation is observational unless the active Playbook explicitly authorizes an automatic recovery. Startup findings are checkpointed and audited; dangling work is not silently requeued.
- Watchdog actions are bounded, idempotent and persisted. Expiry, stalled tickets, offline workers and unfinalized runs are distinct findings with distinct recovery/escalation behavior.
- Worker writes require current ownership/fencing information. Duplicate MQTT deliveries and retried tool calls must resolve to one durable effect.
- Capability verification covers skill loading, CLI version/availability, MCP handshake/scope, credentials and permissions. Declarations in the roster are insufficient evidence.
- `yano init` performs preflight before scaffold writes. It may start the package-approved MQTT Compose service when Docker is already available; missing system-level Pi or Docker installation remains an actionable manual prerequisite rather than an invented installer command.
- Active MCP configurations with placeholder API keys trigger an interactive secret request. Non-interactive or empty-secret cases fail without changing the placeholder or writing the scaffold. Example-only configurations do not request secrets.
- Preflight exposes both human output and machine-readable `{ ok, checks[] }` output. Package-level assets and approved Playbooks are copied or loaded from explicit package locations with no implicit historical fallback.
- Shared worktree collaboration remains the execution isolation model. Finalize validates evidence before merge; merge and push are independent operations.
- Meta-operational agents may propose Playbooks and roles only in a sandbox. Activation requires validation, capability preflight, review, approval and rollback support.

## Testing Decisions

- Tests must assert observable behavior at the highest available seam: CLI process output/exit status first, then extension tools through the Fake Pi harness with real SQLite/MQTT where the behavior crosses process boundaries.
- CLI tests cover `yano --help`, `--version`, `init`, `doctor`, `doctor --json`, credential failure, preflight rollback, package install, `end` and prompt copying.
- Runtime tests cover real persisted run/ticket state, dependency readiness, role gates, agent control allow-list, decision-hold lifecycle, idempotency, expiry, outbox resume, watchdog recovery and startup reconciliation.
- Distribution tests build and install an npm tarball, verify the `yano` binary, inspect Playbook and preflight assets, and reject legacy public identifiers.
- MQTT tests use retained presence, command/response fencing, duplicate delivery, project scoping, late broker recovery and team isolation. Missing external broker binaries are reported as explicit skips, never as unhandled process errors.
- Worktree tests cover claims, concurrent report appends, idempotent reuse, conflict preservation, clean finalize, dirty-main refusal and safe abandonment.
- Prompt and planning tests assert research fallback, `to-spec` → local ticket closure, role-specific prompt resolution and skill isolation.
- Failure tests must prove rollback/no partial state, actionable diagnostics, bounded retry and audit persistence. They must not inspect private implementation details when an external contract can be asserted.
- Existing smoke-test patterns are the prior art: real extension harnesses, scratch projects, real SQLite databases, local MQTT broker topics and black-box CLI invocations.

## Out of Scope

- Mathematical infallibility or elimination of every human decision.
- Replacing MQTT, SQLite, Pi, the shared worktree model or the Playbook authority model.
- Publishing to GitHub/GitLab Issues or introducing a remote issue-tracker dependency.
- Automatically installing an unknown system-level Pi distribution, Docker daemon or arbitrary CLI without an approved versioned manifest and platform-specific installer contract.
- Per-role MCP isolation when the underlying Pi/MCP adapter does not provide that capability.
- Making specialist agents autonomous executors outside an explicitly declared Playbook path.
- Treating prompt text as a substitute for runtime enforcement.

## Further Notes

- The local tracker does not define triage labels; the requested `ready-for-agent` label is therefore not applied as a fabricated field.
- The current implementation and smoke suite already cover substantial vertical slices: package rename/distribution, preflight, decision holds, watchdog, reconciliation, control plane, worktrees, planning flow and project scoping.
- Remaining implementation work should begin with the not-yet-specified Playbook loader/interpreter, approved capability manifest/installer, full approval/escalation dispatcher integration and persistence migration engine.
- Every future Playbook or role addition should extend this spec’s invariants and add a black-box regression before activation.
