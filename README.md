# yano-orchestrator (Yet-Another-New-Orchestrator)

[![CI](https://github.com/alessiobacin/yano-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/alessiobacin/yano-orchestrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A multi-agent orchestration extension for [Pi](https://github.com/badlogic/pi-mono). It coordinates a **planner**, a **coder**, a **reviewer**, and an optional roster of specialist agents over MQTT 5, isolates every unit of work in its own git worktree, tracks execution through a persistent ticket/DAG layer, and can notify you through WhatsApp, Telegram, and email when something finishes or needs your attention.

## Overview

You describe a goal to the planner. It scopes the work, breaks it into tickets, and assigns them to a coder — each task runs inside its own isolated git worktree, so nothing touches your main branch until it's actually done. A reviewer checks the result, runs the project's own test suite, and either sends it back for fixes or approves it. Frontend UI work goes through the same reviewer loop — reviewer confirms the specific requested design/UI change is actually present, not just that the code compiles, and sends it back for another round if it isn't. Once approved, the planner merges the work into your main branch and reports back — automatically parallelizing across the roster of specialist roles (security review, documentation, CI/CD, accessibility, and more) when a task calls for it, and picking up again on its own if an agent gets stuck.

Everything communicates over a local MQTT broker, using role/instance identity and presence instead of a flat peer-to-peer chat — so any agent can reach any other by role or by name, and you can watch the whole team work from your terminal.

## Features

- **Role-based multi-agent coordination** over MQTT 5 — planner, coder, reviewer, and 35 optional specialist roles (TDD, mutation testing, security review, Kubernetes, CI/CD, accessibility, documentation sync, architecture diagrams, read-only observers, and more)
- **Git worktree isolation** — every task runs in its own worktree; your main branch is only ever touched by a clean, reviewed merge
- **A persistent ticket/DAG layer** (SQLite-backed) that tracks runs, specs, and tickets across restarts
- **A watchdog** that detects stalled tickets, runs that finished all their tickets but were never merged/notified, *and* tickets whose assigned instance has confirmably vanished (offline presence, not just slow) — the last case is auto-failed and escalated within a couple of minutes, not 15-30
- **`agent_terminate`** lets the planner force a clean shutdown of a wedged instance instead of waiting it out — with an opt-in fully automatic tier for hard-stuck-but-connected tickets
- **`agent_send` warns immediately, in the same turn, if nobody is actually there to receive it** — instead of silently reporting success when a role/instance was never launched
- **The planner is structurally barred from claiming ticket work itself** (`ticket_claim` refuses the planner role outright) — planning and delegating is the job, never quietly doing the work when an instance is missing
- **A mandatory closing checklist**: `worktree_finalize` refuses to merge until you declare the user actually confirmed the result, e2e tests ran (or don't apply), the version was bumped (or doesn't apply), *and* a docs-sync pass actually reconciled the project's own README/QUICK-START/architecture diagram with what shipped (or doesn't apply) — and now pushes to the remote automatically after a successful merge
- **Frontend work has its own enforced review loop** — `frontend-developer` always hands off to `frontend-reviewer`, never to the backend `reviewer`; the frontend reviewer uses Playwright CLI/skill, chrome-devtools, and `code-review`, rejects back with specifics if needed, and informs the planner only after verification
- **Code review is two-axis** — backend and frontend reviewers separate specification compliance from repository standards/maintainability; Fowler smell checks are labelled heuristics, while Yano keeps the existing worktree, trace, MQTT and planner-finalization workflow
- **Planning uses vertical tickets** — after the spec, the planner invokes the vendored `to-tickets` skill, validates granularity and blocking edges with you, then imports each approved ticket once into the SQLite/DAG runtime
- **Phased execution plans** — the planner declares which roles work together and in what order, and the system enforces it
- **Multi-channel notifications** via Evolution API/WhatsApp, Telegram Bot API, and SendGrid email when a task completes or needs your input, so you don't have to watch the terminal
- **A global `yano` CLI** (`yano init`, `yano start`, `yano doctor`, `yano update`, `yano copy-prompts`, `yano uninstall`, `yano end`, `yano pause`, `yano resume`, `yano recovery`) for scaffolding, launching, verifying the environment, checkpointing and restoring active work, and closing projects — `yano resume` restores agents exclusively in the visible Herdr workspace
- **External `yano-debugger` agent** — `yano debugger` keeps application bug reports and diagnostic transitions in global SQLite, starts one Herdr debugger tab per project, preserves trace provenance and hands accepted diagnoses to the planner
- **Read-only external observers** — debugger diagnostica senza modificare, mentre `yano auto-improve` esegue audit periodici (default 5 giorni) in un workspace Herdr globale e consegna evidenze/raccomandazioni al planner

Gli audit auto-improve riconoscono test, build e lint anche quando il progetto
non li dichiara come script npm; distinguono quindi una suite esistente senza
comando standard dall'assenza effettiva di test. Ogni audit usa inoltre un
transcript Pi nuovo, anche quando riusa la tab Herdr del progetto, e una
allow-list runtime che esclude `bash`, `edit` e `write` dal worker.
- **User suggestion observer** — `yano suggester` raccoglie proposte in un workspace Herdr globale, le deduplica e notifica il planner solo dopo approvazione del superadmin
- **Model advisor** — `yano model-advisor` propone un pin llmProxy `model@provider-id` per role-class (coordinator/support) in base a costo/coding/latenza live di llmProxy, con fallback ad auto-routing (`llmproxy`) quando i dati non sono disponibili — vedi `docs/yano-model-advisor.md`
- **Global playbook/role architect** — `yano architect` crea proposte ephemeral, verifica skill/CLI/MCP, avvia il watcher di validazione e promuove versioni immutabili solo dopo feedback positivo; `yano playbook|agent` consulta il catalogo
- **Controlled deployment agent** — `deployment-agent` uses the `deployment-delivery` Playbook and `yano-deployment` skill to keep development source-based, dockerize staging/production, preserve paired ports and require rollback evidence plus explicit production approval
- **Shared trace-analysis skill** for planner, coder, reviewer and specialists — workers can inspect the filtered origin of a mismatch, while the planner records cross-project opinions and systemic interventions
- **Shared `yano-cli`** for every Pi/Yano role — agents can translate requests such as “is watcher active?” or “initialize this repository?” into scoped, observable CLI commands, with the complete reference under `skills-vendor/yano/yano-cli/`
- **Local embeddings prerequisite** — `yano doctor` verifies Ollama, the `nomic-embed-text` model and a real `/api/embed` probe; `yano init` installs/pulls them when missing (no extra npm embedding library is required)
- **Semantic trace index** — `yano trace index` incrementally stores local Ollama vectors in SQLite and `yano trace search` retrieves only the most relevant observable evidence with project/run/round filters
- **Project Gantt dashboards** — each project gets a free port in `10000-19999`; `--persistent` registers a live link, while `--link` and `--links` recover it later without scanning Herdr manually
- **Consolidated trace memory** — `yano trace consolidate` derives provenance-preserving summaries, failures, opinions and recurring cross-project patterns; `yano trace plan` selects the smallest useful context within a token budget
- **Trace backup and restore** — `yano trace export` creates a portable JSON bundle and `yano trace import --reindex` restores raw evidence before rebuilding derived indexes
- **Role prompts are always read live from the installed package by default — no per-project copy to keep in sync** — `yano update` alone is enough to bring every project current; `yano copy-prompts` + `yano start --custom-prompts` are there only if you actually want to customize a role's prompt for one specific project
- **Automatic per-project MQTT scoping** — two different projects never collide on a shared broker without you having to pass `--project` yourself
- **Frontend prerequisites are deterministic** — every `yano init` verifies/installs global `@playwright/cli@latest` and the global `playwright-cli` skill; `frontend-developer` and `frontend-reviewer` receive the browser skill, while backend `reviewer` remains backend-only. The optional `chrome-devtools` MCP remains project-wide because Pi cannot scope MCP servers per role
- **Cross-platform** — macOS, Linux, and Windows

## Installation

Install as a Pi extension:

```bash
pi extension install https://github.com/alessiobacin/yano-orchestrator
```

This also installs the `yano` CLI, which you'll use to scaffold and launch orchestrated projects. If you're installing directly from a clone instead:

```bash
npm install -g .
```

### Windows

Works the same way from PowerShell — no WSL required, just Node.js 22.5+ and Git for Windows:

```powershell
npm install -g .

mkdir url-shortener; cd url-shortener
yano init --name "URL Shortener"
cp .env.example .env   # optional: WhatsApp, Telegram, and email notifications

# conversation test senza repository Git o worktree di sviluppo:
# yano init --name "Conversation Test" --no-git

# MQTT broker — either works:
docker compose -f mqtt/compose.yaml up -d   # with Docker Desktop
# or, without Docker Desktop, native Mosquitto for Windows:
#   install from https://mosquitto.org/download/ (or `winget install EclipseFoundation.Mosquitto`)
#   then, in a separate window: mosquitto -c mqtt\mosquitto.native.conf

yano start --instance planner-01
```

`yano init` detects your OS automatically and prints the right commands either way. It also verifies Ollama plus the local `nomic-embed-text` model, pulling them when possible, and finishes by running `yano doctor` for you — a quick check that git, `pi`, embeddings, and an MQTT broker are all available, with OS-specific install hints for anything that's missing. Run it again any time with `yano doctor`.

Yano uses Ollama's local HTTP API for embeddings. The default endpoint is
`http://127.0.0.1:11434`; override it with `YANO_OLLAMA_URL` if needed. The
model can be changed for an experimental setup with `YANO_EMBEDDING_MODEL`,
and the semantic index is created on demand under the same global Yano data
directory (`<YANO_DATA_DIR>` or the platform default) with `yano trace index`.

The ticket/DAG layer uses Node's built-in `node:sqlite` API, so Node 22.5 or newer is required. `yano doctor` refuses unsupported runtimes before initialization.

### Keeping `yano` up to date

```bash
yano update           # reinstall the global package from the latest GitHub main
yano update --check   # just check whether an update is available, without installing
yano update --reload --dry-run # preview a controlled reload of this project's Herdr team
yano update --reload --yes     # pause, update, restart and verify live instances
yano repair --dry-run          # detect stale MQTT/Herdr agents and scope drift
yano repair --yes --update     # snapshot, reconcile, update if needed and restart
yano repair --all-projects --dry-run # inventory every active project safely
yano repair --all-projects --yes --update # repair all active projects sequentially
yano uninstall        # remove the global installation (asks for confirmation; add --yes to skip it)
```

`yano update` updates both places the extension can live: the global npm package (`npm install -g` against this repo's GitHub URL) and, if present, the separate clone `pi extension install` keeps under `~/.pi/agent/git/github.com/<owner>/<repo>` (a plain `git pull`). At the end it also runs `pi update --extensions` and synchronizes the global `yano-cli` skill in the detected harness catalogs, so Pi's installed extension registry and CLI skill are synchronized before the next session. A failure in those final synchronizations is reported clearly without hiding the successful Yano package update. `yano update --check` remains read-only and does not run any update command. `yano uninstall` removes both the same way, asking a separate confirmation for the second one.

During a global `npm install -g` the package lifecycle runs the same deterministic skill installer. It detects Claude Code (`~/.claude/skills`), Codex (`~/.codex/skills`) and Pi (`~/.pi/agent/skills`), reads Pi's configured skill roots, and installs only the minimum set of copies. When Pi already discovers the Claude or Codex catalog, it reuses that copy instead of creating a second Pi copy. Inspect or repeat the operation explicitly with:

```bash
yano skills status --json
yano skills install --dry-run --json
yano skills install
```

Identical, safe duplicate copies discovered by Pi are moved to the Yano data-root backup; modified or unmanaged copies are never deleted automatically. Use `--force` only when deliberately replacing a locally edited Yano-managed copy.

`yano update --reload --yes` is the controlled restart path for a live project:
it waits for agent safe points, saves recovery and Herdr inventory snapshots,
updates Yano and the Pi extension, reuses Herdr tabs, resumes missing agents
and verifies the new runtime through the trace. It is not a JavaScript
hot-reload and it only affects the current project. Use `--timeout <seconds>`
to extend the safe-point/version wait or `--force` to explicitly allow an
interrupted operation. If the update fails, agents remain paused and can be
resumed from the saved snapshot.

If the project has no `orchestrator.db`, agents are still alive under an old
MQTT name, or Herdr contains stale panes from a previous initialization, use
`yano repair --dry-run` followed by `yano repair --yes --update`. Repair saves
its own snapshot under global `<YANO_DATA_DIR>/recovery/repair/`, reconciles all Pi panes
whose cwd is the current project, restarts all observed agents with the
canonical scope and preserves application files, traces, database and
worktrees. After a canonical replacement is ready it may close only stale
duplicate singleton tabs for that same project (`planner`, `architect`, or
`watcher`); it never closes application workers or tabs belonging to another
project.

For an explicit operator-wide sweep use `yano repair --all-projects --dry-run`
first, then `yano repair --all-projects --yes --update`. It groups active Herdr
project roots with the persistent debugger/auto-improver/suggester registries,
repairs each project sequentially and writes one recovery snapshot per project;
paused or stopped external workers are left paused or stopped.

**Role prompts are always read live from whichever global install `pi` actually loaded — never from a per-project copy — so `yano update` alone is enough.** `yano init` no longer creates a `prompts/` folder in a scaffolded project at all; every instance simply reads `<installed-package>/prompts/<role>.md` at launch, so a `yano update` immediately takes effect for every existing project too, with no extra step.

**If you want to customize a role's prompt for one specific project**, run `yano copy-prompts` from inside that project's directory — it copies the package's current `prompts/` into `.pi/extensions/yano-orchestrator/prompts/` (backing up any previous local copy first, as `prompts.bak-<timestamp>`, so nothing is ever silently lost), then edit the copied files as you like. That local copy is inert on its own: launch instances with `yano start ... --custom-prompts` to actually make them read it. The override is per-file, not all-or-nothing — a role you never customized locally is always read fresh from the global install, even with `--custom-prompts` on, so customizing one role's prompt can never accidentally freeze every other role's prompt at copy time. And if the local `prompts/` folder doesn't exist at all (e.g. you never ran `yano copy-prompts`), `--custom-prompts` is a safe no-op and everything simply reads from the global install, same as the default.

*(Superseded: earlier revisions of this project shipped a `yano sync-prompts` command for a different design, where `yano init` copied `prompts/` into every project and that copy could go stale after a `yano update`. `yano sync-prompts` no longer exists — the default behavior above closes that gap at the root instead of requiring a resync step after every update.)*

**If you scaffolded a project with an older `yano init`** (one that still copied `extensions/` into new projects), that project directory may have its own leftover `extensions/orchestrator.ts`. `yano start` detects this and simply ignores it, relying on the globally-installed extension instead — it prints a note pointing this out, but the leftover folder no longer causes `pi` to fail with `Tool "..." conflicts with ...`/`Flag "..." conflicts with ...` (a real bug in that detection, fixed — it used to warn about the impending crash and then cause it anyway). The folder is inert at that point; delete it whenever convenient (`rm -rf extensions` / `Remove-Item -Recurse -Force extensions`) — nothing needs it once the extension is installed globally.

**Tracing is global and outside the project checkout.** The observable agent
events and payloads are stored under `<YANO_DATA_DIR>/traces/`, so they
survive worktree cleanup and are never pushed with the application. Use
`yano trace status` to see the exact location, `yano trace enable --mode full`
to capture the maximum observable detail, and `yano trace clear --all --yes`
to remove the global Yano data store. Existing project-local reports and the
operational SQLite database remain workspace state used by the orchestrator;
they are not the forensic trace. The complete command reference is in
[`docs/yano-trace.md`](docs/yano-trace.md).

### Closing out a project

```bash
yano end                       # list this project's "active" runs and, on confirmation, mark them "completed"
yano end --list                # just list them, no changes
yano end --run <run_id>        # close one specific run instead of every active one
yano end --status cancelled    # mark as cancelled instead of completed (also accepts "failed")
yano end --yes                 # skip the confirmation prompt
yano status                    # run/ticket summary from SQLite
yano fleet                     # live MQTT presence of the agent pool
yano projects --json           # conteggio globale dei progetti Yano con agenti Pi live in Herdr
yano deps --cli git,npm        # capability preflight
yano gantt --persistent --open # dashboard live persistente, con link recuperabile
yano gantt --link              # link persistente del progetto corrente
yano gantt --links             # tutti i link Gantt persistenti registrati
yano watch --once              # one stalled-ticket scan
# when an agent target is offline, agent_send escalates to planner or watcher
# context telemetry is written per agent; watcher can request native Pi compaction
yano watch --once --context-compact-ratio 0.82
# yano watch --help and yano watcher <subcommand> --help are read-only
# senza orchestrator.db un watcher ordinario resta in attesa senza errore;
# solo una validazione esplicita usa lo stato blocked e l'escalation
# yano watch also escalates high-confidence Yano faults to .scratch/optimize-orchestrator/issues
# and Telegram; global-only installs use `yano config`, development checkouts may use .env.
yano watcher start --project-root "$PWD"   # persistent registry: Herdr-supervised yano watch --away
yano watcher cron install                  # installa manualmente il self-heal ogni minuto
yano watcher status --json                 # self-heal watcher + planner dei run incompleti
yano config path                 # percorso della configurazione globale utente
yano config list --all           # variabili configurabili, segreti oscurati
yano config set YANO_ORCHESTRATOR_REPO /path/to/yano-orchestrator
yano config set TELEGRAM_DESTINATION_CHAT_ID CHAT_ID
# printf '%s' "$TELEGRAM_BOT_TOKEN" | yano config set TELEGRAM_BOT_TOKEN --stdin
yano config set SERVICE_API_KEY --stdin # credenziale richiesta da un playbook importato
yano rule --add --global "Tutti i progetti devono avere un diagramma di flusso della logica in <root progetto>/docs/diagram"
yano rule --add --project-root "$PWD" "Regola specifica per questo progetto"
yano rule --list --project-root "$PWD" --json
yano playbook candidates --task "<obiettivo>" --project-root "$PWD" --json
yano playbook export knowledge-authoring --out ./knowledge-authoring.yano-playbook.json
yano playbook import ./knowledge-authoring.yano-playbook.json
yano playbook remove <playbook-personale> --yes
yano playbook purge <playbook-personale> --yes
Il playbook `clean-repo` completa anche la documentazione: verifica
`architecture`, `guides`, `quick-guides`, `adr`, `notes`, `postman` (se c'è un
backend), `cheat-sheet` e `diagram`. Ogni categoria mancante riceve una
directory e almeno un file reale; directory vuote, placeholder e TODO non
sono validi. Le directory equivalenti già presenti vengono riutilizzate.
yano trace status              # modalità e percorso del trace globale
yano trace enable --mode full  # trace completo dei dati osservabili
yano trace events --follow     # segue gli eventi raw mentre gli agenti lavorano
yano trace feedback --status rejected --text "<verdetto utente>" --run <id> --round <n> --task <slug>
yano trace context --run <id> --round <n> --task <slug> --json
yano trace index --project <name> --run <id>
yano trace consolidate --project <name> --run <id> --round <n> --json
yano trace plan --run <id> --query "<problema>" --budget 6000 --json
yano trace search --project <name> --run <id> --query "<problema>" --limit 10 --json
yano trace search --query "<problema>" --memory-only --mode hybrid --explain
yano trace overview --all-projects --json
yano trace opinion --text "<analisi planner>" --change prompt --confidence medium
yano trace export --run <id> --output ./trace-bundle.json
yano trace import --input ./trace-bundle.json --reindex
yano trace clear --all --yes   # elimina tutti i dati temporanei di Yano
yano debugger init --base-port 3055  # registra il progetto e le porte dev/staging/prod
yano debugger start             # avvia/riusa il worker nel workspace Herdr yano-debugger
yano debugger start --once --json # preflight read-only senza Herdr
yano debugger status --json     # stato del worker e dei bug del progetto
yano debugger status --bug-id BUG-... --json # dettaglio bug + eventi diagnostici
yano debugger serve --port 4177 # API REST (un'unica istanza, molti progetti — postman/yano-debugger.postman_collection.json)
yano auto-improve init --project-root /path/progetto --interval 5d --notify auto
yano auto-improve start --project-root /path/progetto
yano auto-improve start --project-root /path/progetto --once --dry-run --json
yano auto-improve status --project-root /path/progetto --json
yano auto-improve pause --project-root /path/progetto
yano auto-improve resume --project-root /path/progetto
yano auto-improve stop --project-root /path/progetto
yano auto-improve serve --port 4178 # API REST (un'unica istanza, molti progetti)
yano suggester init --project-root /path/progetto --notify auto
yano suggester start --project-root /path/progetto --once --dry-run
yano suggester submit --project-root /path/progetto --title "..." --description "..."
yano suggester status --project-root /path/progetto --json
yano suggester approve --suggestion-id SUG-... --actor superadmin --yes
yano suggester serve --port 4179 # API REST (un'unica istanza, molti progetti)
```

```bash
yano model-advisor catalog --json                                   # catalogo llmProxy normalizzato, così com'è ora
yano model-advisor recommend --role-class coordinator --json      # model@provider-id pinnato migliore per un ruolo ad alto impatto
yano model-advisor recommend --role-class support --json          # model@provider-id pinnato migliore, più economico, per un ruolo di supporto

# Per lanciare un agente con il pin restituito: Yano lo traduce nel provider Pi llmproxy
yano start --instance debater-01 --role debater --llmproxy-pin 'z-ai/glm-5.3-flash@openrouter-glm' --print-only
```

A run (the ticket/DAG layer's top-level container for one objective — see "Layer ticket/DAG persistente" in `docs/development-notes.md`, Revisione 26) normally closes itself once every one of its tickets is marked done. `yano end` is for when that doesn't happen — a session ended before every ticket was formally completed, the goal changed, or you're simply satisfied with where things landed and want to declare it done. It never touches tickets, worktrees, or any file outside this project's own `orchestrator.db` — closing a run just changes its own status and records the change in its event history, visible later via `run_status` from inside a planner session.

### Optional: local llmproxy config

If you run `pi` against a local LLM proxy instead of a cloud provider directly, `yano init --llmp` also writes `.pi/agent/models.json` and `.pi/agent/settings.json` in the scaffolded project, pre-configured for a proxy listening on `http://127.0.0.1:7045` (provider `llmproxy`, dark theme). It won't overwrite either file if it already exists — pass `--force` too if you want to reset them back to these defaults.

## Quickstart

Per il percorso completo, inclusa l'inizializzazione dei log con `yano trace`,
vedi [`docs/quick-start.md`](docs/quick-start.md).

Per mantenere la documentazione sincronizzata con ogni modifica al codice,
segui [`docs/documentation-sync.md`](docs/documentation-sync.md) e usa anche la
raccolta di [cheat-sheet](docs/cheat-sheet/README.md). Esegui
`npm run check:docs` prima dei test.

Per le procedure brevi, scegli una singola operazione nella raccolta
[`docs/quick_guides/`](docs/quick_guides/README.md): installazione, init di
una repository esistente, avvio con Herdr, update normale o reload, recovery,
trace e troubleshooting.

Scaffold a new project and start the planner:

```bash
mkdir url-shortener && cd url-shortener
yano init --name "URL Shortener"
yano trace enable --mode full
yano trace status
cp .env.example .env   # optional: notifications; fill in only the channels you use
docker compose -f mqtt/compose.yaml up -d   # local MQTT broker
yano start --instance planner-01
```

If you want Yano to open Herdr and perform both steps in a dedicated Herdr
workspace named after the current folder, use the convenience mode:

```bash
mkdir url-shortener && cd url-shortener
yano init --name "URL Shortener" --herdr
```

This creates or reuses a Herdr workspace rooted at the current directory,
runs `yano init` in its root terminal, and starts `planner-01` there. The
option is intentionally in-place only; use the normal `--target` mode when
you do not want Herdr to own the project terminal.

`yano start` usa `full` come modalità predefinita e la propaga agli agenti;
usa `--trace-mode events|standard|off` per ridurla intenzionalmente.

### Inizializzare un progetto già esistente

Puoi eseguire `yano init` direttamente nella root di un'applicazione già
presente, anche se contiene già `package.json`, codice e configurazioni:

```bash
cd /percorso/llmProxy
yano init --name "llmProxy"
```

In questa modalità Yano non richiede `--force` e non sovrascrive il
`package.json`, il codice, `.env.example` o le configurazioni già presenti.
Aggiunge soltanto l'infrastruttura mancante. Se la root contiene già una
cartella `agents/` dell'applicazione, il roster Yano viene collocato in
`.pi/agents/`, layout supportato dal launcher, così i file dell'app non vengono
mescolati con quelli dell'orchestratore.

Then, in the planner's chat, describe what you want built:

```
Build a URL shortener with a REST API and a SQLite backend.
```

The planner will scope the task, propose a team and an execution plan, and — once you confirm — launch the other agents and get to work. Coder implements inside an isolated worktree; reviewer checks the result; the planner merges it into your main branch once it's approved, and reports back.

Other roles (coder, reviewer, and any specialist) are launched the same way, directly with the `pi` CLI once you know their instance name — no `-e` flag needed, since the extension auto-loads once installed:

```bash
pi --instance coder-01 --role coder
```

`yano start` also works for any role now (`yano start --instance coder-01 --role coder`), not just planner — it composes the exact same command, and is what the planner itself now uses when it launches new team members (see Features below).

## Configuration

Notifications are optional and configured via `.env` in development or via the
per-user global store managed by `yano config` (see `.env.example`). The global
store is outside the npm package, is not overwritten by updates and is written
with restrictive permissions. Each channel is independent: incomplete
credentials disable only that channel, while configured channels continue to
receive the same event. Results are recorded in the trace as
`notification_dispatch` with one status per channel.

When a command reaches a branch that genuinely requires missing configuration,
Yano exits with the missing variable names and the exact `yano config set`
commands to use. Secrets are never printed. `YANO_ORCHESTRATOR_REPO` is read
from the development checkout `.env` when running the source checkout, or from
the global configuration for a global-only installation; it is never taken
from the watched project's `.env`.

| Variable | Description |
| --- | --- |
| `EVOLUTION_API_URL` | Base URL of your [Evolution API](https://github.com/EvolutionAPI/evolution-api) instance |
| `EVOLUTION_API_KEY` | API key for your Evolution API instance |
| `EVOLUTION_INSTANCE_NAME` | Your Evolution API instance name (note the `_NAME` suffix — this table itself had the wrong key name, `EVOLUTION_INSTANCE`, until Revisione 48) |
| `DESTINATION_PHONE_NUMBER` | Phone number to notify (with country code, digits only, no `+`) |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `TELEGRAM_DESTINATION_CHAT_ID` | Telegram chat or channel id |
| `SENDGRID_API_KEY` | SendGrid API key with mail-send permission |
| `SENDGRID_FROM_EMAIL` | Verified sender email in SendGrid |
| `SENDGRID_TO_EMAIL` | Recipient email(s), comma-separated if needed |
| `YANO_ORCHESTRATOR_REPO` | Yano checkout for watcher maintenance tickets |
| `YANO_DATA_DIR` | Optional override for global Yano data; defaults to the platform data directory |
| `YANO_OLLAMA_URL` | Optional Ollama endpoint; default `http://127.0.0.1:11434` |
| `YANO_EMBEDDING_MODEL` | Optional embedding model; default `nomic-embed-text` |
| `PI_ORCH_BROKER_URL` | Optional MQTT broker URL |

Without a `.env`, the extension runs normally — notifications are simply skipped. `notify_all` can be used for a manual fan-out; `notify_whatsapp` remains available for a WhatsApp-only message.

### MCP e prerequisiti frontend

`yano init` verifica e installa automaticamente skill, CLI, adapter MCP e broker necessari. I due server MCP essenziali vengono anche dichiarati nel `.mcp.json` attivo del progetto:

```bash
pi install npm:pi-mcp-adapter   # ripetere solo se yano doctor lo segnala
```

`.mcp.json` dichiara `chrome-devtools` e il server remoto GitHub OAuth. Il server MCP resta tecnicamente raggiungibile da tutte le istanze del progetto perché Pi non supporta lo scope MCP per ruolo; i prompt istruiscono però esclusivamente `frontend-developer`/`frontend-reviewer` a usare il browser e `coder`/`reviewer` a usare GitHub quando previsto.

## Project layout

```
extensions/orchestrator.ts        the Pi extension itself — identity, MQTT, tools, prompts
prompts/                          system prompt for each role (planner, coder, reviewer, specialists) —
                                   read live from this installed package by every instance at launch;
                                   never copied into a scaffolded project unless you run `yano copy-prompts`
agents/roles.yaml                 per-role defaults and the specialist roster
agents/agents.yaml                 example instance configuration
bin/yano.mjs                        the `yano` CLI (init/start/doctor/update/uninstall)
scripts/                          CLI internals, dev tooling, and CI checks
skills-vendor/mattpocock/         vendored planner-only skills (wayfinder, to-spec, to-tickets, and their own
                                   dependencies) — see VERSION.md
skills-vendor/yano/               bundled trace-analysis skill plus the reviewer code-review adapter
skills-vendor/yano/yano-cli/      shared semantic CLI skill and complete command reference for every agent
skills-vendor/awesome-copilot/    vendored chrome-devtools skill, reviewer/frontend-developer only —
                                   see VERSION.md
mqtt/                             local Mosquitto broker config for development
docs/                             architecture, trace reference, quick start, quick guides, Mermaid diagrams and development notes
.env.example                      WhatsApp, Telegram, and SendGrid notification template
mcp.json.example                  chrome-devtools MCP server configuration template
```

## Contributing

Contributions are welcome — open an issue or a pull request. `docs/development-notes.md` has the detailed engineering history and design rationale behind each part of the system, if you want the full context before diving in.

## License

[MIT](LICENSE)
