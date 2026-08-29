# Yano CLI command reference

This is the detailed reference for `yano-cli`. It mirrors the command
surface implemented by the package. Always prefer the installed binary's
`--help` output if a release has changed.

## Top-level commands

```text
yano init [--name <name>] [--target <dir>] [--force] [--llmp] [--herdr]
yano start --instance <id> [--role <role>] [--project <scope>] [--trace-mode <mode>]
yano doctor [--json] [--network]
yano update [--check|--reload] [--dry-run] [--yes] [--timeout <seconds>] [--force]
yano uninstall [--yes]
yano end [--run <id>] [--status completed|cancelled|failed] [--list] [--yes]
yano copy-prompts
yano skills install|status [--dry-run] [--force] [--json]
yano projects [--json]
yano status|logs|fleet|mcp [options]
yano deps [options]
yano gantt [options]
yano watch [options]
yano trace [subcommand] [options]
yano pause|resume|recovery [subcommand] [options]
yano repair [options]
yano config [subcommand] [options]
yano data [subcommand] [options]
yano architect [subcommand] [options]
yano watcher projects [options]
yano debugger [subcommand] [options]
yano auto-improve [subcommand] [options]
yano suggester [subcommand] [options]
yano playbook [subcommand] [options]
yano agent [subcommand] [options]
```

`--help` is supported at the top level and by command groups. `--version`
prints the installed package version.

## Initialization and launch

```text
yano init --name "Project Name"
yano init --name "Project Name" --herdr
yano init --name "Project Name" --target /absolute/path --force
yano start --instance planner-01 --role planner
yano start --instance coder-01 --role coder
yano start --instance reviewer-01 --role reviewer
yano start --instance <id> --role <generated-role> --proposal-id <proposal-id>
```

`init` merges missing Yano infrastructure in place and preserves existing
application files. `--force` is needed when `--target` points to a non-empty
directory. `start` loads role skills, passes the derived project scope and
uses Herdr as the supported workspace runtime. It does not perform a live
in-process reload.

## Diagnostics and project views

```text
yano projects [--json]
yano doctor --network
yano status [--run <id>] [--project <scope>] [--json]
yano logs [<instance>] [--project <scope>] [--json]
yano fleet [--project-root <dir>] [--project <scope>] [--json]
yano mcp [<role>] [--json]
yano skills [<role>] [--json]                 # skill dichiarate dal progetto
yano deps [--project-root <dir>] [--json]
yano gantt --project-root <dir> [--project <name>] [--port 10000..19999] [--persistent]
yano gantt --link [--project-root <dir>] [--project <name>] [--json]
yano gantt --links [--json]
```

Senza `--port`, Gantt seleziona automaticamente una porta libera nel range
`10000-19999`, usando uno slot stabile per progetto e provando il successivo
se quello slot è occupato. In questo modo più progetti possono avere Gantt
simultanei. Una porta esplicita deve appartenere allo stesso range.

`projects` is the global read-only live-project inventory. It queries Herdr,
keeps only live Pi/Yano panes rooted in an initialized Yano project, groups
them by canonical filesystem root, and returns each root once. Use
`project_count` for the answer to “how many Yano projects are active now?”.
`project_count: null` with `herdr_reachable: false` means that Herdr could not
be queried and the number is unknown. The role-specific `*_projects` commands
below answer a different question: which projects are covered by one external
worker role.

Gantt is project-scoped. Without `--port`, it selects an available port in
`10000-19999`; `--persistent` stores the URL under the global Yano data-root.
Use `--link` for the current project or `--links` for every registered project.
These lookup commands are read-only. A stored link can be marked `stopped` if
its health endpoint is no longer reachable; the record is retained so the
dashboard can be restarted without losing its URL history.

`fleet` and the external `projects` commands are read-only. A retained MQTT
card can be stale, so use the `active` field and Herdr reachability rather
than treating every record as a running process.

### Harness skill synchronization

```text
yano skills status --json
yano skills install --dry-run --json
yano skills install
```

