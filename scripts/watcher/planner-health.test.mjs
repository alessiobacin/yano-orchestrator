// Fase 3 / M3 — planner health and workspace matching, extracted from
// scripts/yano-watcher-registry.mjs. Uses the REAL yano-trace-storage.mjs
// heartbeat reader/writer (same convention as
// scripts/smoke-test-heartbeat-unification.mjs) with YANO_DATA_DIR
// isolation, and mocks only spawnSync("herdr", ...) for the Herdr-fallback
// branch of plannerHeartbeatHealthy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync: (...args) => spawnSyncMock(...args) }));

const ORIGINAL_ENV = { ...process.env };

describe("planner-health", () => {
	let projectRoot;

	beforeEach(() => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-health-test-"));
		process.env = { ...ORIGINAL_ENV, YANO_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "planner-health-data-")), YANO_CONFIG_FILE: path.join(os.tmpdir(), "no-such-config.env") };
		spawnSyncMock.mockReset();
	});
	afterEach(() => {
		fs.rmSync(projectRoot, { recursive: true, force: true });
		fs.rmSync(process.env.YANO_DATA_DIR, { recursive: true, force: true });
		process.env = { ...ORIGINAL_ENV };
	});

	async function writeHeartbeat(instance, { ageMs = 1000, status = "idle" } = {}) {
		const { applicationHeartbeatPath } = await import("../yano-trace-storage.mjs");
		const file = applicationHeartbeatPath(projectRoot, instance);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ observed_at: new Date(Date.now() - ageMs).toISOString(), status }));
	}

	describe("plannerHeartbeatHealthy", () => {
		it("is true immediately from a fresh MQTT-retained last_heartbeat, without ever shelling out to herdr", async () => {
			const { plannerHeartbeatHealthy } = await import("./planner-health.mjs");
			const result = plannerHeartbeatHealthy({ agent_status: "idle", last_heartbeat: new Date().toISOString() });
			expect(result).toBe(true);
			expect(spawnSyncMock).not.toHaveBeenCalled();
		});

		it("is false when the MQTT last_heartbeat is stale, even if agent_status looks idle", async () => {
			const { plannerHeartbeatHealthy } = await import("./planner-health.mjs");
			const stale = new Date(Date.now() - 5 * 60_000).toISOString();
			expect(plannerHeartbeatHealthy({ agent_status: "idle", last_heartbeat: stale })).toBe(false);
		});

		it("is false outright for a non-idle/working status, before even looking at heartbeats", async () => {
			const { plannerHeartbeatHealthy } = await import("./planner-health.mjs");
			expect(plannerHeartbeatHealthy({ agent_status: "offline", last_heartbeat: new Date().toISOString() })).toBe(false);
		});

		it("falls back to the Herdr pane process + explain API when no MQTT heartbeat field is present, and reports healthy", async () => {
			await writeHeartbeat("planner-01", { ageMs: 1000 });
			spawnSyncMock.mockImplementation((cmd, args) => {
				if (args.includes("process-info")) return { status: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 123 }] } } }) };
				if (args.includes("explain")) return { status: 0, stdout: JSON.stringify({ state: "idle", warning: null, visible_blocker: false }) };
				throw new Error(`unexpected herdr call: ${args}`);
			});
			const { plannerHeartbeatHealthy } = await import("./planner-health.mjs");
			const result = plannerHeartbeatHealthy({ agent_status: "idle", cwd: projectRoot, name: "planner-01", pane_id: "pane-1" });
			expect(result).toBe(true);
		});

		it("is false via the Herdr fallback when the file heartbeat explicitly says dead — the wedge-detection signal", async () => {
			await writeHeartbeat("planner-01", { ageMs: 5 * 60_000 }); // stale beyond the 120s window
			const { plannerHeartbeatHealthy } = await import("./planner-health.mjs");
			const result = plannerHeartbeatHealthy({ agent_status: "idle", cwd: projectRoot, name: "planner-01", pane_id: "pane-1" });
			expect(result).toBe(false);
			expect(spawnSyncMock).not.toHaveBeenCalled(); // short-circuited before ever calling herdr
		});

		it("is false via the Herdr fallback when there is no pane_id to check at all", async () => {
			const { plannerHeartbeatHealthy } = await import("./planner-health.mjs");
			expect(plannerHeartbeatHealthy({ agent_status: "idle", cwd: projectRoot, name: "planner-01" })).toBe(false);
		});

		it("is false via the Herdr fallback when explain reports a visible_blocker", async () => {
			spawnSyncMock.mockImplementation((cmd, args) => {
				if (args.includes("process-info")) return { status: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 123 }] } } }) };
				if (args.includes("explain")) return { status: 0, stdout: JSON.stringify({ state: "idle", warning: null, visible_blocker: true }) };
			});
			const { plannerHeartbeatHealthy } = await import("./planner-health.mjs");
			expect(plannerHeartbeatHealthy({ agent_status: "idle", cwd: projectRoot, name: "planner-01", pane_id: "pane-1" })).toBe(false);
		});
	});

	describe("findProjectWorkspace", () => {
		it("returns null when no workspace matches the label at all", async () => {
			const { findProjectWorkspace } = await import("./planner-health.mjs");
			expect(findProjectWorkspace({ workspaces: [] }, "/p", "demo")).toBeNull();
		});

		it("matches the label case-insensitively", async () => {
			const { findProjectWorkspace } = await import("./planner-health.mjs");
			const snapshot = { workspaces: [{ workspace_id: "w-1", label: "DEMO" }] };
			expect(findProjectWorkspace(snapshot, "/p", "demo")?.workspace_id).toBe("w-1");
		});

		it("prefers the candidate workspace with a live planner + matching root over one that merely matches by label", async () => {
			const snapshot = {
				workspaces: [{ workspace_id: "w-stale", label: "demo" }, { workspace_id: "w-live", label: "demo" }],
				panes: [{ pane_id: "p-1", workspace_id: "w-live", cwd: "/p" }],
				tabs: [{ tab_id: "t-1", label: "planner-01" }],
				agents: [{ workspace_id: "w-live", cwd: "/p", tab_id: "t-1", agent_status: "idle" }],
			};
			const { findProjectWorkspace } = await import("./planner-health.mjs");
			expect(findProjectWorkspace(snapshot, "/p", "demo").workspace_id).toBe("w-live");
		});
	});

	describe("plannerAgentsInWorkspace", () => {
		it("matches an agent by planner tab label even when agent.name lacks the instance", async () => {
			const snapshot = {
				tabs: [{ tab_id: "t-1", label: "planner-01" }],
				agents: [{ workspace_id: "w-1", cwd: "/p", tab_id: "t-1", name: "", terminal_title_stripped: "" }],
			};
			const { plannerAgentsInWorkspace } = await import("./planner-health.mjs");
			expect(plannerAgentsInWorkspace(snapshot, "w-1", "/p")).toHaveLength(1);
		});

		it("excludes an agent whose cwd does not match the requested root", async () => {
			const snapshot = {
				tabs: [{ tab_id: "t-1", label: "planner-01" }],
				agents: [{ workspace_id: "w-1", cwd: "/other", tab_id: "t-1" }],
			};
			const { plannerAgentsInWorkspace } = await import("./planner-health.mjs");
			expect(plannerAgentsInWorkspace(snapshot, "w-1", "/p")).toHaveLength(0);
		});
	});

	describe("paneHasLivePiProcess", () => {
		it("returns false immediately without shelling out when paneId is missing", async () => {
			const { paneHasLivePiProcess } = await import("./planner-health.mjs");
			expect(paneHasLivePiProcess(null)).toBe(false);
			expect(spawnSyncMock).not.toHaveBeenCalled();
		});

		it("is true when a foreground process's argv0 is pi", async () => {
			spawnSyncMock.mockReturnValue({ status: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv0: "pi" }] } } }) });
			const { paneHasLivePiProcess } = await import("./planner-health.mjs");
			expect(paneHasLivePiProcess("pane-1")).toBe(true);
		});

		it("is false when herdr is unreachable (non-zero exit)", async () => {
			spawnSyncMock.mockReturnValue({ status: 1 });
			const { paneHasLivePiProcess } = await import("./planner-health.mjs");
			expect(paneHasLivePiProcess("pane-1")).toBe(false);
		});
	});

	describe("livePlannerPanesInWorkspace", () => {
		it("requires both a planner-labelled tab and a live pi process", async () => {
			spawnSyncMock.mockReturnValue({ status: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv0: "pi" }] } } }) });
			const snapshot = {
				panes: [{ pane_id: "p-1", workspace_id: "w-1", cwd: "/p", tab_id: "t-1" }],
				tabs: [{ tab_id: "t-1", label: "planner-01" }],
			};
			const { livePlannerPanesInWorkspace } = await import("./planner-health.mjs");
			expect(livePlannerPanesInWorkspace(snapshot, "w-1", "/p")).toHaveLength(1);
		});

		it("excludes a planner-labelled pane whose process is not actually alive", async () => {
			spawnSyncMock.mockReturnValue({ status: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [] } } }) });
			const snapshot = {
				panes: [{ pane_id: "p-1", workspace_id: "w-1", cwd: "/p", tab_id: "t-1" }],
				tabs: [{ tab_id: "t-1", label: "planner-01" }],
			};
			const { livePlannerPanesInWorkspace } = await import("./planner-health.mjs");
			expect(livePlannerPanesInWorkspace(snapshot, "w-1", "/p")).toHaveLength(0);
		});
	});
});
