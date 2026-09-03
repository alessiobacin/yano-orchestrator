#!/usr/bin/env node
// `yano` — CLI unificata di yano-orchestrator (Revisione 31, vedi
// docs/notes/development-notes.md). Sostituisce il vecchio binario a sé
// `pi-orchestrator-init` con questi sottocomandi:
//
//   yano init [opzioni]    scaffolda l'estensione nella directory CORRENTE
//                        (default — vedi `yano init --help`), delega a
//                        scripts/create-project.mjs (runCreateProject()).
//   yano start [opzioni]   lancia planner-01 componendo i flag --skill per le
//                        skill vendorizzate mattpocock, delega a
//                        scripts/launch-planner.mjs (runLaunchPlanner()).
//   yano doctor            verifica che l'ambiente abbia tutto il necessario
//                        (git, `pi`, un broker MQTT disponibile) e stampa
//                        istruzioni di installazione per il tuo sistema
//                        operativo per ciò che manca (Revisione 33) — delega
//                        a scripts/doctor.mjs (runDoctor()). Girato anche in
//                        automatico in coda a `yano init`.
//   yano update [--check|--reload]  aggiorna l'installazione globale all'ultima
//                        versione del repo GitHub (Revisione 34) — delega a
//                        scripts/update.mjs (runUpdate()).
//   yano uninstall [--yes] rimuove l'installazione globale (Revisione 34) —
//                        delega a scripts/uninstall.mjs (runUninstall()).
//   yano end [opzioni]     chiude i run "active" del layer ticket/DAG per il
//                        progetto nella directory corrente (Revisione 38) —
//                        delega a scripts/end-project.mjs (runEndProject()).
//   yano copy-prompts      copia prompts/ dal pacchetto installato dentro
//                        <progetto>/.pi/extensions/yano-orchestrator/prompts/,
//                        per chi vuole personalizzarli per QUESTO progetto
//                        (Revisione 47) — delega a scripts/copy-prompts.mjs
//                        (runCopyPrompts()). Da solo non cambia nulla: serve
//                        anche `yano start ... --custom-prompts` per farli
//                        usare davvero (default: i prompt si leggono sempre
//                        dal pacchetto installato, mai da una copia locale
//                        — vedi extensions/orchestrator.ts).
//   yano status|logs|fleet|mcp|skills  viste read-only del progetto e della flotta
//   yano deps              capability preflight per CLI, credenziali e auth
//   yano docs-check        verifica scriptata delle otto categorie canoniche
//                        sotto docs/ (Ticket #124) — delega a
//                        scripts/yano-docs-check.mjs (runYanoDocsCheck()).
//   yano qa-inventory scan raccoglie meccanicamente le fonti (README,
//                        docs/guides, --help reale) per l'audit QA
//                        (Ticket #124) — delega a scripts/yano-qa-inventory.mjs
//                        (runYanoQaInventory()).
//   yano gantt              dashboard web locale live dei run/ticket
//   yano watch              watcher dei ticket stalled
//   yano trace              attiva, consulta, indicizza e cancella il tracing globale
//   yano auto-improve       esegue audit periodici read-only e inoltra report al planner
//   yano model-advisor     propone un provider:model pinnato per role-class
//                        in base ai dati live di llmProxy (costo/coding/
//                        latenza) — delega a scripts/yano-model-advisor.mjs
//                        (runYanoModelAdvisor()).
//   yano architect          crea, prepara e promuove playbook/ruoli globali
//   yano playbook|agent     consulta il catalogo globale di playbook e ruoli
//
// Installazione: `npm install -g <repo>` (o `npm link` in locale, per lo
// sviluppo di questo pacchetto stesso) espone `yano` sul PATH — campo "bin" di
// package.json.
//
// Perché un binario dedicato invece di un vero sottocomando `pi yano` o `pi
// orchestrator`: come già documentato in scripts/create-project.mjs, non
// esiste in questo codebase nessuna evidenza che la CLI `pi` supporti
// sottocomandi shell registrati da un'estensione — solo slash-command
// dentro una sessione già avviata. `yano` è quindi un binario NPM separato,
// non un plugin di `pi`.

