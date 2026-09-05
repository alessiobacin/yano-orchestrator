#!/usr/bin/env node

// Data-root inspection and non-destructive migration from the pre-1.4 package
// temp directory to the platform-specific per-user Yano data directory.
import fs from "node:fs";
import path from "node:path";
import { globalDataPath } from "./yano-config.mjs";

function has(argv, flag) { return argv.includes(flag); }
function packageLegacyRoot(packageRoot) { return path.join(packageRoot, "temp"); }
function filesUnder(root) { try { return fs.readdirSync(root); } catch { return []; } }
export function bytesUnder(root) { let total = 0; const projects = new Map(); const visit = (current, relative = "") => { let entries; try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; } for (const entry of entries) { const file = path.join(current, entry.name); const rel = path.join(relative, entry.name); if (entry.isDirectory()) visit(file, rel); else { let size = 0; try { size = fs.statSync(file).size; } catch {} total += size; const top = rel.split(path.sep)[0] || "_root"; projects.set(top, (projects.get(top) || 0) + size); } } }; if (fs.existsSync(root)) visit(root); return { bytes: total, files_by_top_level: Object.fromEntries([...projects.entries()].sort((a, b) => b[1] - a[1])) }; }
export function dataUsageReport({ root = globalDataPath({ env: process.env }) } = {}) { const traces = bytesUnder(path.join(root, "traces")); const recovery = bytesUnder(path.join(root, "recovery")); const logs = bytesUnder(path.join(root, "logs")); const feedback = bytesUnder(path.join(root, "feedback")); return { data_root: root, generated_at: new Date().toISOString(), totals: { bytes: traces.bytes + recovery.bytes + logs.bytes + feedback.bytes, traces_bytes: traces.bytes, recovery_bytes: recovery.bytes, logs_bytes: logs.bytes, feedback_bytes: feedback.bytes }, by_area: { traces, recovery, logs, feedback }, recommendation: { traces: "conserva 30 giorni per diagnosi ordinaria; archivia o elimina solo dopo export", recovery: "conserva 14 giorni; mantieni snapshot collegati a run non finalizzati", logs: "conserva 30 giorni; i log operativi hanno crescita ridotta", feedback: "conserva finché il bug/suggerimento non è risolto o cancellato dall'utente" } }; }

// Fase 8 — the three global one-minute-cadence logs (watcher-global,
// global-services, scheduler-connectivity) used to be single ever-growing
// files. Retention (oldFiles() below) filters by file mtime, but a file
// appended to every minute always has mtime "now" — retention could
// structurally never fire on it, which is why these files reached 5-7MB
// each in real installs. Rotating by calendar day gives yesterday's segment
// (and every day before it) a real, aging mtime the existing retention scan
// already knows how to sweep — no change needed there at all.
export function dailyLogPath(dir, baseName, { now = new Date() } = {}) {
	const day = now.toISOString().slice(0, 10);
	return path.join(dir, `${baseName}-${day}.jsonl`);
}

const retentionDefaults = Object.freeze({ traces: 30, recovery: 14, logs: 30 });
function retentionConfig() { const cfg = process.env; return { traces: Math.max(0, Number(cfg.YANO_TRACE_RETENTION_DAYS || retentionDefaults.traces)), recovery: Math.max(0, Number(cfg.YANO_RECOVERY_RETENTION_DAYS || retentionDefaults.recovery)), logs: Math.max(0, Number(cfg.YANO_LOG_RETENTION_DAYS || retentionDefaults.logs)), backup: cfg.YANO_DATA_BACKUP_DIR ? path.resolve(cfg.YANO_DATA_BACKUP_DIR) : null }; }
function oldFiles(root, cutoff) { const result = []; const visit = (dir) => { let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const entry of entries) { const file = path.join(dir, entry.name); if (entry.isDirectory()) visit(file); else { try { if (fs.statSync(file).mtimeMs < cutoff) result.push(file); } catch {} } } }; if (fs.existsSync(root)) visit(root); return result; }
export function retentionPlan({ root = globalDataPath({ env: process.env }), nowMs = Date.now() } = {}) { const cfg = retentionConfig(); const areas = ["traces", "recovery", "logs"]; const files = areas.flatMap((area) => oldFiles(path.join(root, area), nowMs - cfg[area] * 86400000).map((source) => ({ area, source, relative: path.relative(root, source), bytes: fs.statSync(source).size }))); return { root, backup: cfg.backup, retention_days: cfg, files, bytes: files.reduce((sum, item) => sum + item.bytes, 0) }; }
export function applyRetention({ root = globalDataPath({ env: process.env }), yes = false } = {}) { const plan = retentionPlan({ root }); if (!yes) return { ...plan, dry_run: true, applied: false }; for (const item of plan.files) { if (plan.backup) { const target = path.join(plan.backup, "retired", item.relative); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(item.source, target); fs.unlinkSync(item.source); } else fs.unlinkSync(item.source); } return { ...plan, dry_run: false, applied: true, action: plan.backup ? "moved_to_backup" : "deleted" }; }

