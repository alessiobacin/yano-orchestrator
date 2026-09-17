#!/usr/bin/env node
// User-facing bridge to the persistent Local PC agent. Requests use a
// dedicated Yano scope, never a project scope.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
function usage() { console.log("Uso: yano local-pc <start|status|ask|pending> [--planner] [--no-wait] [--prompt \"...\"] [--timeout-ms N]"); }

function localPcRuntimeRoot() { return path.join(globalDataPath(), "yano-local-pc"); }

// Redact secrets/tokens/PII before anything is persisted to CodeMem.
// Minimal by design: key=value secrets, Bearer tokens, emails.
export function redactLocalPcText(value) {
	return String(value || "")
		.replace(/(api[_-]?key|token|secret|password|passwd|pwd|authorization|private[_-]?key|credential)\s*[:=]\s*['"]?\S+['"]?/gi, "$1=[REDACTED]")
		.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/g, "Bearer [REDACTED]")
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED-EMAIL]");
}

// Best-effort bounded recall of past Local PC conversations.
// Runs `cm sq` with cwd=runtimeRoot (never the project checkout);
// any failure returns "" and never blocks ask.
// Derive a keyword query from a natural-language prompt: `cm sq` uses
// AND keyword semantics, so a raw sentence rarely matches anything.
export function localPcRecallQuery(prompt) {
	const words = String(prompt || "").toLowerCase().split(/[^a-zà-ÿ0-9]+/i).filter((w) => w.length >= 5);
	const unique = [...new Set(words)].slice(0, 6);
	return (unique.join(" ") || String(prompt || "").trim().slice(0, 200)).slice(0, 200);
}

export function recallLocalPcContext(prompt, { root = localPcRuntimeRoot(), limit = 5, maxChars = 2000 } = {}) {
	try {
		const query = localPcRecallQuery(prompt);
		if (!query) return "";
		const result = spawnSync("cm", ["sq", query, String(limit)], { cwd: root, encoding: "utf8", timeout: 8000 });
		if (result?.error || result?.status !== 0) return "";
		const text = String(result.stdout || "").trim();
		if (!text || /^no results\.?$/i.test(text)) return "";
		return text.slice(0, maxChars);
	} catch { return ""; }
}

// Best-effort capture of a prompt/response exchange via `cm save --auto`.
// The redacted text is persisted; failures return false, never throw.
export function saveLocalPcExchange(prompt, response, { root = localPcRuntimeRoot() } = {}) {
	try {
		const answer = typeof response === "string" ? response : JSON.stringify(response ?? "");
		const text = redactLocalPcText(`Q: ${String(prompt || "").trim().slice(0, 1000)}\nA: ${String(answer || "").slice(0, 1000)}`);
		if (!text.trim()) return false;
		const result = spawnSync("cm", ["save", "--auto", "--role", "agent", text], { cwd: root, encoding: "utf8", timeout: 10_000 });
		if (result?.error || result?.status !== 0) return false;
		return true;
	} catch { return false; }
}

export async function askLocalPc(prompt, { timeoutMs = 120000, broker = brokerUrl(), ensure = ensureComputerLocalService, planner = false, waitForResponse = true, mqttConnect = mqtt.connectAsync } = {}) {
	if (!prompt?.trim()) throw new Error("--prompt è obbligatorio.");
	const service = ensure();
	const runtimeRoot = localPcRuntimeRoot();
	const memContext = recallLocalPcContext(prompt, { root: runtimeRoot });
	const enrichedPrompt = memContext ? `${prompt.trim()}\n\n[CodeMem locale — contesto pertinente]\n${memContext}` : prompt.trim();
	// The planner is the durable scheduler target. The Local PC shell/agent
	// tab may be recovering independently; do not drop a scheduled request
	// when planner-01 is already healthy and able to receive MQTT.
	if (!service.running && !service.planner?.running) throw new Error(`Local PC non attivo (${service.error || "avvio fallito"}).`);
	// The persistent planner is the sole LLM process for the Local PC control
	// plane. `yano-local-pc` remains the logical service name, never a second
	// short-lived Pi session that can churn under the minute supervisor.
	const targetInstance = "planner-01";
	const requestId = `${planner ? "planner" : "computer"}-${crypto.randomUUID()}`;
	const replyTopic = `pi/${SCOPE}/cli/${requestId}/response`;
	const commandTopic = `pi/${SCOPE}/agents/${targetInstance}/commands`;
	const request = { type: "command", assignment_id: requestId, sender_instance: "yano-cli", sender_role: "user", target_instance: targetInstance, target_role: planner ? "planner" : INSTANCE, project: PROJECT, prompt: enrichedPrompt, reply_to: replyTopic, hops: 0, timestamp: new Date().toISOString(), response_schema: null };
	savePending(request);
	const client = await mqttConnect(broker, { reconnectPeriod: 0, connectTimeout: 3000 });
	try {
		await client.subscribeAsync(replyTopic, { qos: 1 });
		const result = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`nessuna risposta entro ${timeoutMs} ms`)), timeoutMs);
			client.on("message", (topic, payload) => {
				if (topic !== replyTopic) return;
				clearTimeout(timer);
				try { resolve(JSON.parse(payload.toString())); } catch { resolve({ response: payload.toString() }); }
			});
			const publish = typeof client.publishAsync === "function"
				? client.publishAsync(commandTopic, JSON.stringify(request), { qos: 1 })
				: new Promise((publishResolve, publishReject) => client.publish(commandTopic, JSON.stringify(request), { qos: 1 }, (error) => error ? publishReject(error) : publishResolve()));
			publish.then(() => {
				if (!waitForResponse) { clearTimeout(timer); resolve({ accepted: true, request_id: requestId, target_instance: targetInstance, durable_pending: true }); }
			}).catch(reject);
		});
		removePending(requestId);
		saveLocalPcExchange(prompt, result, { root: runtimeRoot });
		return result;
	} finally { await client.endAsync(); }
}

export async function runYanoLocalPc({ argv = [] } = {}) {
	const [sub] = argv;
	if (!sub || sub === "--help" || sub === "-h") { usage(); return; }
	if (sub === "start" || sub === "status") { const result = ensureComputerLocalService(); console.log(JSON.stringify(result, null, 2)); return result; }
	if (sub === "pending") { const result = pendingRequests(); console.log(JSON.stringify(result, null, 2)); return result; }
	if (sub === "ask") { const result = await askLocalPc(value(argv, "--prompt"), { timeoutMs: Number(value(argv, "--timeout-ms") || 120000), planner: argv.includes("--planner"), waitForResponse: !argv.includes("--no-wait") }); console.log(JSON.stringify(result, null, 2)); return result; }
	usage(); throw new Error(`sottocomando sconosciuto: ${sub}`);
}

if (process.argv[1]?.endsWith("yano-local-pc.mjs")) runYanoLocalPc({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano local-pc: ${error.message}`); process.exitCode = 1; });
