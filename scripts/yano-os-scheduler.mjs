#!/usr/bin/env node

// Cross-platform one-minute scheduled-job installer (ticket #119,
// .scratch/optimize-orchestrator/issues/119-windows-task-scheduler-parity.md).
//
// docs/architecture.md always documented "Su Windows il supervisore deve
// usare Task Scheduler o un servizio equivalente, non il comando `cron`
// POSIX" — but every installer in this repo
// (install-yano-watcher-cron.mjs, install-yano-scheduler-cron.mjs,
// yano-watcher-registry.mjs, yano-scheduler.mjs) called only
// `spawnSync("crontab", ...)`, so on Windows the entire one-minute
// self-healing loop silently never installed. This module adds the Windows
// branch (`schtasks`) without touching the existing, already-tested POSIX
// crontab code paths in those two files — see the platform check they add
// around their existing cron functions.

import { spawnSync } from "node:child_process";

export function isWindows(platform = process.platform) {
	return platform === "win32";
}

// schtasks task names reject most punctuation; derive a stable alnum-only
// name from the same marker comment already used to tag the crontab line.
export function schtasksTaskName(marker) {
	return `Yano${String(marker || "").replace(/[^A-Za-z0-9]+/g, "")}`;
}

export function installScheduledTask({ taskName, command, spawn = spawnSync }) {
	// /F overwrites without prompting if the task already exists — the same
	// idempotent-on-repeated-install semantics as the crontab installer's
	// "strip any existing marker line, then add one".
	const result = spawn("schtasks", ["/Create", "/F", "/SC", "MINUTE", "/MO", "1", "/TN", taskName, "/TR", command], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`impossibile installare l'attività pianificata "${taskName}"${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { installed: true };
}

export function removeScheduledTask({ taskName, spawn = spawnSync }) {
	const result = spawn("schtasks", ["/Delete", "/F", "/TN", taskName], { encoding: "utf8" });
	if (result.status === 0) return { removed: true };
	if (/cannot find|does not exist/i.test(`${result.stdout || ""}\n${result.stderr || ""}`)) return { removed: false };
	throw new Error(`impossibile rimuovere l'attività pianificata "${taskName}"${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

export function queryScheduledTask({ taskName, spawn = spawnSync }) {
	const result = spawn("schtasks", ["/Query", "/TN", taskName, "/FO", "LIST"], { encoding: "utf8" });
	return result.status === 0 ? (result.stdout || "") : null;
}

// Convenience wrapper returning the same {installed, schedule, command,
// marker} shape the POSIX cronInstall()/cronStatus()/cronRemove() functions
// already return, so a caller can print either uniformly. `platform` is
// injectable so the Windows branch is exercisable (and was exercised, via
// scripts/smoke-test-yano-os-scheduler.mjs) from any host OS, not just a
// real Windows machine.
export function installOneMinuteWindowsJob({ marker, command, platform = process.platform, spawn = spawnSync }) {
	if (!isWindows(platform)) return null;
	const taskName = schtasksTaskName(marker);
	installScheduledTask({ taskName, command, spawn });
	return { installed: true, schedule: "every 1 minute (schtasks)", command, marker: taskName, backend: "schtasks" };
}
export function removeOneMinuteWindowsJob({ marker, platform = process.platform, spawn = spawnSync }) {
	if (!isWindows(platform)) return null;
	const taskName = schtasksTaskName(marker);
	const result = removeScheduledTask({ taskName, spawn });
	return { installed: false, removed: result.removed, marker: taskName, backend: "schtasks" };
}
export function statusOneMinuteWindowsJob({ marker, platform = process.platform, spawn = spawnSync }) {
	if (!isWindows(platform)) return null;
	const taskName = schtasksTaskName(marker);
	const output = queryScheduledTask({ taskName, spawn });
	return { installed: Boolean(output), schedule: output ? "every 1 minute (schtasks)" : null, command: output, marker: taskName, backend: "schtasks" };
}
