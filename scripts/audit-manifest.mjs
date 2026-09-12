#!/usr/bin/env node

// Deterministic project discovery for audit campaigns. This script deliberately
// does not ask an LLM to rediscover the same repository facts for every chapter.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IGNORED_DIRS = new Set([".git", "node_modules", ".lavish", ".scratch", ".cache", "coverage", "dist", "build"]);
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php", ".yaml", ".yml", ".json", ".md", ".css", ".html", ".sh"]);
const MAX_FILES = 4000;
const MAX_HASH_BYTES = 2_000_000;

function argValue(argv, flag, fallback = null) {
	const index = argv.indexOf(flag);
	return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function hasArg(argv, flag) { return argv.includes(flag); }

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function readYaml(file) {
	try { return parseYaml(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function walk(root) {
	const result = [];
	function visit(relative) {
		if (result.length >= MAX_FILES) return;
		const absolute = path.join(root, relative);
		let entries;
		try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch { return; }
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (result.length >= MAX_FILES) return;
			if (entry.name.startsWith(".") && entry.name !== ".mcp.json") continue;
			const next = path.join(relative, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) visit(next);
				continue;
			}
			if (entry.isFile()) result.push(next);
		}
	}
	visit("");
	return result;
}

function fileRecord(root, relative) {
	const absolute = path.join(root, relative);
	try {
		const stat = fs.statSync(absolute);
		const extension = path.extname(relative).toLowerCase();
		const record = { path: relative, bytes: stat.size, lines: null, extension, sha256: null };
		if (stat.size <= MAX_HASH_BYTES) {
			const content = fs.readFileSync(absolute);
			record.sha256 = crypto.createHash("sha256").update(content).digest("hex");
			if (CODE_EXTENSIONS.has(extension) || path.basename(relative) === "Dockerfile") {
				record.lines = content.toString("utf8").split(/\r?\n/).length;
			}
		}
		return record;
	} catch (error) {
		return { path: relative, unreadable: true, error: error instanceof Error ? error.message : String(error) };
	}
}

function packageInventory(root) {
	const pkg = readJson(path.join(root, "package.json"));
	if (!pkg) return { present: false, scripts: {}, dependencies: [], dev_dependencies: [], bins: {} };
	return {
		present: true,
		name: pkg.name ?? null,
		version: pkg.version ?? null,
		scripts: pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {},
		dependencies: Object.keys(pkg.dependencies ?? {}).sort(),
		dev_dependencies: Object.keys(pkg.devDependencies ?? {}).sort(),
		bins: typeof pkg.bin === "string" ? { [pkg.name ?? "default"]: pkg.bin } : (pkg.bin ?? {}),
		engines: pkg.engines ?? {},
	};
}

function yamlInventory(root) {
	const files = ["agents/roles.yaml", "agents/agents.yaml", "agents/capabilities.yaml"];
	const playbookDir = path.join(root, "playbooks");
	let playbooks = [];
	try {
		playbooks = fs.readdirSync(playbookDir).filter((file) => file.endsWith(".yaml")).sort().map((file) => {
			const value = readYaml(path.join(playbookDir, file));
			return { file: path.join("playbooks", file), id: value?.id ?? path.basename(file, ".yaml"), label: value?.label ?? null, intents: value?.catalog?.intents ?? [], variants: value?.catalog?.parameters?.includes("variant") ?? false };
		});
	} catch { /* project may not use Yano playbooks */ }
	const config = Object.fromEntries(files.map((file) => {
		const value = readYaml(path.join(root, file));
		return [file, value ? { schema_version: value.schema_version ?? null, keys: Object.keys(value) } : { present: false }];
	}));
	const roles = readYaml(path.join(root, "agents/roles.yaml"));
	const capabilities = readYaml(path.join(root, "agents/capabilities.yaml"));
	return {
		config,
		role_ids: Object.keys(roles?.roles ?? {}).sort(),
		known_mcp_capabilities: Object.keys(capabilities?.mcp_capabilities ?? {}).sort(),
		playbooks,
	};
}

function mcpInventory(root) {
	for (const file of [".mcp.json", ".mcp.json.example", ".cursor/mcp.json"]) {
		const value = readJson(path.join(root, file));
		if (value) return { source: file, servers: Object.keys(value.mcpServers ?? value.servers ?? {}).sort(), config_keys: Object.keys(value) };
	}
	return { source: null, servers: [], config_keys: [] };
}

function classifyFiles(files) {
	const counts = {};
	for (const file of files) {
		const ext = file.extension || "[none]";
		counts[ext] = (counts[ext] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function markdown(manifest) {
	const pkg = manifest.package;
	return [
		`# Audit manifest — ${manifest.project.name}`,
		``,
		`- Root: \`${manifest.project.root}\``,
		`- Generated: ${manifest.generated_at}`,
		`- Files indexed: ${manifest.inventory.file_count}${manifest.inventory.truncated ? " (truncated)" : ""}`,
		`- Package: ${pkg.present ? `${pkg.name ?? "?"} ${pkg.version ?? "?"}` : "not detected"}`,
		``,
		`## Deterministic inventory`,
		``,
		`- Extensions: \`${JSON.stringify(manifest.inventory.extension_counts)}\``,
		`- Package scripts: ${Object.keys(pkg.scripts).sort().map((name) => `\`${name}\``).join(", ") || "none"}`,
		`- Playbooks: ${manifest.yano.playbooks.map((item) => item.id).join(", ") || "none"}`,
		`- MCP servers declared: ${manifest.mcp.servers.join(", ") || "none"}`,
		``,
		`## Evidence boundary`,
		``,
		`This file is a deterministic inventory. It does not claim that a command or feature works; functional, product and semantic conclusions belong to the relevant audit chapters.`,
		``,
	].join("\n");
}

function main() {
	const argv = process.argv.slice(2);
	const projectRoot = path.resolve(argValue(argv, "--project-root", scriptRoot));
	if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new Error(`project root non valido: ${projectRoot}`);
	const files = walk(projectRoot).map((relative) => fileRecord(projectRoot, relative));
	const manifest = {
		schema_version: 1,
		kind: "yano-audit-manifest",
		generated_at: new Date().toISOString(),
		project: { root: projectRoot, name: path.basename(projectRoot), git_head: null, git_branch: null },
		inventory: { file_count: files.length, truncated: files.length >= MAX_FILES, extension_counts: classifyFiles(files), files },
		package: packageInventory(projectRoot),
		yano: yamlInventory(projectRoot),
		mcp: mcpInventory(projectRoot),
		boundaries: { ignored_directories: [...IGNORED_DIRS].sort(), max_files: MAX_FILES, max_hash_bytes: MAX_HASH_BYTES },
	};
	try { manifest.project.git_head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* not a git checkout */ }
	try { manifest.project.git_branch = execFileSync("git", ["branch", "--show-current"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* detached or not git */ }
	const output = JSON.stringify(manifest, null, hasArg(argv, "--compact") ? 0 : 2);
	const outputFile = argValue(argv, "--output");
	if (outputFile) fs.writeFileSync(path.resolve(outputFile), `${output}\n`, { mode: 0o600 });
	const markdownFile = argValue(argv, "--markdown-output");
	if (markdownFile) fs.writeFileSync(path.resolve(markdownFile), markdown(manifest), { mode: 0o600 });
	process.stdout.write(`${output}\n`);
}

try { main(); } catch (error) { console.error(`audit-manifest: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
