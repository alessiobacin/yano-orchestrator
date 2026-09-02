#!/usr/bin/env node

// Shared, retrying `herdr api snapshot` client (ticket #118,
// .scratch/optimize-orchestrator/issues/118-herdr-self-heal-unreachable.md).
//
// Before this module, `herdrSnapshot()` was independently reimplemented in
// roughly a dozen scripts, each a single un-retried `spawnSync("herdr",
// ["api", "snapshot"])` — one flaky call (Herdr's local server still waking
// up after a machine restart, momentarily busy, ...) and every caller gave
// up immediately with "Herdr non raggiungibile". This centralizes the call
// with bounded retry/backoff so a transient blip within a single supervisor
// pass does not need to wait for the next one-minute cron tick to resolve
// itself.
//
// This module is intentionally conservative about what counts as
// "self-heal": it does not guess at how to start Herdr's server (a GUI app,
// a background/launchd service, a CLI daemon — this varies per machine and a
// wrong guess could be worse than doing nothing). Bringing Herdr back up
// when retries are exhausted is the operator's own declared restart command,
// registered like any other dependency via `yano services add --name herdr
// --healthcheck-command "..." --restart-command "..."` (see
// scripts/yano-services.mjs, ticket #117) — `yano-watcher-registry.mjs`'s
// `supervise()` runs that registry before taking its own snapshot, so a
// registered `herdr` restart command gets a chance to run first.

import { spawnSync } from "node:child_process";

const DEFAULT_MAX_BUFFER = 8_000_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 400;

// Node has no built-in synchronous sleep; `Atomics.wait` on a throwaway
// SharedArrayBuffer is the standard portable (Windows/macOS/Linux) way to
// block the current thread for a bounded time without spawning a process.
// Acceptable here: every caller of herdrSnapshot() in this codebase is
// already a fully synchronous spawnSync-based CLI/supervisor path.
function sleepSync(ms) {
	if (!(ms > 0)) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseSnapshot(stdout) {
	try {
		const parsed = JSON.parse(stdout || "");
		return parsed?.result?.snapshot || parsed?.result || parsed || null;
	} catch {
		return null;
	}
}

// Returns the parsed snapshot, or `null` if Herdr could not be reached after
// `attempts` tries. Synchronous by design — every existing call site is
// synchronous and migrating all of them to async is a larger, separate
// change; retry/backoff does not require it (see sleepSync above).
export function herdrSnapshot({ maxBuffer = DEFAULT_MAX_BUFFER, attempts = DEFAULT_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS, run = spawnSync } = {}) {
	for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
		const result = run("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer });
		if (result.status === 0) {
			const snapshot = parseSnapshot(result.stdout);
			if (snapshot) return snapshot;
		}
		if (attempt < attempts) sleepSync(baseDelayMs * attempt);
	}
	return null;
}
