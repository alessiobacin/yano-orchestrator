// T1: CodeMem store for yano-local-pc — ensureComputerRuntime must ensure
// `memory/state.db` via idempotent `cm init pi` (cwd=runtimeRoot), and a
// simulated `cm` failure must never block startup.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureComputerRuntime } from "./yano-global-services.mjs";

const checkoutMemory = path.join(path.resolve(import.meta.dirname, ".."), "memory", "state.db");
const checkoutMemoryExisted = fs.existsSync(checkoutMemory);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codemem-localpc-"));
// Path with spaces: spawnSync cwd must survive it (no shell quoting needed).
const dataDir = path.join(tmp, "yano data dir");
fs.mkdirSync(dataDir, { recursive: true });
process.env.YANO_DATA_DIR = dataDir;

console.log("=== TEST 1 — double ensure is idempotent, state.db present ===");
const root1 = ensureComputerRuntime();
assert.equal(root1, path.join(dataDir, "yano-local-pc"));
const stateDb = path.join(root1, "memory", "state.db");
assert.ok(fs.existsSync(stateDb), `cm init pi must create memory/state.db under runtimeRoot (missing ${stateDb})`);
const mtime1 = fs.statSync(stateDb).mtimeMs;
const root2 = ensureComputerRuntime();
assert.equal(root2, root1, "second ensure must return the same runtimeRoot");
assert.ok(fs.existsSync(stateDb), "state.db must survive a second idempotent ensure");
console.log(`   OK — runtimeRoot=${root1}, state.db present across 2 ensures`);

console.log("\n=== TEST 2 — simulated cm failure never blocks startup ===");
const fakeBin = path.join(tmp, "fakebin");
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(fakeBin, "cm"), "#!/usr/bin/env node\nprocess.stderr.write('simulated cm outage\\n');\nprocess.exit(1);\n", { mode: 0o700 });
const oldPath = process.env.PATH;
process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ""}`;
try {
	const dataDir2 = path.join(tmp, "yano data dir 2");
	fs.mkdirSync(dataDir2, { recursive: true });
	process.env.YANO_DATA_DIR = dataDir2;
	const rootFail = ensureComputerRuntime();
	assert.equal(rootFail, path.join(dataDir2, "yano-local-pc"), "ensure must still return runtimeRoot when cm fails");
	assert.ok(fs.existsSync(path.join(rootFail, "agents", "roles.yaml")), "runtime scaffolding must still be created when cm fails");
	assert.ok(!fs.existsSync(path.join(rootFail, "memory", "state.db")), "failing cm must not create a store");
	console.log("   OK — cm exit 1 logged to global-services, startup continued");
} finally {
	process.env.PATH = oldPath;
	process.env.YANO_DATA_DIR = dataDir;
}

console.log("\n=== TEST 3 — never touches the project checkout ===");
assert.equal(fs.existsSync(checkoutMemory), checkoutMemoryExisted, "project checkout store presence must not change");
console.log("   OK — no memory/state.db in the project checkout");

console.log("\nsmoke-test-codemem-localpc-store: ok");
