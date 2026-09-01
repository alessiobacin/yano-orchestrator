# Yano Orchestrator Architecture

### Clean-repo e completezza documentale

`clean-repo` coordina `repo-curator`, `docs-sync` e `reviewer`. Dopo
l'approvazione del piano, `docs-sync` crea i documenti mancanti per
architettura, guide, quick guide, ADR, note, cheat-sheet e diagramma Mermaid;
per un backend crea anche una collection Postman JSON. Il report elenca tutte
le categorie e dichiara Postman non applicabile quando non c'è backend.

This document is the human-readable companion to [`architecture.mmd`](./architecture.mmd), the Mermaid source diagram for the current system. The detailed command flows are split into [`docs/diagramma/`](diagramma/README.md), so each operational path can be read without loading the whole architecture graph.

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

Every instance has an `instance`, `role`, `project` and `team` identity. MQTT topics are scoped as `pi/<project>/...`, so two projects sharing a broker remain isolated unless the operator deliberately passes the same `--project` value. `yano start` resolves the root identity and passes the canonical slug explicitly to the child `pi` process, so an auto-loaded extension from a different installation cannot silently choose a shared/default namespace; a human display name belonging to the same root is normalized to that slug even when it appears in a generated command. The runtime also validates both the status topic and the `project` field in every retained presence card before adding it to the roster. An explicit scope override is reported at startup when it differs from the scope derived by the current project root; all instances that must collaborate must use the same value. The watcher also inspects session-start trace records and reports `project_scope_mismatch` when a worker from the root joins the wrong namespace.

## Main flow

1. `yano init` validates Node, Pi-facing prerequisites, MCP configuration and broker availability before writing a scaffold. In-place initialization of an existing project is non-destructive: it preserves application files and merges only missing Yano infrastructure; if root `agents/` belongs to the application, the Yano roster uses `.pi/agents/`. With `--herdr`, the CLI first creates or reuses and explicitly focuses a Herdr workspace rooted at the current directory, runs the scaffold command in its root pane, then starts `planner-01` in that same terminal; when invoked outside Herdr it opens/attaches the Herdr client, while an invocation already inside Herdr avoids nesting another client. Older projects whose roster is still under `.pi/agents/` remain launchable; the launcher selects that directory explicitly instead of assuming the modern root `agents/` layout.
2. `yano start` launches any configured role. For a worker tab, `yano start --herdr`
   verifies both the Herdr workspace label and a pane rooted at the current
   project before creating the tab; it refuses to fall back to whichever
   workspace is focused in the UI. The shared `yano-cli` and
   trace-analysis skill are attached to every worker, so every Pi agent can
   interpret and report the complete Yano CLI consistently. Planner-only vendor
   skills remain restricted to the planner, and browser skills remain
   restricted to frontend roles. The CLI skill is packaged at the repository
   root and included in the global npm package; it is not copied into managed
   application repositories.
3. After `to-spec`, the planner invokes the vendored `to-tickets` skill for
   development and mixed tasks. It proposes vertical slices, acceptance
   criteria and blocking edges, waits for the user's granularity approval and
   writes the local Markdown planning artefacts under `.scratch/<feature>/issues/`.
4. The planner creates or reuses a Git worktree, initializes the persistent workspace and declares a phase plan. Each approved `to-tickets` item is imported once into SQLite/DAG; Markdown remains a human-readable plan, never a second scheduler.
5. `agent_send` routes work by instance or role. Presence is advisory but immediately warns when no live target is available. Structured phase gates can refuse sends to locked phases.
6. Coder, reviewer and specialists append evidence to the task report. File claims prevent simultaneous edits to the same shared file. The reviewer applies the vendored `/code-review` method through Yano's adapter: every review records separate `Spec` and `Standards` findings, the automatic worktree fixed point when available, verification evidence and a verdict. It does not spawn nested agents, ask the user for a ref, commit or finalize.
7. Ticket/DAG and Playbook state are persisted in SQLite. Generation fencing, idempotency keys and the effect outbox make retries resumable.
8. The planner advances phases and runs the mandatory closing evidence checklist before `worktree_finalize` merges the reviewed branch.

### Project repair and reconciliation

