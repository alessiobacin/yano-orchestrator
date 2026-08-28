#!/usr/bin/env node

// Installs the shared Yano CLI skill in the harnesses that are actually
// available on this machine.  The important invariant is that one harness
// gets one discoverable copy: Pi may discover configured skill directories
// belonging to another harness, so blindly copying into every directory can
// make Pi load the same frontmatter more than once and report a conflict.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { globalDataPath } from "./yano-config.mjs";

export const YANO_CLI_SKILL_NAME = "yano-cli";
export const LEGACY_YANO_CLI_SKILL_NAMES = ["yano-cli-skill"];
const MANAGED_FILE = ".yano-managed.json";
const MANAGED_BY = "yano-orchestrator";

function expandHome(value, home) {
	const text = String(value ?? "").trim();
	if (!text) return null;
	if (text === "~") return home;
	if (text.startsWith(`~${path.sep}`) || text.startsWith("~/")) return path.join(home, text.slice(2));
	return path.resolve(text);
}

function commandAvailable(command, platform = process.platform) {
	try {
		const result = spawnSync(command, ["--version"], {
			stdio: "ignore",
			shell: platform === "win32",
			timeout: 3_000,
		});
		return !result.error || result.error.code !== "ENOENT";
	} catch {
		return false;
	}
}

function configuredBoolean(map, key, fallback) {
	return Object.hasOwn(map ?? {}, key) ? Boolean(map[key]) : fallback;
}

function resolveHarnessPaths({ home = os.homedir(), env = process.env } = {}) {
	const homeDir = path.resolve(home);
	const claudeHome = expandHome(env.CLAUDE_CONFIG_DIR, homeDir) || path.join(homeDir, ".claude");
	const codexHome = expandHome(env.CODEX_HOME, homeDir) || path.join(homeDir, ".codex");
	const piHome = expandHome(env.PI_CODING_AGENT_DIR, homeDir) || path.join(homeDir, ".pi", "agent");
	return {
		claude: { id: "claude", command: "claude", configDir: claudeHome, skillsDir: path.join(claudeHome, "skills") },
		codex: { id: "codex", command: "codex", configDir: codexHome, skillsDir: path.join(codexHome, "skills") },
		pi: { id: "pi", command: "pi", configDir: piHome, skillsDir: path.join(piHome, "skills") },
	};
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function samePath(left, right) {
	if (!left || !right) return false;
	const resolve = (value) => {
		const absolute = path.resolve(value);
		try { return fs.realpathSync(absolute); } catch { return absolute; }
	};
	return resolve(left) === resolve(right);
}

function piConfiguredSkillRoots({ pi, home }) {
	const roots = [pi.skillsDir];
	const settings = readJson(path.join(pi.configDir, "settings.json"));
	for (const value of Array.isArray(settings?.skills) ? settings.skills : []) {
		if (typeof value !== "string" || !value.trim()) continue;
		// Pi settings can also contain package sources such as npm:foo. They
		// are not filesystem discovery roots and must not become directories.
		if (/^(npm:|https?:|git@|github:)/i.test(value.trim())) continue;
		const resolved = expandHome(value, home);
		if (!resolved) continue;
		const candidate = path.basename(resolved) === "SKILL.md" ? path.dirname(resolved) : resolved;
		if (!roots.some((root) => samePath(root, candidate))) roots.push(candidate);
	}
	return roots;
}

function skillPackageRoot(packageRoot) {
	return path.join(packageRoot, "skills-vendor", "yano", YANO_CLI_SKILL_NAME);
}

function packageVersion(packageRoot) {
	try { return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version || "unknown"; }
	catch { return "unknown"; }
}

function walkFiles(root) {
	if (!fs.existsSync(root)) return [];
	const output = [];
	function visit(current, relative = "") {
		for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === MANAGED_FILE) continue;
			const absolute = path.join(current, entry.name);
			const next = relative ? path.join(relative, entry.name) : entry.name;
			if (entry.isDirectory()) visit(absolute, next);
			else if (entry.isFile()) output.push(next);
			else output.push(next);
		}
	}
	visit(root);
	return output;
}

