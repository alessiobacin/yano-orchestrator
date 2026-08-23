#!/usr/bin/env node

/*
 * Semantic trace index.
 *
 * The vectors live in SQLite as JSON so the feature works on every supported
 * Node installation without a native sqlite-vec extension. Ollama is used
 * only at index/query time; the raw forensic JSONL remains the source of
 * truth and can always be re-indexed.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
	traceRoot,
	tracePaths,
	readTraceRecords,
	traceProjectKeys,
} from "./yano-trace-storage.mjs";
import { embedTexts, resolveEmbeddingModel } from "./doctor.mjs";

const require = createRequire(import.meta.url);
const INDEX_SCHEMA_VERSION = 1;
const DEFAULT_BATCH_SIZE = 32;
const MAX_TEXT_LENGTH = 12_000;

function databaseClass() {
	try {
		return require("node:sqlite").DatabaseSync;
	} catch (error) {
		throw new Error(`semantic trace index: node:sqlite non disponibile (${error instanceof Error ? error.message : String(error)}); serve Node >=22.5`);
	}
}

export function traceIndexPath() {
	return path.join(traceRoot(), "semantic-index.sqlite");
}

export function traceIndexStatus() {
	const file = traceIndexPath();
	if (!fs.existsSync(file)) return { exists: false, path: file, documents: 0, models: [] };
	const db = openDatabase({ readOnly: true });
	try {
		return {
			exists: true,
			path: file,
			documents: db.prepare("SELECT COUNT(*) AS count FROM trace_documents").get().count,
			models: db.prepare("SELECT embedding_model AS model, COUNT(*) AS count FROM trace_documents GROUP BY embedding_model ORDER BY model").all(),
		};
	} finally {
		db.close();
	}
}

function openDatabase({ readOnly = false } = {}) {
	const file = traceIndexPath();
	if (!readOnly) fs.mkdirSync(traceRoot(), { recursive: true, mode: 0o700 });
	if (readOnly && !fs.existsSync(file)) return null;
	const DatabaseSync = databaseClass();
	const db = new DatabaseSync(file, { readOnly });
	if (!readOnly) {
		db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS trace_index_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS trace_documents (
				document_id TEXT PRIMARY KEY,
				project TEXT,
				project_key TEXT NOT NULL,
				ts TEXT,
				record_type TEXT,
				event_type TEXT,
				instance TEXT,
				role TEXT,
				run_id TEXT,
				round TEXT,
				task_slug TEXT,
				text TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				embedding_model TEXT NOT NULL,
				embedding_dimensions INTEGER NOT NULL,
				embedding_json TEXT NOT NULL,
				indexed_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS trace_documents_project_idx ON trace_documents(project_key);
			CREATE INDEX IF NOT EXISTS trace_documents_run_idx ON trace_documents(run_id);
			CREATE INDEX IF NOT EXISTS trace_documents_ts_idx ON trace_documents(ts);
			CREATE INDEX IF NOT EXISTS trace_documents_model_idx ON trace_documents(embedding_model);
		`);
		db.prepare("INSERT INTO trace_index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("schema_version", String(INDEX_SCHEMA_VERSION));
	}
	return db;
}

function hash(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function stringValue(value) {
	if (value === null || value === undefined || value === "") return null;
	if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && item !== "").join(", ");
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

// These are observable trace fields. In particular, this deliberately does
// not attempt to reconstruct or persist hidden model chain-of-thought.
const TEXT_FIELDS = [
	"record_type", "type", "tool", "tool_name", "role", "instance", "project",
	"run_id", "round", "task_slug", "slug", "status", "ok", "reason", "detail",
	"message", "text", "summary", "root_cause", "recommendation", "change_type",
	"confidence", "failure_class", "expected", "actual", "observed_value", "source",
];

export function traceDocumentText(record) {
	const parts = [];
	for (const field of TEXT_FIELDS) {
		const value = stringValue(record[field]);
		if (value !== null) parts.push(`${field}: ${value}`);
	}
	if (!parts.length) parts.push(JSON.stringify(record));
	return parts.join("\n").slice(0, MAX_TEXT_LENGTH);
}

function documentId(record) {
	const identity = record.id
		? `${record.project_key}|${record.record_type || "event"}|${record.id}`
		: `${record.project_key}|event|${record.instance || ""}|${record.seq || ""}|${record.ts || ""}|${record.type || ""}|${record.tool_call_id || ""}`;
	return `trace-${hash(identity)}`;
}

function documentFor(record) {
	const text = traceDocumentText(record);
	const payload = JSON.stringify(record);
	return {
		document_id: documentId(record),
		project: record.project || null,
		project_key: record.project_key || "unknown",
		ts: record.ts || null,
		record_type: record.record_type || null,
		event_type: record.type || null,
		instance: record.instance || null,
		role: record.role || null,
		run_id: record.run_id || null,
		round: record.round === null || record.round === undefined ? null : String(record.round),
		task_slug: record.task_slug || record.slug || null,
		text,
		payload_json: payload,
		content_hash: hash(`${text}\n${payload}`),
	};
}

function filteredRecords({ cwd, project, allProjects = false, run = null, round = null, task = null, instance = null, type = null, since = null, limit = 1000000 }) {
	return readTraceRecords({ cwd, project, allProjects, since, limit })
		.filter((record) => !run || record.run_id === run)
		.filter((record) => round === null || String(record.round) === String(round))
		.filter((record) => !task || record.task_slug === task || record.slug === task)
		.filter((record) => !instance || record.instance === instance)
		.filter((record) => !type || record.type === type);
}

function chunks(items, size) {
	const result = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

export async function indexTraceRecords({
	cwd = process.cwd(), project, allProjects = false, run = null, round = null, task = null,
	instance = null, type = null, since = null, limit = 1000000, batchSize = DEFAULT_BATCH_SIZE,
	force = false, model = resolveEmbeddingModel(),
} = {}) {
	const db = openDatabase();
	const records = filteredRecords({ cwd, project, allProjects, run, round, task, instance, type, since, limit });
	const documents = records.map(documentFor);
	const pending = force
		? documents
		: documents.filter((document) => {
			const row = db.prepare("SELECT content_hash, embedding_model FROM trace_documents WHERE document_id = ?").get(document.document_id);
			return !row || row.content_hash !== document.content_hash || row.embedding_model !== model;
		});
	let indexed = 0;
	let failed = 0;
	const errors = [];
	const insert = db.prepare(`
		INSERT INTO trace_documents (
			document_id, project, project_key, ts, record_type, event_type, instance, role,
			run_id, round, task_slug, text, payload_json, content_hash, embedding_model,
			embedding_dimensions, embedding_json, indexed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(document_id) DO UPDATE SET
			project = excluded.project, project_key = excluded.project_key, ts = excluded.ts,
			record_type = excluded.record_type, event_type = excluded.event_type,
			instance = excluded.instance, role = excluded.role, run_id = excluded.run_id,
			round = excluded.round, task_slug = excluded.task_slug, text = excluded.text,
			payload_json = excluded.payload_json, content_hash = excluded.content_hash,
			embedding_model = excluded.embedding_model, embedding_dimensions = excluded.embedding_dimensions,
			embedding_json = excluded.embedding_json, indexed_at = excluded.indexed_at
	`);
	try { db.exec("BEGIN"); } catch { /* a caller cannot hold a transaction across this CLI call */ }
	try {
		for (const batch of chunks(pending, Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE))) {
			try {
				const vectors = await embedTexts(batch.map((document) => document.text), { model });
				for (let index = 0; index < batch.length; index++) {
					const vector = vectors[index];
					insert.run(
						batch[index].document_id, batch[index].project, batch[index].project_key, batch[index].ts,
						batch[index].record_type, batch[index].event_type, batch[index].instance, batch[index].role,
						batch[index].run_id, batch[index].round, batch[index].task_slug, batch[index].text,
						batch[index].payload_json, batch[index].content_hash, model, vector.length,
						JSON.stringify(vector), new Date().toISOString(),
					);
					indexed++;
				}
			} catch (error) {
				failed += batch.length;
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
		try { db.exec("COMMIT"); } catch { /* no-op if BEGIN was unavailable */ }
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch { /* best effort */ }
		throw error;
	} finally {
		db.close();
	}
	return {
		ok: failed === 0,
		db_path: traceIndexPath(),
		model,
		total: documents.length,
		pending: pending.length,
		indexed,
		skipped: documents.length - pending.length,
		failed,
		errors: errors.slice(0, 5),
		filters: { project: allProjects ? null : (project || tracePaths({ cwd }).project), all_projects: allProjects, run, round, task, instance, type, since: since?.toISOString?.() || null },
	};
}

