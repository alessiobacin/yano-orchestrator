// Regression test for the Herdr agent-name length defect (defect A).
//
// `yano start --herdr` used to derive Herdr's registration name as
//   `${slugify(instance)}-${slugify(project)}-${randomUUID().slice(0, 8)}`.slice(0, 48)
// but Herdr accepts at most 32 characters and answers with a misleading error:
//   invalid_agent_name: agent name must start with a lowercase letter and
//   contain only lowercase letters, digits, '-' or '_' (1-32 characters)
// The `.slice(0, 48)` clamp therefore never protected anything: with a project
// scope of 8 characters ("code-mem") the usable instance budget is only
// 32 - 1 - 8 - 1 - 8 = 14 characters, so every audit-campaign role id
// (repo-cartographer-01 = 20, architecture-health-reviewer-01 = 31, ...) was
// rejected and the whole playbook could not be launched. Real evidence:
// code-mem, run 01M291N9EZ725JB04R92S7VCAK, wave 1 stuck, one orphan tab
// (w5E:t2, label repo-cartographer-01, 0 agents) left behind.
//
// The random suffix is what keeps the registration unique against a Herdr
// registration that outlived a crashed pane (agent_name_taken), so it must
// never be dropped: when the full name does not fit, the readable
// `<instance>-<project>` prefix is trimmed instead.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { HERDR_AGENT_NAME_MAX, herdrAgentName } from "./launch-planner.mjs";

// Minimal fake `herdr` used by the end-to-end check below: it records the
// exact <NAME> the launcher hands to `herdr agent start` and answers the other
// two calls the launcher makes (api snapshot / tab create). No real agent is
// ever started, and no real Herdr instance is touched.
const FAKE_HERDR_SHIM = [
	"#!/usr/bin/env node",
	'const fs = require("node:fs");',
	"const args = process.argv.slice(2);",
	'const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };',
	'if (args[0] === "api" && args[1] === "snapshot") out({ result: { snapshot: { workspaces: [{ workspace_id: "wZZ", label: "code-mem" }], tabs: [{ tab_id: "wZZ:t1", workspace_id: "wZZ", label: "1" }], panes: [{ workspace_id: "wZZ", pane_id: "wZZ:p1", tab_id: "wZZ:t1", cwd: process.env.E2E_CWD }], agents: [] } } });',
	'if (args[0] === "tab" && args[1] === "create") out({ result: { root_pane: { pane_id: "wZZ:p2" } } });',
	'if (args[0] === "tab" && args[1] === "rename") out({ result: { ok: true } });',
	'if (args[0] === "agent" && args[1] === "start") { fs.appendFileSync(process.env.E2E_CAPTURE, args[2] + "\\n"); out({ result: { ok: true } }); }',
	'out({ result: { ok: true } });',
	"",
].join("\n");

// The exact acceptance contract Herdr enforces (observed from its own error
// message and confirmed by differential probes: a 33-char name is rejected,
// a 23-char name is accepted).
const HERDR_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

console.log("Regression: Herdr agent name always fits in 32 characters and stays unique");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

function assertAcceptable(name, label) {
	assert.ok(name.length <= HERDR_AGENT_NAME_MAX, `${label}: "${name}" is ${name.length} chars, over the ${HERDR_AGENT_NAME_MAX} limit`);
	assert.match(name, HERDR_NAME_PATTERN, `${label}: "${name}" violates Herdr's name format`);
}

check("the exact cases that were blocked on code-mem are now accepted", () => {
	for (const instance of ["repo-cartographer-01", "toolchain-evaluator-01", "test-adequacy-analyst-01", "architecture-health-reviewer-01", "automation-control-auditor-01", "product-ux-analyst-01", "audit-synthesizer-01"]) {
		assertAcceptable(herdrAgentName(instance, "code-mem", "a1b2c3d4"), `${instance}/code-mem`);
	}
});

check("ordinary team instances keep working unchanged", () => {
	assertAcceptable(herdrAgentName("coder-01", "code-mem", "a1b2c3d4"), "coder-01/code-mem");
	assertAcceptable(herdrAgentName("reviewer-01", "code-mem", "a1b2c3d4"), "reviewer-01/code-mem");
	assertAcceptable(herdrAgentName("docs-sync-01", "code-mem", "a1b2c3d4"), "docs-sync-01/code-mem");
});