export function dataUsage() {
	return [
		"Uso: yano data <path|usage|migrate> [opzioni]",
		"",
		"  path                         mostra data-root attuale e vecchio percorso",
		"  migrate [--dry-run] [--yes]  copia il vecchio package/temp nel data-root per-user",
		"  usage [--json]               misura bytes/file per area e per progetto; non modifica nulla",
		"",
		"La migrazione non cancella il vecchio store. L'origine resta disponibile per rollback.",
	].join("\n");
}

export function runYanoData({ packageRoot, argv = [] } = {}) {
	const sub = argv[0];
	if (!sub || sub === "--help" || sub === "-h") { console.log(dataUsage()); return; }
	const target = globalDataPath({ env: process.env });
	const legacy = packageLegacyRoot(packageRoot);
	if (sub === "path") {
		const result = { data_root: target, legacy_package_temp: legacy, legacy_exists: fs.existsSync(legacy) };
		console.log(JSON.stringify(result, null, 2));
		return result;
	}
	if (sub === "usage") {
		const result = dataUsageReport();
		if (has(argv, "--json")) console.log(JSON.stringify(result, null, 2));
		else console.log(`yano data: ${result.data_root}\nTotale: ${result.totals.bytes} bytes\nTrace: ${result.totals.traces_bytes} bytes\nRecovery: ${result.totals.recovery_bytes} bytes\nLog: ${result.totals.logs_bytes} bytes\nFeedback: ${result.totals.feedback_bytes} bytes`);
		return result;
	}
	if (sub === "retain") {
		const result = applyRetention({ root: target, yes: has(argv, "--yes") });
		console.log(JSON.stringify(result, null, 2));
		return result;
	}
	if (sub !== "migrate") throw new Error(`yano data: comando sconosciuto "${sub}".\n${dataUsage()}`);
	const sourceEntries = filesUnder(legacy);
	if (!sourceEntries.length) {
		const result = { migrated: false, reason: "legacy_store_empty", source: legacy, target };
		console.log(JSON.stringify(result, null, 2));
		return result;
	}
	const targetEntries = filesUnder(target);
	if (targetEntries.length && !has(argv, "--merge")) throw new Error(`yano data migrate: il nuovo data-root non è vuoto (${target}); usa --merge per fondere i file o scegli un target diverso`);
	const result = { migrated: false, source: legacy, target, entries: sourceEntries, dry_run: has(argv, "--dry-run") || !has(argv, "--yes") };
	if (result.dry_run) {
		console.log(JSON.stringify(result, null, 2));
		return result;
	}
	fs.mkdirSync(target, { recursive: true, mode: 0o700 });
	fs.cpSync(legacy, target, { recursive: true, force: has(argv, "--merge"), errorOnExist: false });
	result.migrated = true;
	result.source_preserved = true;
	console.log(JSON.stringify(result, null, 2));
	return result;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
	try { runYanoData({ packageRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), argv: process.argv.slice(2) }); }
	catch (error) { console.error(`yano data: ${error.message}`); process.exit(1); }
}
