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
const INDEX_SCHEMA_VERSION = 2;
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
			memories: tableExists(db, "trace_memories") ? db.prepare("SELECT COUNT(*) AS count FROM trace_memories").get().count : 0,
			links: tableExists(db, "trace_memory_links") ? db.prepare("SELECT COUNT(*) AS count FROM trace_memory_links").get().count : 0,
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
			PRAGMA foreign_keys = ON;
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
			CREATE TABLE IF NOT EXISTS trace_memories (
				memory_id TEXT PRIMARY KEY,
				project TEXT,
				project_key TEXT NOT NULL,
				run_id TEXT,
				round TEXT,
				task_slug TEXT,
				kind TEXT NOT NULL,
				layer TEXT NOT NULL,
				title TEXT NOT NULL,
				body TEXT NOT NULL,
				summary TEXT,
				confidence TEXT NOT NULL,
				salience REAL NOT NULL DEFAULT 0.5,
				source_record_ids_json TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'active',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				valid_from TEXT,
				valid_to TEXT,
				supersedes_id TEXT,
				content_hash TEXT NOT NULL,
				embedding_model TEXT NOT NULL,
				embedding_dimensions INTEGER NOT NULL,
				embedding_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS trace_memories_project_idx ON trace_memories(project_key);
			CREATE INDEX IF NOT EXISTS trace_memories_run_idx ON trace_memories(run_id);
			CREATE INDEX IF NOT EXISTS trace_memories_kind_idx ON trace_memories(kind);
			CREATE INDEX IF NOT EXISTS trace_memories_layer_idx ON trace_memories(layer);
			CREATE TABLE IF NOT EXISTS trace_memory_context (
				memory_id TEXT PRIMARY KEY REFERENCES trace_memories(memory_id) ON DELETE CASCADE,
				cwd TEXT,
				git_branch TEXT,
				roles_json TEXT NOT NULL,
				tools_json TEXT NOT NULL,
				files_json TEXT NOT NULL,
				entities_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS trace_memory_links (
				link_id TEXT PRIMARY KEY,
				source_memory_id TEXT NOT NULL REFERENCES trace_memories(memory_id) ON DELETE CASCADE,
				target_memory_id TEXT NOT NULL REFERENCES trace_memories(memory_id) ON DELETE CASCADE,
				relation TEXT NOT NULL,
				weight REAL NOT NULL DEFAULT 1,
				evidence_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				UNIQUE(source_memory_id, target_memory_id, relation)
			);
			CREATE INDEX IF NOT EXISTS trace_memory_links_source_idx ON trace_memory_links(source_memory_id);
			CREATE INDEX IF NOT EXISTS trace_memory_links_target_idx ON trace_memory_links(target_memory_id);
		`);
		db.prepare("INSERT INTO trace_index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("schema_version", String(INDEX_SCHEMA_VERSION));
	}
	return db;
}

function tableExists(db, name) {
	return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
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

const FAILURE_RULES = [
	["no_live_target", (record) => record.type === "agent_send_no_live_target"],
	["delegation_timeout", (record) => record.type === "whatsapp_notify" && record.reason === "agent_send_timeout"],
	["watchdog_stall", (record) => typeof record.type === "string" && record.type.includes("stall")],
	["orphaned_agent", (record) => typeof record.type === "string" && record.type.includes("orphan")],
	["merge_conflict", (record) => record.type === "worktree_finalize" && record.conflict === true],
	["dirty_main_finalize", (record) => record.type === "worktree_finalize" && record.blocked_dirty_main === true],
	["tool_failure", (record) => record.type === "tool_execution_end" && record.ok === false],
];

const FEEDBACK_RULES = [
	["requirements_missed", /requisit|richiest|specifica|non era quello|mancava/i],
	["wrong_implementation", /errore|sbagliat|bug|non funziona|regression|rotto/i],
	["verification_gap", /test|verific|review|controll|non provat/i],
	["orchestration_gap", /planner|deleg|agent|round|workflow|flusso|coordin/i],
	["missing_capability", /skill|competenz|specialist|agente|ruolo|tool|cli|mcp/i],
	["ux_or_output_gap", /interfaccia|ui|ux|output|document|report|spiegaz/i],
];

function memoryHash(memory) {
	return hash(JSON.stringify({
		project_key: memory.project_key, run_id: memory.run_id, round: memory.round,
		task_slug: memory.task_slug, kind: memory.kind, layer: memory.layer,
		title: memory.title, body: memory.body, source_record_ids: memory.source_record_ids,
	}));
}

function memoryId(memory) {
	return `memory-${memoryHash(memory).slice(0, 32)}`;
}

function recordId(record) {
	return record.id || hash(JSON.stringify(record));
}

function memoryScope(record) {
	return {
		project: record.project || null,
		project_key: record.project_key || "unknown",
		run_id: record.run_id || null,
		round: record.round === null || record.round === undefined ? null : String(record.round),
		task_slug: record.task_slug || record.slug || null,
	};
}

function memoryText(memory) {
	return [
		`kind: ${memory.kind}`,
		`layer: ${memory.layer}`,
		`title: ${memory.title}`,
		memory.summary ? `summary: ${memory.summary}` : null,
		`body: ${memory.body}`,
		`confidence: ${memory.confidence}`,
	].filter(Boolean).join("\n").slice(0, MAX_TEXT_LENGTH);
}

function makeMemory(input) {
	const now = new Date().toISOString();
	const memory = {
		...input,
		round: input.round === null || input.round === undefined ? null : String(input.round),
		summary: input.summary || input.body,
		confidence: input.confidence || "medium",
		salience: Number.isFinite(Number(input.salience)) ? Number(input.salience) : 0.5,
		source_record_ids: [...new Set((input.source_record_ids || []).filter(Boolean))],
		status: input.status || "active",
		created_at: input.created_at || now,
		updated_at: now,
		valid_from: input.valid_from || now,
		valid_to: input.valid_to || null,
		supersedes_id: input.supersedes_id || null,
	};
	memory.content_hash = memoryHash(memory);
	memory.memory_id = input.memory_id || memoryId(memory);
	return memory;
}

function groupKey(record) {
	const scope = memoryScope(record);
	return [scope.project_key, scope.run_id || "", scope.round || "", scope.task_slug || ""].join("|");
}

function recordsByScope(records) {
	const groups = new Map();
	for (const record of records) {
		const key = groupKey(record);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(record);
	}
	return groups;
}

function uniqueValues(records, fields) {
	const values = [];
	for (const record of records) for (const field of fields) {
		const value = record[field];
		if (value && !values.includes(String(value))) values.push(String(value));
	}
	return values.slice(0, 50);
}

function classifyFailure(record) {
	for (const [name, predicate] of FAILURE_RULES) if (predicate(record)) return name;
	return null;
}

function feedbackPatterns(record) {
	const text = String(record.text || "");
	return FEEDBACK_RULES.filter(([, matcher]) => matcher.test(text)).map(([name]) => name);
}

/**
 * Build a deterministic, provenance-preserving memory layer from observable
 * trace records. This is intentionally not an LLM summary: every conclusion
 * points back to raw record ids and can be regenerated from JSONL.
 */
export function buildTraceMemories(records, { includePatterns = true } = {}) {
	const memories = [];
	const links = [];
	for (const [scopeKey, scoped] of recordsByScope(records)) {
		const first = scoped[0] || {};
		const scope = memoryScope(first);
		const failures = scoped.map((record) => ({ record, class: classifyFailure(record) })).filter((item) => item.class);
		const feedback = scoped.filter((record) => record.record_type === "feedback");
		const opinions = scoped.filter((record) => record.record_type === "opinion");
		const agents = uniqueValues(scoped, ["instance", "role"]);
		const tools = uniqueValues(scoped, ["tool", "tool_name"]);
		const files = uniqueValues(scoped, ["file", "file_path", "path", "changed_file"]);
		const entities = uniqueValues(scoped, ["type", "tool", "role", "task_slug", "failure_class"]);
		const summaryBody = [
			`${scoped.length} record osservabili nello scope.`,
			feedback.length ? `Feedback: ${feedback.map((item) => `${item.status}: ${item.text}`).join(" | ")}` : "Nessun feedback utente registrato.",
			failures.length ? `Segnali di failure: ${failures.map((item) => item.class).join(", ")}.` : "Nessun segnale di failure classificato.",
			opinions.length ? `Opinioni planner: ${opinions.map((item) => item.summary || item.root_cause || item.text).join(" | ")}` : "",
		].filter(Boolean).join(" ");
		const summary = makeMemory({
			...scope, kind: "trace_run_summary", layer: "episodic",
			title: `Scope ${scope.run_id || scope.project || scopeKey}${scope.round ? ` round ${scope.round}` : ""}`,
			body: summaryBody, summary: summaryBody.slice(0, 500),
			confidence: feedback.length || failures.length || opinions.length ? "high" : "medium",
			salience: feedback.some((item) => item.status === "rejected") || failures.length ? 0.9 : 0.55,
			source_record_ids: scoped.map(recordId),
			roles: agents, tools, files, entities, cwd: first.cwd || first.workspace_cwd || null, git_branch: first.git_branch || null,
		});
		memories.push(summary);

		for (const { record, class: failureClass } of failures) {
			const failure = makeMemory({
				...memoryScope(record), kind: "trace_failure", layer: "episodic",
				title: `Failure ${failureClass}`,
				body: traceDocumentText(record), summary: `${failureClass}: ${record.detail || record.reason || record.message || record.type}`,
				confidence: "high", salience: 0.9, source_record_ids: [recordId(record)],
				roles: uniqueValues([record], ["instance", "role"]), tools: uniqueValues([record], ["tool", "tool_name"]),
				files: uniqueValues([record], ["file", "file_path", "path", "changed_file"]), entities: uniqueValues([record], ["type", "tool", "role"]),
				cwd: record.cwd || record.workspace_cwd || null, git_branch: record.git_branch || null,
			});
			memories.push(failure);
			links.push({ source_memory_id: failure.memory_id, target_memory_id: summary.memory_id, relation: "failure_observed_in", weight: 1, evidence: [recordId(record)] });
		}

		for (const opinion of opinions) {
			const opinionMemory = makeMemory({
				...memoryScope(opinion), kind: "trace_opinion", layer: "episodic",
				title: "Planner opinion", body: traceDocumentText(opinion),
				summary: opinion.summary || opinion.root_cause || opinion.text,
				confidence: opinion.confidence || "medium", salience: 0.8, source_record_ids: [recordId(opinion)],
				roles: opinion.affected_roles || [], tools: [],
			});
			memories.push(opinionMemory);
			links.push({ source_memory_id: opinionMemory.memory_id, target_memory_id: summary.memory_id, relation: "opinion_based_on", weight: 1, evidence: [recordId(opinion)] });
		}

		for (const feedbackRecord of feedback) {
			for (const pattern of feedbackPatterns(feedbackRecord)) {
				const feedbackMemory = makeMemory({
					...memoryScope(feedbackRecord), kind: "trace_observation", layer: "episodic",
					title: `User feedback ${pattern}`, body: feedbackRecord.text,
					summary: `${pattern}: ${feedbackRecord.text}`, confidence: "high",
					salience: feedbackRecord.status === "rejected" ? 1 : 0.75,
					source_record_ids: [recordId(feedbackRecord)], roles: [], tools: [],
				});
				memories.push(feedbackMemory);
				links.push({ source_memory_id: feedbackMemory.memory_id, target_memory_id: summary.memory_id, relation: "feedback_observed_in", weight: 1, evidence: [recordId(feedbackRecord)] });
			}
		}
	}

	if (includePatterns) {
		const patternGroups = new Map();
		for (const memory of memories.filter((item) => item.kind === "trace_failure" || item.kind === "trace_observation")) {
			const pattern = memory.title.replace(/^Failure |^User feedback /, "");
			if (!patternGroups.has(pattern)) patternGroups.set(pattern, []);
			patternGroups.get(pattern).push(memory);
		}
		for (const [pattern, evidence] of patternGroups) {
			if (evidence.length < 2) continue;
			const patternMemory = makeMemory({
				project: null, project_key: "global", run_id: null, round: null, task_slug: null,
				kind: "trace_pattern", layer: "systemic", title: `Recurring pattern ${pattern}`,
				body: `Il pattern ${pattern} è comparso ${evidence.length} volte in ${new Set(evidence.map((item) => item.project_key)).size} progetto/i.`,
				summary: `${pattern}: ${evidence.length} evidenze`, confidence: evidence.length >= 3 ? "high" : "medium",
				salience: 0.95, source_record_ids: evidence.flatMap((item) => item.source_record_ids),
			});
			memories.push(patternMemory);
			for (const evidenceMemory of evidence) links.push({ source_memory_id: evidenceMemory.memory_id, target_memory_id: patternMemory.memory_id, relation: "supports_pattern", weight: 1 / evidence.length, evidence: evidenceMemory.source_record_ids });
		}
	}
	return { memories, links };
}

function writeMemoryProjection(memories, links, { cwd, project, allProjects = false } = {}) {
	const base = tracePaths({ cwd, project }).projectDir;
	const directory = path.join(base, "projections");
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const visible = allProjects ? memories : memories.filter((memory) => memory.project_key === tracePaths({ cwd, project }).projectKey || memory.project_key === "global");
	const projection = {
		generated_at: new Date().toISOString(),
		project: allProjects ? null : project,
		memories: visible,
		links: links.filter((link) => visible.some((memory) => memory.memory_id === link.source_memory_id || memory.memory_id === link.target_memory_id)),
	};
	fs.writeFileSync(path.join(directory, "planner-context.json"), `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
	const failures = visible.filter((memory) => memory.kind === "trace_failure" || memory.kind === "trace_pattern");
	fs.writeFileSync(path.join(directory, "recurring-failures.md"), [
		"# Yano trace — failure memory",
		"",
		`Generato: ${projection.generated_at}`,
		"",
		...(failures.length ? failures.map((memory) => `- **${memory.title}** — ${memory.summary} (confidence: ${memory.confidence})`) : ["Nessuna failure consolidata."]),
		"",
	].join("\n"), { mode: 0o600 });
	return { directory, files: ["planner-context.json", "recurring-failures.md"] };
}

function upsertMemories(db, memories, links) {
	const insertMemory = db.prepare(`
		INSERT INTO trace_memories (
			memory_id, project, project_key, run_id, round, task_slug, kind, layer, title, body,
			summary, confidence, salience, source_record_ids_json, status, created_at, updated_at,
			valid_from, valid_to, supersedes_id, content_hash, embedding_model, embedding_dimensions, embedding_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(memory_id) DO UPDATE SET
			project = excluded.project, project_key = excluded.project_key, run_id = excluded.run_id,
			round = excluded.round, task_slug = excluded.task_slug, kind = excluded.kind, layer = excluded.layer,
			title = excluded.title, body = excluded.body, summary = excluded.summary, confidence = excluded.confidence,
			salience = excluded.salience, source_record_ids_json = excluded.source_record_ids_json,
			status = excluded.status, updated_at = excluded.updated_at, valid_from = excluded.valid_from,
			valid_to = excluded.valid_to, supersedes_id = excluded.supersedes_id, content_hash = excluded.content_hash,
			embedding_model = excluded.embedding_model, embedding_dimensions = excluded.embedding_dimensions,
			embedding_json = excluded.embedding_json
	`);
	const insertContext = db.prepare(`
		INSERT INTO trace_memory_context(memory_id, cwd, git_branch, roles_json, tools_json, files_json, entities_json)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(memory_id) DO UPDATE SET cwd = excluded.cwd, git_branch = excluded.git_branch,
		roles_json = excluded.roles_json, tools_json = excluded.tools_json, files_json = excluded.files_json,
		entities_json = excluded.entities_json
	`);
	const insertLink = db.prepare(`
		INSERT INTO trace_memory_links(link_id, source_memory_id, target_memory_id, relation, weight, evidence_json, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(source_memory_id, target_memory_id, relation) DO UPDATE SET weight = excluded.weight, evidence_json = excluded.evidence_json
	`);
	for (const memory of memories) {
		insertMemory.run(memory.memory_id, memory.project, memory.project_key, memory.run_id, memory.round, memory.task_slug, memory.kind, memory.layer, memory.title, memory.body, memory.summary, memory.confidence, memory.salience, JSON.stringify(memory.source_record_ids), memory.status, memory.created_at, memory.updated_at, memory.valid_from, memory.valid_to, memory.supersedes_id, memory.content_hash, memory.embedding_model, memory.embedding_dimensions, JSON.stringify(memory.embedding));
		insertContext.run(memory.memory_id, memory.cwd || null, memory.git_branch || null, JSON.stringify(memory.roles || []), JSON.stringify(memory.tools || []), JSON.stringify(memory.files || []), JSON.stringify(memory.entities || []));
	}
	for (const link of links) insertLink.run(link.link_id || `link-${hash(JSON.stringify([link.source_memory_id, link.target_memory_id, link.relation]))}`, link.source_memory_id, link.target_memory_id, link.relation, link.weight ?? 1, JSON.stringify(link.evidence || []), new Date().toISOString());
}

export async function consolidateTraceMemories({
	cwd = process.cwd(), project, allProjects = false, run = null, round = null, task = null,
	instance = null, type = null, since = null, limit = 1000000, model = resolveEmbeddingModel(),
} = {}) {
	// Summaries are generated projections, not new evidence. Excluding them
	// keeps consolidation idempotent and prevents summary-of-summary growth.
	const records = filteredRecords({ cwd, project, allProjects, run, round, task, instance, type, since, limit })
		.filter((record) => record.record_type !== "summary");
	const built = buildTraceMemories(records, { includePatterns: allProjects || !run });
	const texts = built.memories.map(memoryText);
	const db = openDatabase();
	let vectors = [];
	try { vectors = await embedTexts(texts, { model }); } catch (error) {
		db.close();
		throw new Error(`trace consolidate: embeddings non disponibili (${error instanceof Error ? error.message : String(error)})`);
	}
	for (let index = 0; index < built.memories.length; index++) {
		built.memories[index].embedding_model = model;
		built.memories[index].embedding = vectors[index];
		built.memories[index].embedding_dimensions = vectors[index].length;
	}
	try {
		db.exec("BEGIN");
		upsertMemories(db, built.memories, built.links);
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch { /* best effort */ }
		throw error;
	} finally { db.close(); }
	const projection = writeMemoryProjection(built.memories, built.links, { cwd, project, allProjects });
	return {
		ok: true, memories: built.memories.length, links: built.links.length, records: records.length,
		patterns: built.memories.filter((memory) => memory.kind === "trace_pattern").length,
		projection, db_path: traceIndexPath(), model,
		filters: { project: allProjects ? null : (project || tracePaths({ cwd }).project), all_projects: allProjects, run, round, task, instance, type, since: since?.toISOString?.() || null },
	};
}

export function planTraceRetrieval({ cwd = process.cwd(), project, allProjects = false, query = "", run = null, round = null, task = null, limit = 12, budget = 6000 } = {}) {
	const effectiveLimit = Math.max(1, Number(limit) || 12);
	const records = filteredRecords({ cwd, project, allProjects, run, round, task, limit: 1000000 });
	const db = openDatabase({ readOnly: true });
	let memories = 0;
	if (db && tableExists(db, "trace_memories")) {
		const clauses = [];
		const params = [];
		if (!allProjects) { const keys = traceProjectKeys({ cwd, project }); clauses.push(`project_key IN (${keys.map(() => "?").join(",")}, 'global')`); params.push(...keys); }
		if (run) { clauses.push("run_id = ?"); params.push(run); }
		if (round !== null && round !== undefined) { clauses.push("round = ?"); params.push(String(round)); }
		if (task) { clauses.push("task_slug = ?"); params.push(task); }
		memories = db.prepare(`SELECT COUNT(*) AS count FROM trace_memories${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}`).get(...params).count;
	}
	if (db) db.close();
	const lexical = String(query || "").trim();
	const suggested = [];
	if (lexical) suggested.push(`yano trace search --query ${JSON.stringify(lexical)} --mode hybrid --limit ${effectiveLimit} --explain`);
	suggested.push(`yano trace context --limit ${Math.min(120, effectiveLimit * 8)} --json${run ? ` --run ${run}` : ""}${round ? ` --round ${round}` : ""}${task ? ` --task ${task}` : ""}`);
	return {
		ok: true, query: lexical, budget_tokens: Math.max(500, Number(budget) || 6000), suggested_limit: effectiveLimit,
		filters: { project: allProjects ? null : (project || tracePaths({ cwd }).project), all_projects: allProjects, run, round, task },
		available: { raw_records: records.length, consolidated_memories: memories },
		strategy: ["consolidated memories first", "hybrid semantic + lexical ranking", "recency/context tie-break", "raw evidence only when memory confidence or coverage is insufficient"],
		commands: suggested,
		estimated_raw_tokens: Math.ceil(records.reduce((total, record) => total + JSON.stringify(record).length, 0) / 4),
	};
}

export function exportTraceBundle({ cwd = process.cwd(), project, allProjects = false, run = null, round = null, task = null, since = null, limit = 1000000 } = {}) {
	const records = filteredRecords({ cwd, project, allProjects, run, round, task, since, limit });
	const projectKeys = new Set(records.map((record) => record.project_key));
	const db = openDatabase({ readOnly: true });
	let documents = [];
	let memories = [];
	let links = [];
	if (db) {
		if (tableExists(db, "trace_documents")) documents = db.prepare("SELECT * FROM trace_documents").all().filter((row) => allProjects || projectKeys.has(row.project_key));
		if (tableExists(db, "trace_memories")) memories = db.prepare("SELECT * FROM trace_memories").all().filter((row) => allProjects || projectKeys.has(row.project_key) || row.project_key === "global");
		if (tableExists(db, "trace_memory_links")) links = db.prepare("SELECT * FROM trace_memory_links").all();
		db.close();
	}
	return {
		format: "yano-trace-bundle",
		bundle_version: 1,
		exported_at: new Date().toISOString(),
		source_of_truth: "observable-jsonl",
		filters: { project: allProjects ? null : (project || tracePaths({ cwd }).project), all_projects: allProjects, run, round, task, since: since?.toISOString?.() || null },
		records,
		derived: { documents, memories, links },
		restore_note: "Importa prima records; poi esegui yano trace index e yano trace consolidate per rigenerare le proiezioni.",
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
	mode = "hybrid", memoryOnly = false, explain = false,
} = {}) {
	if (!query?.trim()) throw new Error("semantic trace search: --query è obbligatorio");
	const db = openDatabase({ readOnly: true });
	if (!db) return { ok: false, db_path: traceIndexPath(), model, query, total: 0, results: [], message: "indice assente: esegui prima yano trace index" };
	try {
		if (!["keyword", "semantic", "hybrid"].includes(mode)) throw new Error(`trace search: modalità non valida "${mode}"`);
		let vector = null;
		let embeddingWarning = null;
		if (mode !== "keyword") {
			try { vector = (await embedTexts([query.trim()], { model }))[0]; }
			catch (error) {
				if (mode === "semantic") throw error;
				embeddingWarning = error instanceof Error ? error.message : String(error);
				mode = "keyword";
			}
		}
		const clauses = [];
		const params = [];
		if (!allProjects) {
			const keys = traceProjectKeys({ cwd, project });
			clauses.push(`project_key IN (${keys.map(() => "?").join(",")}${memoryOnly ? ", 'global'" : ""})`);
			params.push(...keys);
		}
		if (run) { clauses.push("run_id = ?"); params.push(run); }
		if (round !== null && round !== undefined) { clauses.push("round = ?"); params.push(String(round)); }
		if (task) { clauses.push("task_slug = ?"); params.push(task); }
		if (instance) { clauses.push("instance = ?"); params.push(instance); }
		if (type) { clauses.push("event_type = ?"); params.push(type); }
		if (since) { clauses.push("(ts IS NULL OR ts >= ?)"); params.push(since.toISOString()); }
		const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = memoryOnly || !tableExists(db, "trace_documents") ? [] : db.prepare(`SELECT * FROM trace_documents${where}`).all(...params);
		const memoryClauses = [];
		const memoryParams = [];
		if (!allProjects) { const keys = traceProjectKeys({ cwd, project }); memoryClauses.push(`project_key IN (${keys.map(() => "?").join(",")}, 'global')`); memoryParams.push(...keys); }
		if (run) { memoryClauses.push("(run_id = ? OR run_id IS NULL)"); memoryParams.push(run); }
		if (round !== null && round !== undefined) { memoryClauses.push("(round = ? OR round IS NULL)"); memoryParams.push(String(round)); }
		if (task) { memoryClauses.push("(task_slug = ? OR task_slug IS NULL)"); memoryParams.push(task); }
		if (type) memoryClauses.push("1 = 0");
		if (instance) { memoryClauses.push("memory_id IN (SELECT memory_id FROM trace_memory_context WHERE roles_json LIKE ? OR tools_json LIKE ?)"); memoryParams.push(`%${instance}%`, `%${instance}%`); }
		const memoryWhere = memoryClauses.length ? ` WHERE ${memoryClauses.join(" AND ")}` : "";
		const memoryRows = tableExists(db, "trace_memories") ? db.prepare(`SELECT * FROM trace_memories${memoryWhere}`).all(...memoryParams) : [];
		const queryTokens = tokenize(query);
		const now = Date.now();
		const rankRow = (row, source) => {
			let stored = [];
			try { stored = JSON.parse(row.embedding_json); } catch { /* stale/corrupt vector is simply not semantic */ }
			const semantic = vector ? Math.max(0, cosineSimilarity(vector, stored)) : 0;
			const lexical = lexicalScore(queryTokens, row.text || `${row.title || ""} ${row.body || ""}`);
			const ageDays = row.ts || row.updated_at ? Math.max(0, (now - new Date(row.ts || row.updated_at).getTime()) / 86_400_000) : 365;
			const recency = 1 / (1 + ageDays / 30);
			const salience = source === "memory" ? Number(row.salience || 0.5) : 0.5;
			const score = mode === "keyword" ? lexical : mode === "semantic" ? semantic : (semantic * 0.65) + (lexical * 0.25) + (recency * 0.05) + (salience * 0.05);
			let payload = null;
			try { payload = JSON.parse(row.payload_json); } catch { /* memory rows have no payload_json */ }
			let sourceRecordIds = [];
			try { sourceRecordIds = JSON.parse(row.source_record_ids_json || "[]"); } catch { /* malformed derived memory provenance */ }
			return {
				score, semantic_score: semantic, lexical_score: lexical, recency_score: recency,
				source, document_id: row.document_id || row.memory_id, memory_id: row.memory_id || null,
				project: row.project, project_key: row.project_key, ts: row.ts || row.updated_at,
				record_type: row.record_type || `memory:${row.kind || "unknown"}`, event_type: row.event_type || null,
				instance: row.instance || null, role: row.role || null, run_id: row.run_id, round: row.round,
				task_slug: row.task_slug, text: row.text || memoryText({ kind: row.kind, layer: row.layer, title: row.title, body: row.body, summary: row.summary, confidence: row.confidence }),
				kind: row.kind || null, layer: row.layer || null, confidence: row.confidence || null,
				source_record_ids: sourceRecordIds,
				...(includePayload && source === "trace" ? { payload } : {}),
			};
		};
		const results = [...rows.map((row) => rankRow(row, "trace")), ...memoryRows.map((row) => rankRow(row, "memory"))]
			.filter((row) => mode === "keyword" ? row.lexical_score > 0 : row.score >= 0)
			.sort((left, right) => right.score - left.score).slice(0, Math.max(1, Number(limit) || 10));
		return { ok: true, db_path: traceIndexPath(), model, query, mode, embedding_warning: embeddingWarning, total: rows.length + memoryRows.length, results, filters: { project: allProjects ? null : (project || tracePaths({ cwd }).project), all_projects: allProjects, run, round, task, instance, type, since: since?.toISOString?.() || null }, ...(explain ? { explanation: "hybrid = semantic 65% + lexical 25% + recency 5% + salience 5%; memory rows are consolidated and provenance-preserving" } : {}) };
	} finally {
		db.close();
	}
}

function tokenize(value) {
	return [...new Set(String(value || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}_-]+/gu, " ").split(/\s+/).filter((token) => token.length >= 3))];
}