function cosineSimilarity(left, right) {
	if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return -1;
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index++) {
		const a = Number(left[index]) || 0;
		const b = Number(right[index]) || 0;
		dot += a * b;
		leftNorm += a * a;
		rightNorm += b * b;
	}
	return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

export async function searchTraceRecords({
	cwd = process.cwd(), project, allProjects = false, query, run = null, round = null, task = null,
	instance = null, type = null, since = null, limit = 10, model = resolveEmbeddingModel(), includePayload = false,
} = {}) {
	if (!query?.trim()) throw new Error("semantic trace search: --query è obbligatorio");
	const db = openDatabase({ readOnly: true });
	if (!db) return { ok: false, db_path: traceIndexPath(), model, query, total: 0, results: [], message: "indice assente: esegui prima yano trace index" };
	try {
		const vector = (await embedTexts([query.trim()], { model }))[0];
		const clauses = ["embedding_model = ?"];
		const params = [model];
		if (!allProjects) {
			const keys = traceProjectKeys({ cwd, project });
			clauses.push(`project_key IN (${keys.map(() => "?").join(",")})`);
			params.push(...keys);
		}
		if (run) { clauses.push("run_id = ?"); params.push(run); }
		if (round !== null && round !== undefined) { clauses.push("round = ?"); params.push(String(round)); }
		if (task) { clauses.push("task_slug = ?"); params.push(task); }
		if (instance) { clauses.push("instance = ?"); params.push(instance); }
		if (type) { clauses.push("event_type = ?"); params.push(type); }
		if (since) { clauses.push("(ts IS NULL OR ts >= ?)"); params.push(since.toISOString()); }
		const rows = db.prepare(`SELECT * FROM trace_documents WHERE ${clauses.join(" AND ")}`).all(...params);
		const results = rows.map((row) => {
			let stored;
			try { stored = JSON.parse(row.embedding_json); } catch { stored = []; }
			let payload;
			try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
			return {
				score: cosineSimilarity(vector, stored), document_id: row.document_id, project: row.project,
				project_key: row.project_key, ts: row.ts, record_type: row.record_type, event_type: row.event_type,
				instance: row.instance, role: row.role, run_id: row.run_id, round: row.round,
				task_slug: row.task_slug, text: row.text, ...(includePayload ? { payload } : {}),
			};
		}).filter((row) => row.score >= 0).sort((left, right) => right.score - left.score).slice(0, Math.max(1, Number(limit) || 10));
		return { ok: true, db_path: traceIndexPath(), model, query, total: rows.length, results, filters: { project: allProjects ? null : (project || tracePaths({ cwd }).project), all_projects: allProjects, run, round, task, instance, type, since: since?.toISOString?.() || null } };
	} finally {
		db.close();
	}
}

