#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	TRACE_MODES,
	clearTraceData,
	appendTraceRecord,
	buildTraceOverview,
	getTraceConfig,
	listTraceProjects,
	readTraceRecords,
	resolveTraceProject,
	setTraceMode,
	tracePaths,
} from "./yano-trace-storage.mjs";

function value(argv, flag) {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : null;
}

function has(argv, flag) { return argv.includes(flag); }

function csv(value) {
	return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function validDate(value, flag) {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`${flag} non valida: ${value}`);
	return date;
}

function usage() {
	console.log([
		"Uso: yano trace <status|enable|disable|events|clear> [opzioni]",
		"",
		"  status                         mostra modalità e directory globale",
		"  enable --mode <mode>           attiva off|events|standard|full",
		"  disable                        equivalente a enable --mode off",
		"  events [--follow]              mostra gli eventi raw del run/agente",
		"  feedback --status <s> --text  registra il verdetto dell'utente sul round",
		"  context [filtri]               prepara il contesto compatto per il planner",
		"  opinion --text <testo>         salva l'opinione del planner sul fallimento",
		"  overview [--all-projects]      aggrega errori e pattern tra progetti/round",
		"  clear --yes                    cancella il tracing del progetto corrente",
		"  clear --run <id> --yes         cancella solo gli eventi di un run",
		"  clear --instance <id> --yes   cancella solo gli eventi di un agente",
		"  clear --before <ISO> --yes     cancella eventi precedenti a una data",
		"  clear --all --yes              cancella tutto il temp globale di Yano",
		"",
		"Opzioni comuni: --project <nome>, --data-dir <directory>",
		"Filtri: --run <id>, --round <n>, --task <slug>, --since <ISO>, --limit <n>, --json",
	].join("\n"));
}

function eventFilter(argv) {
	return {
		run: value(argv, "--run"),
		instance: value(argv, "--instance"),
		type: value(argv, "--type"),
		since: validDate(value(argv, "--since"), "--since"),
	};
}

function matchingEvents(records, filters) {
	return records
		.filter((record) => !record.record_type)
		.filter((record) => !filters.run || record.run_id === filters.run)
		.filter((record) => !filters.instance || record.instance === filters.instance)
		.filter((record) => !filters.type || record.type === filters.type)
		.filter((record) => !filters.since || !record.ts || new Date(record.ts).getTime() >= filters.since.getTime());
}

function eventIdentity(event) {
	return [event.project_key, event.instance, event.seq, event.ts, event.type, event.tool_call_id].map((part) => String(part ?? "")).join("|");
}

function printEvents(events, json) {
	for (const event of events) console.log(json ? JSON.stringify(event) : `${event.ts || "?"} ${event.instance || "?"} ${event.type || "?"}${event.tool ? ` tool=${event.tool}` : ""}${event.ok === false ? " FAILED" : ""}`);
}

async function followEvents({ cwd, project, argv }) {
	const filters = eventFilter(argv);
	const limit = Math.max(1, Number(value(argv, "--limit") || 50));
	const json = has(argv, "--json");
	const emitted = new Set();
	let firstPoll = true;
	const poll = () => {
		const all = readTraceRecords({ cwd, project, allProjects: has(argv, "--all-projects"), limit: 100000 });
		const events = matchingEvents(all, filters);
		const pending = firstPoll ? events.slice(-limit) : events;
		const fresh = pending.filter((event) => !emitted.has(eventIdentity(event)));
		fresh.forEach((event) => emitted.add(eventIdentity(event)));
		if (fresh.length) printEvents(fresh, json);
		firstPoll = false;
	};
	poll();
	process.once("SIGINT", () => process.exit(0));
	while (true) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		poll();
	}
}

function applyDataDir(argv) {
	const dataDir = value(argv, "--data-dir");
	if (dataDir) process.env.YANO_DATA_DIR = path.resolve(dataDir);
}

