#!/usr/bin/env node

// Project-scoped Agentation helper. It deliberately does not edit application
// source: the frontend developer must mount the component in the real layout.
// This keeps framework-specific source changes inside the normal reviewed
// worktree flow while making package install and dev-server discovery
// deterministic for the planner.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { projectKey, resolveTraceProject } from "./yano-trace-storage.mjs";

const usage = () => console.log([
	"Uso: yano frontend-review <setup|start|url>",
	"  setup  installa agentation come devDependency e stampa il contratto di integrazione",
	"  start  esegue setup, avvia lo script dev inferito e stampa l'URL rilevato",
	"  url    inferisce soltanto comando e URL probabile, senza avviare processi",
].join("\n"));

function readPackage(root) {
	try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
	catch { throw new Error(`package.json non trovato o non valido in ${root}`); }
}

function hasDevScript(root) {
	try {
		const scripts = readPackage(root).scripts || {};
		return ["dev", "start", "serve"].some((name) => typeof scripts[name] === "string");
	} catch { return false; }
}

export function resolveFrontendRoots(root) {
	const requestedRoot = path.resolve(root);
	if (hasDevScript(requestedRoot)) {
		const parent = path.dirname(requestedRoot);
		const nestedName = path.basename(requestedRoot).toLowerCase();
		if (["webapp", "client", "frontend"].includes(nestedName) && fs.existsSync(path.join(parent, "package.json"))) {
			return { projectRoot: parent, frontendRoot: requestedRoot };
		}
		return { projectRoot: requestedRoot, frontendRoot: requestedRoot };
	}
	for (const directory of ["webapp", "client", "frontend"]) {
		const frontendRoot = path.join(requestedRoot, directory);
		if (hasDevScript(frontendRoot)) return { projectRoot: requestedRoot, frontendRoot };
	}
	throw new Error("nessuno script frontend dev trovato (cercati scripts.dev, scripts.start o scripts.serve nella directory corrente e nei sotto-progetti webapp/client/frontend)");
}

export function inferFrontendDev(root) {
	const roots = resolveFrontendRoots(root);
	const frontendRoot = roots.frontendRoot;
	const pkg = readPackage(frontendRoot);
	const scripts = pkg.scripts || {};
	const script = ["dev", "start", "serve"].find((name) => typeof scripts[name] === "string");
	if (!script) throw new Error("nessuno script frontend dev trovato (attesi scripts.dev, scripts.start o scripts.serve)");
	const raw = scripts[script];
	const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
	const isAngular = Boolean(dependencies["@angular/core"]) || /(?:^|\s)ng(?:\s|$)|angular/i.test(raw) || fs.existsSync(path.join(frontendRoot, "angular.json"));
	const isReact = !isAngular && (Boolean(dependencies.react) || /react|next/i.test(raw) || fs.existsSync(path.join(frontendRoot, "src", "App.jsx")) || fs.existsSync(path.join(frontendRoot, "src", "App.tsx")));
	const framework = isReact ? "react" : isAngular ? "angular" : "unknown";
	const portMatch = raw.match(/(?:--|\s)(?:port|p)[=\s]+(\d{2,5})/i);
	const frameworkPort = isAngular ? 4200
		: /next/i.test(raw) ? 3000
		: /react-scripts/i.test(raw) ? 3000
		: 5173;
	const port = Number(portMatch?.[1] || process.env.YANO_FRONTEND_PORT || frameworkPort);
	const managerRoot = roots.projectRoot === frontendRoot ? frontendRoot : (fs.existsSync(path.join(frontendRoot, "package-lock.json")) ? frontendRoot : roots.projectRoot);
	const manager = fs.existsSync(path.join(managerRoot, "pnpm-lock.yaml")) ? "pnpm"
		: fs.existsSync(path.join(managerRoot, "yarn.lock")) ? "yarn"
		: fs.existsSync(path.join(managerRoot, "bun.lockb")) || fs.existsSync(path.join(managerRoot, "bun.lock")) ? "bun" : "npm";
	return { script, raw, manager, port, url: `http://localhost:${port}`, framework, agentation_supported: isReact, review_mode: isReact ? "agentation" : isAngular ? "browser-only" : "unsupported", project_root: roots.projectRoot, frontend_root: frontendRoot };
}

