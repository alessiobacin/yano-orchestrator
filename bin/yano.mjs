#!/usr/bin/env node
// `yano` — CLI unificata di yano-orchestrator (Revisione 31, vedi
// docs/development-notes.md). Sostituisce il vecchio binario a sé
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
//   yano gantt              dashboard web locale live dei run/ticket
//   yano watch              watcher dei ticket stalled
//   yano trace              attiva, consulta, indicizza e cancella il tracing globale
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
import { runRecovery } from "../scripts/yano-recovery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const cwd = process.cwd();

// The CLI and the Pi extension may be loaded from different installations
// (npm global package vs ~/.pi/agent/git/... clone). Make every child started
// by this CLI inherit the same trace root. An explicit YANO_DATA_DIR remains
// authoritative, and `yano trace --data-dir` can still inspect another store.
process.env.YANO_DATA_DIR ??= path.join(packageRoot, "temp");

function printTopUsage() {
	console.log(
		[
			"Uso: yano <comando> [opzioni]",
			"",
			"Comandi:",
			'  init [opzioni]   Scaffolda yano-orchestrator nella directory corrente (default) — `yano init --help`',
			"  start [opzioni]  Lancia planner-01 con le skill vendorizzate mattpocock — `yano start --help`",
			"  doctor [--json]  Verifica prerequisiti; --json restituisce un risultato machine-readable",
			"  update [--check|--reload] Aggiorna Yano; --reload pausa/salva/riavvia le istanze Herdr del progetto corrente",
			"  uninstall [--yes] Rimuove l'installazione globale",
			'  end [opzioni]    Chiude i run "active" del progetto nella directory corrente — `yano end --help`',
			"  copy-prompts     Copia prompts/ dal pacchetto installato nel progetto corrente, per personalizzarli",
			"  status|logs|fleet|mcp|skills  Viste read-only del progetto e della flotta",
			"  deps [opzioni]   Verifica CLI, credenziali e autenticazione richieste dal task",
			"  gantt [opzioni]  Avvia la dashboard web live dei run/ticket",
			"  watch [opzioni]  Osserva stall e segnala falle Yano ( --once | --project-root | --yano-repo )",
			"  trace [opzioni]  Attiva/disattiva, cerca e cancella il tracing globale — `yano trace --help`",
			"  pause [opzioni]  Salva uno snapshot non distruttivo e mette in pausa i run",
			"  resume [opzioni] Ripristina uno snapshot e riapre gli agenti mancanti",
			"  recovery [opzioni] Ispeziona gli snapshot e lo stato di ripristino",
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
	if (["status", "logs", "fleet", "mcp", "skills"].includes(sub)) {
		await runYanoStatus({ cwd, argv: [sub, ...rest] });
		return;
	}
	if (sub === "deps") {
		await runYanoDeps({ cwd, argv: rest });
		return;
	}
	if (sub === "gantt") {
		await runGantt({ cwd, argv: rest, packageRoot });
		return;
	}
	if (sub === "watch") {
		await runWatch({ cwd, argv: rest });
		return;
	}
	if (sub === "trace") {
		await runTrace({ cwd, argv: rest });
		return;
	}
	if (["pause", "resume", "recovery"].includes(sub)) {
		await runRecovery({ cwd, argv: [sub, ...rest], packageRoot });
		return;
	}

	console.error(`yano: comando sconosciuto "${sub}" (vedi \`yano --help\`).`);
	process.exit(1);
}

main().catch((err) => {
	console.error(`yano: errore inatteso — ${err instanceof Error ? err.stack || err.message : String(err)}`);
	process.exit(1);
});