`yano update --reload` is intentionally narrow: it needs the project-local
`orchestrator.db` and an active run. A project can still be inconsistent before
that point, for example when Herdr panes were started with an old project name
and their retained MQTT presence is therefore invisible to the current
Planner. The recovery command for this wider condition is:

```text
yano repair --dry-run
yano repair --yes
yano repair --yes --update
```

`repair` derives the canonical identity from the project root, inspects Herdr
panes whose current working directory is that root, discovers retained MQTT
cards under the canonical name and aliases visible in the Herdr labels, and
saves a forensic snapshot under `<YANO_DATA_DIR>/recovery/repair/`. With `--yes` it
sends graceful termination commands, reuses or creates the project workspace,
restarts the observed agents in their existing panes with the canonical scope
(including `planner-01`) and verifies the new presence. Architect and Watcher
tabs are renamed to `architect-<project-name>` and `watcher-<project-name>`;
their resumed sessions receive a read-only scope correction.
With `--update` it first checks for a newer Yano release, runs the normal update
only when needed (including `pi update --extensions`), then performs the same
reconciliation. Persisted Architect proposals are re-provisioned when their
durable record is still available; no new proposal is fabricated without its
original context.

For an operator-level sweep across all active projects use the explicit global
mode:

```text
yano repair --all-projects --dry-run
yano repair --all-projects --yes --update
```

This inventories active Herdr project roots and the persistent registries of
the read-only external workers (`debugger`, `auto-improver` and `suggester`),
then repairs projects one at a time. Each project gets its own snapshot and
the update is performed once before the sequence. Workers that are deliberately
`paused` or `stopped` are not resurrected; a worker with an active registry and
an absent pane gets a new workspace/tab when Herdr permits it. Unknown MQTT
scopes are reported but never guessed into a filesystem root.

The repair inventory treats MQTT cards with an `offline` or stale heartbeat as
historical evidence, not live agents. Herdr can also retain an old `pane.name`
after a restart, so repair prefers the current terminal title and MQTT card for
the displayed instance while preserving old labels as aliases for cleanup.

The operation never deletes application files, worktrees, SQLite state or trace
history. Once a canonical replacement is ready, it may close only stale
duplicate singleton tabs for the same project (`planner`, `architect` or
`watcher`); it does not close unrelated worker tabs. `--force` is an explicit
acknowledgement that a process which did not leave gracefully may be
interrupted.

### Inventario degli agenti esterni

Herdr è la fonte di verità per sapere se un agente è realmente attivo. I
comandi brevi interrogano quella fonte senza dover filtrare manualmente lo
snapshot:

```text
yano architect projects
yano watcher projects
yano debugger projects
yano auto-improve projects
yano suggester projects
```

Per includere anche proposte e registrazioni offline usa `--all`; per script
usa `--json`. `active_projects` indica solo agenti Pi live, mentre
`registered_projects` può contenere una proposta Architect pronta ma con
Architect già terminato. Architect è normalmente transitorio: serve a creare,
verificare o revisionare un playbook; Watcher può restare attivo come tripwire.
Il Planner è invece un agente del progetto e si controlla con
`yano fleet --project-root <dir>`.

`fleet` è una vista read-only: filtra heartbeat recenti, ignora card retained
stale/offline e, quando Herdr è disponibile, esclude anche un processo marcato
`done`. Non crea agenti né ripara tab.

Per il conteggio globale dei progetti realmente attivi si usa invece:

```text
yano projects --json
```

Il comando interroga Herdr, considera tutti gli agenti Pi/Yano live (non solo
gli external worker), raggruppa per root canonica e restituisce ogni progetto
una sola volta in `projects`, con il totale in `project_count`. Se Herdr non è
raggiungibile il totale è `null`, perché l'assenza di dati non equivale a zero.

`external_workers` nel report di `repair` contiene i worker esterni effettivamente
osservati da Herdr o presenti nei registri globali. Architect e Watcher non hanno
un registro `*_projects` autonomo: quando non sono live, il loro contesto è
visibile in `architect_proposals`, non in `external_workers`.

### Database operativo e Gantt

