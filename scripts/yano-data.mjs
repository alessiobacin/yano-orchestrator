#!/usr/bin/env node

// Data-root inspection and non-destructive migration from the pre-1.4 package
// temp directory to the platform-specific per-user Yano data directory.
import fs from "node:fs";
import path from "node:path";
import { globalDataPath } from "./yano-config.mjs";

function has(argv, flag) { return argv.includes(flag); }
function packageLegacyRoot(packageRoot) { return path.join(packageRoot, "temp"); }
function filesUnder(root) { try { return fs.readdirSync(root); } catch { return []; } }

export function dataUsage() {
	return [
		"Uso: yano data <path|migrate> [opzioni]",
		"",
		"  path                         mostra data-root attuale e vecchio percorso",
		"  migrate [--dry-run] [--yes]  copia il vecchio package/temp nel data-root per-user",
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
