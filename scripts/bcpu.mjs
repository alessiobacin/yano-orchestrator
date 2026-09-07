#!/usr/bin/env node

// Controlled release helper: validate, bump patch, commit, push, then update
// the permanent global Yano installation. Untracked files require an explicit
// opt-in so secrets or unrelated artifacts are never committed accidentally.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log("Uso: npm run bcpu [-- <messaggio commit>]");
	console.log("  --include-untracked  include esplicitamente file nuovi verificati");
	process.exit(0);
}
const includeUntracked = args.includes("--include-untracked");
const message = args.filter((arg) => arg !== "--include-untracked").join(" ").trim();

function run(command, commandArgs, options = {}) {
	return execFileSync(command, commandArgs, { cwd: root, stdio: "inherit", ...options });
}

function output(command, commandArgs) {
	return execFileSync(command, commandArgs, { cwd: root, encoding: "utf8" }).trim();
}

const status = output("git", ["status", "--short"]);
const untracked = status.split("\n").filter((line) => line.startsWith("?? "));
if (untracked.length && !includeUntracked) {
	console.error("bcpu: file non tracciati rilevati; nessun commit creato:");
	for (const file of untracked) console.error(`  ${file.slice(3)}`);
	console.error("bcpu: verifica/stage manualmente oppure ripeti con --include-untracked.");
	process.exit(2);
}

console.log("bcpu: verifico documentazione, sintassi e suite test...");
run("npm", ["run", "check:docs"]);
run("npm", ["run", "check-syntax"]);
run("npm", ["test"]);
run("git", ["diff", "--check"]);

run("npm", ["version", "patch", "--no-git-tag-version"]);
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const commitMessage = message || `chore(release): bump version to ${version}`;

run("git", includeUntracked ? ["add", "-A"] : ["add", "-u"]);
run("git", ["diff", "--cached", "--check"]);
run("git", ["commit", "-m", commitMessage]);
run("git", ["push", "origin", "HEAD"]);
run("yano", ["update"]);

console.log(`bcpu: completato — versione ${version}, commit pushato e installazione globale aggiornata.`);