Il database locale non viene creato per il solo fatto che la directory sia
stata inizializzata. Il Planner lo crea chiamando `orchestrator_init`, così un
progetto appena scaffoldato può legittimamente avere `orchestrator.db` assente.
In conversation mode questo stato è valido: il watcher ordinario registra
`waiting/not_initialized` senza escalation e continua a riprovare. Solo il
Watcher di una validazione esplicita usa `blocked` e notifica il precondition
failure.
Se serve preparare la struttura prima del primo run:

```text
yano repair --project-root <dir> --yes --init-db
```

Questo crea lo schema corrente in modo idempotente e non modifica il codice
dell'applicazione. Rimane necessario che il Planner esegua
`orchestrator_init`, `run_create`, `spec_create` e `ticket_create` per avere
dati da visualizzare. Perciò Gantt può rispondere `ok: true` con `runs: []`:
significa che il DB esiste ma non è ancora stato creato un run. Se il DB manca,
il server mostra il percorso preciso e il comando `repair --init-db`.

```text
yano gantt --project-root <dir> --project <nome> # porta libera automatica 10000-19999
```

Ogni istanza Gantt sceglie una porta libera nel range `10000-19999`, partendo
da uno slot stabile derivato dal progetto e provando gli slot successivi se
necessario. Due progetti possono quindi avere dashboard simultanee; `--port`
resta disponibile per una scelta esplicita, ma deve appartenere allo stesso
range. Con `--persistent` il link viene registrato in
`<YANO_DATA_DIR>/gantt/instances.json`; `--link` recupera quello del progetto
corrente e `--links` elenca tutti i link registrati, verificando se il server è
ancora raggiungibile. La registrazione è persistente, mentre il processo resta
foreground e quindi non viene lasciato nascosto o avviato come daemon.

## Persistence model

The workspace lives under `.pi/extensions/yano-orchestrator/`:

- `orchestratorStorage/orchestrator.db`: SQLite state and audit history;
- `config/project.json`: project identity and schema metadata;
- `reports/`: task reports and round evidence;
- `<YANO_DATA_DIR>/traces/<project-key>/events/`: global per-instance trace JSONL, outside the project checkout. If `YANO_DATA_DIR` is omitted, Yano uses the platform data directory;
- `specs/`, `playbooks/`, `diagrams/`, `knowledge/`, `policies/`, `artifacts/`: project-scoped working artifacts.

The database is intentionally local to a project. MQTT provides fast coordination, while SQLite is the durable source for recovery, status, evidence and outbox state.

Code Mem is a separate required local-memory layer: `yano init` first verifies
`cm`, then runs `cm init pi` in the project root. This creates `memory/` and a
project-local Pi skill/hook. The hook recalls contextual memory at session
start and captures completed agent responses on a best-effort basis; it cannot
block a Yano/Pi session. Yano also injects `yano-code-mem` into every launched
role so agents retrieve and save memory with the same evidence and secrecy
rules.

When upgrading from a pre-platform-data release, `yano data migrate --dry-run`
previews and `yano data migrate --yes` copies the old package `temp/` into the
new per-user data root without deleting the source.

### Global tracing

Yano's forensic trace is stored in the per-user Yano data directory, never in
the installed package and never under the project. `YANO_DATA_DIR` (or the
legacy alias `YANO_TEMP_DIR`) can override this location. The default is
`~/Library/Application Support/yano/data` on macOS, `~/.local/share/yano` on
Linux and `%LOCALAPPDATA%/yano/data` on Windows. Use `yano config path` for
the configuration file and `yano trace status` for the effective data root.
The CLI controls the capture policy:

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

### Global `yano-watcher` escalation

The watcher has two separate responsibilities: it observes a project without
using LLM tokens (stalled tickets and liveness signals), and it classifies only
high-confidence failures of Yano itself. A failed `npm test`, `git` command or
application tool is evidence about the watched project and is not escalated as
a Yano defect. Signals such as `agent_send_no_live_target`, an internal Yano
tool failure, a workspace-scope mismatch or an orphaned Yano lifecycle are
eligible for escalation.

When an eligible signal is found, the watcher:

1. writes a Markdown maintenance ticket to
   `.scratch/optimize-orchestrator/issues/` in the Yano source repository;
2. deduplicates by a deterministic fingerprint, so a ten-minute polling loop
   does not create an unbounded number of tickets;
