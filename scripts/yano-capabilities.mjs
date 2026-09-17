import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const CAPABILITIES_PATH = path.join(".pi", "extensions", "yano-orchestrator", "config", "capabilities.json");

function has(root, relative) { return fs.existsSync(path.join(root, relative)); }
function packageJson(root) { try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); } catch { return {}; } }
function componentRoots(root) {
	const roots = [root];
	try {
		for (const entry of fs.readdirSync(path.join(root, ".worktrees"), { withFileTypes: true })) if (entry.isDirectory()) roots.push(path.join(root, ".worktrees", entry.name));
	} catch { /* optional */ }
	return roots.flatMap((candidate) => [candidate, "client", "server", "frontend", "backend", "app"].map((child) => child === candidate ? candidate : path.join(candidate, child))).filter((candidate, index, all) => all.indexOf(candidate) === index);
}
function projectName(root) {
	try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name || path.basename(root); } catch { return path.basename(root); }
}

function detectComponent(root, kind) {
	return componentRoots(root).some((candidate) => {
		if (kind === "backend") return has(candidate, "app/main.py") || has(candidate, "src/index.ts") || has(candidate, "src/server.ts") || has(candidate, "src/server.js") || has(candidate, "server.js") || has(candidate, "pyproject.toml") || Boolean(packageJson(candidate).dependencies?.express);
		const pkg = packageJson(candidate);
		return has(candidate, "app/gui/streamlit_app.py") || has(candidate, "src/App.tsx") || has(candidate, "src/App.jsx") || has(candidate, "src/app") || ["vite.config.ts", "vite.config.js", "next.config.js", "next.config.mjs", "next.config.ts", "angular.json"].some((file) => has(candidate, file)) || Boolean(pkg.dependencies?.next || pkg.dependencies?.react || pkg.dependencies?.["@angular/core"] || pkg.dependencies?.["@ionic/angular"]);
	});
}

function inferredUrl(root, kind) {
	if (!detectComponent(root, kind)) return null;
	if (kind === "backend") return componentRoots(root).some((candidate) => has(candidate, "app/main.py")) ? "http://localhost:8000" : "http://localhost:3000";
	if (componentRoots(root).some((candidate) => has(candidate, "app/gui/streamlit_app.py"))) return "http://localhost:8501";
	if (componentRoots(root).some((candidate) => has(candidate, "angular.json"))) return "http://localhost:4300";
	if (componentRoots(root).some((candidate) => has(candidate, "vite.config.ts") || has(candidate, "vite.config.js"))) return "http://localhost:5173";
	return "http://localhost:3000";
}

export function canonicalProjectRoot(root) {
	const absolute = path.resolve(root);
	try {
		const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: absolute, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : absolute;
	} catch { return absolute; }
}

export function capabilitiesPath(root) { return path.join(canonicalProjectRoot(root), CAPABILITIES_PATH); }

export function readCapabilities(root) {
	try { return JSON.parse(fs.readFileSync(capabilitiesPath(root), "utf8")); } catch { return null; }
}

export function detectCapabilities(root) {
	const projectRoot = canonicalProjectRoot(root);
	const components = {};
	for (const kind of ["frontend", "backend"]) {
		const present = detectComponent(projectRoot, kind);
		components[kind] = {
			present,
			url: inferredUrl(projectRoot, kind),
			source: "detector",
			confidence: present ? "detected" : "unknown",
		};
	}
	return { version: 1, project: projectName(projectRoot), components, updated_at: new Date().toISOString() };
}

export function writeCapabilities(root, data) {
	const target = capabilitiesPath(root);
	const normalized = {
		version: 1,
		project: data.project || projectName(root),
		components: {
			frontend: { present: false, ...data.components?.frontend },
			backend: { present: false, ...data.components?.backend },
		},
		updated_at: new Date().toISOString(),
	};
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, target);
	} finally {
		try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
	}
	return { path: target, data: normalized };
}

export function syncCapabilities(root) {
	const detected = detectCapabilities(root);
	const existing = readCapabilities(root);
	// A refresh is an explicit reconciliation after a structural code change:
	// detector presence wins, while a previously confirmed URL is retained only
	// for a component that still exists. `capabilities set` is the escape hatch
	// for a deliberately non-standard topology.
	for (const kind of ["frontend", "backend"]) {
		if (detected.components[kind].present && existing?.components?.[kind]?.url) detected.components[kind].url = existing.components[kind].url;
	}
	return writeCapabilities(root, detected);
}
