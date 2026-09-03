#!/usr/bin/env node
// User-facing bridge to the persistent Local PC agent. Requests use a
// dedicated Yano scope, never a project scope.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import mqtt from "mqtt";
import { ensureComputerLocalService } from "./yano-global-services.mjs";
import { globalDataPath } from "./yano-config.mjs";
import { projectKey } from "./yano-trace-storage.mjs";

const PROJECT = "yano-local-pc";
const INSTANCE = "yano-local-pc";
// The service currently runs with the canonical project scope derived from
// its runtime project.json. Keep the CLI on that same scope; the Local PC
// runtime is the only stable home for control-plane requests.
const SCOPE = projectKey(path.join(globalDataPath(), "yano-local-pc"), PROJECT);
const brokerUrl = () => process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
function value(argv, flag) { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] || null; }
function pendingRoot() { return path.join(globalDataPath(), "yano-local-pc", "pending"); }
function savePending(request) { fs.mkdirSync(pendingRoot(), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(pendingRoot(), `${request.assignment_id}.json`), JSON.stringify(request, null, 2), { mode: 0o600 }); }
function removePending(id) { try { fs.unlinkSync(path.join(pendingRoot(), `${id}.json`)); } catch { /* already removed */ } }
function pendingRequests() { try { return fs.readdirSync(pendingRoot()).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(pendingRoot(), name), "utf8"))); } catch { return []; } }
function usage() { console.log("Uso: yano local-pc <start|status|ask|pending> [--planner] [--prompt \"...\"] [--timeout-ms N]"); }

export async function askLocalPc(prompt, { timeoutMs = 120000, broker = brokerUrl(), ensure = ensureComputerLocalService, planner = false } = {}) {
	if (!prompt?.trim()) throw new Error("--prompt è obbligatorio.");
	const service = ensure();
	if (!service.running) throw new Error(`Local PC non attivo (${service.error || "avvio fallito"}).`);
	const targetInstance = planner ? "planner-01" : INSTANCE;
	const requestId = `${planner ? "planner" : "computer"}-${crypto.randomUUID()}`;
	const replyTopic = `pi/${SCOPE}/cli/${requestId}/response`;
	const commandTopic = `pi/${SCOPE}/agents/${targetInstance}/commands`;
	const request = { type: "command", assignment_id: requestId, sender_instance: "yano-cli", sender_role: "user", target_instance: targetInstance, target_role: planner ? "planner" : INSTANCE, project: PROJECT, prompt: prompt.trim(), reply_to: replyTopic, hops: 0, timestamp: new Date().toISOString(), response_schema: null };
	savePending(request);
	const client = await mqtt.connectAsync(broker, { reconnectPeriod: 0, connectTimeout: 3000 });
	try {
		await client.subscribeAsync(replyTopic, { qos: 1 });
		const result = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`nessuna risposta entro ${timeoutMs} ms`)), timeoutMs);
			client.on("message", (topic, payload) => {
				if (topic !== replyTopic) return;
				clearTimeout(timer);
				try { resolve(JSON.parse(payload.toString())); } catch { resolve({ response: payload.toString() }); }
			});
			client.publish(commandTopic, JSON.stringify(request), { qos: 1 });
		});
		removePending(requestId);
		return result;
	} finally { await client.endAsync(); }
}

export async function runYanoLocalPc({ argv = [] } = {}) {
	const [sub] = argv;
	if (!sub || sub === "--help" || sub === "-h") { usage(); return; }
	if (sub === "start" || sub === "status") { const result = ensureComputerLocalService(); console.log(JSON.stringify(result, null, 2)); return result; }
	if (sub === "pending") { const result = pendingRequests(); console.log(JSON.stringify(result, null, 2)); return result; }
	if (sub === "ask") { const result = await askLocalPc(value(argv, "--prompt"), { timeoutMs: Number(value(argv, "--timeout-ms") || 120000), planner: argv.includes("--planner") }); console.log(JSON.stringify(result, null, 2)); return result; }
	usage(); throw new Error(`sottocomando sconosciuto: ${sub}`);
}

if (process.argv[1]?.endsWith("yano-local-pc.mjs")) runYanoLocalPc({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano local-pc: ${error.message}`); process.exitCode = 1; });
