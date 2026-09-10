// Fase 5 / M1 — pure workspace-directory resolution helpers, extracted
// verbatim from extensions/orchestrator.ts. Zero closure dependencies (pure
// functions of the `projectCwd`/`workspaceDir` arguments). Used by the
// plan-gate cluster's reportsDir() (moved into
// scripts/orchestrator-tools/plan-gate.ts, this same milestone) AND by code
// that stays in orchestrator.ts (ensureYanoStorage(), spec_create) — same
// "shared pure helper, not duplicated" reasoning as
// scripts/orchestrator-tools/ticket-scheduling.ts in Fase 4/M5.
import fs from "node:fs";
import path from "node:path";

export function yanoWorkspaceDir(projectCwd: string, explicitProject?: string): string {
	const modern = path.join(projectCwd, ".pi", "extensions", "yano-orchestrator");
	const readConfig = (dir: string): any | null => {
		try { return JSON.parse(fs.readFileSync(path.join(dir, "config", "project.json"), "utf8")); } catch { return null; }
	};
	const modernConfig = readConfig(modern);
	if (modernConfig && (!explicitProject || String(modernConfig.project) === String(explicitProject))) return modern;
	// Compatibility with projects scaffolded before the workspace rename. Do
	// not move or rewrite that state: select the existing extension directory
	// by its project config and durable database, then keep writing there.
	try {
		const extensionsRoot = path.join(projectCwd, ".pi", "extensions");
		for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidate = path.join(extensionsRoot, entry.name);
			if (!fs.existsSync(path.join(candidate, "orchestratorStorage", "orchestrator.db"))) continue;
			const config = readConfig(candidate);
			if (config && (!explicitProject || String(config.project) === String(explicitProject))) return candidate;
		}
	} catch { /* use the canonical path when no legacy workspace is present */ }
	return modern;
}

// Revisione 28: "logs" removed from this list (was created but never
// written to by any tool — dead scaffold). This workspace's own event
// trail already lives in SQLite (the `events` table, written by
// recordEvent()), so a second, parallel logs/*.jsonl location here would
// only duplicate it.
//
// Revisione 37: "reports", "prompts", and "logs" ADDED back — this time on
// purpose, at the operator's explicit request. Root-level reports/<slug>.md
// and prompts/<role>.md, and the ROOT-level logs/<instance>.jsonl (Revisione
// 18) all used to live directly under the project root, tracked by git like
// any other source file. The operator's point: these are process artifacts
// of THIS project's development with `yano-orchestrator` — the planner's
// task reports, the role prompts, the raw debug trace — not the project's
// own deliverable. If the scaffolded project is later pushed to a public
// GitHub repo, they'd sit right next to the real application code, fully
// public, revealing internal AI-orchestration process and possibly
// hand-tuned prompts that are effectively personal working notes. Moving
// all three under `.pi/extensions/yano-orchestrator/`, which has been
// gitignored by every scaffolded project since Revisione 31, makes "not
// tracked, not pushed, stays only on the machine where the project was
// developed" the default with zero extra configuration. See
// docs/notes/development-notes.md, Revisione 37, for the full rationale
// (including why prompts/ is NOT meant to be edited per-project in the
// first place — role prompts are customized in the extension itself, once,
// for every project, not forked per scaffold).
export function yanoSubdirs(workspaceDir: string) {
	return {
		config: path.join(workspaceDir, "config"),
		specs: path.join(workspaceDir, "specs"),
		playbooks: path.join(workspaceDir, "playbooks"),
		diagrams: path.join(workspaceDir, "diagrams"),
		knowledge: path.join(workspaceDir, "knowledge"),
		policies: path.join(workspaceDir, "policies"),
		artifacts: path.join(workspaceDir, "artifacts"),
		overrides: path.join(workspaceDir, "overrides"),
		orchestratorStorage: path.join(workspaceDir, "orchestratorStorage"),
		reports: path.join(workspaceDir, "reports"),
		prompts: path.join(workspaceDir, "prompts"),
		logs: path.join(workspaceDir, "logs"),
	};
}
