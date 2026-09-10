// Fase 3 / M0 — cron/OS-scheduler integration, extracted from
// scripts/yano-watcher-registry.mjs. End-to-end crontab behavior (real fake
// crontab binary on PATH, install/status/remove idempotency, CLI dispatch)
// is already covered by scripts/smoke-test-yano-watcher-cron.mjs — these
// unit tests focus on the two things that are new/worth isolating here: the
// POSIX vs Windows branch selection, and cronStatus()'s heartbeat-freshness
// computation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync: (...args) => spawnSyncMock(...args) }));

const installOneMinuteWindowsJobMock = vi.fn(() => null);
const statusOneMinuteWindowsJobMock = vi.fn(() => null);
const removeOneMinuteWindowsJobMock = vi.fn(() => null);
vi.mock("../yano-os-scheduler.mjs", () => ({
	installOneMinuteWindowsJob: (...args) => installOneMinuteWindowsJobMock(...args),
	statusOneMinuteWindowsJob: (...args) => statusOneMinuteWindowsJobMock(...args),
	removeOneMinuteWindowsJob: (...args) => removeOneMinuteWindowsJobMock(...args),
}));

describe("cron-schedule", () => {
	let dataDir;
	const ORIGINAL_ENV = { ...process.env };

	beforeEach(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-schedule-test-"));
		process.env = { ...ORIGINAL_ENV, YANO_DATA_DIR: dataDir, YANO_CONFIG_FILE: path.join(dataDir, "does-not-exist.env") };
		spawnSyncMock.mockReset();
		installOneMinuteWindowsJobMock.mockClear().mockReturnValue(null);
		statusOneMinuteWindowsJobMock.mockClear().mockReturnValue(null);
		removeOneMinuteWindowsJobMock.mockClear().mockReturnValue(null);
	});
	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	describe("POSIX crontab path (no Windows scheduler)", () => {
		it("cronInstall appends a single marked line to the existing crontab", async () => {
			spawnSyncMock.mockImplementation((cmd, args) => {
				if (args[0] === "-l") return { status: 0, stdout: "MAILTO=ops@example.test\n" };
				if (args[0] === "-") return { status: 0 };
				throw new Error(`unexpected spawnSync call: ${cmd} ${args}`);
			});
			const { cronInstall } = await import("./cron-schedule.mjs");
			const result = cronInstall();
			expect(result).toMatchObject({ installed: true, schedule: "* * * * *", backend: "crontab" });
			const [, writeArgs, writeOpts] = spawnSyncMock.mock.calls.find(([, args]) => args[0] === "-");
			expect(writeOpts.input).toContain("MAILTO=ops@example.test");
			expect(writeOpts.input).toContain("* * * * *");
			expect(writeOpts.input.split("yano-watcher-supervisor").length - 1).toBe(1);
		});

		it("cronInstall throws with the crontab's stderr when writing the new crontab fails", async () => {
			spawnSyncMock.mockImplementation((cmd, args) => {
				if (args[0] === "-l") return { status: 0, stdout: "" };
				if (args[0] === "-") return { status: 1, stderr: "permission denied" };
			});
			const { cronInstall } = await import("./cron-schedule.mjs");
			expect(() => cronInstall()).toThrow(/permission denied/);
		});

		it("cronStatus reports installed:false when the marker line is absent", async () => {
			spawnSyncMock.mockReturnValue({ status: 0, stdout: "MAILTO=ops@example.test\n" });
			const { cronStatus } = await import("./cron-schedule.mjs");
			expect(cronStatus()).toMatchObject({ installed: false, schedule: null });
		});

		it("cronStatus reports installed:true and echoes the exact crontab line when the marker is present", async () => {
			const line = "* * * * * /usr/bin/env node watcher supervise # yano-watcher-supervisor";
			spawnSyncMock.mockReturnValue({ status: 0, stdout: `${line}\n` });
			const { cronStatus } = await import("./cron-schedule.mjs");
			expect(cronStatus()).toMatchObject({ installed: true, schedule: "* * * * *", command: line });
		});

		it("cronStatus treats 'no crontab for user' as an empty (not installed) crontab, not an error", async () => {
			spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "no crontab for test" });
			const { cronStatus } = await import("./cron-schedule.mjs");
			expect(cronStatus().installed).toBe(false);
		});

		it("cronRemove strips only the Yano-marked line, preserving the rest of the crontab", async () => {
			const existing = "MAILTO=ops@example.test\n* * * * * some-other-job # not-ours\n* * * * * yano-cmd # yano-watcher-supervisor\n";
			spawnSyncMock.mockImplementation((cmd, args) => {
				if (args[0] === "-l") return { status: 0, stdout: existing };
				if (args[0] === "-") return { status: 0 };
			});
			const { cronRemove } = await import("./cron-schedule.mjs");
			const result = cronRemove();
			expect(result).toEqual({ installed: false, removed: true, marker: "# yano-watcher-supervisor", backend: "crontab" });
			const [, , writeOpts] = spawnSyncMock.mock.calls.find(([, args]) => args[0] === "-");
			expect(writeOpts.input).toContain("MAILTO=ops@example.test");
			expect(writeOpts.input).toContain("some-other-job");
			expect(writeOpts.input).not.toContain("yano-watcher-supervisor");
		});
	});

	describe("cronStatus heartbeat freshness", () => {
		function heartbeatPath() { return path.join(dataDir, "watcher", "supervisor-heartbeat.json"); }
		function writeHeartbeat(ageMs) {
			fs.mkdirSync(path.dirname(heartbeatPath()), { recursive: true });
			fs.writeFileSync(heartbeatPath(), JSON.stringify({ checked_at: new Date(Date.now() - ageMs).toISOString() }));
		}

		it("is healthy when the crontab is installed and the heartbeat is under the 130s freshness window", async () => {
			spawnSyncMock.mockReturnValue({ status: 0, stdout: "* * * * * x # yano-watcher-supervisor\n" });
			writeHeartbeat(5_000);
			const { cronStatus } = await import("./cron-schedule.mjs");
			const status = cronStatus();
			expect(status.healthy).toBe(true);
			expect(status.heartbeat_age_ms).toBeLessThan(130_000);
		});

		it("is unhealthy when the heartbeat is older than the 130s freshness window, even though installed", async () => {
			spawnSyncMock.mockReturnValue({ status: 0, stdout: "* * * * * x # yano-watcher-supervisor\n" });
			writeHeartbeat(200_000);
			const { cronStatus } = await import("./cron-schedule.mjs");
			expect(cronStatus().healthy).toBe(false);
		});

		it("is unhealthy when there is no heartbeat file at all, even if the crontab is installed", async () => {
			spawnSyncMock.mockReturnValue({ status: 0, stdout: "* * * * * x # yano-watcher-supervisor\n" });
			const { cronStatus } = await import("./cron-schedule.mjs");
			const status = cronStatus();
			expect(status.healthy).toBe(false);
			expect(status.last_heartbeat_at).toBeNull();
		});
	});

	describe("Windows scheduler branch", () => {
		it("cronInstall defers entirely to the Windows job when yano-os-scheduler reports a Windows result", async () => {
			installOneMinuteWindowsJobMock.mockReturnValue({ installed: true, backend: "schtasks", task_name: "YanoWatcherSupervisor" });
			const { cronInstall } = await import("./cron-schedule.mjs");
			const result = cronInstall();
			expect(result).toEqual({ installed: true, backend: "schtasks", task_name: "YanoWatcherSupervisor" });
			expect(spawnSyncMock).not.toHaveBeenCalled();
		});

		it("cronStatus merges the Windows result with heartbeat freshness instead of reading a POSIX crontab", async () => {
			statusOneMinuteWindowsJobMock.mockReturnValue({ installed: true, backend: "schtasks" });
			writeHeartbeatHelper(dataDir, 5_000);
			const { cronStatus } = await import("./cron-schedule.mjs");
			const status = cronStatus();
			expect(status).toMatchObject({ installed: true, backend: "schtasks", healthy: true });
			expect(spawnSyncMock).not.toHaveBeenCalled();
		});

		it("cronRemove defers to the Windows job removal, never touching crontab", async () => {
			removeOneMinuteWindowsJobMock.mockReturnValue({ installed: false, removed: true, backend: "schtasks" });
			const { cronRemove } = await import("./cron-schedule.mjs");
			expect(cronRemove()).toEqual({ installed: false, removed: true, backend: "schtasks" });
			expect(spawnSyncMock).not.toHaveBeenCalled();
		});
	});
});

function writeHeartbeatHelper(dataDir, ageMs) {
	const file = path.join(dataDir, "watcher", "supervisor-heartbeat.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ checked_at: new Date(Date.now() - ageMs).toISOString() }));
}
