// Fase 6 / M1 — auto_improve_web_search/web_fetch/complete tool handlers,
// extracted from extensions/orchestrator.ts. vi.mock of
// yano-auto-improve-web.mjs's searchPublicAlternatives/fetchPublicSource,
// same pattern as playbooks.test.mjs's vi.mock of loadPlaybook.
// auto_improve_complete writes a real file to a temp cwd (path
// containment is the actual behavior under test).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const searchPublicAlternativesMock = vi.fn();
const fetchPublicSourceMock = vi.fn();
vi.mock("../yano-auto-improve-web.mjs", () => ({
	searchPublicAlternatives: (...args) => searchPublicAlternativesMock(...args),
	fetchPublicSource: (...args) => fetchPublicSourceMock(...args),
}));

const { createAutoImproveTools } = await import("./auto-improve.ts");

function makeDeps(cwd, overrides = {}) {
	return {
		getIdentity: () => ({ role: "auto-improver", cwd, project: "demo", instance: "auto-improver-01" }),
		...overrides,
	};
}

function toolByName(deps, name) {
	return createAutoImproveTools(deps).find((t) => t.name === name);
}

describe("auto-improve", () => {
	let cwd;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "auto-improve-test-"));
		searchPublicAlternativesMock.mockReset();
		fetchPublicSourceMock.mockReset();
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	describe("auto_improve_web_search", () => {
		it("returns search results for the auto-improver role", async () => {
			searchPublicAlternativesMock.mockResolvedValue({ results: [{ name: "a" }, { name: "b" }] });
			const result = await toolByName(makeDeps(cwd), "auto_improve_web_search").execute("c1", { query: "task runners" });
			expect(result.details.result_count).toBe(2);
			expect(searchPublicAlternativesMock).toHaveBeenCalledWith({ query: "task runners" });
		});

		it("rejects a non-auto-improver role", async () => {
			const deps = makeDeps(cwd, { getIdentity: () => ({ role: "coder", cwd, project: "demo", instance: "coder-01" }) });
			await expect(toolByName(deps, "auto_improve_web_search").execute("c1", { query: "x" })).rejects.toThrow(/riservato al ruolo auto-improver/);
			expect(searchPublicAlternativesMock).not.toHaveBeenCalled();
		});

		it("reports (not throws) a failed search as a read-only error result", async () => {
			searchPublicAlternativesMock.mockRejectedValue(new Error("network down"));
			const result = await toolByName(makeDeps(cwd), "auto_improve_web_search").execute("c1", { query: "x" });
			expect(result.details.error).toBe(true);
			expect(result.content[0].text).toContain("network down");
		});
	});

	describe("auto_improve_web_fetch", () => {
		it("returns the fetched source status for the auto-improver role", async () => {
			fetchPublicSourceMock.mockResolvedValue({ status: 200, body: "ok" });
			const result = await toolByName(makeDeps(cwd), "auto_improve_web_fetch").execute("c1", { url: "https://example.com" });
			expect(result.details.status).toBe(200);
		});

		it("rejects a non-auto-improver role", async () => {
			const deps = makeDeps(cwd, { getIdentity: () => ({ role: "planner", cwd, project: "demo", instance: "planner-01" }) });
			await expect(toolByName(deps, "auto_improve_web_fetch").execute("c1", { url: "https://example.com" })).rejects.toThrow(/riservato al ruolo auto-improver/);
		});
	});

	describe("auto_improve_complete", () => {
		it("rejects a malformed audit_id before touching the filesystem", async () => {
			const deps = makeDeps(cwd);
			await expect(
				toolByName(deps, "auto_improve_complete").execute("c1", { audit_id: "not-valid", report_file: "x.md", report_markdown: "# x", summary: "s" }),
			).rejects.toThrow(/audit_id non valido/);
		});

		it("rejects a report_file outside both allowed roots", async () => {
			const deps = makeDeps(cwd);
			await expect(
				toolByName(deps, "auto_improve_complete").execute("c1", {
					audit_id: "AUDIT-123",
					report_file: "/etc/passwd",
					report_markdown: "# x",
					summary: "s",
				}),
			).rejects.toThrow(/deve restare nel data-root/);
		});

		it("rejects a non-auto-improver role", async () => {
			const deps = makeDeps(cwd, { getIdentity: () => ({ role: "planner", cwd, project: "demo", instance: "planner-01" }) });
			await expect(
				toolByName(deps, "auto_improve_complete").execute("c1", { audit_id: "AUDIT-123", report_file: "auto-improvement-x.md", report_markdown: "# x", summary: "s" }),
			).rejects.toThrow(/riservato al ruolo auto-improver/);
		});
	});
});
