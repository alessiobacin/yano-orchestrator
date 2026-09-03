#!/usr/bin/env node

import dns from "node:dns/promises";
import mqtt from "mqtt";
import { herdrSnapshot } from "./yano-herdr-client.mjs";

const GOOGLE_DNS = ["8.8.8.8", "8.8.4.4"];

function withTimeout(promise, timeoutMs, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: timeout ${timeoutMs}ms`)), timeoutMs)),
	]);
}

export async function checkGoogleDns({ timeoutMs = 3000 } = {}) {
	const resolver = new dns.Resolver();
	resolver.setServers(GOOGLE_DNS);
	const started = Date.now();
	try {
		const addresses = await withTimeout(resolver.resolve4("google.com"), timeoutMs, "DNS Google");
		return { ok: true, target: "google.com", servers: GOOGLE_DNS, addresses, latency_ms: Date.now() - started };
	} catch (error) {
		return { ok: false, target: "google.com", servers: GOOGLE_DNS, error: error instanceof Error ? error.message : String(error), latency_ms: Date.now() - started };
	}
}

export async function checkMqtt({ url = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883", timeoutMs = 3000 } = {}) {
	const started = Date.now();
	let client;
	try {
		client = mqtt.connect(url, { clean: true, reconnectPeriod: 0, connectTimeout: timeoutMs });
		await withTimeout(new Promise((resolve, reject) => {
			client.once("connect", resolve);
			client.once("error", reject);
		}), timeoutMs + 250, "MQTT");
		return { ok: true, url, latency_ms: Date.now() - started };
	} catch (error) {
		return { ok: false, url, error: error instanceof Error ? error.message : String(error), latency_ms: Date.now() - started };
	} finally {
		try { client?.end(true); } catch { /* probe cleanup */ }
	}
}

export function checkHerdr() {
	const started = Date.now();
	const snapshot = herdrSnapshot();
	return snapshot
		? { ok: true, latency_ms: Date.now() - started, workspaces: (snapshot.workspaces || []).length, panes: (snapshot.panes || []).length }
		: { ok: false, latency_ms: Date.now() - started, error: "Herdr snapshot non raggiungibile" };
}

export async function checkConnectivity({ env = process.env, timeoutMs = 3000, googleDns = checkGoogleDns, mqttProbe = checkMqtt, herdrProbe = checkHerdr } = {}) {
	const [dnsCheck, mqttCheck] = await Promise.all([
		googleDns({ timeoutMs }),
		mqttProbe({ url: env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883", timeoutMs }),
	]);
	const herdrCheck = herdrProbe();
	return {
		checked_at: new Date().toISOString(),
		checks: {
			google_dns: dnsCheck,
			mqtt: mqttCheck,
			herdr: herdrCheck,
			cron: { ok: true, evidence: "questa passata di supervisione è stata eseguita" },
		},
		online: Boolean(dnsCheck.ok && mqttCheck.ok && herdrCheck.ok),
	};
}
