// Fase 5 / M1 — pure workspace-directory resolution, extracted from
// extensions/orchestrator.ts. Real temporary directories (fs.mkdtempSync),
// same pattern used throughout Fase 4/5.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { yanoSubdirs, yanoWorkspaceDir } from "./yano-workspace.ts";

describe("yano-workspace", () => {
	let projectCwd;

	beforeEach(() => {
		projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "yano-workspace-test-"));
	});
	afterEach(() => {
		fs.rmSync(projectCwd, { recursive: true, force: true });
	});

	describe("yanoWorkspaceDir", () => {
		it("returns the modern .pi/extensions/yano-orchestrator path when no config exists yet", () => {
			expect(yanoWorkspaceDir(projectCwd)).toBe(path.join(projectCwd, ".pi", "extensions", "yano-orchestrator"));
		});

		it("returns the modern path when its own config matches the explicit project", () => {
			const modern = path.join(projectCwd, ".pi", "extensions", "yano-orchestrator", "config");
			fs.mkdirSync(modern, { recursive: true });
			fs.writeFileSync(path.join(modern, "project.json"), JSON.stringify({ project: "demo" }));
			expect(yanoWorkspaceDir(projectCwd, "demo")).toBe(path.join(projectCwd, ".pi", "extensions", "yano-orchestrator"));
		});

		it("falls back to a legacy extension directory with a matching project config and durable db", () => {
			const legacy = path.join(projectCwd, ".pi", "extensions", "old-extension-name");
			fs.mkdirSync(path.join(legacy, "config"), { recursive: true });
			fs.mkdirSync(path.join(legacy, "orchestratorStorage"), { recursive: true });
			fs.writeFileSync(path.join(legacy, "config", "project.json"), JSON.stringify({ project: "demo" }));
			fs.writeFileSync(path.join(legacy, "orchestratorStorage", "orchestrator.db"), "");
			expect(yanoWorkspaceDir(projectCwd, "demo")).toBe(legacy);
		});

		it("ignores a legacy directory without a durable db (incomplete scaffold)", () => {
			const legacy = path.join(projectCwd, ".pi", "extensions", "old-extension-name");
			fs.mkdirSync(path.join(legacy, "config"), { recursive: true });
			fs.writeFileSync(path.join(legacy, "config", "project.json"), JSON.stringify({ project: "demo" }));
			expect(yanoWorkspaceDir(projectCwd, "demo")).toBe(path.join(projectCwd, ".pi", "extensions", "yano-orchestrator"));
		});
	});

	describe("yanoSubdirs", () => {
		it("returns all 12 expected subdirectories joined under the workspace dir", () => {
			const dirs = yanoSubdirs("/base");
			expect(dirs).toEqual({
				config: "/base/config",
				specs: "/base/specs",
				playbooks: "/base/playbooks",
				diagrams: "/base/diagrams",
				knowledge: "/base/knowledge",
				policies: "/base/policies",
				artifacts: "/base/artifacts",
				overrides: "/base/overrides",
				orchestratorStorage: "/base/orchestratorStorage",
				reports: "/base/reports",
				prompts: "/base/prompts",
				logs: "/base/logs",
			});
		});
	});
});
