// Regression test for Herdr's transient `agent_kind_mismatch` response.
//
// Herdr can start Pi successfully and then answer the synchronous
// `agent start` request with a mismatch while its lifecycle hook is still
// publishing the stable `agent: pi` identity. The launcher must accept that
// response only after it verifies the same pane became a ready Pi agent.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const FAKE_HERDR_SHIM = [
	"#!/usr/bin/env node",
	'const fs = require("node:fs");',
	'const args = process.argv.slice(2);',
	'const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };',
	'const startedFile = process.env.E2E_STARTED;',
	'if (args[0] === "api" && args[1] === "snapshot") {',
	'  const started = fs.existsSync(startedFile);',
	'  const agents = started ? [{ pane_id: "wZZ:p1", agent: "pi", agent_status: "idle", agent_session: { source: "herdr:pi" } }] : [];',
	'  out({ result: { snapshot: { workspaces: [{ workspace_id: "wZZ", label: "code-mem" }], tabs: [{ tab_id: "wZZ:t1", workspace_id: "wZZ", label: "1" }], panes: [{ workspace_id: "wZZ", pane_id: "wZZ:p1", tab_id: "wZZ:t1", cwd: process.env.E2E_CWD }], agents } } });',
	'}',
	'if (args[0] === "tab" && args[1] === "rename") out({ result: { ok: true } });',
	'if (args[0] === "agent" && args[1] === "start") {',
	'  if (!fs.existsSync(startedFile)) {',
	'    fs.writeFileSync(startedFile, "started\\n");',
	'    process.stderr.write(JSON.stringify({ error: { code: "agent_kind_mismatch", message: "expected pi, detected planner-01" } }));',
	'    process.exit(17);',
	'  }',
	'  out({ result: { ok: true } });',
	'}',
	'out({ result: { ok: true } });',
	"",
].join("\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yano-herdr-start-race-"));
const binDir = path.join(tmp, "bin");
const startedFile = path.join(tmp, "started");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, "herdr"), FAKE_HERDR_SHIM);
fs.chmodSync(path.join(binDir, "herdr"), 0o700);

const result = spawnSync(process.execPath, [
	path.join(repoRoot, "scripts", "launch-planner.mjs"),
	"--herdr",
	"--instance", "planner-race-01",
	"--role", "coder",
	"--project", "code-mem",
], {
	cwd: repoRoot,
	encoding: "utf8",
	env: {
		...process.env,
		PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
		E2E_CWD: repoRoot,
		E2E_STARTED: startedFile,
		YANO_DATA_DIR: path.join(tmp, "data"),
	},
});

try {
	assert.equal(result.status, 0, `launcher should recover from a transient mismatch\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
	assert.match(result.stdout, /planner-race-01 avviato nel workspace verificato/);
	assert.doesNotMatch(result.stderr, /Herdr non ha avviato/);
	console.log("smoke-test-herdr-agent-start-race: ok (mismatch followed by verified pi readiness)");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
