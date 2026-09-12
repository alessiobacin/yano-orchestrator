#!/usr/bin/env node

// Aggregate observable Yano trace events by audit chapter. Missing provider
// token data stays null: the ledger is evidence, not a guessed cost report.

import fs from "node:fs";
import path from "node:path";

function argValue(argv, flag, fallback = null) { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; }
function numeric(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function linesFromFile(file) {
	try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}
function traceFiles(root) {
	if (!root || !fs.existsSync(root)) return [];
	const found = [];
	function visit(dir) {
		let entries = [];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(file);
		}
	}
	visit(root);
	return found.sort();
}
function modelParts(event) {
	if (event.model_provider || event.model_id) return { provider: event.model_provider ?? null, model: event.model_id ?? null };
	const value = typeof event.model === "string" ? event.model : "";
	const separator = value.indexOf(":");
	return separator > 0 ? { provider: value.slice(0, separator), model: value.slice(separator + 1) } : { provider: null, model: value || null };
}
function chapterKey(event) { return event.chapter_id || event.phase_id || "unassigned"; }

function aggregate(events) {
	const groups = new Map();
	for (const event of events) {
		const campaign = event.campaign_id || "unassigned";
		const key = `${campaign}::${chapterKey(event)}`;
		if (!groups.has(key)) groups.set(key, {
			campaign_id: campaign,
			chapter_id: chapterKey(event),
			phase_ids: new Set(),
			instances: new Set(),
			models: new Map(),
			started_at: null,
			ended_at: null,
			wall_clock_ms: 0,
			queue_or_wait_ms: 0,
			input_tokens: null,
			output_tokens: null,
			total_tokens: null,
			context_tokens: null,
			inference_rounds: 0,
			agent_turns: new Set(),
			tool_calls: 0,
			deterministic_calls: 0,
			retries: 0,
			compactions: 0,
			event_count: 0,
			trace_event_ids: [],
			measurement: "measured",
		});
		const group = groups.get(key);
		group.event_count++;
		if (event.phase_id) group.phase_ids.add(event.phase_id);
		if (event.instance) group.instances.add(event.instance);
		const model = modelParts(event);
		const modelKey = `${model.provider ?? "unknown"}:${model.model ?? "unknown"}`;
		group.models.set(modelKey, (group.models.get(modelKey) ?? 0) + 1);
		if (event.ts && (!group.started_at || event.ts < group.started_at)) group.started_at = event.ts;
		if (event.ts && (!group.ended_at || event.ts > group.ended_at)) group.ended_at = event.ts;
		if (event.type === "turn_end" || event.type === "inference_end") {
			group.inference_rounds++;
			if (event.turn_index !== null && event.turn_index !== undefined) group.agent_turns.add(String(event.turn_index));
		}
		if (event.type === "tool_execution_end") {
			group.tool_calls++;
			if (numeric(event.duration_ms) !== null) group.wall_clock_ms += event.duration_ms;
			if (event.deterministic === true || /^(bash|read|write|edit|grep|find|ls|command|shell|node|npm|npx|git|yano|rg|script)/i.test(String(event.tool ?? ""))) group.deterministic_calls++;
		}
		if (event.type === "agent_send_out" && event.new_round === true) group.retries++;
		if (event.type === "context_compaction_completed" || event.type === "context_compaction_requested") group.compactions++;
		if (numeric(event.duration_ms) !== null && event.type !== "tool_execution_end") group.wall_clock_ms += event.duration_ms;
		for (const field of ["input_tokens", "output_tokens", "total_tokens", "context_tokens"]) {
			const value = numeric(event[field]);
			if (value !== null) group[field] = (group[field] ?? 0) + value;
		}
		if (numeric(event.queue_or_wait_ms) !== null) group.queue_or_wait_ms += event.queue_or_wait_ms;
		if (event.trace_event_id || event.event_id) group.trace_event_ids.push(event.trace_event_id || event.event_id);
	}
	return [...groups.values()].map((group) => ({
		...group,
		phase_ids: [...group.phase_ids].sort(),
		instances: [...group.instances].sort(),
		models: [...group.models.entries()].map(([model, count]) => ({ model, events: count })).sort((a, b) => a.model.localeCompare(b.model)),
		agent_turns: group.agent_turns.size,
		trace_event_ids: group.trace_event_ids.slice(-100),
		measurement: group.input_tokens === null && group.output_tokens === null ? "partial_provider_usage_unknown" : "measured",
	})).sort((a, b) => `${a.campaign_id}:${a.chapter_id}`.localeCompare(`${b.campaign_id}:${b.chapter_id}`));
}

function main() {
	const argv = process.argv.slice(2);
	const explicitFile = argValue(argv, "--trace-file");
	const root = argValue(argv, "--trace-root", process.env.YANO_DATA_DIR ? path.join(process.env.YANO_DATA_DIR, "traces") : null);
	const files = explicitFile ? [path.resolve(explicitFile)] : traceFiles(root);
	let events = files.flatMap(linesFromFile);
	const project = argValue(argv, "--project");
	const campaign = argValue(argv, "--campaign-id");
	if (project) events = events.filter((event) => event.project === project || event.project_key === project);
	if (campaign) events = events.filter((event) => event.campaign_id === campaign);
	const records = aggregate(events);
	const result = { schema_version: 1, kind: "yano-audit-resource-ledger", generated_at: new Date().toISOString(), source_files: files, filters: { project: project ?? null, campaign_id: campaign ?? null }, event_count: events.length, records };
	const output = JSON.stringify(result, null, 2);
	const outputFile = argValue(argv, "--output");
	if (outputFile) fs.writeFileSync(path.resolve(outputFile), `${output}\n`, { mode: 0o600 });
	process.stdout.write(`${output}\n`);
}

try { main(); } catch (error) { console.error(`audit-resource-ledger: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
