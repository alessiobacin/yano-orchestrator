#!/usr/bin/env node

// Deterministic, per-OS Docker daemon start (ticket #120,
// .scratch/optimize-orchestrator/issues/120-docker-bundle-mqtt-yano-evaluation.md).
//
// Unlike Herdr (ticket #118, where Yano deliberately does NOT guess a start
// command because it varies per installation), Docker Desktop/Engine has a
// small, well-documented, standard start command per major OS — the same
// ones already surfaced as install hints in doctor.mjs. It is safe and
// correct for Yano to know these outright, rather than requiring the
// operator to register them by hand for the one-shot `yano doctor`/`yano
// init` auto-start path. For the *continuous* cron-driven case, the exact
// same command is what this module suggests registering via
// `yano services add --name docker` (ticket #117) — this module is the
// single source of truth for the command so the two paths never drift.

import { spawnSync } from "node:child_process";

const START_COMMANDS = {
	darwin: "open -a Docker",
	// `Start-Service` targets the Docker Desktop service directly; falls back
	// to launching the app if the service is not registered under that name
	// (a plain Docker Engine-on-Windows install without Desktop).
	win32: "powershell -NoProfile -Command \"Start-Service com.docker.service -ErrorAction SilentlyContinue; if (-not $?) { Start-Process 'Docker Desktop' }\"",
	linux: "systemctl start docker || service docker start",
};

export function dockerDaemonRestartCommand(platform = process.platform) {
	return START_COMMANDS[platform] || START_COMMANDS.linux;
}

export function isDockerDaemonRunning({ run = spawnSync, timeoutMs = 5000 } = {}) {
	const result = run("docker", ["info"], { stdio: "ignore", shell: process.platform === "win32", timeout: timeoutMs });
	return result.status === 0;
}

// Every `run` call in this module uses the same (command, args, options)
// shape — including the restart command below, wrapped as a single-element
// shell invocation — so a test double only needs to implement one call
// signature.
function runShellCommand(run, command, options) {
	return run(command, [], { shell: true, ...options });
}

function sleepSync(ms) {
	if (!(ms > 0)) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Attempts the platform's deterministic start command once, then polls
// `isDockerDaemonRunning` with a fixed interval up to `waitMs` — Docker
// Desktop in particular can take several seconds to finish booting after the
// app/service is launched, so a single immediate re-check would report a
// false negative.
export function ensureDockerDaemonRunning({ run = spawnSync, platform = process.platform, waitMs = 20_000, pollIntervalMs = 1000 } = {}) {
	if (isDockerDaemonRunning({ run })) return { running: true, attempted_restart: false };
	const command = dockerDaemonRestartCommand(platform);
	const started = runShellCommand(run, command, { stdio: "ignore", timeout: 10_000 });
	const deadline = Date.now() + Math.max(0, waitMs);
	while (Date.now() < deadline) {
		if (isDockerDaemonRunning({ run })) return { running: true, attempted_restart: true, restart_command: command };
		sleepSync(pollIntervalMs);
	}
	return { running: false, attempted_restart: true, restart_command: command, restart_launch_ok: started.status === 0 };
}
