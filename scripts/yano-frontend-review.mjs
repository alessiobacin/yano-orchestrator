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

export function inferFrontendDev(root) {
	const pkg = readPackage(root);
	const scripts = pkg.scripts || {};
	const script = ["dev", "start", "serve"].find((name) => typeof scripts[name] === "string");
	if (!script) throw new Error("nessuno script frontend dev trovato (attesi scripts.dev, scripts.start o scripts.serve)");
	const raw = scripts[script];
	const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
	const isReact = Boolean(dependencies.react) || /react|next/i.test(raw) || fs.existsSync(path.join(root, "src", "App.jsx")) || fs.existsSync(path.join(root, "src", "App.tsx"));
	const portMatch = raw.match(/(?:--|\s)(?:port|p)[=\s]+(\d{2,5})/i);
	const frameworkPort = /angular/i.test(raw) || fs.existsSync(path.join(root, "angular.json")) ? 4200
		: /next/i.test(raw) ? 3000
		: /react-scripts/i.test(raw) ? 3000
		: 5173;
	const port = Number(portMatch?.[1] || process.env.YANO_FRONTEND_PORT || frameworkPort);
	const manager = fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm"
		: fs.existsSync(path.join(root, "yarn.lock")) ? "yarn"
		: fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock")) ? "bun" : "npm";
	return { script, raw, manager, port, url: `http://localhost:${port}`, framework: isReact ? "react" : "unknown", agentation_supported: isReact };
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

function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} è terminato con exit ${code}`)));
	});
}

export async function setup(root) {
	const info = inferFrontendDev(root);
	if (!info.agentation_supported) throw new Error("Agentation ufficiale richiede React 18+; framework non riconosciuto, nessuna modifica applicata");
	const alreadyInstalled = Boolean(({ ...(readPackage(root).dependencies || {}), ...(readPackage(root).devDependencies || {}) }).agentation);
	const install = info.manager === "npm" ? ["install", "-D", "agentation"]
		: info.manager === "pnpm" ? ["add", "-D", "agentation"]
		: info.manager === "yarn" ? ["add", "-D", "agentation"] : ["add", "-d", "agentation"];
	if (!alreadyInstalled) await run(info.manager, install, root);
	return { ...info, package: "agentation", installed: true, package_changed: !alreadyInstalled, component_imported: hasAgentationImport(root), next: hasAgentationImport(root) ? "planner può avviare la review MCP" : "planner deve delegare al frontend-developer l'import/mount di Agentation nel layout/root con NODE_ENV development e endpoint http://localhost:4747" };
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
	const child = spawn(info.manager, ["run", info.script], { cwd: root, detached: true, stdio: "ignore", shell: process.platform === "win32" });
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