function hasAgentationImport(root) {
	const candidates = ["src", "app", "pages", "components"].map((dir) => path.join(root, dir));
	const files = [];
	const visit = (current) => {
		if (!fs.existsSync(current)) return;
		const stat = fs.statSync(current);
		if (stat.isDirectory()) for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
		else if (/\.(jsx?|tsx?)$/.test(current)) files.push(current);
	};
	for (const candidate of candidates) visit(candidate);
	return files.some((file) => /from\s+["']agentation["']|require\(["']agentation["']\)/.test(fs.readFileSync(file, "utf8")));
}

function injectAgentationWebhook(root, projectRoot) {
	const projectId = projectKey(projectRoot, resolveTraceProject(projectRoot));
	const webhookUrl = `http://127.0.0.1:11000/api/agentation/${projectId}`;
	const candidates = [];
	const visit = (current) => {
		if (!fs.existsSync(current)) return;
		const stat = fs.statSync(current);
		if (stat.isDirectory()) { for (const entry of fs.readdirSync(current)) visit(path.join(current, entry)); return; }
		if (/\.(jsx?|tsx?)$/.test(current)) candidates.push(current);
	};
	visit(path.join(root, "src"));
	for (const file of candidates) {
		const source = fs.readFileSync(file, "utf8");
		if (!/\bAgentation\b/.test(source) || /<Agentation\b[^>]*\bwebhookUrl=/.test(source)) continue;
		const updated = source.replace(/<Agentation\b/, `<Agentation webhookUrl="${webhookUrl}"`);
		if (updated !== source) { fs.writeFileSync(file, updated); return { file, webhook_url: webhookUrl, injected: true }; }
	}
	return { webhook_url: webhookUrl, injected: false };
}

function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} è terminato con exit ${code}`)));
	});
}

const ANGULAR_AGENTATION_MARKER = "/* yano-agentation:angular-dev-only */";

const angularAgentationHost = `${ANGULAR_AGENTATION_MARKER}
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Agentation, type AgentationProps } from "agentation";

const HOST_ID = "yano-agentation-dev";
const FEEDBACK_URL = "http://127.0.0.1:11000/api/agentation/__YANO_PROJECT_ID__";

function reportAnnotation(annotation) {
	return fetch(FEEDBACK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ annotation, page_url: window.location.href, created_by: "agentation" }) }).catch(() => undefined);
}

