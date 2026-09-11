// Fase 6 / M0 — orchestrator_init/run_create/spec_create/run_status/
// run_watchdog_check tool handlers, extracted from extensions/
// orchestrator.ts. Mock OrchestratorStorage + plain vi.fn() spies for the
// still-inline watchdog-detection functions, same pattern as
// decision-holds.test.mjs (Fase 4/M0). spec_create writes a real file to a
// temp cwd (fs.writeFileSync isn't mocked, same reasoning as
// worktree.test.mjs using a real filesystem for the part of the behavior
// that's actually being verified).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunTools } from "./run.ts";
import { yanoWorkspaceDir, yanoSubdirs } from "./yano-workspace.ts";

function makeDeps(overrides = {}) {
	const presence = new Map();
	const runs = new Map();
	const specs = new Map();
	const storage = {
		getSchemaVersion: () => 7,
		createRun: vi.fn((input) => {
			const run = { id: `run-${runs.size + 1}`, status: "active", finalization_status: null, ...input };
			runs.set(run.id, run);
			return run;
		}),
		getRun: (id) => runs.get(id) ?? null,
		createSpec: vi.fn((input) => {
			const spec = { created_at: "2026-01-01T00:00:00.000Z", ...input };
			specs.set(spec.id, spec);
			return spec;
		}),
		recordEvent: vi.fn(),
		listTickets: vi.fn(() => []),
		listDependencies: vi.fn(() => []),
		listEvents: vi.fn(() => []),
		listCheckpoints: vi.fn(() => []),
		getPlaybookBinding: vi.fn(() => null),
		getPlaybookRuntimeState: vi.fn(() => null),
		listPlaybookEvidence: vi.fn(() => []),
		listCapabilityCards: vi.fn(() => []),
		listPlaybookEffects: vi.fn(() => []),
		listDecisionHolds: vi.fn(() => []),
	};
	const deps = {
		getIdentity: () => ({ role: "planner", cwd: "/p", project: "demo", instance: "planner-01" }),
		ensureYanoStorage: () => storage,
		logEvent: vi.fn(),
		yanoPublishEvent: vi.fn(async () => {}),
		yanoEnsureWorkspace: vi.fn((cwd, project, override) => ({
			schema_version: 7,
			extension_version: "1.5.0",
			project: override || project,
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		})),
		yanoReconcilePersistedState: vi.fn(() => 0),
		yanoFindStalledTickets: vi.fn(() => []),
		yanoFindUnfinalizedRuns: vi.fn(() => []),
		yanoFindOrphanedTickets: vi.fn(() => []),
		presence,
		...overrides,
	};
	return { deps, presence, runs, specs, storage };
}

function toolByName(deps, name) {
	return createRunTools(deps).find((t) => t.name === name);
}

