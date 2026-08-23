// Verifica il percorso di apprendimento post-round senza un LLM reale:
// verdetto utente, snapshot, contesto filtrato, overview tra progetti e opinione
// del planner persistono nella directory globale configurata.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendTraceRecord, buildTraceOverview, ensureTraceProject, readTraceRecords, tracePaths } from "./yano-trace-storage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-trace-analysis-"));
const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "yano-trace-analysis-project-a-"));
const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "yano-trace-analysis-project-b-"));
const cli = path.join(root, "scripts", "yano-trace.mjs");
const previousDataDir = process.env.YANO_DATA_DIR;
process.env.YANO_DATA_DIR = dataDir;

function run(cwd, args) {
	return execFileSync(process.execPath, [cli, ...args, "--data-dir", dataDir], { cwd, encoding: "utf8" });
}

function appendEvent(cwd, project, event) {
	ensureTraceProject({ cwd, project, instance: event.instance || "planner-01" });
	const file = tracePaths({ cwd, project, instance: event.instance || "planner-01" }).instanceLog;
	fs.appendFileSync(file, `${JSON.stringify({
		...event,
		project,
		project_key: tracePaths({ cwd, project }).projectKey,
	})}\n`);
}

try {
	const feedbackOutput = run(cwdA, [
		"feedback",
		"--project", "project-a",
		"--status", "rejected",
		"--text", "Il coder ha modificato il file sbagliato e il reviewer non ha verificato il comportamento.",
		"--run", "run-a",
		"--round", "2",
		"--task", "fix-login",
	]);
	assert.match(feedbackOutput, /feedback rejected registrato/);
	appendEvent(cwdA, "project-a", { type: "tool_execution_end", ok: false, run_id: "run-a", round: "2", task_slug: "fix-login" });
	appendEvent(cwdA, "project-a", { type: "worktree_finalize", conflict: true, run_id: "run-a", round: "2", task_slug: "fix-login" });

	const context = JSON.parse(run(cwdA, [
		"context", "--project", "project-a", "--run", "run-a", "--round", "2", "--task", "fix-login", "--json",
	]));
	assert.ok(context.records.length >= 3, "il contesto filtrato deve includere feedback, eventi e snapshot");
	assert.ok(context.records.every((record) => record.run_id === "run-a"), "il contesto deve rispettare il filtro run");
	assert.ok(context.records.some((record) => record.record_type === "feedback"), "il contesto deve includere il verdetto utente");

	run(cwdA, [
		"opinion", "--project", "project-a", "--text", "La causa più probabile è un gap di verifica e di orchestrazione.",
		"--summary", "Reviewer senza controllo comportamentale sul file richiesto.",
		"--root-cause", "Il flusso ha accettato una modifica non allineata al requisito.",
		"--recommendation", "Rafforzare la checklist del reviewer e il gate di evidenza.",
		"--change", "playbook", "--confidence", "high", "--roles", "coder,reviewer,planner",
		"--run", "run-a", "--round", "2", "--task", "fix-login",
	]);

	run(cwdB, [
		"feedback", "--project", "project-b", "--status", "partial",
		"--text", "Manca una verifica automatica prima della consegna.",
		"--run", "run-b", "--round", "1", "--task", "checkout",
	]);

	const overview = JSON.parse(run(cwdA, ["overview", "--all-projects", "--json"]));
	assert.equal(overview.scope, "all-projects");
	assert.equal(overview.totals.feedback, 2);
	assert.equal(overview.totals.opinions, 1);
	assert.equal(overview.failure_signals.user_rejected_round, 2);
	assert.equal(overview.failure_signals.tool_failure, 1);
	assert.equal(overview.failure_signals.merge_conflict, 1);
	assert.ok(overview.feedback_patterns.verification_gap >= 1);
	assert.ok(overview.feedback_by_project["project-a"] === 1 && overview.feedback_by_project["project-b"] === 1);

	// Un record non può sovrascrivere lo scope calcolato dal filesystem.
	const protectedEntry = appendTraceRecord({ cwd: cwdA, project: "project-a", kind: "opinion", record: { project: "spoofed", project_key: "spoofed" } });
	assert.equal(protectedEntry.project, "project-a");
	assert.notEqual(protectedEntry.project_key, "spoofed");
	assert.ok(readTraceRecords({ cwd: cwdA, project: "project-a" }).every((record) => record.project_key === tracePaths({ cwd: cwdA, project: "project-a" }).projectKey));

	console.log("YANO TRACE ANALYSIS SMOKE TEST PASSED");
} finally {
	if (previousDataDir === undefined) delete process.env.YANO_DATA_DIR;
	else process.env.YANO_DATA_DIR = previousDataDir;
	fs.rmSync(dataDir, { recursive: true, force: true });
	fs.rmSync(cwdA, { recursive: true, force: true });
	fs.rmSync(cwdB, { recursive: true, force: true });
}