3. appends a `yano_watcher_finding` event to the watched project's trace,
   including the ticket path and the Telegram delivery result (never secrets);
4. appends a `yano_watcher_scan` event for every pass, including start/end
   timestamps, duration, interval, lookback, status, findings and stalls;
5. sends a concise Telegram alert using `TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_DESTINATION_CHAT_ID` from the development `.env` or the global
   user configuration managed by `yano config`.

The source repository is resolved from `YANO_ORCHESTRATOR_REPO` in the
development checkout `.env`, or from the global user configuration for a
global-only installation. It is never read from the watched project or a CLI
override. If a detected Yano defect needs it and it is missing, the command
returns an actionable configuration error instead of silently losing the
maintenance ticket. The future `yano-debugger` can consume these files; until
then they are deliberately ordinary Markdown tickets for an LLM.

Routing is presence-aware: with at least one live planner, the watcher sends a
direct MQTT command to each live planner instance; if no live planner exists,
it sends the alert to Telegram. A project with no agents and no detected fault
is considered idle and does not page the user.

The same liveness rule is enforced by `agent_send` before every delegation. A
live target receives the command normally; an offline target is never reported
as successfully delegated: the command is rerouted to a live `planner-01`, or,
if no planner is live, to the project's persistent watcher channel
(`system/agent-fallback`). The watcher preserves the original target, sender
and assignment ID, starts/reopens `planner-01` through the Yano control plane
when necessary, and then forwards the command. A persistent watcher is
registered only by an explicit watcher command and remains scoped to the
project/options selected by the operator; starting a planner with `yano start`
does not implicitly create one.
The registry services (`debugger`, `suggester` and `auto-improver`) use the same
router for their planner handoffs; their completion or bug notifications also
cannot disappear silently when the intended worker or planner is offline.

All user-facing channel notifications are decorated centrally with the sender
instance/role, project scope and operating-system hostname of the server that
emitted them. Planner rules are stored in `<YANO_DATA_DIR>/rules/rules.json`;
`yano rule --add --global` and `yano rule --add --project-root` inject the
corresponding rules into the planner system prompt.
The global Yano npm installation installs a user crontab entry that runs
`yano watcher supervise` every minute; the same entry can be installed or
repaired manually with `yano watcher cron install`. The supervisor serializes checks with a lock,
cross-checks every registry row against Herdr, and self-heals dead watcher
panes; explicit `paused` rows are never restarted.
It also restores global worker intent: installed Architect proposals are resumed
through their project-scoped ephemeral phase and, after promotion, their global
phase; `running` debugger workers are resumed when their exact instance is
absent; pending Suggester analyses are dispatched again; and an enabled
auto-improver restores both its scheduler and its persisted idle tab without
starting a premature audit.
The same reconciliation checks project-local SQLite runs: non-finalized runs
trigger recreation of the project workspace and `planner-01` with a recovery
prompt grounded in trace, tickets and worktrees. Recovery selects only the
Herdr workspace explicitly labelled for that project: specialist panes with
the same working directory in a shared workspace can never receive another
project's recovery prompt. A planner that exists but has made no durable run
progress for 15 minutes (unless it is waiting on a decision hold) is treated as
stalled and is restarted with a cooldown to prevent loops. Once every run is
finalized, or a registered project remains uninitialized/without runs beyond
the grace period, the project's watcher tab and durable registry state are
closed automatically.

The external Watcher created for a playbook performs one bounded validation pass
and then keeps a zero-token `yano watch` process alive with a ten-minute
interval. If `orchestrator.db` is not present yet, an ordinary watcher records
`waiting/not_initialized` without escalation and keeps polling; a pass with
explicit validation context records `blocked`. It does not exit and leave a
dead Herdr pane. The continuous pass detects liveness, stalled tickets and explicit
high-confidence Yano signals. It is not an LLM semantic review of every line
of every conversation: deeper interpretation requires a bounded prompt to the
Watcher, with evidence in the trace. A tab labelled `watcher-<project-name>`
without a live Pi process is not an active Watcher.

