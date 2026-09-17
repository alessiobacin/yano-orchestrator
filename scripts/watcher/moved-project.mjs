// Moved-project detection for the watcher registry: when a registered
// project root no longer exists on disk, search a bounded set of candidate
// locations for the same project (matched by its durable
// `.pi/extensions/yano-orchestrator/config/project.json` marker + project
// name) instead of silently dropping supervision. Real evidence: code-mem
// moved from ~/Desktop/code-mem to ~/Development/Code/code-mem and its
// watcher row kept pointing at the dead path, so no planner recovery ever
// fired for its active run.
//
// Design (tradeoff documented in the task report): NEVER auto-rewrite the
// registered root — projectKey() is cwd-derived, so a silent rewrite would
// fork trace/MQTT identity and could hijack an unrelated checkout that
// happens to share the name. Instead this module returns a verdict the
// caller surfaces deterministically: `relocated` (candidate found → caller
// opens a user-owned decision_hold proposing the update) or `missing`
// (nothing found → caller stops the row with an explicit state + the
// `yano watcher init --project-root <nuovo>` re-add instruction). Both are
// pure, dependency-injected, zero Herdr/SQLite — the caller owns I/O.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = path.join(".pi", "extensions", "yano-orchestrator", "config", "project.json");

// Bounded candidate parents: the old root's own parent + siblings (a move
// is usually nearby) plus the conventional checkouts on this machine. Never
// a blind whole-disk walk; mdfind is deliberately NOT used (Spotlight
// indexing lag makes it non-deterministic for a supervisor pass).
function candidateParents(oldRoot) {
	const home = os.homedir();
	const parents = new Set();
	try {
		const oldParent = path.dirname(path.resolve(oldRoot));
		parents.add(oldParent);
		for (const entry of fs.readdirSync(oldParent, { withFileTypes: true })) {
			if (entry.isDirectory()) parents.add(path.join(oldParent, entry.name));
		}
	} catch { /* old parent itself may be gone */ }
	for (const dir of [
		path.join(home, "Development"),
		path.join(home, "Development", "Code"),
		path.join(home, "Development", "testCode"),
		path.join(home, "Desktop"),
		path.join(home, "Code"),
	]) parents.add(dir);
	return [...parents].filter((dir) => {
		try { return fs.statSync(dir).isDirectory(); } catch { return false; }
	});
}

function markerProjectName(dir) {
	try {
		const config = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8"));
		return typeof config.project === "string" && config.project.trim() ? config.project.trim() : null;
	} catch { return null; }
}

// Depth-1 scan of each candidate parent for a directory whose marker names
// the same project. Returns the new root or null. `exists`/`readdir` are
// injectable so the smoke test can run without touching the real filesystem.
export function findRelocatedRoot(oldRoot, projectName, { exists = fs.existsSync, readdir = (dir) => fs.readdirSync(dir, { withFileTypes: true }) } = {}) {
	if (!projectName) return null;
	const wanted = String(projectName).trim().toLowerCase();
	for (const parent of candidateParents(oldRoot)) {
		let entries;
		try { entries = readdir(parent); } catch { continue; }
		for (const entry of entries) {
			const isDir = typeof entry.isDirectory === "function" ? entry.isDirectory() : entry.isDirectory;
			if (!isDir) continue;
			const candidate = path.join(parent, entry.name);
			if (path.resolve(candidate) === path.resolve(oldRoot)) continue;
			if (!exists(path.join(candidate, MARKER))) continue;
			if (markerProjectName(candidate)?.toLowerCase() === wanted) return candidate;
		}
	}
	return null;
}

// Verdict for a registry row whose root is gone: `active` (root exists,
// nothing to do), `relocated` (same project found elsewhere → propose via
// hold), or `missing` (not found → stop with explicit re-add instruction).
export function relocatedProjectVerdict(row, deps = {}) {
	const root = row?.root;
	const exists = deps.exists || fs.existsSync;
	if (root && exists(root)) return { status: "active", root };
	const relocatedRoot = findRelocatedRoot(root || "", row?.name, deps);
	if (relocatedRoot) {
		return {
			status: "relocated",
			old_root: root,
			new_root: relocatedRoot,
			project: row?.name,
			proposal: `Il progetto "${row?.name}" risulta spostato da ${root} a ${relocatedRoot}. Confermi l'aggiornamento del watcher a ${relocatedRoot}?`,
			readd_hint: `yano watcher init --project-root ${relocatedRoot}`,
		};
	}
	return {
		status: "missing",
		old_root: root,
		project: row?.name,
		readd_hint: `yano watcher init --project-root <nuovo-percorso-di-${row?.name}>`,
	};
}