import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCreateProject } from "../scripts/create-project.mjs";
import { runLaunchPlanner } from "../scripts/launch-planner.mjs";
import { runDoctor } from "../scripts/doctor.mjs";
import { runUpdate } from "../scripts/update.mjs";
import { runUninstall } from "../scripts/uninstall.mjs";
import { runEndProject } from "../scripts/end-project.mjs";
import { runCopyPrompts } from "../scripts/copy-prompts.mjs";
import { runYanoStatus } from "../scripts/yano-status.mjs";
import { runYanoDeps } from "../scripts/yano-deps.mjs";
import { runGantt } from "../scripts/gantt-server.mjs";
import { runWatch } from "../scripts/watch-stalls.mjs";
import { runTrace } from "../scripts/yano-trace.mjs";
import { runYanoWatcherRegistry } from "../scripts/yano-watcher-registry.mjs";
import { runYanoAutoImprove } from "../scripts/yano-auto-improver.mjs";
import { runYanoFeedback } from "../scripts/yano-feedback.mjs";
import { runYanoModelAdvisor } from "../scripts/yano-model-advisor.mjs";
import { runYanoArchitect } from "../scripts/yano-architect.mjs";
import { runYanoCatalog } from "../scripts/yano-catalog.mjs";
import { runYanoData } from "../scripts/yano-data.mjs";
import { runRecovery } from "../scripts/yano-recovery.mjs";
import { runRepair } from "../scripts/yano-repair.mjs";
import { runExternalStatus } from "../scripts/yano-external-status.mjs";
import { applyGlobalConfig, runYanoConfig } from "../scripts/yano-config.mjs";
import { runYanoHarnessSkills } from "../scripts/install-yano-cli.mjs";
import { runYanoProjects } from "../scripts/yano-projects.mjs";
import { runYanoRules } from "../scripts/yano-rules.mjs";
import { runYanoScheduler } from "../scripts/yano-scheduler.mjs";
import { runYanoInvoke } from "../scripts/yano-invoke.mjs";
import { runYanoLocalPc } from "../scripts/yano-local-pc.mjs";
import { runYanoServices } from "../scripts/yano-services.mjs";
import { runYanoDocsCheck } from "../scripts/yano-docs-check.mjs";
import { runYanoQaInventory } from "../scripts/yano-qa-inventory.mjs";
import { runYanoAgentMcp } from "../scripts/yano-agent-mcp.mjs";
import { runFrontendReview } from "../scripts/yano-frontend-review.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const cwd = process.cwd();

// Load per-user global configuration before choosing defaults or spawning Pi.
// A development checkout .env is supported, but the npm package never ships
// user secrets and a global-only installation has no dependency on it.
applyGlobalConfig({ packageRoot });

// The CLI and the Pi extension may be loaded from different installations
// (npm global package vs ~/.pi/agent/git/... clone). Child processes resolve
// the same per-user data root through yano-config. An explicit YANO_DATA_DIR
// remains authoritative; no data is silently written inside the package.