Conversation consultations add one deterministic, zero-token check: when a
planner delegates to `conversation-researcher`, the watcher audits the trace
for forbidden delivery tools, mutating shell commands, and failed specialist
launches. It emits `yano_watcher_conversation_check`, records deduplicated
`conversation_policy_violation` events, and routes corrective context to a
live planner or Telegram. Read-only documentation queries remain valid.

Explicit `debate` intents use a separate deterministic contract check:
`yano_watcher_debate_check` reports `debate_policy_violation` when the planner
uses `conversation-researcher`, completes without at least two `debater`
instances, omits the `yano model-advisor` proposal, or launches the roster
without a proposed and explicitly user-confirmed plan. A read-only researcher
therefore cannot make a wrongly routed debate appear healthy.

The persistent watcher also subscribes to planner and run completion events.
`planner_task_completed` and `run_completed` enqueue one immediate final scan,
recorded as `yano_watcher_final_scan_requested` plus a `once: true` scan; the
configured polling cadence remains active after that pass.

Every Pi session also emits bounded `context_usage` telemetry to its per-agent
trace log. The external watcher uses the latest `context_ratio` for each live
agent and, above `YANO_WATCH_CONTEXT_COMPACT_RATIO` (default `0.82`), sends a
`context_compact_request` control message to that agent. The agent owns the
session operation and invokes Pi's native `ctx.compact()`, recording
`context_compaction_completed` or `context_compaction_failed`; the native
compaction reloads the effective context and resumes the same Yano work with
SQLite/run/ticket state intact. This path is intentionally playbook-agnostic.

### Global `yano-debugger`

`yano debugger` è il secondo agente esterno e vive fuori dal workspace del
progetto, nel workspace Herdr globale `yano-debugger`, con una tab per ogni
progetto registrato, nominata `debugger-<project-name>`. Il registro `debugger/debugger.sqlite` contiene progetto,
worker, bug, transizioni e audit; gli eventi vengono duplicati nel trace del
progetto per consentire la diagnosi contestuale. La modalità `project` è
separata da `yano-maintenance`, che può puntare solo al repository
`yano-orchestrator`.

Il debugger esterno è esclusivamente diagnostico: il suo lifecycle è
`reported → triaged → reproducing → not_reproducible|blocked`. Legge trace,
log, stato Git e superfici applicative osservabili, ma non modifica codice,
test, configurazioni, worktree o deployment. Un report del debugger viene
consegnato al planner, che decide se aprire un normale task di sviluppo e
delegarlo a coder/reviewer/deployment-agent. Le vecchie transizioni
`fixing/testing/staging/production` non appartengono più al debugger.

Le porte vengono assegnate con la stessa base nei tre ambienti:
backend `3000–3999`, `4000–4999`, `5000–5999`; frontend `6000–6999`,
`7000–7999`, `8000–8999`.
Per una verifica bounded e read-only è disponibile
`yano debugger start --project-root <dir> --once`; non apre Herdr e non avvia
processi persistenti.

### Global `yano-auto-improver`

`yano auto-improve` registra un progetto nel database globale
`<YANO_DATA_DIR>/auto-improver/auto-improver.sqlite`, crea audit periodici (per default
ogni `5d`) e avvia, tramite Herdr, una tab `auto-improver-<project-name>` per progetto nel workspace globale
`yano-auto-improver`. Ogni audit raccoglie un evidence pack limitato con
manifest, Git, trace/semantic retrieval, test/lint/build disponibili, bug e
feedback; i report vivono soltanto nella directory globale `<YANO_DATA_DIR>/`.
La discovery di test/build/lint usa anche marker reali del repository (in modo
bounded e read-only), distinguendo una suite esistente senza script standard
dalla sua assenza. Il worker Pi è inoltre limitato a tool di lettura,
coordinamento, ricerca web pubblica e `auto_improve_complete`, che scrive
soltanto il report globale. Ogni audit deve confrontare la capability principale
con almeno tre alternative tramite fonti ufficiali HTTPS e produrre una gap
matrix su feature, UX utente/LLM, tool/API, MCP, connettori, plugin, qualità,
performance, sicurezza, test, deployment, maturità e licenza.