export async function runTrace({ cwd, argv }) {
	applyDataDir(argv);
	const sub = argv[0];
	if (!sub || sub === "--help" || sub === "-h") { usage(); return; }
	const project = value(argv, "--project") || resolveTraceProject(cwd);

	if (sub === "status") {
		const cfg = getTraceConfig({ cwd, project });
		const paths = tracePaths({ cwd, project });
		console.log(`yano trace: progetto "${cfg.project}" — modalità ${cfg.mode}`);
		console.log(`   root globale: ${cfg.root}`);
		console.log(`   progetto trace: ${paths.projectDir}`);
		const projects = listTraceProjects();
		if (projects.length) console.log(`   progetti indicizzati: ${projects.length}`);
		return cfg;
	}

	if (sub === "enable" || sub === "disable") {
		const mode = sub === "disable" ? "off" : (value(argv, "--mode") || "standard");
		if (!TRACE_MODES.includes(mode)) throw new Error(`modalità non valida "${mode}" (scegli: ${TRACE_MODES.join(", ")})`);
		const cfg = setTraceMode({ cwd, project, mode });
		console.log(`yano trace: modalità "${cfg.mode}" attivata per "${cfg.project}".`);
		console.log(`   dati: ${cfg.root}`);
		return cfg;
	}

	if (sub === "feedback") {
		const status = value(argv, "--status");
		const text = value(argv, "--text");
		if (!["accepted", "partial", "rejected"].includes(status)) throw new Error("feedback: --status deve essere accepted, partial oppure rejected");
		if (!text?.trim()) throw new Error("feedback: --text è obbligatorio e deve contenere il feedback reale dell'utente");
		const entry = appendTraceRecord({
			cwd,
			project,
			kind: "feedback",
			record: {
				status,
				text: text.trim(),
				run_id: value(argv, "--run"),
				round: value(argv, "--round"),
				task_slug: value(argv, "--task"),
				tags: csv(value(argv, "--tags")),
				source: "user",
			},
		});
		const snapshot = buildTraceOverview({ cwd, project, allProjects: false });
		const summary = appendTraceRecord({
			cwd,
			project,
			kind: "summary",
			record: {
				summary_kind: "feedback_snapshot",
				feedback_id: entry.id,
				run_id: entry.run_id,
				round: entry.round,
				task_slug: entry.task_slug,
				totals: snapshot.totals,
				failure_signals: snapshot.failure_signals,
				feedback_patterns: snapshot.feedback_patterns,
			},
		});
		console.log(`yano trace: feedback ${status} registrato (${entry.id}).`);
		console.log(`   snapshot round: ${summary.id}`);
		return { feedback: entry, summary };
	}

	if (sub === "context") {
		const since = validDate(value(argv, "--since"), "--since");
		const limit = Math.max(1, Number(value(argv, "--limit") || 120));
		let records = readTraceRecords({ cwd, project, since, limit: Math.max(limit * 5, 500) });
		const run = value(argv, "--run");
		const round = value(argv, "--round");
		const task = value(argv, "--task");
		if (run) records = records.filter((record) => record.run_id === run);
		if (round) records = records.filter((record) => String(record.round) === String(round));
		if (task) records = records.filter((record) => record.task_slug === task || record.slug === task);
		const context = {
			generated_at: new Date().toISOString(),
			project,
			filters: { run, round, task, since: since?.toISOString() || null },
			records: records.slice(-limit),
		};
		if (has(argv, "--json")) console.log(JSON.stringify(context, null, 2));
		else {
			console.log(`yano trace context: ${context.records.length} record(s) per "${project}"`);
			for (const record of context.records) console.log(JSON.stringify(record));
		}
		return context;
	}

	if (sub === "events") {
		const filters = eventFilter(argv);
		if (has(argv, "--follow")) return followEvents({ cwd, project, argv });
		const limit = Math.max(1, Number(value(argv, "--limit") || 50));
		const events = matchingEvents(
			readTraceRecords({ cwd, project, allProjects: has(argv, "--all-projects"), since: filters.since, limit: 100000 }),
			filters,
		).slice(-limit);
		if (has(argv, "--json")) console.log(JSON.stringify(events, null, 2));
		else {
			console.log(`yano trace events: ${events.length} evento/i per "${project}"`);
			printEvents(events, false);
		}
		return events;
	}

	if (sub === "opinion") {
		const text = value(argv, "--text");
		if (!text?.trim()) throw new Error("opinion: --text è obbligatorio");
		const confidence = value(argv, "--confidence") || "medium";
		if (!["low", "medium", "high"].includes(confidence)) throw new Error("opinion: --confidence deve essere low, medium oppure high");
		const entry = appendTraceRecord({
			cwd,
			project,
			kind: "opinion",
			record: {
				text: text.trim(),
				summary: value(argv, "--summary"),
				root_cause: value(argv, "--root-cause"),
				recommendation: value(argv, "--recommendation"),
				confidence,
				change_type: value(argv, "--change") || "unknown",
				affected_roles: csv(value(argv, "--roles")),
				run_id: value(argv, "--run"),
				round: value(argv, "--round"),
				task_slug: value(argv, "--task"),
				author: "planner",
			},
		});
		console.log(`yano trace: opinione planner registrata (${entry.id}).`);
		return entry;
	}

	if (sub === "overview") {
		const since = validDate(value(argv, "--since"), "--since");
		const overview = buildTraceOverview({ cwd, project, allProjects: has(argv, "--all-projects"), since, limit: Math.max(1, Number(value(argv, "--limit") || 10000)) });
		if (has(argv, "--save")) {
			const saved = appendTraceRecord({ cwd, project, kind: "summary", record: { summary_kind: "overview", scope: overview.scope, overview } });
			console.log(`yano trace: overview salvata (${saved.id}).`);
		}
		if (has(argv, "--json")) console.log(JSON.stringify(overview, null, 2));
		else {
			console.log(`yano trace overview (${overview.scope})`);
			console.log(`   feedback: ${overview.totals.feedback} — rejected: ${overview.totals.rejected}, partial: ${overview.totals.partial}, accepted: ${overview.totals.accepted}`);
			console.log(`   opinioni planner: ${overview.totals.opinions}`);
			console.log(`   failure signals: ${JSON.stringify(overview.failure_signals)}`);
			console.log(`   feedback patterns: ${JSON.stringify(overview.feedback_patterns)}`);
		}
		return overview;
	}

	if (sub === "clear" || sub === "purge") {
		if (!has(argv, "--yes")) throw new Error("cancellazione distruttiva: aggiungi --yes per confermare");
		const all = has(argv, "--all");
		const beforeValue = value(argv, "--before");
		const before = beforeValue ? new Date(beforeValue) : null;
		if (beforeValue && Number.isNaN(before.getTime())) throw new Error(`data --before non valida: ${beforeValue}`);
		const result = clearTraceData({
			cwd,
			project,
			run: value(argv, "--run"),
			instance: value(argv, "--instance"),
			type: value(argv, "--type"),
			before,
			all,
		});
		console.log(all
			? `yano trace: cancellato tutto il contenuto globale di ${result.root}`
			: `yano trace: cancellati ${result.events} eventi in ${result.files} file per "${project}".`);
		return result;
	}

	usage();
	throw new Error(`sottocomando trace sconosciuto "${sub}"`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runTrace({ cwd: process.cwd(), argv: process.argv.slice(2) }).catch((error) => { console.error(`yano trace: ${error.message}`); process.exit(1); });
