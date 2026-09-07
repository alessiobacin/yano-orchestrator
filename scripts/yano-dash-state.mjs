#!/usr/bin/env node

// Tiny, dependency-light state-file helpers for yano dash — deliberately
// kept out of yano-dash.mjs (which pulls in the full feedback/HTTP stack) so
// yano-services.mjs can read the current port/pid on every supervise pass
// without importing anything heavier than this file.
import fs from "node:fs";
import path from "node:path";
import { globalDataPath } from "./yano-config.mjs";

export const DASH_PORT = Object.freeze({ default: 11000, min: 11000, max: 11999 });

export function dashStatePath() {
	return path.join(globalDataPath({ env: process.env }), "dashboards", "dash.json");
}

export function readDashState() {
	try {
		return JSON.parse(fs.readFileSync(dashStatePath(), "utf8"));
	} catch {
		return null;
	}
}

export function writeDashState(state) {
	const file = dashStatePath();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function processAlive(pid) {
	if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch {
		return false;
	}
}
