// T3: restart rehydration — every ensureComputerRuntime start/recovery tick
// must leave the CodeMem store readable via rehydrateLocalPcMemory
// (cwd=runtimeRoot, never the project checkout), best-effort.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureComputerRuntime, rehydrateLocalPcMemory } from "./yano-global-services.mjs";
import { saveLocalPcExchange } from "./yano-local-pc.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codemem-rehydrate-"));
const dataDir = path.join(tmp, "yano data dir");
fs.mkdirSync(dataDir, { recursive: true });
const oldDataDir = process.env.YANO_DATA_DIR;
process.env.YANO_DATA_DIR = dataDir;

console.log("=== TEST 1 — ask -> simulated restart -> recall finds it ===");
// First boot: full ensure creates the store (real `cm init pi`, T1).
const root1 = ensureComputerRuntime();
assert.ok(fs.existsSync(path.join(root1, "memory", "state.db")), "first boot must create memory/state.db");
const saved = saveLocalPcExchange(
	"promemoria reidratazione omegacinque: spegnere il forno",
	{ response: "ok, forno spento" },
	{ root: root1 },
);
assert.equal(saved, true, "exchange must persist in the runtime store");
// Simulated kill + recovery: a fresh ensure tick (idempotent `cm init pi`)
// must not wipe the store, and rehydration must surface the exchange.
const root2 = ensureComputerRuntime();
assert.equal(root2, root1, "recovery tick must return the same runtimeRoot");
assert.ok(fs.existsSync(path.join(root1, "memory", "state.db")), "store must survive the recovery tick");
const rehydrated = rehydrateLocalPcMemory({ root: root1 });
assert.equal(rehydrated.ok, true, "rehydration must succeed on a live store");
assert.ok(rehydrated.count >= 1, "rehydration must report at least one memory row");
assert.match(rehydrated.context, /omegacinque/, "rehydrated context must contain the pre-restart exchange");
assert.ok(rehydrated.context.length <= 2000, "rehydrated context must stay bounded");
console.log(`   OK — store survived restart, recall found ${rehydrated.count} row(s)`);

console.log("\n=== TEST 2 — empty store rehydrates clean, never throws ===");
const emptyDir = path.join(tmp, "empty data");
fs.mkdirSync(emptyDir, { recursive: true });
process.env.YANO_DATA_DIR = emptyDir;
const emptyRoot = ensureComputerRuntime();
const empty = rehydrateLocalPcMemory({ root: emptyRoot });
assert.equal(empty.ok, true, "fresh-but-initialized store is a clean hit, not a failure");
// `cm init pi` seeds a project-snapshot row, so a fresh store legitimately
// reports it; the point is rehydration succeeds and stays bounded.
assert.ok(empty.context.length <= 2000, "rehydrated context must stay bounded");
console.log(`   OK — fresh store returns ok:true (${empty.count} seeded row(s), no throw)`);
process.env.YANO_DATA_DIR = dataDir;

console.log("\n=== TEST 3 — cm outage at restart never blocks recovery ===");
const fakeBin = path.join(tmp, "fakebin");
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(fakeBin, "cm"), "#!/usr/bin/env node\nprocess.stderr.write('simulated cm outage\\n');\nprocess.exit(1);\n", { mode: 0o700 });
const oldPath = process.env.PATH;
process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ""}`;
try {
	const failed = rehydrateLocalPcMemory({ root: root1 });
	assert.equal(failed.ok, false, "failing cm must degrade to ok:false");
	assert.equal(failed.context, "", "no context on failure");
	const rootAfterFailure = ensureComputerRuntime();
	assert.equal(rootAfterFailure, root1, "ensure must still return runtimeRoot when cm is down");
	console.log("   OK — cm exit 1 degrades to ok:false, recovery tick continued");
} finally {
	process.env.PATH = oldPath;
}

console.log("\n=== TEST 4 — project checkout untouched ===");
assert.ok(!fs.existsSync(path.join(path.resolve(import.meta.dirname, ".."), "memory", "state.db")), "project checkout must not gain memory/state.db");
console.log("   OK — no memory/state.db in the project checkout");

process.env.YANO_DATA_DIR = oldDataDir;
console.log("\nsmoke-test-codemem-localpc-rehydrate: ok");
