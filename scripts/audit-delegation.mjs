#!/usr/bin/env node

// Deterministic companion to the AI delegation chapter. It proposes which
// observations should be scripts and which still need semantic judgement.

import fs from "node:fs";
import path from "node:path";

function argValue(argv, flag, fallback = null) { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

const D0_RULES = [
	[/inventory|manifest|file.?tree|dependency|package|playbook|role|mcp|capabilit/i, "repository/configuration inventory is deterministic"],
	[/help|version|lint|format|type.?check|build|test|coverage|mutation|snapshot|hash|diff/i, "the tool already emits a machine-checkable result"],
	[/parse|extract|count|duplicate|dead.?code|long.?line|complexity|cycle/i, "static analysis can produce a reproducible candidate set"],
	[/trace|token|latency|duration|round|retry|context/i, "runtime telemetry can aggregate this without model judgement"],
];
const AI_RULES = [
	[/architecture|refactor|maintain|modular|coupling|cohesion/i, "requires trade-offs across boundaries and behavior"],
	[/product|feature|roadmap|market|competitor|gui|ux|user|human/i, "requires user expectation and value judgement"],
	[/semantic|logic|meaning|correctness.*expect|should.*do/i, "requires interpretation of intended behavior"],
	[/security.*design|threat|privacy.*trade/i, "requires contextual risk judgement after deterministic evidence"],
];

function classify(name, detail = "") {
	const text = `${name} ${detail}`;
	for (const [rule, rationale] of D0_RULES) if (rule.test(text)) return { mode: "D0", rationale, deterministic: true };
	for (const [rule, rationale] of AI_RULES) if (rule.test(text)) return { mode: "AI", rationale, deterministic: false };
	return { mode: "D1", rationale: "script collects evidence; specialist interprets it", deterministic: false };
}

function main() {
	const argv = process.argv.slice(2);
	const manifestFile = argValue(argv, "--manifest");
	if (!manifestFile) throw new Error("usa --manifest <audit-manifest.json>");
	const manifest = readJson(path.resolve(manifestFile));
	const candidates = [];
	for (const name of Object.keys(manifest.package?.scripts ?? {}).sort()) candidates.push({ id: `package-script:${name}`, source: "package.json", action: name, ...classify(name, manifest.package.scripts[name]) });
	for (const item of manifest.yano?.playbooks ?? []) candidates.push({ id: `playbook:${item.id}`, source: item.file, action: `validate ${item.id}`, ...classify("playbook", `${item.id} ${item.intents.join(" ")}`) });
	for (const server of manifest.mcp?.servers ?? []) candidates.push({ id: `mcp:${server}`, source: manifest.mcp.source, action: `probe ${server}`, ...classify("mcp capability", server) });
	for (const server of manifest.yano?.known_mcp_capabilities ?? []) if (!(manifest.mcp?.servers ?? []).includes(server)) candidates.push({ id: `mcp-declared:${server}`, source: "agents/capabilities.yaml", action: `probe declared ${server}`, ...classify("mcp capability", server) });
	const summary = { D0: 0, D1: 0, AI: 0 };
	for (const item of candidates) summary[item.mode]++;
	const result = {
		schema_version: 1,
		kind: "yano-audit-delegation-map",
		generated_at: new Date().toISOString(),
		project_root: manifest.project?.root ?? null,
		policy: { D0: "script-first", D1: "script evidence plus specialist interpretation", AI: "LLM judgement with explicit evidence" },
		summary: { ...summary, candidates: candidates.length },
		candidates,
		measurement_plan: [
			"measure wall-clock and exit status for every deterministic call",
			"measure prompt/model/token fields for every specialist turn when provider telemetry exposes them",
			"mark unavailable token values as unknown rather than inventing estimates",
			"compare repeated campaign runs by chapter_id and campaign_id",
		],
	};
	const output = JSON.stringify(result, null, 2);
	const outputFile = argValue(argv, "--output");
	if (outputFile) fs.writeFileSync(path.resolve(outputFile), `${output}\n`, { mode: 0o600 });
	process.stdout.write(`${output}\n`);
}

try { main(); } catch (error) { console.error(`audit-delegation: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
