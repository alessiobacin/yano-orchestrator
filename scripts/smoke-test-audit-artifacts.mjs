#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (script, args) => JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts", script), ...args], { cwd: root, encoding: "utf8" }));

const confidenceContract = fs.readFileSync(path.join(root, "prompts", "audit-confidence-contract.md"), "utf8");
assert.match(confidenceContract, /evidence_confidence/);
assert.match(confidenceContract, /judgment_confidence/);
assert.match(confidenceContract, /judgment_confidence_rationale/);
for (const artifact of [
	"playbooks/audit-campaign.yaml",
	"playbooks/qa-full-audit.yaml",
	"playbooks/architecture-health-audit.yaml",
	"playbooks/test-adequacy-audit.yaml",
	"playbooks/automation-control-audit.yaml",
	"playbooks/toolchain-readiness-audit.yaml",
	"playbooks/ai-delegation-audit.yaml",
	"prompts/audit-synthesizer.md",
	"prompts/auto-improver.md",
]) {
	const content = fs.readFileSync(path.join(root, artifact), "utf8");
	assert.match(content, /evidence_confidence/, `${artifact} must require evidence confidence`);
	assert.match(content, /judgment_confidence/, `${artifact} must require judgment confidence`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yano-audit-artifacts-"));
try {
	fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
	fs.mkdirSync(path.join(tmp, "test"), { recursive: true });
	fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node test/run.mjs", lint: "node lint.mjs" }, dependencies: { yaml: "1" } }));
	fs.writeFileSync(path.join(tmp, "src", "app.mjs"), "export function answer() { return 42; }\n");
	fs.writeFileSync(path.join(tmp, "test", "run.mjs"), "console.log('ok')\n");
	fs.writeFileSync(path.join(tmp, "README.md"), "# Fixture\n\nRun `npm test`.\n");
	const manifestFile = path.join(tmp, "manifest.json");
	const manifest = run("audit-manifest.mjs", ["--project-root", tmp, "--output", manifestFile]);
	assert.equal(manifest.kind, "yano-audit-manifest");
	assert.equal(manifest.package.scripts.test, "node test/run.mjs");
	assert.ok(manifest.inventory.files.some((file) => file.path === "src/app.mjs"));
	const delegation = run("audit-delegation.mjs", ["--manifest", manifestFile]);
	assert.equal(delegation.kind, "yano-audit-delegation-map");
	assert.ok(delegation.candidates.some((candidate) => candidate.id === "package-script:test" && candidate.mode === "D0"));
	const traceFile = path.join(tmp, "trace.jsonl");
	fs.writeFileSync(traceFile, [
		JSON.stringify({ event_id: "planner-01:1", ts: "2026-01-01T00:00:00.000Z", type: "turn_start", instance: "planner-01", project: "fixture", campaign_id: "camp-1", chapter_id: "qa", model_provider: "llmproxy", model_id: "model-a" }),
		JSON.stringify({ event_id: "planner-01:2", ts: "2026-01-01T00:00:01.000Z", type: "tool_execution_end", instance: "planner-01", project: "fixture", campaign_id: "camp-1", chapter_id: "qa", tool: "npm", deterministic: true, duration_ms: 1000 }),
		JSON.stringify({ event_id: "planner-01:3", ts: "2026-01-01T00:00:02.000Z", type: "turn_end", instance: "planner-01", project: "fixture", campaign_id: "camp-1", chapter_id: "qa", model_provider: "llmproxy", model_id: "model-a", turn_index: 2, duration_ms: 2000, input_tokens: 10, output_tokens: 20, total_tokens: 30 }),
	].join("\n") + "\n");
	const ledger = run("audit-resource-ledger.mjs", ["--trace-file", traceFile, "--project", "fixture"]);
	assert.equal(ledger.kind, "yano-audit-resource-ledger");
	assert.equal(ledger.records.length, 1);
	assert.equal(ledger.records[0].chapter_id, "qa");
	assert.equal(ledger.records[0].total_tokens, 30);
	assert.equal(ledger.records[0].deterministic_calls, 1);
	console.log("audit artifact smoke test passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