The installer detects the Claude Code, Codex and Pi user catalogs. It reads
Pi's `settings.json` discovery roots before choosing targets, so a Claude or
Codex copy already discovered by Pi is reused rather than duplicated. Use
`--force` only for a deliberate replacement of a locally edited Yano-managed
copy; use `--no-prune-duplicates` to inspect without moving safe duplicates.
Unmanaged or modified duplicate directories are left in place and reported.

## Watcher and external agents

```text
yano watch --project-root <dir> [--project <name>] [--once]
yano watch --project-root <dir> --lookback-ms <ms> --interval-ms <ms> [--away]
yano watch --project-root <dir> --validation-run <id> --playbook-proposal <id> --once
yano watcher projects [--all] [--project-root <dir>] [--json]
yano architect projects [--all] [--project-root <dir>] [--json]
yano debugger projects [--all] [--project-root <dir>] [--json]
yano auto-improve projects [--all] [--project-root <dir>] [--json]
yano suggester projects [--all] [--project-root <dir>] [--json]
```

The scan history window is `--lookback-ms`; the recurring polling delay is
`--interval-ms`. `--once` exits after one scan. Watcher findings are routed to
live project planners when possible and are otherwise reported through the
configured escalation path. A watcher does not edit the watched application.

## Trace and semantic evidence

```text
yano trace status [--project <name>]
yano trace enable --mode off|events|standard|full
yano trace disable
yano trace events [--project <name>] [--instance <id>] [--type <type>] [--since <ISO>] [--limit <n>] [--follow] [--json]
yano trace feedback --status accepted|partial|rejected --text <text> [--run <id>] [--round <n>] [--task <slug>]
yano trace context [--project <name>] [--run <id>] [--round <n>] [--task <slug>] [--since <ISO>] [--limit <n>] [--json]
yano trace opinion --text <text> [--summary <text>] [--root-cause <text>] [--recommendation <text>] [--change <type>] [--confidence low|medium|high] [--roles <csv>]
yano trace overview [--all-projects] [--since <ISO>] [--limit <n>] [--save] [--json]
yano trace index [filters] [--all-projects] [--batch-size <n>] [--force] [--json]
yano trace consolidate [filters] [--all-projects] [--json]
yano trace plan [filters] --query <text> [--budget <tokens>] [--json]
yano trace search --query <text> [filters] [--mode keyword|semantic|hybrid] [--memory-only] [--limit <n>] [--explain] [--include-payload] [--json]
yano trace export [--project <name>] [--run <id>] --output <file.json>
yano trace import --input <file.json> [--project <name>] [--reindex]
yano trace clear [--run <id>|--instance <id>|--before <ISO>|--all] --yes
```

Common filters include `--project`, `--run`, `--round`, `--task`,
`--instance`, `--type`, `--since`, `--limit`, and `--data-dir` where supported.
The raw observable trace is authoritative; the SQLite semantic index and
consolidated memories are derived data. Never clear evidence during an active
diagnosis.

## Recovery, update, and repair

```text
yano pause --run <id> [--project <name>] [--all] [--yes]
yano resume --run <id> [--project <name>] [--all] [--dry-run] [--yes]
yano recovery status|list [--project <name>]
yano repair [--project-root <dir>] [--dry-run|--yes] [--init-db] [--force]
yano repair --all-projects [--dry-run|--yes] [--update]
yano update --reload --dry-run
yano update --reload --yes [--timeout <seconds>] [--force]
```

`pause` writes a non-destructive checkpoint before a graceful stop. `resume`
reopens only missing agents and continues from durable assignments. `repair`
reconciles project identity, Herdr panes, MQTT presence, databases and
external-worker registrations; inspect its dry-run before applying it. `--all`
or `--all-projects` broadens scope and therefore needs extra care. `--force`
can interrupt an uncooperative process.

## Configuration and data root

```text
yano config path
yano config list [--all]
yano config get <KEY> [--show]
yano config set <KEY> <VALUE>
printf '%s' "$SECRET" | yano config set <KEY> --stdin
yano config unset <KEY>
yano data path
yano data migrate [--dry-run] [--yes] [--merge]
```

Secrets are masked by `config list` and should be supplied through stdin.
`YANO_DATA_DIR` is optional and platform-aware. The effective path is printed
by `yano trace status` and `yano data path`; do not assume it is inside the
installed package.

