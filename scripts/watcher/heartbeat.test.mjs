// Fase 1 / M5 — the anti-double-publish gate. Two processes can both decide
// the same ticket is stalled: the in-process watchdog (extensions/
// orchestrator.ts's watchdogSweep(), only alive while a planner session is
// up) and the standalone scripts/watch-stalls.mjs (always alive, zero-token,
// no planner session required). Both used to publish `ticket_stalled`
// independently — this module lets the standalone watcher know whether the
// in-process one is already covering a project, so only one of them
// actually publishes to MQTT for the same event.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWatchdogHeartbeatAgeMs, shouldPublishStallEvent, watchdogHeartbeatPath, writeWatchdogHeartbeat } from "./heartbeat.mjs";

describe("shouldPublishStallEvent — pure gate, no I/O", () => {
	it("fail-open: publishes when the heartbeat age is unknown (null/undefined/NaN) — never silently drop a real stall", () => {
		expect(shouldPublishStallEvent({ heartbeatAgeMs: null })).toBe(true);
		expect(shouldPublishStallEvent({ heartbeatAgeMs: undefined })).toBe(true);
		expect(shouldPublishStallEvent({ heartbeatAgeMs: NaN })).toBe(true);
	});

	it("skips publishing when the in-process watchdog's heartbeat is fresh (within maxAgeMs)", () => {
		expect(shouldPublishStallEvent({ heartbeatAgeMs: 1000, maxAgeMs: 300_000 })).toBe(false);
	});

	it("publishes when the heartbeat is stale (older than maxAgeMs) — the in-process watchdog is presumed gone", () => {
		expect(shouldPublishStallEvent({ heartbeatAgeMs: 400_000, maxAgeMs: 300_000 })).toBe(true);
	});

	it("uses a sensible default maxAgeMs when none is given", () => {
		expect(shouldPublishStallEvent({ heartbeatAgeMs: 1000 })).toBe(false);
		expect(shouldPublishStallEvent({ heartbeatAgeMs: 10 * 60_000 })).toBe(true);
	});
});

describe("writeWatchdogHeartbeat / readWatchdogHeartbeatAgeMs — real filesystem round-trip", () => {
	let dataDir;
	beforeEach(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-heartbeat-test-"));
		process.env.YANO_DATA_DIR = dataDir;
	});
	afterEach(() => {
		delete process.env.YANO_DATA_DIR;
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	it("a project with no heartbeat ever written reports an unknown (null) age", () => {
		expect(readWatchdogHeartbeatAgeMs("workspace-never-seen", Date.now())).toBeNull();
	});

	it("round-trips: write now, read back a near-zero age", () => {
		const now = Date.now();
		writeWatchdogHeartbeat("workspace-demo", now);
		const age = readWatchdogHeartbeatAgeMs("workspace-demo", now + 500);
		expect(age).toBe(500);
	});

	it("writes under the expected per-project path so watch-stalls.mjs and orchestrator.ts agree on the same file for the same projectKey", () => {
		writeWatchdogHeartbeat("workspace-demo", Date.now());
		expect(fs.existsSync(watchdogHeartbeatPath("workspace-demo"))).toBe(true);
	});

	it("two different projects never collide", () => {
		writeWatchdogHeartbeat("workspace-a", Date.now());
		expect(readWatchdogHeartbeatAgeMs("workspace-b", Date.now())).toBeNull();
	});
});