export function clearTraceIndexData({ cwd = process.cwd(), project, allProjects = false, run = null, round = null, task = null, instance = null, type = null, before = null, all = false } = {}) {
	if (all) {
		const file = traceIndexPath();
		if (fs.existsSync(file)) fs.rmSync(file, { force: true });
		for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(`${file}${suffix}`)) fs.rmSync(`${file}${suffix}`, { force: true });
		return { deleted: true, all: true, documents: 0, db_path: file };
	}
	const db = openDatabase({ readOnly: true });
	if (!db) return { deleted: true, all: false, documents: 0, db_path: traceIndexPath() };
	db.close();
	const writable = openDatabase();
	const clauses = [];
	const params = [];
	if (!allProjects) {
		const keys = traceProjectKeys({ cwd, project });
		clauses.push(`project_key IN (${keys.map(() => "?").join(",")})`);
		params.push(...keys);
	}
	if (run) { clauses.push("run_id = ?"); params.push(run); }
	if (round !== null && round !== undefined) { clauses.push("round = ?"); params.push(String(round)); }
	if (task) { clauses.push("task_slug = ?"); params.push(task); }
	if (instance) { clauses.push("instance = ?"); params.push(instance); }
	if (type) { clauses.push("event_type = ?"); params.push(type); }
	if (before) { clauses.push("(ts IS NULL OR ts < ?)"); params.push(before.toISOString()); }
	const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
	const count = writable.prepare(`SELECT COUNT(*) AS count FROM trace_documents${where}`).get(...params).count;
	writable.prepare(`DELETE FROM trace_documents${where}`).run(...params);
	writable.close();
	return { deleted: true, all: false, documents: count, db_path: traceIndexPath() };
}