function printTopUsage() {
	console.log(
		[
			"Uso: yano <comando> [opzioni]",
			"",
			"Comandi:",
			'  init [opzioni]   Scaffolda yano-orchestrator nella directory corrente (default) — `yano init --help`',
			"  start [opzioni]  Lancia un ruolo; `--herdr` crea una tab nel solo workspace verificato del progetto — `yano start --help`",
			"  doctor [--json]  Verifica prerequisiti; --json restituisce un risultato machine-readable",
			"  update [--check|--reload] Aggiorna Yano; --reload pausa/salva/riavvia le istanze Herdr del progetto corrente",
			"  uninstall [--yes] Rimuove l'installazione globale",
			'  end [opzioni]    Chiude i run "active" del progetto nella directory corrente — `yano end --help`',
			'  leave [--project-root <dir>] --yes Rimuove definitivamente il progetto corrente dal registro watcher',
			"  copy-prompts     Copia prompts/ dal pacchetto installato nel progetto corrente, per personalizzarli",
			"  frontend-review setup|start  Prepara Agentation e avvia il frontend dev con URL inferito",
			"  status|logs|fleet|mcp          Viste read-only del progetto e della flotta",
			"  projects [--json]             Conta i progetti Yano con agenti live in Herdr",
			"  skills install|status        Installa/verifica yano-cli negli harness globali",
			"  deps [opzioni]   Verifica CLI, credenziali e autenticazione richieste dal task",
			"  docs-check [--project-root <dir>] [--json]  Verifica scriptata delle otto categorie canoniche sotto docs/",
			"  qa-inventory scan [--project-root <dir>] [--yano-self-audit] [--json]  Bozza grezza dell'inventario comandi/funzionalità",
			"  gantt [opzioni]  Dashboard per progetto; --persistent registra il link, --link/--links lo recuperano",
			"  watch [opzioni]  Osserva stall e segnala falle Yano ( --once | --project-root | --lookback-ms | --interval-ms )",
			"  architect projects|watcher projects|auto-improve|auto-improver projects",
			"                   Elenca i progetti attivi dei worker esterni (aggiungi --all per gli offline)",
			"  trace [opzioni]  Attiva/disattiva, cerca e cancella il tracing globale — `yano trace --help`",
			"  auto-improve [opzioni] Audit periodici read-only e report al planner — `yano auto-improve --help`",
			"  feedback serve|create|list|get|update|delete  CRUD bug e suggestions — API su porta 20002",
			"  model-advisor [opzioni] Propone un provider:model pinnato da llmProxy per role-class — `yano model-advisor --help`",
			"  architect [opzioni]  Progetta/provisiona playbook e ruoli globali — `yano architect --help`",
			"  playbook|agent [opzioni] Catalogo read-only di playbook, ruoli e capability",
			"  config [opzioni] Gestisce la configurazione globale utente — `yano config --help`",
			"  rule [opzioni]   Gestisce regole globali e per-progetto — `yano rule --help`",
			"  schedule [opzioni] Crea job ricorrenti a script; cron persistente e ripulibile — `yano schedule --help`",
			"  cron [opzioni]  CRUD naturale dei job ricorrenti e supervisore yano-scheduler — `yano cron --help`",
			"  local-pc start|status|ask  Agente del PC sviluppatore — `yano local-pc --help`",
			"  services [opzioni] Registro servizi esterni (Docker/pm2/comando) con health-check e restart deterministico — `yano services --help`",
			"  data [opzioni]    Mostra o migra il data-root globale — `yano data --help`",
			"  pause [opzioni]  Salva uno snapshot non distruttivo e mette in pausa i run",
			"  resume [opzioni] Ripristina uno snapshot e riapre gli agenti mancanti",
			"  recovery [opzioni] Ispeziona gli snapshot e lo stato di ripristino",
			"  repair [opzioni]   Riconcilia progetto o tutti i progetti attivi, agenti Herdr/MQTT e versione Yano",
			"",
			"  --version, -v    Stampa la versione del pacchetto installato",
			"  --help, -h       Mostra questo messaggio",
		].join("\n"),
	);
}

