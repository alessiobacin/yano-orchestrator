# yano-orchestrator

[![CI](https://github.com/alessiobacin/yano-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/alessiobacin/yano-orchestrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A multi-agent orchestration extension for [Pi](https://github.com/badlogic/pi-mono). It coordinates a **planner**, a **coder**, a **reviewer**, and an optional roster of specialist agents over MQTT 5, isolates every unit of work in its own git worktree, tracks execution through a persistent ticket/DAG layer, and can notify you over WhatsApp when something finishes or needs your attention.

## Overview

You describe a goal to the planner. It scopes the work, breaks it into tickets, and assigns them to a coder — each task runs inside its own isolated git worktree, so nothing touches your main branch until it's actually done. A reviewer checks the result, runs the project's own test suite, and either sends it back for fixes or approves it. Frontend UI work goes through the same reviewer loop — reviewer confirms the specific requested design/UI change is actually present, not just that the code compiles, and sends it back for another round if it isn't. Once approved, the planner merges the work into your main branch and reports back — automatically parallelizing across the roster of specialist roles (security review, documentation, CI/CD, accessibility, and more) when a task calls for it, and picking up again on its own if an agent gets stuck.

Everything communicates over a local MQTT broker, using role/instance identity and presence instead of a flat peer-to-peer chat — so any agent can reach any other by role or by name, and you can watch the whole team work from your terminal.

## Features

- **Role-based multi-agent coordination** over MQTT 5 — planner, coder, reviewer, and 23 optional specialist roles (TDD, mutation testing, security review, Kubernetes, CI/CD, accessibility, documentation sync, architecture diagrams, and more)
- **Git worktree isolation** — every task runs in its own worktree; your main branch is only ever touched by a clean, reviewed merge
- **A persistent ticket/DAG layer** (SQLite-backed) that tracks runs, specs, and tickets across restarts
- **A watchdog** that detects stalled tickets, runs that finished all their tickets but were never merged/notified, *and* tickets whose assigned instance has confirmably vanished (offline presence, not just slow) — the last case is auto-failed and escalated within a couple of minutes, not 15-30
- **`agent_terminate`** lets the planner force a clean shutdown of a wedged instance instead of waiting it out — with an opt-in fully automatic tier for hard-stuck-but-connected tickets
- **`agent_send` warns immediately, in the same turn, if nobody is actually there to receive it** — instead of silently reporting success when a role/instance was never launched
- **The planner is structurally barred from claiming ticket work itself** (`ticket_claim` refuses the planner role outright) — planning and delegating is the job, never quietly doing the work when an instance is missing
- **A mandatory closing checklist**: `worktree_finalize` refuses to merge until you declare the user actually confirmed the result, e2e tests ran (or don't apply), the version was bumped (or doesn't apply), *and* a docs-sync pass actually reconciled the project's own README/QUICK-START/architecture diagram with what shipped (or doesn't apply) — and now pushes to the remote automatically after a successful merge
- **Frontend work has its own enforced review loop** — `frontend-developer` always hands off to `frontend-reviewer`, never to the backend `reviewer`; the frontend reviewer uses Playwright CLI/skill, chrome-devtools, and `code-review`, rejects back with specifics if needed, and informs the planner only after verification
- **Phased execution plans** — the planner declares which roles work together and in what order, and the system enforces it
- **WhatsApp notifications** (via Evolution API) when a task completes or needs your input, so you don't have to watch the terminal
- **A global `yano` CLI** (`yano init`, `yano start`, `yano doctor`, `yano update`, `yano copy-prompts`, `yano uninstall`, `yano end`) for scaffolding, launching, verifying the environment, keeping new orchestrated projects up to date, and closing them out — `yano start` now composes the right launch command for *any* role, not just planner, which is what the planner itself uses when it launches new team members over herdr/tmux
- **Shared trace-analysis skill** for planner, coder, reviewer and specialists — workers can inspect the filtered origin of a mismatch, while the planner records cross-project opinions and systemic interventions
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
copy .env.example .env   # optional: WhatsApp notifications

# MQTT broker — either works:
docker compose -f mqtt/compose.yaml up -d   # with Docker Desktop
# or, without Docker Desktop, native Mosquitto for Windows:
#   install from https://mosquitto.org/download/ (or `winget install EclipseFoundation.Mosquitto`)
#   then, in a separate window: mosquitto -c mqtt\mosquitto.native.conf

yano start --instance planner-01
```

`yano init` detects your OS automatically and prints the right commands either way, and finishes by running `yano doctor` for you — a quick check that git, `pi`, and an MQTT broker are all available, with OS-specific install hints for anything that's missing. Run it again any time with `yano doctor`.

The ticket/DAG layer uses Node's built-in `node:sqlite` API, so Node 22.5 or newer is required. `yano doctor` refuses unsupported runtimes before initialization.

### Keeping `yano` up to date

```bash
yano update           # reinstall the global package from the latest GitHub main
yano update --check   # just check whether an update is available, without installing
yano uninstall        # remove the global installation (asks for confirmation; add --yes to skip it)
```

`yano update` updates both places the extension can live: the global npm package (`npm install -g` against this repo's GitHub URL) and, if present, the separate clone `pi extension install` keeps under `~/.pi/agent/git/github.com/<owner>/<repo>` (a plain `git pull`). `yano uninstall` removes both the same way, asking a separate confirmation for the second one.

**Role prompts are always read live from whichever global install `pi` actually loaded — never from a per-project copy — so `yano update` alone is enough.** `yano init` no longer creates a `prompts/` folder in a scaffolded project at all; every instance simply reads `<installed-package>/prompts/<role>.md` at launch, so a `yano update` immediately takes effect for every existing project too, with no extra step.

**If you want to customize a role's prompt for one specific project**, run `yano copy-prompts` from inside that project's directory — it copies the package's current `prompts/` into `.pi/extensions/multiAgentOrchestrator/prompts/` (backing up any previous local copy first, as `prompts.bak-<timestamp>`, so nothing is ever silently lost), then edit the copied files as you like. That local copy is inert on its own: launch instances with `yano start ... --custom-prompts` to actually make them read it. The override is per-file, not all-or-nothing — a role you never customized locally is always read fresh from the global install, even with `--custom-prompts` on, so customizing one role's prompt can never accidentally freeze every other role's prompt at copy time. And if the local `prompts/` folder doesn't exist at all (e.g. you never ran `yano copy-prompts`), `--custom-prompts` is a safe no-op and everything simply reads from the global install, same as the default.

*(Superseded: earlier revisions of this project shipped a `yano sync-prompts` command for a different design, where `yano init` copied `prompts/` into every project and that copy could go stale after a `yano update`. `yano sync-prompts` no longer exists — the default behavior above closes that gap at the root instead of requiring a resync step after every update.)*

**If you scaffolded a project with an older `yano init`** (one that still copied `extensions/` into new projects), that project directory may have its own leftover `extensions/orchestrator.ts`. `yano start` detects this and simply ignores it, relying on the globally-installed extension instead — it prints a note pointing this out, but the leftover folder no longer causes `pi` to fail with `Tool "..." conflicts with ...`/`Flag "..." conflicts with ...` (a real bug in that detection, fixed — it used to warn about the impending crash and then cause it anyway). The folder is inert at that point; delete it whenever convenient (`rm -rf extensions` / `Remove-Item -Recurse -Force extensions`) — nothing needs it once the extension is installed globally.

**Tracing is global and outside the project checkout.** The observable agent
events and payloads are stored under `<yano-install>/temp/traces/`, so they
survive worktree cleanup and are never pushed with the application. Use
`yano trace status` to see the exact location, `yano trace enable --mode full`
to capture the maximum observable detail, and `yano trace clear --all --yes`
to remove the global temporary store. Existing project-local reports and the
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
yano deps --cli git,npm        # capability preflight
yano gantt                     # local live dashboard at 127.0.0.1:8174
yano watch --once              # one stalled-ticket scan
yano trace status              # modalità e percorso del trace globale
yano trace enable --mode full  # trace completo dei dati osservabili
yano trace events --follow     # segue gli eventi raw mentre gli agenti lavorano
yano trace feedback --status rejected --text "<verdetto utente>" --run <id> --round <n> --task <slug>
yano trace context --run <id> --round <n> --task <slug> --json
yano trace overview --all-projects --json
yano trace opinion --text "<analisi planner>" --change prompt --confidence medium
yano trace clear --all --yes   # elimina tutti i dati temporanei di Yano
```

A run (the ticket/DAG layer's top-level container for one objective — see "Layer ticket/DAG persistente" in `docs/development-notes.md`, Revisione 26) normally closes itself once every one of its tickets is marked done. `yano end` is for when that doesn't happen — a session ended before every ticket was formally completed, the goal changed, or you're simply satisfied with where things landed and want to declare it done. It never touches tickets, worktrees, or any file outside this project's own `orchestrator.db` — closing a run just changes its own status and records the change in its event history, visible later via `run_status` from inside a planner session.

### Optional: local llmproxy config

If you run `pi` against a local LLM proxy instead of a cloud provider directly, `yano init --llmp` also writes `.pi/agent/models.json` and `.pi/agent/settings.json` in the scaffolded project, pre-configured for a proxy listening on `http://127.0.0.1:7045` (provider `llmproxy`, dark theme). It won't overwrite either file if it already exists — pass `--force` too if you want to reset them back to these defaults.

## Quickstart

Per il percorso completo, inclusa l'inizializzazione dei log con `yano trace`,
vedi [`docs/quick-start.md`](docs/quick-start.md).

Scaffold a new project and start the planner:

```bash
mkdir url-shortener && cd url-shortener
yano init --name "URL Shortener"
yano trace enable --mode events
yano trace status
cp .env.example .env   # optional: WhatsApp notifications, fill in your Evolution API details
docker compose -f mqtt/compose.yaml up -d   # local MQTT broker
yano start --instance planner-01
```

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

WhatsApp notifications are optional and configured via `.env` (see `.env.example`). **All four variables below are required together** — if even one is missing, the extension silently skips every notification (logged as "non configurato — variabili mancanti nel .env: `<name>`"), a real bug found and fixed in a project using this package (Revisione 48, see `docs/development-notes.md`):

| Variable | Description |
| --- | --- |
| `EVOLUTION_API_URL` | Base URL of your [Evolution API](https://github.com/EvolutionAPI/evolution-api) instance |
| `EVOLUTION_API_KEY` | API key for your Evolution API instance |
| `EVOLUTION_INSTANCE_NAME` | Your Evolution API instance name (note the `_NAME` suffix — this table itself had the wrong key name, `EVOLUTION_INSTANCE`, until Revisione 48) |
| `DESTINATION_PHONE_NUMBER` | Phone number to notify (with country code, digits only, no `+`) |

Without a `.env`, the extension runs normally — notifications are simply skipped.

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
skills-vendor/mattpocock/         vendored planner-only skills (wayfinder, to-spec, and their own
                                   dependencies) — see VERSION.md
skills-vendor/yano/               bundled shared skill for trace CLI usage and post-round diagnosis
skills-vendor/awesome-copilot/    vendored chrome-devtools skill, reviewer/frontend-developer only —
                                   see VERSION.md
mqtt/                             local Mosquitto broker config for development
docs/                             architecture, trace reference, quick start, Mermaid diagrams and development notes
.env.example                      WhatsApp notification configuration template
mcp.json.example                  chrome-devtools MCP server configuration template
```

## Contributing

Contributions are welcome — open an issue or a pull request. `docs/development-notes.md` has the detailed engineering history and design rationale behind each part of the system, if you want the full context before diving in.

## License

[MIT](LICENSE)