function lexicalScore(queryTokens, text) {
	if (!queryTokens.length) return 0;
	const haystack = String(text || "").toLowerCase();
	return queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0) / queryTokens.length;
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
	let memories = 0;
	if (tableExists(writable, "trace_memories")) {
		const memoryClauses = [];
		const memoryParams = [];
		if (!allProjects) { const keys = traceProjectKeys({ cwd, project }); memoryClauses.push(`project_key IN (${keys.map(() => "?").join(",")})`); memoryParams.push(...keys); }
		if (run) { memoryClauses.push("run_id = ?"); memoryParams.push(run); }
		if (round !== null && round !== undefined) { memoryClauses.push("round = ?"); memoryParams.push(String(round)); }
		if (task) { memoryClauses.push("task_slug = ?"); memoryParams.push(task); }
		if (instance) {
			memoryClauses.push("memory_id IN (SELECT memory_id FROM trace_memory_context WHERE roles_json LIKE ? OR tools_json LIKE ?)");
			memoryParams.push(`%${instance}%`, `%${instance}%`);
		}
		if (before) { memoryClauses.push("(updated_at IS NULL OR updated_at < ?)"); memoryParams.push(before.toISOString()); }
		const memoryWhere = memoryClauses.length ? ` WHERE ${memoryClauses.join(" AND ")}` : "";
		memories = writable.prepare(`SELECT COUNT(*) AS count FROM trace_memories${memoryWhere}`).get(...memoryParams).count;
		writable.prepare(`DELETE FROM trace_memories${memoryWhere}`).run(...memoryParams);
	}
	writable.close();
	return { deleted: true, all: false, documents: count, memories, db_path: traceIndexPath() };
}
