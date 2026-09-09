#!/usr/bin/env node

// Fase 1 / M0 — pulizia una tantum del backlog di ticket auto-generati dal
// watcher sotto .scratch/optimize-orchestrator/issues/. Archivia (non
// cancella mai) ogni ticket created_by:yano-watcher, status:open, senza
// commenti umani in ## Comments, riscrivendo lo status in
// `archived-bulk-cleanup` — distinto da `auto-closed-stale`
// (sweepStaleYanoWatcherTickets, la sweep automatica ricorrente) perché
// questa è una decisione manuale dell'operatore, non una recidiva mai
// riosservata. Vedi il piano di Fase 1, milestone M0.
//
// Uso:
//   node scripts/watcher/bulk-close-watcher-tickets.mjs --dry-run
//   node scripts/watcher/bulk-close-watcher-tickets.mjs
//   node scripts/watcher/bulk-close-watcher-tickets.mjs --tickets-dir <dir> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hasHumanComments, parseFrontmatter } from "../yano-watcher-findings.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function defaultTicketsDir(packageRoot = PACKAGE_ROOT) {
	return path.join(packageRoot, ".scratch", "optimize-orchestrator", "issues");
}

// Read-only classification pass: which open watcher tickets would be
// archived, which are spared because a human commented, and a per-signal
// breakdown of everything scanned — used identically by --dry-run and the
// real run so the printed preview and the applied result can never diverge.
export function planBulkClose({ ticketsDir }) {
	const archive = [];
	const skippedWithComments = [];
	const scannedBySignal = new Map();
	if (!ticketsDir || !fs.existsSync(ticketsDir)) return { archive, skippedWithComments, scanned: 0, scannedBySignal };
	let scanned = 0;
	for (const file of fs.readdirSync(ticketsDir)) {
		if (!file.endsWith(".md")) continue;
		const full = path.join(ticketsDir, file);
		let content;
		try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
		const meta = parseFrontmatter(content);
		if (meta.created_by !== "yano-watcher" || meta.status !== "open") continue;
		scanned += 1;
		const signal = meta.signal || "unknown";
		scannedBySignal.set(signal, (scannedBySignal.get(signal) || 0) + 1);
		if (hasHumanComments(content)) { skippedWithComments.push({ path: full, signal }); continue; }
		archive.push({ path: full, signal, content });
	}
	return { archive, skippedWithComments, scanned, scannedBySignal };
}

// Applies a plan from planBulkClose(). Additive rewrite only, same principle
// as sweepStaleYanoWatcherTickets: the file stays in place, git-tracked and
// recoverable, nothing is ever deleted from disk.
export function applyBulkClose(plan, { now = new Date() } = {}) {
	const iso = now.toISOString();
	const archived = [];
	for (const item of plan.archive) {
		const updated = `${item.content
			.replace(/^status: open$/m, "status: archived-bulk-cleanup")
			.replace(/^Status: open$/m, "Status: archived-bulk-cleanup")}\n## Archiviato (pulizia manuale)\n\nTicket archiviato in blocco il ${iso} durante la pulizia una tantum del backlog watcher (Fase 1, milestone M0): nessuna recidiva mancata come nello sweep automatico, ma una decisione dell'operatore. Il ticket resta nel repository (git-tracked) e recuperabile.\n`;
		fs.writeFileSync(item.path, updated);
		archived.push(item.path);
	}
	return { archived };
}

function printSummary(plan, { dryRun }) {
	const prefix = dryRun ? "[dry-run] " : "";
	console.log(`${prefix}Ticket watcher open scansionati: ${plan.scanned}`);
	const bySignal = [...plan.scannedBySignal.entries()].map(([signal, count]) => `${signal}=${count}`).join(", ") || "(nessuno)";
	console.log(`  → per segnale: ${bySignal}`);
	console.log(`  → da archiviare (nessun commento umano): ${plan.archive.length}`);
	console.log(`  → risparmiati (hanno commenti umani, mai toccati): ${plan.skippedWithComments.length}`);
	for (const item of plan.skippedWithComments) console.log(`     - ${path.basename(item.path)} (${item.signal})`);
}

function parseArgs(argv) {
	const flags = { dryRun: false, ticketsDir: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--dry-run") flags.dryRun = true;
		else if (arg === "--tickets-dir") flags.ticketsDir = argv[i += 1];
	}
	return flags;
}

export async function runBulkCloseWatcherTickets({ argv = [], packageRoot = PACKAGE_ROOT } = {}) {
	const flags = parseArgs(argv);
	const ticketsDir = flags.ticketsDir ? path.resolve(flags.ticketsDir) : defaultTicketsDir(packageRoot);
	const plan = planBulkClose({ ticketsDir });
	printSummary(plan, { dryRun: flags.dryRun });
	if (flags.dryRun) {
		console.log("\nNessuna modifica scritta (--dry-run). Rilancia senza --dry-run per applicare davvero.");
		return { ...plan, applied: false };
	}
	const result = applyBulkClose(plan);
	console.log(`\nArchiviati ${result.archived.length} ticket. Nulla è stato cancellato dal disco.`);
	return { ...plan, applied: true, archived: result.archived };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runBulkCloseWatcherTickets({ argv: process.argv.slice(2) }).catch((error) => {
		console.error(`bulk-close-watcher-tickets: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
