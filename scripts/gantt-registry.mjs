// Persistent metadata for Gantt dashboards. The registry never owns the
// server process: it only makes links discoverable and reports liveness.

import fs from "node:fs";
import path from "node:path";
import { traceRoot } from "./yano-trace-storage.mjs";

const REGISTRY_VERSION = 1;

export function ganttRegistryPath() {
	return path.join(traceRoot(), "gantt", "instances.json");
}

function readRegistry() {
	try {
		const value = JSON.parse(fs.readFileSync(ganttRegistryPath(), "utf8"));
		return {
			version: REGISTRY_VERSION,
			instances: Array.isArray(value.instances) ? value.instances : [],
		};
	} catch {
		return { version: REGISTRY_VERSION, instances: [] };
	}
}

function writeRegistry(registry) {
	const file = ganttRegistryPath();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(temporary, 0o600);
	fs.renameSync(temporary, file);
}

export function registerGantt({ projectKey, project, root, port, url, pid = process.pid }) {
	const now = new Date().toISOString();
	const registry = readRegistry();
	const instance = {
		project_key: projectKey,
		project,
		root,
		port,
		url,
		pid,
		status: "running",
		active: true,
		started_at: now,
		last_seen_at: now,
		stopped_at: null,
	};
	const instances = registry.instances.filter((item) => item.project_key !== projectKey);
	instances.push(instance);
	writeRegistry({ version: REGISTRY_VERSION, instances });
	return instance;
}

export function markGanttStopped(projectKey, pid = process.pid) {
	const registry = readRegistry();
	let changed = false;
	const instances = registry.instances.map((item) => {
		if (item.project_key !== projectKey || (pid && item.pid !== pid)) return item;
		changed = true;
		return { ...item, status: "stopped", active: false, stopped_at: new Date().toISOString() };
	});
	if (changed) writeRegistry({ version: REGISTRY_VERSION, instances });
}

export function listRegisteredGantts() {
	return readRegistry().instances
		.filter((item) => item && item.project_key && item.root && item.url)
		.sort((left, right) => String(left.project || "").localeCompare(String(right.project || "")));
}

async function probe(entry, timeoutMs = 800) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${entry.url}/healthz`, { signal: controller.signal });
		if (!response.ok) return false;
		const body = await response.json();
		return body?.ok === true && (!body.project || body.project === entry.project);
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

export async function listGanttsWithStatus() {
	const registered = listRegisteredGantts();
	const statuses = await Promise.all(registered.map(async (entry) => {
		const active = await probe(entry);
		return { ...entry, active, status: active ? "running" : "stopped" };
	}));
	// Refresh only liveness metadata. A failed probe is not destructive and the
	// URL remains available for a future restart or operator inspection.
	const registry = readRegistry();
	let changed = false;
	const byKey = new Map(statuses.map((entry) => [entry.project_key, entry]));
	const instances = registry.instances.map((entry) => {
		const current = byKey.get(entry.project_key);
		if (!current || (entry.status === current.status && entry.active === current.active)) return entry;
		changed = true;
		return { ...entry, status: current.status, active: current.active, last_seen_at: current.active ? new Date().toISOString() : entry.last_seen_at, stopped_at: current.active ? null : (entry.stopped_at || new Date().toISOString()) };
	});
	if (changed) writeRegistry({ version: REGISTRY_VERSION, instances });
	return statuses;
}
