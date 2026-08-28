#!/usr/bin/env node
// `yano watch` — zero-token stall watcher (Ticket 04).
//
// A standalone detector that runs OUTSIDE any `pi` session (no LLM context at
// all — this process never calls an LLM). It periodically queries the local
// orchestrator.db for tickets stuck in "running" past a configured stall
// threshold and, when one is found:
//   - publishes a `ticket_stalled` event on the run's MQTT event topic
//     (pi/<project>/runs/<run>/events) so any live planner/widget sees it,
//   - appends a JSONL marker to the workspace logs area, and
//   - optionally sends a WhatsApp tripwire (same env contract as the extension).
//
// Why it exists: the in-process watchdog (Revisione 29) only runs while a
// planner instance is alive. `yano watch` detaches detection+alerting from any
// live session — pure Node + sqlite + mqtt, zero tokens. It does NOT judge
// (lento vs bloccato) and does NOT act on the ticket: surfacing/pinging/
// failing stays the planner's decision (resumability contract). Idempotent:
// it only reads SQLite and appends markers.
//
// Complementary, not a replacement: keep the in-process watchdog for the
// planner's own wake; run `yano watch` in a Herdr pane as a
// detached tripwire so stalls are still surfaced when no planner is open.
//
// Uso:
//   yano watch [--project <slug>] [--project-root <dir>]
//              [--lookback-ms 86400000] [--stall-ms 900000]
//              [--interval-ms 60000] [--once] [--away]
//              [--validation-run <id>] [--playbook-proposal <id>]
//   (in locale: node scripts/watch-stalls.mjs [stesse opzioni])
//
// Away-mode (Ticket 07): con `--away` il watcher assorbe il rumore di routine
// (una passata senza stall è silenziosa) e alza SOLO le decisioni vere (uno o
// più stall), incluse le notifiche WhatsApp. Nessun LLM extra — è il filtro di
// priorità in pura logica.
//
// Oppure `--away` può essere guidato da env: quando PI_ORCH_AWAY=1 la routine
// viene assorbita allo stesso modo, così il watcher può essere lanciato una
// volta e rimanere silenzioso mentre l'operatore è lontano.

import { existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import mqtt from "mqtt";
import { readTraceRecords, tracePaths } from "./yano-trace-storage.mjs";
import { appendRawTraceRecord } from "./yano-trace-storage.mjs";
import { processYanoWatcherFindings, resolveYanoRepository, sendTelegramWatcherNotification } from "./yano-watcher-findings.mjs";
import { missingConfigError, resolveYanoConfig } from "./yano-config.mjs";
import { projectDbPath } from "./yano-project.mjs";

const yanoRequire = createRequire(import.meta.url);
let missingYanoRepoWarned = false;

function parseArgs(argv) {
	const o = { project: null, projectRoot: null, lookbackMs: 86_400_000, stallMs: 900000, intervalMs: 60000, once: false, away: false, validationRun: null, playbookProposal: null, playbookId: null, playbookChecksum: null, validationRound: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--project") o.project = argv[++i];
		else if (a === "--project-root") o.projectRoot = argv[++i];
		else if (a === "--lookback-ms") o.lookbackMs = Number(argv[++i]);
		else if (a === "--stall-ms") o.stallMs = Number(argv[++i]);
		else if (a === "--interval-ms") o.intervalMs = Number(argv[++i]);
		else if (a === "--once") o.once = true;
		else if (a === "--away" || a === "-aw") o.away = true;
		else if (a === "--validation-run") o.validationRun = argv[++i];
		else if (a === "--playbook-proposal") o.playbookProposal = argv[++i];
		else if (a === "--playbook-id") o.playbookId = argv[++i];
		else if (a === "--playbook-checksum") o.playbookChecksum = argv[++i];
		else if (a === "--validation-round") o.validationRound = argv[++i];
	}
	return o;
}

function appendWatcherScan({ cwd, project, opts, startedAt, status, reason = null, stalls = 0, findings = 0, liveAgents = 0, livePlanners = 0 }) {
	const completedAtMs = Date.now();
	const completedAt = new Date(completedAtMs).toISOString();
	const entry = {
		ts: completedAt,
		type: "yano_watcher_scan",
		record_type: "event",
		source: "yano-watcher",
		instance: "yano-watcher",
		scan_id: crypto.randomUUID(),
		started_at: startedAt,
		completed_at: completedAt,
		duration_ms: Math.max(0, completedAtMs - new Date(startedAt).getTime()),
		mode: opts.validationRun ? "validation" : "continuous",
		once: opts.once,
		interval_ms: opts.intervalMs,
		lookback_ms: opts.lookbackMs,
		stall_ms: opts.stallMs,
		away: awayEnabled(opts),
		status,
		reason,
		stalls,
		findings,
		live_agents: liveAgents,
		live_planners: livePlanners,
		validation_run_id: opts.validationRun || null,
		proposal_id: opts.playbookProposal || null,
		playbook_id: opts.playbookId || null,
	};
	try { appendRawTraceRecord({ cwd, project, record: entry }); } catch { /* tracing must never block the watcher */ }
	return entry;
}

function resolveProject(cwd) {
	const cfgPath = path.join(cwd, ".pi", "extensions", "yano-orchestrator", "config", "project.json");
	try {
		const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
		if (cfg.project) return cfg.project;
	} catch { /* fallthrough */ }
	try {
		const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8"));
		if (pkg.name && !String(pkg.name).startsWith("@otomatik/yano-")) return pkg.name;
	} catch { /* fallthrough */ }
	return path.basename(cwd);
}

export async function runWatch({ cwd, argv, packageRoot = null }) {
	// `argv` is already the post-slice argument vector (script/import callers
	// pass process.argv.slice(2) or `--once --project ...`); parseArgs iterates
	// it directly, matching runEndProject's convention.
	const opts = parseArgs(argv);
	const startedAt = new Date().toISOString();
	const watchCwd = opts.projectRoot ? path.resolve(opts.projectRoot) : cwd;
	const project = opts.project || resolveProject(watchCwd);
	const effectivePackageRoot = packageRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const config = resolveYanoConfig({ packageRoot: effectivePackageRoot });
	const yanoRepo = resolveYanoRepository({ packageRoot: effectivePackageRoot });
	if (!yanoRepo && !missingYanoRepoWarned) {
		missingYanoRepoWarned = true;
		console.warn("yano watch: YANO_ORCHESTRATOR_REPO non trovato nel .env di sviluppo né nella configurazione globale — se viene rilevato un difetto Yano, il comando mostrerà come configurarlo.");
	}

	const dbPath = projectDbPath(watchCwd, project);
	const brokerUrl = config.PI_ORCH_BROKER_URL || process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";

	let client = null;
	try {
		client = mqtt.connect(brokerUrl);
		await new Promise((res, rej) => {
			const timeout = setTimeout(() => rej(new Error("timeout connessione broker")), 2_000);
			client.once("connect", () => { clearTimeout(timeout); res(); });
			client.once("error", (error) => { clearTimeout(timeout); rej(error); });
		});
	} catch (err) {
		try { client?.end(true); } catch { /* best effort */ }
		client = null;
		console.warn(`yano watch: broker ${brokerUrl} non raggiungibile (${err instanceof Error ? err.message : String(err)}) — solo report locale.`);
	}
	const liveAgents = await discoverLiveAgents(client, project);
	const livePlanners = liveAgents.filter((agent) => agent.role === "planner");

	// A validation watcher must report a blocked precondition just as it reports
	// a stall. Previously the missing-DB branch exited before connecting to
	// MQTT, so a live Planner never received the result and no Telegram fallback
	// happened. Do not call process.exit: runWatch is imported by tests and by
	// the Architect control plane.
	if (!existsSync(dbPath)) {
		const details = {
			project,
			project_root: watchCwd,
			validation_run_id: opts.validationRun || null,
			proposal_id: opts.playbookProposal || null,
			playbook_id: opts.playbookId || null,
			reason: "not_initialized",
			orchestrator_db: dbPath,
			live_agents: liveAgents.map((agent) => ({ instance: agent.instance, role: agent.role, status: agent.status })),
		};
		const previous = readTraceRecords({ cwd: watchCwd, project, limit: 100000 }).some((record) =>
			record.type === "yano_watcher_notification_route" &&
			record.signal === "validation_blocked" &&
			record.validation_run_id === (opts.validationRun || null),
		);
		try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_validation_blocked", record_type: "event", instance: "yano-watcher", signal: "validation_blocked", ...details } }); } catch { /* best effort */ }
		let route = { route: "deduplicated", delivered: 0 };
		if (!previous) {
			if (livePlanners.length && client) {
				let delivered = 0;
				for (const planner of livePlanners) {
					try {
						await client.publishAsync(`pi/${project}/agents/${planner.instance}/commands`, JSON.stringify({
							type: "command",
							assignment_id: `watcher-${crypto.randomUUID()}`,
							sender_instance: "yano-watcher",
							sender_role: "yano-watcher",
							target_instance: planner.instance,
							project,
							correlation_id: opts.validationRun || null,
							prompt: `[yano-watcher] Validazione bloccata: il progetto non è inizializzato per Yano (manca orchestrator.db). Segnale: validation_blocked. Evidenze: ${JSON.stringify(details)}. Non modificare il progetto; informa l'utente o inizializza Yano prima di ripetere la validazione.`,
							timestamp: new Date().toISOString(),
						}), { qos: 1 });
						delivered++;
					} catch { /* best effort */ }
				}
				route = { route: "planner", delivered };
			} else {
				const telegram = await sendTelegramWatcherNotification({
					yanoRepo,
					env: config,
					message: `🚨 Yano watcher: validazione bloccata perché il progetto non è inizializzato (manca orchestrator.db).\nProgetto: ${project}\nSegnale: validation_blocked\nNessun planner live è presente: serve attenzione dell’utente.\nDettagli: ${JSON.stringify(details)}`,
				});
				if (!telegram.ok && telegram.detail === "telegram_env_missing") throw missingConfigError("watch", telegram.missing, { packageRoot: effectivePackageRoot });
				route = { route: "telegram", telegram };
			}
			try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: route.route, delivered: route.delivered || 0, planner_instances: livePlanners.map((agent) => agent.instance), signal: "validation_blocked", validation_run_id: opts.validationRun || null, telegram: route.telegram ? { ok: route.telegram.ok, detail: route.telegram.detail } : null } }); } catch { /* best effort */ }
		}
		appendWatcherScan({ cwd: watchCwd, project, opts, startedAt, status: "blocked", reason: "not_initialized", liveAgents: liveAgents.length, livePlanners: livePlanners.length });
		console.log(`yano watch: validation blocked — nessun orchestrator.db per questo progetto (${dbPath})${previous ? " (notifica già inviata)" : ""}.`);
		if (client) { try { await new Promise((resolve) => setTimeout(resolve, 120)); client.end(false); } catch { /* best effort */ } }
		return { status: "blocked", reason: "not_initialized", route, project, db_path: dbPath };
	}

	let DatabaseSync;
	try {
		({ DatabaseSync } = yanoRequire("node:sqlite"));
	} catch (err) {
		console.error(`yano watch: node:sqlite non disponibile (${err instanceof Error ? err.message : String(err)}).`);
		appendWatcherScan({ cwd: watchCwd, project, opts, startedAt, status: "error", reason: "sqlite_unavailable", liveAgents: liveAgents.length, livePlanners: livePlanners.length });
		return { status: "error", reason: "sqlite_unavailable", project, db_path: dbPath };
	}

	const db = new DatabaseSync(dbPath, { readOnly: true });

	const now = Date.now();
	let stalled = [];
	try {
		const rows = db.prepare("SELECT * FROM tickets WHERE status = 'running' ORDER BY updated_at ASC").all();
		stalled = rows.filter((t) => now - new Date(t.updated_at).getTime() > opts.stallMs);
	} catch (err) {
		appendWatcherScan({ cwd: watchCwd, project, opts, startedAt, status: "error", reason: "sqlite_query_failed", liveAgents: liveAgents.length, livePlanners: livePlanners.length });
		console.error(`yano watch: query SQLite fallita (${err instanceof Error ? err.message : String(err)})`);
		process.exit(1);
	}

	const logDir = tracePaths({ cwd: watchCwd, project }).eventsDir;

	// Semantic liveness proxy (Ticket 05): an assignee whose JSONL log carries a
	// recent tool_execution_start marker (logged by the extension at the START of
	// each tool call) is *actively tooling* — likely a long task, not a hung turn.
	// This is the per-harness semantic signal that lets an observer distinguish
	// "slow" from "blocked" (the Revisione 29 case) without any LLM turn.
	const semanticActive = new Set();
	try {
		if (existsSync(logDir)) {
			const stalenessWindow = Math.min(opts.stallMs, 600_000); // tool call within the last (stall or 10min) window counts as active
			const cutoff = now - stalenessWindow;
			for (const f of readdirSync(logDir)) {
				if (!f.endsWith(".jsonl")) continue;
				const inst = f.replace(/\.jsonl$/, "");
				try {
					const lines = readFileSync(path.join(logDir, f), "utf-8").split("\n").filter(Boolean);
					for (let i = lines.length - 1; i >= 0; i--) {
						const line = lines[i].trim();
						if (!line) continue;
						const o = JSON.parse(line);
						if (o && o.type === "tool_execution_start") {
							const t = new Date(o.ts).getTime();
							if (!Number.isNaN(t) && t > cutoff) semanticActive.add(inst);
							break;
						}
					}
				} catch { /* log format drift — ignore */ }
			}
		}
	} catch { /* best-effort */ }
	const marker = [];
	for (const t of stalled) {
		const elapsedMs = now - new Date(t.updated_at).getTime();
		const active = t.assigned_instance ? semanticActive.has(t.assigned_instance) : false;
		const event = { ts: new Date().toISOString(), type: "stall_watch", project, project_key: tracePaths({ cwd: watchCwd, project }).projectKey, ticket_id: t.id, run_id: t.run_id, assigned_instance: t.assigned_instance, elapsed_ms: elapsedMs, semantic_active: active };
		if (client) {
			const topic = `pi/${project}/runs/${t.run_id}/events`;
			try {
				await client.publishAsync(topic, JSON.stringify({ type: "ticket_stalled", run_id: t.run_id, payload: { ticket_id: t.id, assigned_instance: t.assigned_instance, elapsed_ms: elapsedMs }, timestamp: new Date().toISOString() }), { qos: 0 });
			} catch { /* best-effort */ }
		}
		try {
			mkdirSync(logDir, { recursive: true });
			appendFileSync(path.join(logDir, "watch-stalls.jsonl"), JSON.stringify(event) + "\n");
		} catch { /* best-effort */ }
		console.log(`⚠️  ${t.id} "${t.title || "(no title)"}" — running da ${Math.round(elapsedMs / 60_000)} min (${t.assigned_instance ?? "?"})${active ? " [tool attivi di recente → probabile task lento, non bloccato]" : " [NESSUN tool recente → possibile turno bloccato]"}`);
		marker.push(event);
	}

	if (stalled.length === 0) {
		// Away-mode (Ticket 07): a clean 'no stall' pass is routine/heartbeat —
		// absorb it (silence) instead of paging the operator on every sweep.
		if (!awayEnabled(opts)) console.log(`yano watch: nessun ticket running oltre ${Math.round(opts.stallMs / 60_000)} min (project "${project}").`);
	} else {
		// A real stall is a genuine decision — surface it in BOTH modes (away
		// still escalates real decisions; it only absorbs routine noise).
		console.log(`yano watch: ${marker.length} stall rilevat${marker.length === 1 ? "o" : "i"} — pubblicati su MQTT e loggati. La decisione operativa è del planner, non del watcher.`);
	}

	if (marker.length && config.DESTINATION_PHONE_NUMBER && config.EVOLUTION_API_URL) {
		// Optional WhatsApp tripwire — best-effort, same env contract as the extension.
		try {
			const api = config.EVOLUTION_API_URL.replace(/\/$/, "");
			const url = `${api}/message/sendText/${encodeURIComponent(config.EVOLUTION_INSTANCE_NAME || "default")}`;
			await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", apikey: config.EVOLUTION_API_KEY || "" },
				body: JSON.stringify({ number: config.DESTINATION_PHONE_NUMBER, text: `⏱️ ${marker.length} ticket stagnanti (yano watch): ${marker.map((m) => m.ticket_id).join(", ")}` }),
			});
		} catch { /* best-effort */ }
	}

	const routeNotice = async ({ summary, signal, details = {} }) => {
		if (livePlanners.length) {
			let delivered = 0;
			for (const planner of livePlanners) {
				try {
					const envelope = {
						type: "command",
						assignment_id: `watcher-${crypto.randomUUID()}`,
						sender_instance: "yano-watcher",
						sender_role: "yano-watcher",
						target_instance: planner.instance,
						project,
						prompt: `[yano-watcher] ${summary}\n\nSegnale: ${signal}\n${JSON.stringify(details)}\nVerifica il trace e decidi come procedere; non considerare il watcher autorizzato a modificare ticket o codice.`,
						reply_to: `pi/${project}/agents/yano-watcher/responses`,
						hops: 0,
						timestamp: new Date().toISOString(),
					};
					await client.publishAsync(`pi/${project}/agents/${planner.instance}/commands`, JSON.stringify(envelope), { qos: 1 });
					delivered++;
				} catch { /* best effort */ }
			}
			try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: "planner", planner_instances: livePlanners.map((agent) => agent.instance), delivered, signal, fingerprint: details.fingerprint || null, ticket_path: details.ticket_path || null, run_id: details.run_id || null, ticket_id: details.ticket_id || null } }); } catch { /* best effort */ }
			return { route: "planner", delivered };
		}
		const telegram = await sendTelegramWatcherNotification({ yanoRepo, env: config, message: `🚨 Yano watcher: ${summary}\nProgetto: ${project}\nSegnale: ${signal}\nNessun planner live è presente: serve attenzione dell’utente.\nDettagli: ${JSON.stringify(details)}` });
		if (!telegram.ok && telegram.detail === "telegram_env_missing") throw missingConfigError("watch", telegram.missing, { packageRoot: effectivePackageRoot });
		try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: "telegram", planner_instances: [], telegram: { ok: telegram.ok, detail: telegram.detail }, signal, fingerprint: details.fingerprint || null, ticket_path: details.ticket_path || null, run_id: details.run_id || null, ticket_id: details.ticket_id || null } }); } catch { /* best effort */ }
		return { route: "telegram", telegram };
	};
	const previouslyRoutedStalls = new Set(readTraceRecords({ cwd: watchCwd, project, limit: 100000 })
		.filter((record) => record.type === "yano_watcher_notification_route" && record.signal === "ticket_stalled")
		.map((record) => `${record.run_id || "?"}:${record.ticket_id || "?"}`));
	for (const stalled of marker) {
		const stallKey = `${stalled.run_id || "?"}:${stalled.ticket_id || "?"}`;
		if (previouslyRoutedStalls.has(stallKey)) continue;
		await routeNotice({
			summary: `Il ticket ${stalled.ticket_id} è bloccato da ${Math.round(stalled.elapsed_ms / 60_000)} minuti.`,
			signal: "ticket_stalled",
			details: { ticket_id: stalled.ticket_id, run_id: stalled.run_id, assigned_instance: stalled.assigned_instance },
		});
		previouslyRoutedStalls.add(stallKey);
	}

	// Escalation path for defects in Yano itself. The classifier is deliberately
	// conservative: generic project failures stay in the project trace and do
	// not create maintenance tickets in the Yano repository.
	let validationFindings = [];
	try {
		const traceRecords = readTraceRecords({ cwd: watchCwd, project, since: new Date(Date.now() - Math.max(0, opts.lookbackMs)), limit: 100000 });
		const routedFindingKeys = new Set(traceRecords
			.filter((record) => record.type === "yano_watcher_notification_route")
			.flatMap((record) => [record.fingerprint, record.ticket_path].filter(Boolean)));
		const escalation = await processYanoWatcherFindings({
			records: traceRecords,
			projectRoot: watchCwd,
			project,
			yanoRepo,
			traceContext: { cwd: watchCwd, project_key: tracePaths({ cwd: watchCwd, project }).projectKey },
			notify: livePlanners.length === 0,
			env: config,
		});
		validationFindings = escalation.findings || [];
		if (escalation.created || escalation.notified || escalation.findings.length) {
			console.log(`yano watch: ${escalation.findings.length} segnal${escalation.findings.length === 1 ? "e" : "i"} Yano, ${escalation.created} ticket creat${escalation.created === 1 ? "o" : "i"}, ${escalation.notified} notific${escalation.notified === 1 ? "a" : "he"} Telegram.`);
		}
		if (!livePlanners.length) {
			const missingTelegram = escalation.results.find((item) => item.telegram?.detail === "telegram_env_missing")?.telegram?.missing;
			if (missingTelegram?.length) throw missingConfigError("watch", missingTelegram, { packageRoot: effectivePackageRoot });
		}
		for (const result of escalation.results.filter((item) => (livePlanners.length && (item.created || item.skipped)) || (item.skipped && !livePlanners.length))) {
			if (result.skipped && !yanoRepo) throw missingConfigError("watch", ["YANO_ORCHESTRATOR_REPO"], { packageRoot: effectivePackageRoot });
			const findingKey = result.finding.fingerprint || result.path || null;
			if (findingKey && routedFindingKeys.has(findingKey)) continue;
			await routeNotice({ summary: result.finding.summary, signal: result.finding.signal, details: { fingerprint: result.finding.fingerprint || null, ticket_path: result.path || null, severity: result.finding.severity } });
			if (findingKey) routedFindingKeys.add(findingKey);
		}
	} catch (error) {
		if (error?.code === "YANO_CONFIG_MISSING") throw error;
		console.warn(`yano watch: escalation Yano non riuscita — ${error instanceof Error ? error.message : String(error)}`);
	}

	// A clean validation pass is positive evidence only for the architect's
	// bounded proposal. It is never sent to Telegram as an alert and never
	// promotes anything by itself; the planner still collects user feedback.
	if (opts.validationRun && marker.length === 0 && validationFindings.length === 0) {
		const healthy = {
			ts: new Date().toISOString(),
			type: "yano_watcher_round_ok",
			record_type: "event",
			source: "yano-watcher",
			instance: "yano-watcher",
			project,
			validation_run_id: opts.validationRun,
			proposal_id: opts.playbookProposal,
			playbook_id: opts.playbookId,
			playbook_checksum: opts.playbookChecksum,
			round: opts.validationRound,
			message: "Passata di osservazione bounded senza stall o finding Yano.",
		};
		try { appendRawTraceRecord({ cwd: watchCwd, project, record: healthy }); } catch { /* best effort */ }
		if (livePlanners.length && client) {
			for (const planner of livePlanners) {
				try {
					await client.publishAsync(`pi/${project}/agents/${planner.instance}/commands`, JSON.stringify({
						type: "command",
						assignment_id: `watcher-healthy-${crypto.randomUUID()}`,
						sender_instance: "yano-watcher",
						sender_role: "yano-watcher",
						target_instance: planner.instance,
						project,
						correlation_id: opts.validationRun,
						display: true,
						triggerTurn: true,
						followUp: true,
						prompt: `[yano-watcher] Round di validazione sano per la proposta ${opts.playbookProposal || "?"}. Nessuno stall o finding Yano osservato. Il playbook resta ephemeral: raccogli il feedback dell'utente prima di chiedere la promozione.`,
						timestamp: new Date().toISOString(),
					}), { qos: 1 });
				} catch { /* best effort */ }
			}
		}
	}

	const scanStatus = marker.length || validationFindings.length ? "finding" : "healthy";
	const scan = appendWatcherScan({
		cwd: watchCwd,
		project,
		opts,
		startedAt,
		status: scanStatus,
		reason: null,
		stalls: marker.length,
		findings: validationFindings.length,
		liveAgents: liveAgents.length,
		livePlanners: livePlanners.length,
	});

	try { db.close(); } catch { /* ignore */ }
	if (client) {
		// Graceful close: force:false lets already-published (QoS0 in-flight)
		// messages flush before the connection drops — force:true here would
		// discard the ticket_stalled events we just published.
		try { await new Promise((r) => setTimeout(r, 120)); client.end(false); } catch { /* ignore */ }
	}

	if (opts.once || opts.intervalMs <= 0) return { status: scanStatus, scan }; // single pass — let the caller decide to exit
	// Real watcher loop: after this pass, wait intervalMs then run again.
	// Env-gated away mode is honored on every pass, so `--away` can be implied
	// by PI_ORCH_AWAY=1 even if the process was launched without the flag.
	setTimeout(() => {
		runWatch({ cwd, argv, packageRoot }).catch((e) => { console.error(e); process.exit(1); });
	}, opts.intervalMs);
	return { status: scanStatus, scan };
}