check("a long project scope can never push the name over the limit", () => {
	const longScope = "a-very-long-project-scope-used-as-a-stress-case-for-herdr";
	for (const instance of ["repo-cartographer-01", "coder-01", "architecture-health-reviewer-01"]) {
		assertAcceptable(herdrAgentName(instance, longScope, "a1b2c3d4"), `${instance}/long-scope`);
	}
	assertAcceptable(herdrAgentName("architecture-health-reviewer-01", "x".repeat(200), "a1b2c3d4"), "200-char scope");
});

check("the random suffix is always preserved (uniqueness against agent_name_taken)", () => {
	const first = herdrAgentName("architecture-health-reviewer-01", "code-mem", "deadbee1");
	const second = herdrAgentName("architecture-health-reviewer-01", "code-mem", "cafe0002");
	assert.notEqual(first, second, "two different suffixes must produce two different names");
	assert.ok(first.endsWith("-deadbee1"), `"${first}" must keep the injected suffix`);
	assert.ok(second.endsWith("-cafe0002"), `"${second}" must keep the injected suffix`);
	assert.equal(first, herdrAgentName("architecture-health-reviewer-01", "code-mem", "deadbee1"), "the derivation must be deterministic for the same inputs");
});

check("names remain unique across instances of the same project", () => {
	const seen = new Set();
	for (const instance of ["repo-cartographer-01", "toolchain-evaluator-01", "test-adequacy-analyst-01", "architecture-health-reviewer-01", "automation-control-auditor-01", "product-ux-analyst-01", "audit-synthesizer-01", "coder-01"]) {
		const name = herdrAgentName(instance, "code-mem", "a1b2c3d4");
		assert.ok(!seen.has(name), `${instance}: duplicate derived name "${name}"`);
		seen.add(name);
	}
});

check("defensive cases: digit-leading and empty instance names still satisfy Herdr", () => {
	assertAcceptable(herdrAgentName("01-coder", "code-mem", "a1b2c3d4"), "digit-leading instance");
	assertAcceptable(herdrAgentName("", "code-mem", "a1b2c3d4"), "empty instance");
	assertAcceptable(herdrAgentName("coder-01", "", "a1b2c3d4"), "empty project scope");
	assertAcceptable(herdrAgentName("x".repeat(120), "y".repeat(120), "a1b2c3d4"), "everything too long");
});

check("regression proof: the old expression really produced an invalid name", () => {
	const oldExpression = `${"repo-cartographer-01"}-${"code-mem"}-a1b2c3d4`.slice(0, 48);
	assert.equal(oldExpression.length, 38, "the old derivation produced 38 characters");
	assert.ok(oldExpression.length > HERDR_AGENT_NAME_MAX, "and therefore exceeded Herdr's 32-character limit");
	assert.ok(herdrAgentName("repo-cartographer-01", "code-mem", "a1b2c3d4").length <= HERDR_AGENT_NAME_MAX, "while the fixed derivation fits");
});

// End-to-end wiring: the launcher must PASS a valid name to `herdr agent
// start`, not merely be able to compute one. Spawns the real
// scripts/launch-planner.mjs --herdr against the fake shim above and asserts
// on the argv it really received.
check("end-to-end: the name the launcher really passes to `herdr agent start` is valid", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yano-herdr-name-e2e-"));
	const binDir = path.join(tmp, "bin");
	const captureFile = path.join(tmp, "captured-names.txt");
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(captureFile, "");
	fs.writeFileSync(path.join(binDir, "herdr"), FAKE_HERDR_SHIM);
	fs.chmodSync(path.join(binDir, "herdr"), 0o700);
	const cases = ["architecture-health-reviewer-01", "repo-cartographer-01", "reviewer-01", "coder-01"];
	for (const instance of cases) {
		spawnSync(process.execPath, [path.join(repoRoot, "scripts", "launch-planner.mjs"), "--herdr", "--instance", instance, "--role", "coder", "--project", "code-mem"], {
			cwd: repoRoot,
			encoding: "utf8",
			env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`, E2E_CWD: repoRoot, E2E_CAPTURE: captureFile, YANO_DATA_DIR: path.join(tmp, "data") },
		});
	}
	const captured = fs.readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean);
	assert.equal(captured.length, cases.length, `expected ${cases.length} captured agent names, got ${captured.length}`);
	for (const name of captured) assertAcceptable(name, "end-to-end");
	fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\nsmoke-test-herdr-agent-name: ${passed} passed`);
