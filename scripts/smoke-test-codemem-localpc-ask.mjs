// T2: ask capture/recall — askLocalPc must recall CodeMem context before send
// (cwd=runtimeRoot, never project checkout) and save the redacted exchange
// after the response, best-effort: a save failure must never fail ask.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { askLocalPc, recallLocalPcContext, redactLocalPcText, saveLocalPcExchange } from "./yano-local-pc.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codemem-ask-"));
const dataDir = path.join(tmp, "yano data dir");
fs.mkdirSync(dataDir, { recursive: true });
const checkoutMemoryExisted = fs.existsSync(path.join(path.resolve(import.meta.dirname, ".."), "memory", "state.db"));
const oldDataDir = process.env.YANO_DATA_DIR;
process.env.YANO_DATA_DIR = dataDir;
const runtimeRoot = path.join(dataDir, "yano-local-pc");
fs.mkdirSync(runtimeRoot, { recursive: true });
// Real CodeMem store in the temp runtime root (never the project checkout).
const init = spawnSync("cm", ["init", "pi"], { cwd: runtimeRoot, encoding: "utf8" });
assert.equal(init.status, 0, "cm init pi must succeed in the temp runtime root");
assert.ok(fs.existsSync(path.join(runtimeRoot, "memory", "state.db")), "temp store must exist");

// Fake MQTT: captures the published prompt, answers on the reply topic.
const ensureOk = () => ({ running: true });

console.log("=== TEST 1 — secrets/token/PII redacted before save ===");
const dirty = "api_key=sk-live-123 Bearer abcdefghijklmnop contatto mario.rossi@example.com ok";
const clean = redactLocalPcText(dirty);
assert.doesNotMatch(clean, /sk-live-123/);
assert.doesNotMatch(clean, /abcdefghijklmnop/);
assert.doesNotMatch(clean, /mario\.rossi@example\.com/);
assert.match(clean, /\[REDACTED\]/);
console.log(`   OK — redacted: ${clean}`);

console.log("\n=== TEST 2 — simulated ask: save redacted, sq finds it, 2nd ask enriched ===");
const secretPrompt = "promemoria testuale unico zetaquattro: pausa caffe, api_key=TOPSECRET-XYZ";
{
	const captured2 = {};
	const connect2 = async () => ({
		handlers: {},
		async subscribeAsync(topic) { this.replyTopic = topic; },
		async publishAsync(_topic, payload) {
			captured2.prompt = JSON.parse(String(payload)).prompt;
			const t = this.replyTopic;
			setImmediate(() => this.handlers.message(t, Buffer.from(JSON.stringify({ response: "ok, promemoria registrato" }))));
		},
		on(event, handler) { this.handlers[event] = handler; },
		async endAsync() {},
	});
	const result = await askLocalPc(secretPrompt, { ensure: ensureOk, mqttConnect: connect2, timeoutMs: 10_000 });
	assert.equal(result.response, "ok, promemoria registrato");
	assert.ok(!captured2.prompt.includes("[CodeMem locale"), "first ask on empty store sends the raw prompt");
}
const found = spawnSync("cm", ["sq", "zetaquattro", "5"], { cwd: runtimeRoot, encoding: "utf8" });
assert.equal(found.status, 0);
assert.match(String(found.stdout || ""), /zetaquattro/, "sq must retrieve the saved exchange text");
assert.doesNotMatch(String(found.stdout || ""), /TOPSECRET-XYZ/, "the persisted exchange must be redacted");
console.log("   OK — exchange saved redacted and retrievable via sq");
{
	const captured2 = {};
	const connect2 = async () => ({
		handlers: {},
		async subscribeAsync(topic) { this.replyTopic = topic; },
		async publishAsync(_topic, payload) {
			captured2.prompt = JSON.parse(String(payload)).prompt;
			const t = this.replyTopic;
			setImmediate(() => this.handlers.message(t, Buffer.from(JSON.stringify({ response: "seconda risposta" }))));
		},
		on(event, handler) { this.handlers[event] = handler; },
		async endAsync() {},
	});
	const result2 = await askLocalPc("promemoria zetaquattro: che ore sono?", { ensure: ensureOk, mqttConnect: connect2, timeoutMs: 10_000 });
	assert.equal(result2.response, "seconda risposta");
	assert.match(captured2.prompt, /\[CodeMem locale/, "second ask must inject recalled context into the planner prompt");
	assert.match(captured2.prompt, /zetaquattro/, "recalled context must mention the earlier exchange");
	console.log("   OK — second ask enriched with CodeMem context");
}

console.log("\n=== TEST 3 — save failure (cm exit 1) never fails ask ===");
const fakeBin = path.join(tmp, "fakebin");
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(fakeBin, "cm"), "#!/usr/bin/env node\nprocess.stderr.write('simulated cm outage\\n');\nprocess.exit(1);\n", { mode: 0o700 });
const oldPath = process.env.PATH;
process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ""}`;
try {
	assert.equal(recallLocalPcContext("anything", { root: runtimeRoot }), "", "failing recall must degrade to empty context");
	assert.equal(saveLocalPcExchange("q", "a", { root: runtimeRoot }), false, "failing save must return false, not throw");
	const captured3 = {};
	const connect3 = async () => ({
		handlers: {},
		async subscribeAsync(topic) { this.replyTopic = topic; },
		async publishAsync(_topic, payload) {
			captured3.prompt = JSON.parse(String(payload)).prompt;
			const t = this.replyTopic;
			setImmediate(() => this.handlers.message(t, Buffer.from(JSON.stringify({ response: "risposta nonostante cm rotto" }))));
		},
		on(event, handler) { this.handlers[event] = handler; },
		async endAsync() {},
	});
	const result3 = await askLocalPc("domanda con cm rotto", { ensure: ensureOk, mqttConnect: connect3, timeoutMs: 10_000 });
	assert.equal(result3.response, "risposta nonostante cm rotto", "ask must resolve even when cm fails");
	assert.ok(!captured3.prompt.includes("[CodeMem locale"), "no context injected when recall fails");
	console.log("   OK — cm outage logged as failure, ask resolved anyway");
} finally {
	process.env.PATH = oldPath;
}

console.log("\n=== TEST 4 — pending/ untouched, project checkout untouched ===");
assert.deepEqual(fs.existsSync(path.join(runtimeRoot, "pending")) ? fs.readdirSync(path.join(runtimeRoot, "pending")) : [], [], "pending/ must be empty after answered asks");
assert.equal(fs.existsSync(path.join(path.resolve(import.meta.dirname, ".."), "memory", "state.db")), checkoutMemoryExisted, "project checkout memory presence must stay unchanged");
console.log("   OK — pending/ drained, checkout clean");

process.env.YANO_DATA_DIR = oldDataDir;
console.log("\nsmoke-test-codemem-localpc-ask: ok");