function awayEnabled(opts) {
	return opts.away || String(process.env.PI_ORCH_AWAY || "") === "1";
}

async function discoverLiveAgents(client, project) {
	if (!client) return [];
	const agents = new Map();
	const topic = `pi/${project}/agents/+/status`;
	const onMessage = (_topic, payload) => {
		try {
			const card = JSON.parse(payload.toString());
			if (card?.instance) agents.set(card.instance, card);
		} catch { /* malformed retained card */ }
	};
	try {
		client.on("message", onMessage);
		await client.subscribeAsync(topic, { qos: 1 });
		await new Promise((resolve) => setTimeout(resolve, 250));
	} catch { /* best effort */ }
	try { client.removeListener("message", onMessage); } catch { /* ignore */ }
	const staleAfterMs = Number(process.env.PI_ORCH_STALE_AFTER_MS) || 45_000;
	const now = Date.now();
	return [...agents.values()].filter((agent) => {
		if (agent.status === "offline") return false;
		const heartbeat = Date.parse(agent.last_heartbeat || "");
		return Number.isFinite(heartbeat) && now - heartbeat <= staleAfterMs;
	});
}

// Direct invocation: `node scripts/watch-stalls.mjs --once` — only here do we
// take ownership of the process lifetime (process.exit), so an embedded caller
// importing runWatch can still run assertions after a --once pass.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const invokedOnce = async () => {
		await runWatch({ cwd: process.cwd(), argv: process.argv.slice(2) });
		process.exit(0); // explicit --once or defaults to single pass by this exit
	};
	invokedOnce().catch((err) => {
		console.error(`yano watch: errore — ${err instanceof Error ? err.stack || err.message : String(err)}`);
		process.exit(1);
	});
}