function fileHash(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fileHashes(root) {
	const hashes = {};
	for (const relative of walkFiles(root)) hashes[relative] = fileHash(path.join(root, relative));
	return hashes;
}

function readMarker(root) {
	const marker = readJson(path.join(root, MANAGED_FILE));
	return marker?.managed_by === MANAGED_BY && marker.skill === YANO_CLI_SKILL_NAME ? marker : null;
}

function exactSourceMatch(source, target) {
	if (!fs.existsSync(source) || !fs.existsSync(target)) return false;
	const sourceFiles = walkFiles(source);
	const targetFiles = walkFiles(target);
	if (sourceFiles.length !== targetFiles.length || sourceFiles.some((file) => !targetFiles.includes(file))) return false;
	return sourceFiles.every((file) => fileHash(path.join(source, file)) === fileHash(path.join(target, file)));
}

function markerFilesUnchanged(marker, target) {
	if (!marker?.file_hashes || typeof marker.file_hashes !== "object") return true;
	const current = fileHashes(target);
	return Object.entries(marker.file_hashes).every(([relative, hash]) => current[relative] === hash);
}

function targetClassification({ source, target, allowModifiedManaged = false }) {
	if (!fs.existsSync(target)) return { state: "missing", safe: true };
	if (fs.lstatSync(target).isSymbolicLink()) return { state: "symlink-conflict", safe: false };
	if (!fs.statSync(target).isDirectory()) return { state: "file-conflict", safe: false };
	const marker = readMarker(target);
	if (marker) {
		const unchanged = markerFilesUnchanged(marker, target);
		return {
			state: unchanged || allowModifiedManaged ? "managed" : "managed-local-changes",
			safe: unchanged || allowModifiedManaged,
			marker,
		};
	}
	if (exactSourceMatch(source, target)) return { state: "adoptable-identical", safe: true };
	return { state: "unmanaged-conflict", safe: false };
}

function atomicWriteJson(file, value, mode = 0o600) {
	const temporary = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
	fs.chmodSync(temporary, mode);
	fs.renameSync(temporary, file);
}

function copySkill(source, target, version) {
	fs.mkdirSync(target, { recursive: true, mode: 0o755 });
	for (const relative of walkFiles(source)) {
		const destination = path.join(target, relative);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(path.join(source, relative), destination);
	}
	atomicWriteJson(path.join(target, MANAGED_FILE), {
		managed_by: MANAGED_BY,
		skill: YANO_CLI_SKILL_NAME,
		source_package_version: version,
		installed_at: new Date().toISOString(),
		file_hashes: fileHashes(source),
	});
}

function harnessAvailability(harness, { platform, commandAvailability }) {
	const command = Object.hasOwn(commandAvailability ?? {}, harness.id)
		? configuredBoolean(commandAvailability, harness.id, false)
		: commandAvailable(harness.command, platform);
	const config = fs.existsSync(harness.configDir);
	return { command, config, available: command || config };
}

export function inspectYanoCliSkill({ packageRoot, home = os.homedir(), env = process.env, platform = process.platform, commandAvailability } = {}) {
	const source = skillPackageRoot(packageRoot);
	const homeDir = path.resolve(home);
	const harnessPaths = resolveHarnessPaths({ home: homeDir, env });
	const harnesses = {};
	for (const [id, harness] of Object.entries(harnessPaths)) {
		harnesses[id] = {
			...harness,
			...harnessAvailability(harness, { platform, commandAvailability }),
		};
	}
	harnesses.pi.discoveryRoots = harnesses.pi.available ? piConfiguredSkillRoots({ pi: harnesses.pi, home: homeDir }) : [];

	const targets = [];
	const addTarget = (harness, reason) => {
		if (!targets.some((item) => samePath(item.path, harness.skillsDir))) targets.push({ harness: harness.id, path: harness.skillsDir, reason });
	};
	if (harnesses.claude.available) addTarget(harnesses.claude, "Claude Code skill catalog");
	if (harnesses.codex.available) addTarget(harnesses.codex, "Codex skill catalog");
	if (harnesses.pi.available) {
		const sharedTarget = targets.find((target) => harnesses.pi.discoveryRoots.some((root) => samePath(root, target.path)));
		if (sharedTarget) sharedTarget.reason += "; condivisa con Pi (Pi la scopre già qui)";
		else addTarget(harnesses.pi, "Pi skill catalog");
	}

	const duplicateRoots = harnesses.pi.discoveryRoots.filter((root) => !targets.some((target) => samePath(target.path, root)));
	const allDiscoveryRoots = [...new Set([
		...Object.values(harnesses).map((harness) => harness.skillsDir),
		...harnesses.pi.discoveryRoots,
	])];
	const legacyPaths = LEGACY_YANO_CLI_SKILL_NAMES.flatMap((name) => allDiscoveryRoots
		.map((root) => path.join(root, name))
		.filter((candidate) => fs.existsSync(candidate)));
	return {
		skill: YANO_CLI_SKILL_NAME,
		source,
		package_version: packageVersion(packageRoot),
		harnesses,
		targets,
		duplicate_roots: duplicateRoots,
		legacy_paths: legacyPaths,
	};
}

function duplicateSafety({ source, duplicate }) {
	return targetClassification({ source, target: duplicate }).safe;
}

function quarantineDuplicate({ duplicate, home, env, platform }) {
	const root = path.join(globalDataPath({ env, platform, home }), "skill-backups", YANO_CLI_SKILL_NAME);
	const suffix = `${Date.now()}-${process.pid}`;
	const destination = path.join(root, `${path.basename(path.dirname(duplicate))}-${suffix}`);
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.renameSync(duplicate, destination);
	return destination;
}

function legacySkillIsRecognized(legacyPath) {
	if (!fs.existsSync(legacyPath) || fs.lstatSync(legacyPath).isSymbolicLink()) return false;
	try {
		const skill = fs.readFileSync(path.join(legacyPath, "SKILL.md"), "utf8");
		return /^name:\s*yano-cli(?:-skill)?\s*$/m.test(skill);
	} catch {
		return false;
	}
}

export function installYanoCliSkill({
	packageRoot,
		home = os.homedir(),
		env = process.env,
		platform = process.platform,
		commandAvailability,
		dryRun = false,
		force = false,
		pruneDuplicates = true,
	} = {}) {
	const source = skillPackageRoot(packageRoot);
	if (!fs.existsSync(path.join(source, "SKILL.md"))) {
		return { ok: false, error: `skill ${YANO_CLI_SKILL_NAME} mancante nel pacchetto: ${source}` };
	}
	const plan = inspectYanoCliSkill({ packageRoot, home, env, platform, commandAvailability });
	const result = { ...plan, dry_run: dryRun, installed: [], duplicates: [], ok: true };
	if (!plan.targets.length) {
		result.warning = "nessun harness Claude Code, Codex o Pi rilevato; installazione globale rimandata al primo harness disponibile";
		return result;
	}
	for (const target of plan.targets) {
		const destination = path.join(target.path, YANO_CLI_SKILL_NAME);
		const classification = targetClassification({ source, target: destination, allowModifiedManaged: force });
		if (!classification.safe) {
			result.installed.push({ ...target, path: destination, state: classification.state, action: "skipped" });
			result.ok = false;
			continue;
		}
		const action = classification.state === "missing" ? "install" : classification.state === "adoptable-identical" ? "adopt" : classification.state === "managed" ? "update" : "unchanged";
		if (action !== "unchanged" && !dryRun) {
			try { copySkill(source, destination, plan.package_version); }
			catch (error) {
				result.installed.push({ ...target, path: destination, state: "write-error", action: "failed", error: error instanceof Error ? error.message : String(error) });
				result.ok = false;
				continue;
			}
		}
		result.installed.push({ ...target, path: destination, state: classification.state, action: dryRun ? `would-${action}` : action });
	}

	for (const root of plan.duplicate_roots) {
		const duplicate = path.join(root, YANO_CLI_SKILL_NAME);
		if (!fs.existsSync(duplicate)) continue;
		const safe = duplicateSafety({ source, duplicate });
		if (!pruneDuplicates) {
			result.duplicates.push({ path: duplicate, state: safe ? "duplicate" : "conflict", action: "kept" });
			if (!safe) result.ok = false;
			continue;
		}
		if (!safe) {
			result.duplicates.push({ path: duplicate, state: "conflict", action: "kept", detail: "copia non gestita o modificata: non viene rimossa" });
			result.ok = false;
			continue;
		}
		if (dryRun) {
			result.duplicates.push({ path: duplicate, state: "duplicate", action: "would-quarantine" });
			continue;
		}
		try {
			const backup = quarantineDuplicate({ duplicate, home, env, platform });
			result.duplicates.push({ path: duplicate, state: "duplicate", action: "quarantined", backup });
		} catch (error) {
			result.duplicates.push({ path: duplicate, state: "duplicate", action: "failed", error: error instanceof Error ? error.message : String(error) });
			result.ok = false;
		}
	}

	for (const legacyPath of plan.legacy_paths) {
		const safe = legacySkillIsRecognized(legacyPath);
		if (!pruneDuplicates) {
			result.duplicates.push({ path: legacyPath, state: "legacy-name", action: "kept" });
			result.ok = false;
			continue;
		}
		if (!safe) {
			result.duplicates.push({ path: legacyPath, state: "legacy-conflict", action: "kept", detail: "cartella legacy non riconosciuta o symlink: non viene rimossa" });
			result.ok = false;
			continue;
		}
		if (dryRun) {
			result.duplicates.push({ path: legacyPath, state: "legacy-name", action: "would-quarantine" });
			continue;
		}
		try {
			const backup = quarantineDuplicate({ duplicate: legacyPath, home, env, platform });
			result.duplicates.push({ path: legacyPath, state: "legacy-name", action: "quarantined", backup });
		} catch (error) {
			result.duplicates.push({ path: legacyPath, state: "legacy-name", action: "failed", error: error instanceof Error ? error.message : String(error) });
			result.ok = false;
		}
	}
	return result;
}

function parseArgs(argv) {
	let action = "install";
	let json = false;
	let dryRun = false;
	let force = false;
	let pruneDuplicates = true;
	for (const arg of argv) {
		if (arg === "install" || arg === "status") action = arg;
		else if (arg === "--json") json = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--force") force = true;
		else if (arg === "--no-prune-duplicates") pruneDuplicates = false;
		else if (arg === "--help" || arg === "-h") return { help: true };
		else if (arg === "--if-global") {
			// Handled by runYanoHarnessSkills, because npm lifecycle variables
			// are not part of the public CLI contract.
		}
		else if (arg === "--quiet") { /* lifecycle convenience */ }
		else throw new Error(`argomento non riconosciuto: ${arg}`);
	}
	return { action, json, dryRun, force, pruneDuplicates };
}

export function harnessSkillsUsage() {
	return [
		"Uso: yano skills <install|status> [--dry-run] [--force] [--json]",
		"",
		"  install                  installa yano-cli negli harness disponibili",
		"  status                   mostra harness, target condivisi e duplicati",
		"  --dry-run                mostra il piano senza scrivere o spostare file",
		"  --force                  aggiorna anche una copia Yano modificata localmente",
		"  --no-prune-duplicates    non sposta copie duplicate identiche dal catalogo Pi",
		"",
		"Strategia: Claude Code usa ~/.claude/skills, Codex ~/.codex/skills e Pi",
		"usa ~/.pi/agent/skills solo quando non scopre già uno dei cataloghi sopra.",
		"Le copie duplicate sicure vengono spostate nel backup del data-root Yano.",
	].join("\n");
}

function yanoCliStatus({ packageRoot } = {}) {
	const report = installYanoCliSkill({ packageRoot, dryRun: true });
	const missingTargets = report.targets.filter((target) => !fs.existsSync(path.join(target.path, YANO_CLI_SKILL_NAME, "SKILL.md")));
	const activeDuplicates = report.duplicate_roots.filter((root) => fs.existsSync(path.join(root, YANO_CLI_SKILL_NAME, "SKILL.md")));
	const ready = !report.targets.length || (report.ok && !missingTargets.length && !activeDuplicates.length && !report.legacy_paths.length);
	return {
		...report,
		status: ready ? "ready" : "needs-sync",
		missing_targets: missingTargets.map((target) => path.join(target.path, YANO_CLI_SKILL_NAME)),
		active_duplicate_roots: activeDuplicates,
		ok: ready,
	};
}

export function runYanoHarnessSkills({ packageRoot, argv = [] } = {}) {
	let parsed;
	try { parsed = parseArgs(argv); }
	catch (error) { console.error(`yano skills: ${error.message}`); process.exitCode = 1; return { ok: false }; }
	if (parsed.help) { console.log(harnessSkillsUsage()); return { ok: true, help: true }; }
	const ifGlobal = argv.includes("--if-global");
	if (ifGlobal && !["true", "1"].includes(String(process.env.npm_config_global || "").toLowerCase())) {
		if (!argv.includes("--quiet")) console.log("yano skills: installazione lifecycle saltata (non è un npm install globale).");
		return { ok: true, skipped: true, reason: "not-global-npm-install" };
	}
	const report = parsed.action === "status"
		? yanoCliStatus({ packageRoot })
		: installYanoCliSkill({ packageRoot, dryRun: parsed.dryRun, force: parsed.force, pruneDuplicates: parsed.pruneDuplicates });
	if (parsed.json) console.log(JSON.stringify(report, null, 2));
	else {
		console.log(`yano skills ${parsed.action}: skill ${YANO_CLI_SKILL_NAME}`);
		console.log(`  sorgente: ${report.source}`);
		if (report.warning) console.warn(`  ⚠ ${report.warning}`);
		for (const item of report.targets ?? []) console.log(`  target: ${item.path} (${item.reason})`);
		for (const item of report.installed ?? []) console.log(`  ${item.action}: ${item.path}`);
		for (const item of report.duplicates ?? []) console.log(`  duplicato ${item.action}: ${item.path}${item.backup ? ` → ${item.backup}` : ""}`);
		if (!report.targets?.length) console.log("  nessuna modifica necessaria.");
		else if (report.ok) console.log("  stato: sincronizzata");
		else if (report.status === "needs-sync") console.log("  stato: da sincronizzare — esegui `yano skills install` e verifica i dettagli sopra");
		else console.log("  stato: conflitto o errore — vedere i dettagli sopra");
	}
	if (!report.ok) process.exitCode = 1;
	return report;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	try {
		const result = runYanoHarnessSkills({ packageRoot, argv: process.argv.slice(2) });
		if (result?.ok === false) process.exitCode = 1;
	} catch (error) {
		console.error(`yano skills: errore inatteso — ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
