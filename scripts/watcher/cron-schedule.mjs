// Fase 3 / M0 — cron/OS-scheduler integration for `yano watcher cron
// install|status|remove`, extracted verbatim from scripts/yano-watcher-
// registry.mjs. Zero dependency on the watcher registry DB or a live Herdr
// snapshot beyond the heartbeat file written by the global supervisor pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installOneMinuteWindowsJob, removeOneMinuteWindowsJob, statusOneMinuteWindowsJob } from "../yano-os-scheduler.mjs";
import { traceRoot } from "../yano-trace-storage.mjs";

// One directory deeper than the original scripts/yano-watcher-registry.mjs,
// so this needs an extra ".." to still resolve to the package root.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CRON_MARKER = "# yano-watcher-supervisor";
// Value only — NOT the process.env.PATH mutation side effect that
// yano-watcher-registry.mjs performs at import time (that stays there; it
// exists so every spawnSync("herdr", ...) call across that file, not just
// cronCommand() here, can find the herdr binary).
const herdrBinDir = path.join(os.homedir(), ".local", "bin");

function shellQuote(valueToQuote) {
	return process.platform === "win32" ? `"${String(valueToQuote).replaceAll('"', '\\"')}"` : `'${String(valueToQuote).replaceAll("'", `'"'"'`)}'`;
}

// Duplicated one-liner (same path contract as yano-watcher-registry.mjs's
// own supervisorHeartbeatPath()) — cronStatus() only needs to read this
// file, never write it, so a tiny stable duplicate is safer than importing
// back into the file that is extracting this module.
function supervisorHeartbeatPath() { return path.join(traceRoot(), "watcher", "supervisor-heartbeat.json"); }

function readCrontab() {
	const result = spawnSync("crontab", ["-l"], { encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status === 0) return result.stdout || "";
	if (/no crontab for|can't open crontab/i.test(`${result.stdout || ""}\n${result.stderr || ""}`)) return "";
	throw new Error(`yano watcher: impossibile leggere il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

function cronCommand() {
	return `PATH=${shellQuote(herdrBinDir)}:\$PATH ${shellQuote(process.execPath)} ${shellQuote(path.join(PACKAGE_ROOT, "bin", "yano.mjs"))} watcher supervise --json >/dev/null 2>&1 ${CRON_MARKER}`;
}

export function cronInstall() {
	const windows = installOneMinuteWindowsJob({ marker: CRON_MARKER, command: cronCommand() });
	if (windows) return windows;
	const line = `* * * * * ${cronCommand()}`;
	const existing = readCrontab().split("\n").filter((item) => item.trim() && !item.includes(CRON_MARKER));
	const content = [...existing, line].join("\n") + "\n";
	const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) throw new Error(`yano watcher: impossibile installare il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { installed: true, schedule: "* * * * *", command: line, marker: CRON_MARKER, backend: "crontab" };
}

export function cronStatus() {
	const windows = statusOneMinuteWindowsJob({ marker: CRON_MARKER });
	let heartbeat = null;
	try { heartbeat = JSON.parse(fs.readFileSync(supervisorHeartbeatPath(), "utf8")); } catch { /* not run yet */ }
	const heartbeatAt = heartbeat?.checked_at || null;
	const heartbeatAgeMs = heartbeatAt ? Math.max(0, Date.now() - Date.parse(heartbeatAt)) : null;
	const healthy = Boolean(heartbeatAt && heartbeatAgeMs <= 130_000);
	if (windows) return { ...windows, installed: windows.installed, last_heartbeat_at: heartbeatAt, heartbeat_age_ms: heartbeatAgeMs, healthy: Boolean(windows.installed && healthy) };
	const line = readCrontab().split("\n").find((item) => item.includes(CRON_MARKER)) || null;
	return { installed: Boolean(line), schedule: line ? "* * * * *" : null, command: line, marker: CRON_MARKER, backend: "crontab", last_heartbeat_at: heartbeatAt, heartbeat_age_ms: heartbeatAgeMs, healthy: Boolean(line && healthy) };
}

export function cronRemove() {
	const windows = removeOneMinuteWindowsJob({ marker: CRON_MARKER });
	if (windows) return windows;
	const existing = readCrontab().split("\n").filter((item) => item.trim() && !item.includes(CRON_MARKER));
	const content = existing.length ? `${existing.join("\n")}\n` : "";
	const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) throw new Error(`yano watcher: impossibile rimuovere il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { installed: false, removed: true, marker: CRON_MARKER, backend: "crontab" };
}