## Playbook and role catalog

```text
yano playbook list [--json]
yano playbook show <id> [--json]
yano playbook check <file> [--json]
yano playbook candidates --task <text> [--project-root <dir>] [--project <name>] [--json]
yano playbook export <id> [--out <file>]
yano playbook import <bundle.json> [--dry-run] [--once] [--json]
yano playbook remove <id> --yes
yano playbook purge <id> --yes
yano agent list [--json]
yano agent show <id> [--json]
```

`show` and `check` expose `credential_checks` and warnings. A missing
capability must be resolved before the playbook is described as operational.
Import and promotion are global catalog operations owned by Architect; a
personal playbook is soft-disabled by `remove` and physically deleted only by
the explicitly confirmed `purge` after removal.

## Architect

```text
yano architect assess --task <text> --project-root <dir> [--json]
yano architect candidates --task <text> --project-root <dir> [--json]
yano architect propose --task <text> --project-root <dir> [--new-playbook]
yano architect import --file <bundle.json> [--dry-run|--once] [--json]
yano architect interview --proposal-id <id> [--json]
yano architect answer --proposal-id <id> --status approved|changes_requested
yano architect team --proposal-id <id> --variant <id> [--json]
yano architect provision --proposal-id <id> [--install] [--dry-run|--once]
yano architect verify --proposal-id <id> [--json]
yano architect status --proposal-id <id> [--json]
yano architect validation --proposal-id <id> --run-id <id> --result passed|failed
yano architect feedback --proposal-id <id> --status positive|changes_requested|negative --text <text>
yano architect capability --proposal-id <id> --kind <kind> --name <name> --status ready --evidence <text>
yano architect revise --proposal-id <id> --task <text>
yano architect promote --proposal-id <id> --yes
yano architect start --proposal-id <id> [--dry-run|--once]
```

Architect may create a generic reusable playbook, not a project-specific copy.
The candidate remains ephemeral until capability readiness, bounded Watcher
validation, and planner/user feedback permit promotion.

## Debugger, auto-improver, suggester

```text
yano debugger init --project-root <dir>
yano debugger start --project-root <dir> [--dry-run|--once]
yano debugger status --project-root <dir> [--bug-id <id>]
yano debugger report --project-root <dir> --title <text> ...
yano debugger claim --project-root <dir> --bug-id <id>
yano debugger transition --project-root <dir> --bug-id <id> --to <state>
yano debugger pause|resume --project-root <dir>

yano auto-improve init --project-root <dir> --interval 5d --notify auto
yano auto-improve start|run --project-root <dir> [--dry-run] [--once]
yano auto-improve status|reports|pause|resume|stop --project-root <dir>
yano auto-improve complete --audit-id <id> --report-file <temp-file>

yano suggester init --project-root <dir> [--notify auto]
yano suggester submit --project-root <dir> --title <text> --description <text> [--queue-only] [--once]
yano suggester start --project-root <dir> [--dry-run] [--once]
yano suggester status|reports|pause|resume|stop --project-root <dir>
yano suggester complete --suggestion-id <id> --report-file <temp-file> --category <bug|feature|improvement|ux>
yano suggester approve --suggestion-id <id> --actor <superadmin> --yes
yano suggester reject --suggestion-id <id> --actor <superadmin> --reason <text> --yes
```

All three external agents have read-only contracts against the reference
application. Their records and reports live under the global data root and
are routed to the planner after their respective gates.

## Error handling

- Missing global configuration returns the variable names and an actionable
  `yano config set KEY ...` command. Use that command rather than writing
  secrets into the repository.
- A missing project database is not automatically an application failure.
  Use `yano repair --yes --init-db` only when the user asks to prepare the
  orchestration schema; the planner still needs to initialize a run.
- A missing live worker is not proven by one retained-card snapshot. Check
  Herdr reachability, `fleet`, the role's `projects` view, and recent trace
  events before repairing.
- If a command is not listed here, consult `yano --help` and the command's
  help in the installed version, then update this reference in a follow-up
  change rather than guessing.
