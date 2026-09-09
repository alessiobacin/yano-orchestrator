// Fase 2 / M1 — terminal/pane/tab display integration, extracted mechanically
// (zero logic change) from extensions/orchestrator.ts. All functions here
// are no-ops outside their respective host environment (herdr/paseo) by
// design — these tests exercise both the guarded no-op path (the common
// case in CI and for any plain terminal) and the active path via a
// child_process mock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn((_bin, _args, cb) => { if (typeof cb === "function") cb(null, "", ""); });
vi.mock("node:child_process", () => ({ execFile: (...args) => execFileMock(...args) }));

const ORIGINAL_ENV = { ...process.env };

describe("yano-terminal-integration", () => {
	beforeEach(() => {
		execFileMock.mockClear();
		for (const key of ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "PASEO_AGENT_ID"]) delete process.env[key];
	});
	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	describe("herdrReportAgent", () => {
		it("is a no-op when HERDR_ENV is not set", async () => {
			const { herdrReportAgent } = await import("./yano-terminal-integration.ts");
			herdrReportAgent("planner-01", "idle", "planner-01");
			expect(execFileMock).not.toHaveBeenCalled();
		});

		it("calls the herdr binary with the expected pane report-agent args when active", async () => {
			process.env.HERDR_ENV = "1";
			process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr";
			process.env.HERDR_PANE_ID = "pane-1";
			const { herdrReportAgent } = await import("./yano-terminal-integration.ts");
			herdrReportAgent("planner-01", "working", "planner-01");
			expect(execFileMock).toHaveBeenCalledTimes(1);
			const [bin, args] = execFileMock.mock.calls[0];
			expect(bin).toBe("/usr/local/bin/herdr");
			expect(args).toEqual(["pane", "report-agent", "pane-1", "--source", "planner-01", "--agent", "planner-01", "--state", "working"]);
		});

		it("is a no-op when HERDR_ENV is set but HERDR_PANE_ID is missing", async () => {
			process.env.HERDR_ENV = "1";
			process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr";
			const { herdrReportAgent } = await import("./yano-terminal-integration.ts");
			herdrReportAgent("planner-01", "idle", "planner-01");
			expect(execFileMock).not.toHaveBeenCalled();
		});
	});

	describe("herdrRenamePane", () => {
		it("is a no-op outside herdr", async () => {
			const { herdrRenamePane } = await import("./yano-terminal-integration.ts");
			herdrRenamePane("new-name");
			expect(execFileMock).not.toHaveBeenCalled();
		});

		it("tries `agent rename` first when active", async () => {
			process.env.HERDR_ENV = "1";
			process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr";
			process.env.HERDR_PANE_ID = "pane-1";
			const { herdrRenamePane } = await import("./yano-terminal-integration.ts");
			herdrRenamePane("new-name");
			expect(execFileMock).toHaveBeenCalledTimes(1);
			expect(execFileMock.mock.calls[0][1]).toEqual(["agent", "rename", "pane-1", "new-name"]);
		});

		it("falls back to `pane rename` when `agent rename` fails", async () => {
			execFileMock.mockImplementationOnce((_bin, _args, cb) => cb(new Error("unknown subcommand")));
			process.env.HERDR_ENV = "1";
			process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr";
			process.env.HERDR_PANE_ID = "pane-1";
			const { herdrRenamePane } = await import("./yano-terminal-integration.ts");
			herdrRenamePane("new-name");
			expect(execFileMock).toHaveBeenCalledTimes(2);
			expect(execFileMock.mock.calls[1][1]).toEqual(["pane", "rename", "pane-1", "new-name"]);
		});
	});

	describe("herdrRenameTab", () => {
		it("is a no-op outside herdr", async () => {
			const { herdrRenameTab } = await import("./yano-terminal-integration.ts");
			herdrRenameTab("new-name");
			expect(execFileMock).not.toHaveBeenCalled();
		});

		it("renames directly when HERDR_TAB_ID is already known", async () => {
			process.env.HERDR_ENV = "1";
			process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr";
			process.env.HERDR_TAB_ID = "tab-1";
			const { herdrRenameTab } = await import("./yano-terminal-integration.ts");
			herdrRenameTab("new-name");
			expect(execFileMock).toHaveBeenCalledTimes(1);
			expect(execFileMock.mock.calls[0][1]).toEqual(["tab", "rename", "tab-1", "new-name"]);
		});

		it("looks up the owning tab via `pane get` when only HERDR_PANE_ID is known", async () => {
			execFileMock.mockImplementationOnce((_bin, _args, opts, cb) => cb(null, JSON.stringify({ result: { pane: { tab_id: "tab-9" } } })));
			process.env.HERDR_ENV = "1";
			process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr";
			process.env.HERDR_PANE_ID = "pane-1";
			const { herdrRenameTab } = await import("./yano-terminal-integration.ts");
			herdrRenameTab("new-name");
			expect(execFileMock).toHaveBeenCalledTimes(2);
			expect(execFileMock.mock.calls[0][1]).toEqual(["pane", "get", "pane-1"]);
			expect(execFileMock.mock.calls[1][1]).toEqual(["tab", "rename", "tab-9", "new-name"]);
		});
	});

	describe("paseoDetectAndLog", () => {
		it("is a no-op when PASEO_AGENT_ID is not set — logEvent is never called", async () => {
			const logEvent = vi.fn();
			const { paseoDetectAndLog } = await import("./yano-terminal-integration.ts");
			paseoDetectAndLog({ logEvent });
			expect(logEvent).not.toHaveBeenCalled();
		});

		it("logs paseo_detected with the agent id when PASEO_AGENT_ID is set", async () => {
			process.env.PASEO_AGENT_ID = "agent-42";
			const logEvent = vi.fn();
			const { paseoDetectAndLog } = await import("./yano-terminal-integration.ts");
			paseoDetectAndLog({ logEvent });
			expect(logEvent).toHaveBeenCalledWith("paseo_detected", { paseo_agent_id: "agent-42" });
		});

		it("never throws even if the injected logEvent throws", async () => {
			process.env.PASEO_AGENT_ID = "agent-42";
			const logEvent = vi.fn(() => { throw new Error("boom"); });
			const { paseoDetectAndLog } = await import("./yano-terminal-integration.ts");
			expect(() => paseoDetectAndLog({ logEvent })).not.toThrow();
		});
	});

	describe("setTerminalTitle", () => {
		it("never throws when stdout is not a TTY (the common CI/test case)", async () => {
			const { setTerminalTitle } = await import("./yano-terminal-integration.ts");
			expect(() => setTerminalTitle("some title")).not.toThrow();
		});
	});
});
