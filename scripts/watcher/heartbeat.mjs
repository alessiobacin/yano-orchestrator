// Fase 1 / M5 — anti-double-publish gate between the two stalled-ticket
// watchers. `extensions/orchestrator.ts`'s in-process watchdog
// (watchdogSweep(), timer-driven, only alive while a planner session is up)
// writes a per-project heartbeat file every time it completes a pass —
// regardless of whether it found anything stalled. `scripts/watch-stalls.mjs`
// (standalone, always alive, zero-token) checks that heartbeat before
// publishing `ticket_stalled` to MQTT: if it's fresh, the in-process
// watchdog is presumed to have already published for the same condition, so
// the standalone watcher stays silent on MQTT (it still logs the finding
// locally — see findStalledTicketsFromDb's caller). If the heartbeat is
// stale or missing, the standalone watcher is the only one covering this
// project right now, so it publishes.
//
// Fail-open by design (shouldPublishStallEvent): an unknown heartbeat age —
// file missing, corrupt, never written, or the project simply never had an
// in-process watchdog run — always results in "publish". A real stall
// notification must never be silently dropped because of an ambiguous
// heartbeat; a rare duplicate publish is a strictly smaller problem than a
// missed one.
import fs from "node:fs";
import path from "node:path";
import { traceRoot } from "../yano-trace-storage.mjs";

const DEFAULT_MAX_AGE_MS = Number(process.env.YANO_WATCHDOG_HEARTBEAT_MAX_AGE_MS) || 5 * 60_000; // ~2.5x the in-process watchdog's own default sweep interval (WATCHDOG_INTERVAL_MS, 120s) — tolerates one missed tick plus margin.

export function watchdogHeartbeatPath(projectKey) {
	return path.join(traceRoot(), "watcher", `${projectKey}-watchdog-heartbeat.json`);
}

export function writeWatchdogHeartbeat(projectKey, nowMs = Date.now()) {
	const file = watchdogHeartbeatPath(projectKey);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, JSON.stringify({ checked_at: new Date(nowMs).toISOString() }), { mode: 0o600 });
	} catch {
		// Best-effort bookkeeping — never let a heartbeat write failure block
		// the real in-process watchdog sweep that called this.
	}
}

/** @returns {number | null} age in ms, or null if unknown (missing/corrupt file). */
export function readWatchdogHeartbeatAgeMs(projectKey, nowMs = Date.now()) {
	try {
		const raw = JSON.parse(fs.readFileSync(watchdogHeartbeatPath(projectKey), "utf8"));
		const checkedAt = Date.parse(raw.checked_at || "");
		if (!Number.isFinite(checkedAt)) return null;
		return nowMs - checkedAt;
	} catch {
		return null;
	}
}

/** @param {{ heartbeatAgeMs: number | null | undefined, maxAgeMs?: number }} args */
export function shouldPublishStallEvent({ heartbeatAgeMs, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
	if (heartbeatAgeMs === null || heartbeatAgeMs === undefined || !Number.isFinite(heartbeatAgeMs)) return true;
	return heartbeatAgeMs > maxAgeMs;
}
