// Opt-in server discovery/probing for the Pi footer. Never invent a port.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readCapabilities } from "./yano-capabilities.mjs";

const CONFIG_PATH = path.join(".pi", "extensions", "yano-orchestrator", "config", "e2e-environment.json");
const URL_KEYS = {
	frontend: ["YANO_FRONTEND_URL", "FRONTEND_URL", "PLAYWRIGHT_BASE_URL", "VITE_APP_URL", "NEXT_PUBLIC_APP_URL"],
	backend: ["YANO_BACKEND_URL", "BACKEND_URL", "API_URL", "YANO_API_URL", "APP_URL", "VITE_API_URL", "NEXT_PUBLIC_API_URL"],
};
const PORT_KEYS = {
	frontend: ["YANO_FRONTEND_PORT", "FRONTEND_PORT", "VITE_PORT", "PORT_DEV", "PORT_STAGING"],
	backend: ["YANO_BACKEND_PORT", "BACKEND_PORT", "API_PORT", "PORT"],
};

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function validUrl(value) {
	if (!value) return null;
	try { const url = new URL(String(value)); return ["http:", "https:"].includes(url.protocol) ? url.toString().replace(/\/$/, "") : null; } catch { return null; }
}
function firstValue(env, keys) { return keys.map((key) => env[key]).find((value) => String(value || "").trim()) || null; }

function readProjectEnv(root) {
	const values = {};
	for (const filename of [".env", ".env.local", ".env.development", ".env.development.local"]) {
		try {
			for (const line of fs.readFileSync(path.join(root, filename), "utf8").split(/\r?\n/)) {
				const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
				if (!match || match[2].startsWith("#")) continue;
				values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
			}
		} catch { /* an env file is optional */ }
	}
	return values;
}

function canonicalProjectRoot(root) {
	const absoluteRoot = path.resolve(root);
	try {
		const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: absoluteRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : absoluteRoot;
	} catch { return absoluteRoot; }
}

function projectRoots(root) {
	const mainRoot = canonicalProjectRoot(root);
	const roots = [mainRoot];
	const worktrees = path.join(mainRoot, ".worktrees");
	try {
		for (const entry of fs.readdirSync(worktrees, { withFileTypes: true })) {
			if (entry.isDirectory()) roots.push(path.join(worktrees, entry.name));
		}
	} catch { /* worktrees are optional */ }
	return roots;
}

function projectComponent(root, kind) {
	function has(relative) { return fs.existsSync(path.join(root, relative)); }
	if (kind === "backend") return has("app/main.py") || has("src/server.ts") || has("src/server.js") || has("server.js") || has("pyproject.toml");
	return has("app/gui/streamlit_app.py") || has("frontend") || has("src/App.tsx") || has("src/App.jsx") || has("src/app") || has("vite.config.ts") || has("vite.config.js") || has("next.config.js") || has("next.config.mjs") || has("next.config.ts");
}

function inferredUrl(root, kind) {
	if (kind === "backend" && projectComponent(root, kind)) {
		if (fs.existsSync(path.join(root, "app", "main.py"))) return "http://localhost:8000";
	}
	if (kind === "frontend" && projectComponent(root, kind)) {
		if (fs.existsSync(path.join(root, "app", "gui", "streamlit_app.py"))) return "http://localhost:8501";
		if (fs.existsSync(path.join(root, "vite.config.ts")) || fs.existsSync(path.join(root, "vite.config.js"))) return "http://localhost:5173";
		if (fs.existsSync(path.join(root, "next.config.js")) || fs.existsSync(path.join(root, "next.config.mjs")) || fs.existsSync(path.join(root, "next.config.ts"))) return "http://localhost:3000";
		// projectComponent()'s remaining frontend signals (a "frontend" directory,
		// src/App.tsx|jsx, src/app) say only "this looks like a frontend",
		// never which dev server or port — Angular (4200), Create React App
		// (3000, but only by historical convention, not this codebase's own
		// rule), a custom Express static server, anything. Guessing 3000 here
		// used to always "work" in the sense of always showing a light, but the
		// light was frequently wrong: green from an unrelated process that
		// happens to own port 3000, or red for a server that is actually up on
		// its own different port. No real signal beats no light at all.
	}
	return null;
}

export function discoverServerEndpoints(root, env = process.env) {
	const roots = projectRoots(root);
	const effectiveEnv = { ...readProjectEnv(roots[0]), ...env };
	const result = {};
	for (const kind of ["frontend", "backend"]) {
		const capabilities = readCapabilities(roots[0]);
		const declared = capabilities?.components?.[kind];
		if (declared && declared.present === false) continue;
		if (declared?.present === true) {
			const declaredUrl = validUrl(declared.url || declared.health_url);
			if (declaredUrl) { result[kind] = { url: declaredUrl, source: "capabilities" }; continue; }
		}
		const configuredEnvUrl = validUrl(firstValue(effectiveEnv, URL_KEYS[kind]));
		const configuredEnvPort = firstValue(effectiveEnv, PORT_KEYS[kind]);
		const envUrl = configuredEnvUrl || (configuredEnvPort ? `http://localhost:${Number(configuredEnvPort)}` : null);
		const componentDetected = roots.some((projectRoot) => projectComponent(projectRoot, kind));
		for (const projectRoot of roots) {
			const config = readJson(path.join(projectRoot, CONFIG_PATH)) || {};
			const configuredUrl = validUrl(kind === "frontend" ? config.frontend_url : config.backend_url);
			const configuredPort = kind === "frontend" ? config.frontend_port : config.backend_port;
			const url = configuredUrl || (configuredPort ? `http://localhost:${Number(configuredPort)}` : null) || (componentDetected ? envUrl : null) || inferredUrl(projectRoot, kind);
			if (url) { result[kind] = { url }; break; }
		}
		if (!result[kind] && envUrl && (componentDetected || configuredEnvUrl)) result[kind] = { url: envUrl };
	}
	return result;
}

// 800ms (the original default) mislabeled a genuinely running dev server as
// "stopped" on its very first probe after startup or after a file change:
// Vite/Next/CRA all compile-on-first-request, and that alone routinely takes
// longer than 800ms, so the request aborts, is caught below, and reports
// "stopped" for a server that is actually up — exactly a false red/muted
// light. 2500ms still comfortably fits the footer's 5s refresh cadence
// (extensions/orchestrator.ts's serverStatusTimer) for both probes running
// in parallel, while giving a cold compile a realistic chance to answer.
export async function probeServer(url, timeoutMs = 2500, fetchImpl = globalThis.fetch) {
	if (!url || typeof fetchImpl !== "function") return "stopped";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, { method: "GET", signal: controller.signal, redirect: "manual" });
		const status = Number(response?.status || 200);
		return status >= 500 ? "error" : "running";
	} catch { return "stopped"; }
	finally { clearTimeout(timer); }
}

export async function discoverAndProbeServers(root, env = process.env, timeoutMs = 2500, fetchImpl = globalThis.fetch) {
	const endpoints = discoverServerEndpoints(root, env);
	const entries = await Promise.all(Object.entries(endpoints).map(async ([kind, endpoint]) => {
		const state = await probeServer(endpoint.url, timeoutMs, fetchImpl);
		return [kind, { ...endpoint, state, running: state === "running" }];
	}));
	return Object.fromEntries(entries);
}
