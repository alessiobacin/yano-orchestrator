#!/usr/bin/env node

// Inizializzazione esplicita e non distruttiva del DB del layer orchestrator.
// La definizione dello schema resta nell'estensione TypeScript, così la CLI
// non può divergere accidentalmente dallo storage usato da Pi.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { projectDbPath } from "./yano-project.mjs";

const require = createRequire(import.meta.url);

function sqliteClass() {
	try { return process.getBuiltinModule?.("node:sqlite")?.DatabaseSync || require("node:sqlite").DatabaseSync; }
	catch { return null; }
}

function readExtensionSource(packageRoot) {
	const file = path.join(packageRoot, "extensions", "orchestrator.ts");
	try { return fs.readFileSync(file, "utf8"); } catch (error) { throw new Error(`estensione orchestrator non leggibile: ${file} (${error.message})`); }
}

function schemaFromExtension(source) {
	const match = source.match(/const YANO_SCHEMA_SQL = `([\s\S]*?)`;\s*\n/);
	if (!match) throw new Error("schema Yano non trovato nell'estensione.");
	return match[1];
}

// The version number must come from the SAME extension source as the SQL
// above — a second hardcoded literal here already drifted out of sync once
// (this file still seeded '10' after YANO_STORAGE_SCHEMA_VERSION became 11),
// silently understating the schema_version of every DB this creates.
function schemaVersionFromExtension(source) {
	const match = source.match(/const YANO_STORAGE_SCHEMA_VERSION = (\d+);/);
	if (!match) throw new Error("YANO_STORAGE_SCHEMA_VERSION non trovata nell'estensione.");
	return Number(match[1]);
}

export function ensureProjectDatabase({ projectRoot, project = null, packageRoot }) {
	const dbPath = projectDbPath(projectRoot, project);
	if (fs.existsSync(dbPath)) return { created: false, exists: true, path: dbPath, schema_version: readSchemaVersion(dbPath) };
	const DatabaseSync = sqliteClass();
	if (!DatabaseSync) throw new Error("node:sqlite non disponibile: serve Node >=22.5 per creare orchestrator.db");
	fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
	let db = null;
	try {
		const source = readExtensionSource(packageRoot);
		const schemaVersion = schemaVersionFromExtension(source);
		db = new DatabaseSync(dbPath);
		db.exec(schemaFromExtension(source));
		const row = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get();
		if (!row) db.prepare("INSERT INTO schema_meta(key,value) VALUES('schema_version',?)").run(String(schemaVersion));
		return { created: true, exists: true, path: dbPath, schema_version: Number(row?.value || schemaVersion) };
	} catch (error) {
		try { db?.close(); } catch { /* best effort */ }
		try { if (fs.existsSync(dbPath) && fs.statSync(dbPath).size === 0) fs.unlinkSync(dbPath); } catch { /* best effort */ }
		throw new Error(`creazione orchestrator.db fallita: ${error.message}`);
	} finally { try { db?.close(); } catch { /* best effort */ } }
}

function readSchemaVersion(dbPath) {
	const DatabaseSync = sqliteClass();
	if (!DatabaseSync) return null;
	let db = null;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
		return Number(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value || 0);
	} catch { return null; }
	finally { try { db?.close(); } catch { /* best effort */ } }
}