L'auto-improver è read-only come tutti gli agenti esterni: non modifica il
progetto osservato, non crea worktree, non fa commit, non installa dipendenze,
non apre ticket operativi e non esegue deploy. Al termine invia report e
raccomandazioni al planner via MQTT e, se configurati, all'utente via Telegram,
WhatsApp e SendGrid. Il planner classifica ogni proposta e decide se chiedere
conferma o avviare il normale flusso `to-spec → to-tickets → coder/reviewer`.
Comandi principali: `init`, `start`, `run`, `status`, `reports`, `pause`,
`resume`, `stop` e `complete`; `--dry-run` permette di verificare la
composizione del worker senza aprire Herdr. `yano auto-improve run|start
--once` esegue un solo audit e non avvia lo scheduler detached.

### Global `yano-suggester`

`yano suggester` è un osservatore globale read-only. Registra i suggerimenti in
`<YANO_DATA_DIR>/suggester/suggester.sqlite`, conserva evidence pack e report sotto
`<YANO_DATA_DIR>/suggester/` e usa il workspace Herdr `yano-suggester`, con una tab
`suggester-<project-name>` per progetto. La v1 offre intake CLI, redazione di segreti, fingerprint esatto,
analisi bounded e lifecycle `received → analyzing → awaiting_approval →
accepted|rejected`.

Una proposta resta in attesa del superadmin: `approve` è il solo passaggio che
può notificare il planner via MQTT e canali configurati. Il planner decide se
chiedere chiarimenti o avviare `to-spec → to-tickets`; il suggester non modifica
codice, test, dati, configurazioni, ticket operativi o deployment. FAB/HTTP,
auth, rate limiting e deduplicazione semantica sono roadmap, non capacità v1.

La distinzione tra v1 e sviluppi successivi di tutti gli agenti esterni è
registrata in [`docs/agents/external-agents-roadmap.md`](agents/external-agents-roadmap.md).
`yano suggester start|submit --once` consente un test bounded; `--dry-run`
evita l'apertura del worker Herdr.

### Global `yano-architect`

`yano architect` è un agente globale di progettazione del catalogo, non un
worker del progetto osservato. Vive nel workspace Herdr `yano-architect` e
scrive il database `<YANO_DATA_DIR>/architect/architect.sqlite`, le proposte
ephemeral in `<YANO_DATA_DIR>/architect/proposals/` e, solo dopo promozione, le
versioni immutabili in `<YANO_DATA_DIR>/catalog/`.

Il lifecycle è catalog-first: `assess → reuse` se esiste un match esatto,
oppure `assess → propose globale → intervista utente → team variant →
capability gate → watcher validation → feedback planner/utente → revise|promote`.
L'architect non modifica mai codice, test, configurazioni, worktree o
deployment del progetto. Prima di avviare un playbook controlla tutte le skill,
CLI, MCP e credenziali dichiarate; un MCP solo presente in `.mcp.json` resta
`pending` fino a un handshake reale registrato con `yano architect capability`.
Le credenziali mancanti producono il comando esatto `yano config set ...` e il
percorso della configurazione globale. `--once` esegue soltanto il gate e non
apre Herdr.

Una proposta nuova è globale e parametrica: il progetto che ha originato la
richiesta è soltanto il primo caso d'uso. L'intervista chiede all'utente se
preferisce un agente singolo, un team multi-agente o una scelta lasciata al
planner, oltre alla priorità velocità/profondità. Architect definisce il
contratto generico del team (ruoli, output, capability e gruppi paralleli);
Planner sceglie la variante e il numero di istanze in base al task. Per
esempio, `knowledge-authoring` offre `single-author`,
`research-and-author` e `full-team`, evitando di avviare cinque agenti per un
documento breve.

Quando la readiness è completa, l'architect avvia una tab
`architect-<project-name>` nel workspace `yano-architect` e una tab
`watcher-<project-name>` nel workspace `yano-watcher`, oltre ai rispettivi
agenti Pi con ruolo `architect` e `watcher` per osservare il nuovo round:
creare soltanto la tab non costituisce un agente attivo. Il watcher può
segnalare il round sano ma non può promuovere. Il planner intervista l'utente, chiede una
revisione oppure usa `promote --yes` solo con capability pronte, almeno una
validation riuscita e feedback positivo. Il catalogo espone
`yano playbook list|show|check` e `yano agent list|show`; il launcher unisce un
ruolo promosso al roster del progetto in una configurazione runtime temporanea,
senza copiare file nel repository applicativo.