describe("run", () => {
	describe("orchestrator_init", () => {
		it("ensures the workspace, reconciles state for a planner, and reports schema/version", async () => {
			const { deps, storage } = makeDeps({ yanoReconcilePersistedState: vi.fn(() => 2) });
			const result = await toolByName(deps, "orchestrator_init").execute("c1", {});
			expect(result.details.schema_version).toBe(7);
			expect(result.details.reconciled_runs).toBe(2);
			expect(result.content[0].text).toContain("Reconciled 2 active run(s)");
		});

		it("skips reconciliation for a non-planner role", async () => {
			const reconcile = vi.fn(() => 5);
			const { deps } = makeDeps({
				getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }),
				yanoReconcilePersistedState: reconcile,
			});
			const result = await toolByName(deps, "orchestrator_init").execute("c1", {});
			expect(reconcile).not.toHaveBeenCalled();
			expect(result.details.reconciled_runs).toBe(0);
		});

		it("passes project_name through as an override", async () => {
			const { deps } = makeDeps();
			const result = await toolByName(deps, "orchestrator_init").execute("c1", { project_name: "Custom Name" });
			expect(result.details.config.project).toBe("Custom Name");
		});
	});

	describe("run_create", () => {
		it("creates a run, records an event, and publishes it", async () => {
			const { deps, storage } = makeDeps();
			const result = await toolByName(deps, "run_create").execute("c1", { objective: "ship the thing" });
			expect(result.details.run.objective).toBe("ship the thing");
			expect(result.details.run.domain).toBe("generic");
			expect(storage.recordEvent).toHaveBeenCalledWith(result.details.run.id, "run_created", expect.objectContaining({ objective: "ship the thing" }));
			expect(deps.yanoPublishEvent).toHaveBeenCalledWith(result.details.run.id, "run_created", expect.any(Object));
		});

		it("rejects a non-planner role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			await expect(toolByName(deps, "run_create").execute("c1", { objective: "x" })).rejects.toThrow(/only the planner role/);
		});
	});

	describe("spec_create", () => {
		let cwd;

		beforeEach(() => {
			cwd = fs.mkdtempSync(path.join(os.tmpdir(), "spec-create-test-"));
		});
		afterEach(() => {
			fs.rmSync(cwd, { recursive: true, force: true });
		});

		it("writes the spec file under specs/ and persists it in storage", async () => {
			const identity = { role: "planner", cwd, project: "demo", instance: "planner-01" };
			const { deps, runs } = makeDeps({ getIdentity: () => identity });
			runs.set("run-1", { id: "run-1", status: "active" });
			fs.mkdirSync(yanoSubdirs(yanoWorkspaceDir(cwd)).specs, { recursive: true });
			const result = await toolByName(deps, "spec_create").execute("c1", { run_id: "run-1", title: "My Spec!", content: "## Body" });
			expect(result.details.spec.title).toBe("My Spec!");
			const written = fs.readFileSync(path.join(cwd, result.details.spec.file_path), "utf-8");
			expect(written).toContain("# My Spec!");
			expect(written).toContain("## Body");
			expect(result.details.spec.file_path).toMatch(/specs[\\/].*my-spec\.md$/);
		});

		it("throws when the run does not exist", async () => {
			const { deps } = makeDeps();
			await expect(toolByName(deps, "spec_create").execute("c1", { run_id: "missing", title: "t", content: "c" })).rejects.toThrow(/no run "missing"/);
		});

		it("rejects a non-planner role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd, project: "demo", instance: "coder-01" }) });
			await expect(toolByName(deps, "spec_create").execute("c1", { run_id: "run-1", title: "t", content: "c" })).rejects.toThrow(/only the planner role/);
		});
	});

	describe("run_status", () => {
		it("reports ticket buckets and includes stalled/unfinalized warnings scoped to this run", async () => {
			const { deps, runs } = makeDeps({
				yanoFindStalledTickets: vi.fn(() => [{ run_id: "run-1", ticket_id: "t1", title: "x", assigned_instance: "coder-01", running_since: "t0", elapsed_ms: 600000 }]),
				yanoFindUnfinalizedRuns: vi.fn(() => [{ run_id: "run-1", objective: "x", completed_at: "t0", elapsed_ms: 700000 }]),
			});
			runs.set("run-1", { id: "run-1", status: "active", domain: "software" });
			const result = await toolByName(deps, "run_status").execute("c1", { run_id: "run-1" });
			expect(result.details.stalled_tickets).toHaveLength(1);
			expect(result.details.unfinalized_run).toBe(true);
			expect(result.content[0].text).toContain("⚠️ 1 ticket bloccato");
		});

		it("filters out stalled/unfinalized entries belonging to a different run", async () => {
			const { deps, runs } = makeDeps({
				yanoFindStalledTickets: vi.fn(() => [{ run_id: "other-run", ticket_id: "t1", title: "x", assigned_instance: null, running_since: "t0", elapsed_ms: 600000 }]),
			});
			runs.set("run-1", { id: "run-1", status: "active", domain: "software" });
			const result = await toolByName(deps, "run_status").execute("c1", { run_id: "run-1" });
			expect(result.details.stalled_tickets).toHaveLength(0);
		});

		it("throws for an unknown run_id", async () => {
			const { deps } = makeDeps();
			await expect(toolByName(deps, "run_status").execute("c1", { run_id: "missing" })).rejects.toThrow(/no run "missing"/);
		});
	});

	describe("run_watchdog_check", () => {
		it("reports no blockers when nothing is stalled/unfinalized/orphaned", async () => {
			const { deps } = makeDeps();
			const result = await toolByName(deps, "run_watchdog_check").execute("c1", {});
			expect(result.content[0].text).toContain("nessun blocco");
		});

		it("reports stalled/unfinalized/orphaned findings, optionally scoped to one run_id", async () => {
			const { deps } = makeDeps({
				yanoFindStalledTickets: vi.fn(() => [
					{ run_id: "run-1", ticket_id: "t1", title: "a", assigned_instance: "coder-01", running_since: "t0", elapsed_ms: 600000 },
					{ run_id: "run-2", ticket_id: "t2", title: "b", assigned_instance: "coder-02", running_since: "t0", elapsed_ms: 600000 },
				]),
				yanoFindOrphanedTickets: vi.fn(() => [{ run_id: "run-1", ticket_id: "t3", title: "c", assigned_instance: "coder-03", running_since: "t0" }]),
			});
			const scoped = await toolByName(deps, "run_watchdog_check").execute("c1", { run_id: "run-1" });
			expect(scoped.details.stalled).toHaveLength(1);
			expect(scoped.details.orphaned).toHaveLength(1);
			expect(scoped.content[0].text).toContain("🔴");

			const all = await toolByName(deps, "run_watchdog_check").execute("c1", {});
			expect(all.details.stalled).toHaveLength(2);
		});
	});
});
