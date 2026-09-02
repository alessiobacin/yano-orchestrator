#!/usr/bin/env node
// User-facing bridge to the persistent Computer locale agent. Requests use a
// dedicated Yano scope, never a project scope.
import crypto from "node:crypto";
import mqtt from "mqtt";
import { ensureComputerLocalService } from "./yano-global-services.mjs";

const PROJECT = "yano-scheduler";
const INSTANCE = "computer-locale";
const SCOPE = "yano-system";
const brokerUrl = () => process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
function value(argv, flag) { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] || null; }
function usage() { console.log("Uso: yano computer <start|status|ask> [--prompt \"...\"] [--timeout-ms N]"); }

export async function askComputerLocal(prompt, { timeoutMs = 120000, broker = brokerUrl(), ensure = ensureComputerLocalService } = {}) {
	if (!prompt?.trim()) throw new Error("--prompt è obbligatorio.");
	const service = ensure();
	if (!service.running) throw new Error(`Computer locale non attivo (${service.error || "avvio fallito"}).`);
	const requestId = `computer-${crypto.randomUUID()}`;
	const replyTopic = `pi/${SCOPE}/cli/${requestId}/response`;
	const commandTopic = `pi/${SCOPE}/agents/${INSTANCE}/commands`;
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
			client.publish(commandTopic, JSON.stringify({ type: "command", assignment_id: requestId, sender_instance: "yano-cli", sender_role: "user", target_instance: INSTANCE, project: PROJECT, prompt: prompt.trim(), reply_to: replyTopic, hops: 0, timestamp: new Date().toISOString(), response_schema: null }), { qos: 1 });
		});
		return result;
	} finally { await client.endAsync(); }
}

export async function runYanoComputerLocal({ argv = [] } = {}) {
	const [sub] = argv;
	if (!sub || sub === "--help" || sub === "-h") { usage(); return; }
	if (sub === "start" || sub === "status") { const result = ensureComputerLocalService(); console.log(JSON.stringify(result, null, 2)); return result; }
	if (sub === "ask") { const result = await askComputerLocal(value(argv, "--prompt"), { timeoutMs: Number(value(argv, "--timeout-ms") || 120000) }); console.log(JSON.stringify(result, null, 2)); return result; }
	usage(); throw new Error(`sottocomando sconosciuto: ${sub}`);
}

if (process.argv[1]?.endsWith("yano-computer-local.mjs")) runYanoComputerLocal({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano computer: ${error.message}`); process.exitCode = 1; });