Il catalogo supporta bundle portabili JSON:
`yano playbook export <id> --out <file>` e `yano playbook import <file>`.
L'import non installa silenziosamente il playbook: crea una proposta globale,
calcola conflitti per id/intenti, controlla requisiti e avvia sempre Architect
nel workspace `yano-architect` (se Herdr non è disponibile l'import resta
bloccato e lo dichiara). Il Planner deve mostrare le alternative compatibili,
raccomandarne una e attendere la scelta dell'utente. `remove` disattiva in modo
reversibile un playbook personale; `purge` lo elimina solo dopo la rimozione e
con conferma esplicita. Le dipendenze tra playbook non fanno parte dello schema
attuale.

### Deployment agent

Il `deployment-agent` è un worker distinto dal debugger applicativo. Il suo
Playbook `deployment-delivery` governa il percorso `development_ready →
staging_packaged → staging_validated → production_approved →
production_deployed`. Development resta codice sorgente nella checkout
`~/projects/<project-name>`; staging e production sono Docker/Compose e usano
lo stesso artefatto immutabile. La skill `yano-deployment` impone la matrice di
porte appaiata, healthcheck, smoke test, digest, secrets fuori da Git e
rollback checkpoint. Il passaggio in production richiede approvazione esplicita
del planner/utente: build riuscita o test staging da soli non sono
autorizzazione al rilascio.

The optional semantic layer is stored at `<YANO_DATA_DIR>/semantic-index.sqlite`.
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

### `to-tickets` and SQLite/DAG boundary

`to-tickets` is the planning-time translator between an approved spec and
Yano's runtime ticket layer. It produces one local Markdown file per vertical
slice, including acceptance criteria and blockers, and asks the user to confirm
granularity. The planner then creates one corresponding SQLite ticket and
preserves the dependency edges in `depends_on`. The Markdown files are useful
for review, recovery and audit, but claims, readiness, watchdog, phase gates
and completion read only from SQLite/DAG.

### Review skill boundaries

`skills-vendor/mattpocock/code-review/` preserves the upstream Matt Pocock
reference. Runtime reviewer sessions receive
`skills-vendor/yano/yano-code-review/`, which ports the useful two-axis model
without importing the upstream assumptions that conflict with Yano (manual
fixed-point input, parallel nested reviewers, short standalone reports and
external issue-tracker publication). `reviewer` and `frontend-reviewer` keep
their existing role-specific prompts and routing; the adapter is an additional
checklist, not a replacement for browser evidence, trace analysis, HTTP
hygiene or the coder correction loop.

## Failure and recovery

### Controlled Yano reload

An already-running Pi process has the extension module, tool registry, MQTT
listeners and runtime state in memory. Replacing files on disk therefore does
not hot-reload that process. `yano update --reload` uses a controlled state
machine instead: preflight → reload barrier/safe point → durable snapshot →
graceful Herdr termination → global/package-extension update → Herdr reuse and
`--continue` resume → trace version handshake. The snapshot includes the
project database/WAL/SHM, ticket assignments, Git/worktrees, observable trace,
MQTT presence, and a redacted workspace/tab/pane inventory.

The restart is semantic rather than token-level: observable tool calls,
reports, checkpoints and tickets can be reconciled, while hidden model tokens
from an interrupted generation cannot be restored. The default scope is one
project; a failed update leaves the agents paused and the snapshot available
for an explicit `yano resume`.

- MQTT presence uses retained status plus LWT; stale peers are removed locally. Each heartbeat reconciles the agent's `busy`/`idle` status and load from SQLite ticket ownership, so a planner completing a worker's ticket cannot leave a stale `busy` card behind. Presence publishes are serialized so an older transition cannot overwrite a newer one.
- `yano fleet` applies the same live-heartbeat rule to retained cards and does not report offline or stale agents as live; it reports their ignored-card count as a diagnostic.
- The planner watchdog detects stalled tickets, unfinalized runs and orphaned assignments.
- The standalone `yano-watcher` can turn high-confidence Yano orchestration
  faults into deduplicated maintenance tickets and Telegram alerts; it never
  changes project ticket state or attempts an automatic fix.
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
