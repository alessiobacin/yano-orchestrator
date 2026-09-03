import fs from "node:fs";
import path from "node:path";
import { memoryPaths, MEMORY_LIMITS } from "./yano-agent-memory.mjs";

function value(argv, flag) { const index = argv.indexOf(flag); return index < 0 ? null : argv[index + 1] || null; }
function required(argv, flag) { const result = value(argv, flag); if (!result) throw new Error(`yano memory: ${flag} è obbligatorio`); return result; }
function rootOf(argv, cwd = process.cwd()) { return path.resolve(value(argv, "--project-root") || cwd); }
function jsonMode(argv) { return argv.includes("--json"); }
function print(valueToPrint, argv) { console.log(jsonMode(argv) ? JSON.stringify(valueToPrint, null, 2) : typeof valueToPrint === "string" ? valueToPrint : JSON.stringify(valueToPrint, null, 2)); return valueToPrint; }
function ensureParent(file) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); }
function readText(argv) {
	const file = value(argv, "--file");
	if (file) return fs.readFileSync(path.resolve(file), "utf8");
	return value(argv, "--text") || "";
}
function resolveMemory(argv, cwd) {
	const root = rootOf(argv, cwd);
	const role = value(argv, "--role") || value(argv, "--agent-role") || "unknown";
	const instance = value(argv, "--instance") || value(argv, "--agent");
	const paths = memoryPaths({ root, role, instance: instance || role });
	const scope = value(argv, "--scope") || (instance ? "instance" : role !== "unknown" ? "role" : "project");
	const file = scope === "project" ? paths.project : scope === "preferences" ? paths.preferences : scope === "instance" ? paths.instance : paths.role;
	return { root, role, instance, scope, file, paths };
}
function listFiles(root) {
	const base = path.join(root, ".pi", "extensions", "yano-orchestrator", "memory");
	const result = [{ id: "project", type: "project", file: path.join(base, "project.md"), exists: fs.existsSync(path.join(base, "project.md")) }, { id: "user-preferences", type: "preferences", file: path.join(base, "user-preferences.md"), exists: fs.existsSync(path.join(base, "user-preferences.md")) }];
	for (const [type, folder] of [["role", "roles"], ["instance", "instances"]]) {
		try { for (const name of fs.readdirSync(path.join(base, folder)).filter((item) => item.endsWith(".md"))) result.push({ id: name.slice(0, -3), type, file: path.join(base, folder, name), exists: true }); } catch { /* empty catalog */ }
	}
	return result;
}

export function runYanoMemory({ argv = [], cwd = process.cwd() } = {}) {
	const [sub = "list"] = argv;
	if (sub === "--help" || sub === "-h") return print("Uso: yano memory <agents|list|show|create|update|delete> [--project-root <dir>] [--scope project|role|preferences|instance]", argv);
	if (sub === "agents") {
		const agents = listFiles(rootOf(argv, cwd)).filter((item) => item.type === "role" || item.type === "instance");
		return print(agents, argv);
	}
	if (!["list", "show", "create", "update", "delete", "remove"].includes(sub)) throw new Error(`yano memory: comando sconosciuto ${sub}`);
	if (sub === "list") return print(listFiles(rootOf(argv, cwd)), argv);
	const target = resolveMemory(argv, cwd);
	if (sub === "show") {
		if (!fs.existsSync(target.file)) throw new Error(`memoria non trovata: ${target.file}`);
		return print({ ...target, content: fs.readFileSync(target.file, "utf8") }, argv);
	}
	if (sub === "delete" || sub === "remove") {
		if (fs.existsSync(target.file)) fs.unlinkSync(target.file);
		return print({ deleted: target.file }, argv);
	}
	const text = readText(argv);
	if (!text) throw new Error("yano memory: --text o --file è obbligatorio");
	if (sub === "create" && fs.existsSync(target.file)) throw new Error(`memoria già esistente: ${target.file}; usa update`);
	ensureParent(target.file);
	const limit = MEMORY_LIMITS[target.scope] || (target.scope === "preferences" ? MEMORY_LIMITS.preferences : MEMORY_LIMITS.role);
	const bounded = text.length > limit ? text.slice(0, limit) : text;
	fs.writeFileSync(target.file, bounded, { mode: 0o600 });
	return print({ updated: target.file, scope: target.scope, chars: bounded.length, truncated: bounded.length !== text.length }, argv);
}

if (process.argv[1]?.endsWith("yano-memory-cli.mjs")) {
	try { runYanoMemory({ argv: process.argv.slice(2) }); } catch (error) { console.error(`yano memory: ${error.message}`); process.exitCode = 1; }
}