export function mountAgentation() {
	if (document.getElementById(HOST_ID)) return;
	const host = document.createElement("div");
	host.id = HOST_ID;
	document.body.appendChild(host);
	// Agentation is a React component: render it through React so its hooks run
	// inside a render tree. It is loaded only after Angular bootstraps in dev.
	createRoot(host).render(
		createElement<AgentationProps>(Agentation, { endpoint: "http://localhost:4747", onAnnotationAdd: reportAnnotation }),
	);
}
`;

export function ensureAngularAgentationIntegration(frontendRoot) {
	const mainFile = ["src/main.ts", "src/main.tsx"].map((file) => path.join(frontendRoot, file)).find((file) => fs.existsSync(file));
	if (!mainFile) throw new Error(`entry Angular non trovato in ${frontendRoot} (atteso src/main.ts)`);
	const hostFile = path.join(path.dirname(mainFile), "yano-agentation-host.ts");
	const existingHost = fs.existsSync(hostFile) ? fs.readFileSync(hostFile, "utf8") : "";
	// Repair files generated by older Yano versions as well as creating new ones.
	if (!existingHost || (existingHost.includes(ANGULAR_AGENTATION_MARKER) && !existingHost.includes("createElement<AgentationProps>"))) {
		const projectRoot = path.dirname(frontendRoot);
		fs.writeFileSync(hostFile, angularAgentationHost.replaceAll("__YANO_PROJECT_ID__", projectKey(projectRoot, resolveTraceProject(projectRoot))));
	}
	let main = fs.readFileSync(mainFile, "utf8");
	if (!main.includes(ANGULAR_AGENTATION_MARKER)) {
		const importLine = "import { isDevMode } from '@angular/core';\n";
		if (!main.includes("import { isDevMode }") && !main.includes("import * as AngularCore")) main = `${importLine}${main}`;
		const bootstrap = /platformBrowserDynamic\(\)\.bootstrapModule\(AppModule\)\s*\.catch\(err => console\.error\(err\)\);/;
		if (!bootstrap.test(main)) throw new Error(`bootstrap Angular non riconosciuto in ${mainFile}`);
		main = main.replace(bootstrap, `platformBrowserDynamic().bootstrapModule(AppModule)\n  .then(() => {\n    if (isDevMode()) return import('./yano-agentation-host').then(({ mountAgentation }) => mountAgentation());\n    return undefined;\n  })\n  .catch(err => console.error(err));\n\n${ANGULAR_AGENTATION_MARKER}`);
		fs.writeFileSync(mainFile, main);
	}
	return { main_file: mainFile, host_file: hostFile, injected: true, dev_only: true };
}

async function setupAngularAgentation(info) {
	const dependencies = ["agentation", "react", "react-dom", "@types/react", "@types/react-dom"];
	const pkg = readPackage(info.frontend_root);
	const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
	const missing = dependencies.filter((dependency) => !declared[dependency]);
	if (missing.length) {
		const install = info.manager === "npm" ? ["install", "-D", ...missing]
			: info.manager === "pnpm" ? ["add", "-D", ...missing]
			: info.manager === "yarn" ? ["add", "-D", ...missing]
			: ["add", "-d", ...missing];
		await run(info.manager, install, info.frontend_root);
	}
	const integration = ensureAngularAgentationIntegration(info.frontend_root);
	return { ...info, agentation_supported: true, review_mode: "agentation", package: "agentation + React adapter", installed: true, package_changed: missing.length > 0, component_imported: true, integration, next: "Agentation è attiva solo in development; apri l'URL restituito e verifica il toolbar in basso a destra" };
}

export async function setup(root) {
	const info = inferFrontendDev(root);
	const frontendRoot = info.frontend_root;
	if (info.framework === "angular") {
		return setupAngularAgentation(info);
	}
	if (!info.agentation_supported) throw new Error("framework frontend non riconosciuto; nessuna modifica applicata");
	const alreadyInstalled = Boolean(({ ...(readPackage(frontendRoot).dependencies || {}), ...(readPackage(frontendRoot).devDependencies || {}) }).agentation);
	const install = info.manager === "npm" ? ["install", "-D", "agentation"]
		: info.manager === "pnpm" ? ["add", "-D", "agentation"]
		: info.manager === "yarn" ? ["add", "-D", "agentation"] : ["add", "-d", "agentation"];
	if (!alreadyInstalled) await run(info.manager, install, frontendRoot);
	const componentImported = hasAgentationImport(frontendRoot);
	const integration = componentImported ? injectAgentationWebhook(frontendRoot, info.project_root) : null;
	return { ...info, package: "agentation", installed: true, package_changed: !alreadyInstalled, component_imported: componentImported, integration, next: componentImported && integration?.injected ? "Agentation invia automaticamente ogni annotation al registro bug Yano; planner può avviare la review MCP" : "planner deve delegare al frontend-developer l'import/mount di Agentation nel layout/root con NODE_ENV development e webhook Yano" };
}

function waitForPort(host, port, timeoutMs = 30_000) {
	return new Promise((resolve) => {
		const started = Date.now();
		const probe = () => {
			const socket = net.connect({ host, port });
			const done = (ok) => { socket.destroy(); if (ok || Date.now() - started >= timeoutMs) resolve(ok); else setTimeout(probe, 250); };
			socket.once("connect", () => done(true)); socket.once("error", () => done(false)); socket.setTimeout(500, () => done(false));
		};
		probe();
	});
}

async function start(root) {
	const info = await setup(root);
	const child = spawn(info.manager, ["run", info.script], { cwd: info.frontend_root, detached: true, stdio: "ignore", shell: process.platform === "win32" });
	child.unref();
	const reachable = await waitForPort("127.0.0.1", info.port);
	if (!reachable) throw new Error(`frontend dev non raggiungibile su ${info.url} entro 30 secondi`);
	const stateDir = path.join(root, ".yano"); fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(path.join(stateDir, "agentation-dev.json"), `${JSON.stringify({ ...info, pid: child.pid, started_at: new Date().toISOString() }, null, 2)}\n`);
	return { ...info, pid: child.pid, reachable };
}

export async function runFrontendReview({ cwd = process.cwd(), argv = [] } = {}) {
	const command = argv[0];
	if (!command || command === "--help" || command === "-h") { usage(); return; }
	const rootIndex = argv.indexOf("--project-root"); const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : cwd;
	let result;
	if (command === "url") result = inferFrontendDev(root);
	else if (command === "setup") result = await setup(root);
	else if (command === "start") result = await start(root);
	else throw new Error(`sottocomando frontend-review sconosciuto: ${command}`);
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) runFrontendReview({ argv: process.argv.slice(2) }).catch((error) => { console.error(`frontend-review: ${error.message}`); process.exitCode = 1; });
