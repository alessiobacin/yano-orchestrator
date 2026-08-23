import fs from "node:fs";
import path from "node:path";

export function slugifyProject(value) {
	return String(value || "progetto")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "progetto";
}

function readProjectConfig(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "config", "project.json"), "utf8"));
	} catch {
		return null;
	}
}

/**
 * Resolve the project-local Yano workspace without assuming that the project
 * was scaffolded by the current package version. The modern path wins; an
 * existing extension workspace with a project config is accepted as a
 * compatibility fallback so upgrades remain non-destructive.
 */
export function resolveYanoWorkspaceDir(projectCwd, explicitProject = null) {
	const modern = path.join(projectCwd, ".pi", "extensions", "yano-orchestrator");
	const modernConfig = readProjectConfig(modern);
	if (modernConfig && (!explicitProject || String(modernConfig.project) === String(explicitProject))) return modern;

	const extensionsDir = path.join(projectCwd, ".pi", "extensions");
	try {
		const candidates = fs.readdirSync(extensionsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(extensionsDir, entry.name))
			.filter((dir) => fs.existsSync(path.join(dir, "orchestratorStorage", "orchestrator.db")))
			.map((dir) => ({ dir, config: readProjectConfig(dir) }))
			.filter(({ config }) => config && (!explicitProject
				|| String(config.project) === String(explicitProject)
				|| slugifyProject(config.project) === slugifyProject(explicitProject)));
		if (candidates.length) return candidates[0].dir;
	} catch {
		// Fall through to the canonical location; callers can create it.
	}
	return modern;
}

export function projectDbPath(projectCwd, explicitProject = null) {
	return path.join(resolveYanoWorkspaceDir(projectCwd, explicitProject), "orchestratorStorage", "orchestrator.db");
}

export function projectConfig(projectCwd, explicitProject = null) {
	const workspaceDir = resolveYanoWorkspaceDir(projectCwd, explicitProject);
	return { workspaceDir, config: readProjectConfig(workspaceDir) };
}