async function main() {
	const [sub, ...rest] = process.argv.slice(2);

	if (!sub) {
		printTopUsage();
		process.exit(1);
	}
	if (sub === "--help" || sub === "-h") {
		printTopUsage();
		process.exit(0);
	}
	if (sub === "--version" || sub === "-v") {
		const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
		console.log(pkg.version);
		process.exit(0);
	}
	if (sub === "init") {
		await runCreateProject({ packageRoot, cwd, argv: rest });
		return;
	}
	if (sub === "start") {
		runLaunchPlanner({ packageRoot, cwd, argv: rest });
		return;
	}
	if (sub === "doctor") {
		if (rest.includes("--network")) {
			await runYanoStatus({ cwd, argv: ["doctor", "--network"] });
			return;
		}
		const { ok } = await runDoctor({ cwd, json: rest.includes("--json") });
		process.exit(ok ? 0 : 1);
	}
	if (sub === "update") {
		await runUpdate({ packageRoot, cwd, argv: rest });
		return;
	}
	if (sub === "uninstall") {
		await runUninstall({ packageRoot, argv: rest });
		return;
	}
	if (sub === "end") {
		await runEndProject({ cwd, argv: rest });
		return;
	}
	if (sub === "copy-prompts") {
		runCopyPrompts({ packageRoot, cwd });
		return;
	}
	if (sub === "frontend-review") {
		await runFrontendReview({ cwd, argv: rest });
		return;
	}
	if (sub === "projects") {
		runYanoProjects({ argv: rest });
		return;
	}
	if (sub === "rule" || sub === "rules") {
		runYanoRules({ argv: rest });
		return;
	}
	if (sub === "schedule") {
		await runYanoScheduler({ argv: rest });
		return;
	}
	if (sub === "invoke") {
		await runYanoInvoke({ argv: rest });
		return;
	}
	if (sub === "local-pc") {
		await runYanoLocalPc({ argv: rest });
		return;
	}
	if (sub === "cron") {
		if (rest.includes("--help") || rest.includes("-h")) { await runYanoScheduler({ argv: ["--help"] }); return; }
		const json = rest.includes("--json") ? ["--json"] : [];
		const rootIndex = rest.indexOf("--project-root");
		const projectRoot = rootIndex >= 0 ? rest[rootIndex + 1] : cwd;
		if (rest.includes("--add")) await runYanoScheduler({ argv: ["add-natural", "--task", rest[rest.indexOf("--add") + 1], "--project-root", projectRoot, ...json] });
		else if (rest.includes("--list")) await runYanoScheduler({ argv: ["list", ...json] });
		else if (rest.includes("--remove")) await runYanoScheduler({ argv: ["remove", "--id", rest[rest.indexOf("--remove") + 1], ...json] });
		else if (rest.includes("--enable")) await runYanoScheduler({ argv: ["enable", "--id", rest[rest.indexOf("--enable") + 1], ...json] });
		else if (rest.includes("--disable")) await runYanoScheduler({ argv: ["disable", "--id", rest[rest.indexOf("--disable") + 1], ...json] });
		else if (rest.includes("--run")) await runYanoScheduler({ argv: ["run", "--id", rest[rest.indexOf("--run") + 1], ...json] });
		else if (rest.includes("--supervise")) await runYanoScheduler({ argv: ["supervise", ...json] });
		else if (rest.includes("--install")) await runYanoScheduler({ argv: ["cron", "install", ...json] });
		else if (rest.includes("--uninstall")) await runYanoScheduler({ argv: ["cron", "remove", ...json] });
		else await runYanoScheduler({ argv: ["cron", "status", ...json] });
		return;
	}
	if (sub === "services") {
		await runYanoServices({ argv: rest });
		return;
	}
	if (sub === "skills") {
		if (rest[0] === "install" || rest[0] === "status" || rest.includes("--help") || rest.includes("-h") || rest.includes("--dry-run") || rest.includes("--force") || rest.includes("--no-prune-duplicates")) {
			await runYanoHarnessSkills({ packageRoot, argv: rest });
			return;
		}
		await runYanoStatus({ cwd, argv: [sub, ...rest] });
		return;
	}
	if (["status", "logs", "fleet", "mcp"].includes(sub)) {
		if (sub === "mcp" && rest[0] === "agent") { runYanoAgentMcp({ argv: rest.slice(1) }); return; }
		await runYanoStatus({ cwd, argv: [sub, ...rest] });
		return;
	}
	if (sub === "deps") {
		await runYanoDeps({ cwd, argv: rest });
		return;
	}
	if (sub === "docs-check") {
		const report = await runYanoDocsCheck({ cwd, argv: rest });
		process.exitCode = report.help || report.ok ? 0 : 1;
		return;
	}
	if (sub === "qa-inventory") {
		const report = await runYanoQaInventory({ cwd, argv: rest });
		process.exitCode = report.help || report.ok ? 0 : 1;
		return;
	}
	if (sub === "gantt") {
		await runGantt({ cwd, argv: rest, packageRoot });
		return;
	}
	if (sub === "watch") {
		if (rest[0] === "projects" || rest.includes("--projects")) {
			await runExternalStatus({ role: "watcher", argv: rest });
			return;
		}
		await runWatch({ cwd, argv: rest });
		return;
	}
	if (sub === "trace") {
		await runTrace({ cwd, argv: rest });
		return;
	}
	if (sub === "feedback" || sub === "bug" || sub === "bugs" || sub === "suggestion" || sub === "suggestions") {
		const type = sub === "bug" || sub === "bugs" ? "bug" : sub === "suggestion" || sub === "suggestions" ? "suggestion" : null;
		await runYanoFeedback({ argv: sub === "feedback" ? rest : [rest[0] || "list", ...(type ? ["--type", type] : []), ...rest.slice(1)] });
		return;
	}
	if (sub === "auto-improve" || sub === "auto-improver") {
		if (rest[0] === "projects" || rest.includes("--projects")) {
			await runExternalStatus({ role: "auto-improver", argv: rest });
			return;
		}
		await runYanoAutoImprove({ argv: rest });
		return;
	}
	if (sub === "model-advisor") {
		await runYanoModelAdvisor({ argv: rest });
		return;
	}
	if (sub === "architect") {
		if (rest[0] === "projects" || rest.includes("--projects")) {
			await runExternalStatus({ role: "architect", argv: rest });
			return;
		}
		await runYanoArchitect({ argv: rest });
		return;
	}
	if (sub === "watcher") {
		if (rest[0] === "projects" || rest[0] === "list" || rest.includes("--projects")) {
			await runYanoWatcherRegistry({ argv: [rest[0] === "--projects" ? "projects" : rest[0], ...rest.slice(rest[0] === "--projects" ? 0 : 1)] });
			return;
		}
		if (rest.length === 1 && rest[0] === "--json") {
			await runYanoWatcherRegistry({ argv: ["status", "--json"] });
			return;
		}
		if (rest.includes("--help") || rest.includes("-h")) {
			await runYanoWatcherRegistry({ argv: ["--help"] });
			return;
		}
		if (["init", "start", "status", "pause", "resume", "leave", "supervise", "cron"].includes(rest[0])) {
			await runYanoWatcherRegistry({ argv: rest });
			return;
		}
	console.error("Uso: yano watcher <init|start|status|pause|resume|leave|supervise|cron|projects|list> [opzioni]");
		process.exit(1);
	}
	if (sub === "leave") {
		const leaveArgs = rest.includes("--project-root") ? rest : ["--project-root", cwd, ...rest];
		await runYanoWatcherRegistry({ argv: ["leave", ...leaveArgs] });
		return;
	}
	if (sub === "playbook" || sub === "agent") {
		await runYanoCatalog({ kind: sub, argv: rest });
		return;
	}
	if (sub === "config") {
		await runYanoConfig({ argv: rest });
		return;
	}
	if (sub === "data") {
		runYanoData({ packageRoot, argv: rest });
		return;
	}
	if (["pause", "resume", "recovery"].includes(sub)) {
		await runRecovery({ cwd, argv: [sub, ...rest], packageRoot });
		return;
	}
	if (sub === "repair") {
		await runRepair({ cwd, argv: rest, packageRoot });
		return;
	}

	console.error(`yano: comando sconosciuto "${sub}" (vedi \`yano --help\`).`);
	process.exit(1);
}

main().catch((err) => {
	console.error(`yano: errore inatteso — ${err instanceof Error ? err.stack || err.message : String(err)}`);
	process.exit(1);
});
