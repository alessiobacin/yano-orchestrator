#!/usr/bin/env node

// E2E test for the unified feedback dashboard (yano dash), requested
// 2026-09-06: verify a bug-report flow actually leads to bug resolution,
// and a suggestion flow actually leads to a new-feature record, end to end
// through the REAL served HTTP surface — not a reimplementation of it.
//
// yano dash is launched exactly as an operator would (`yano dash start`),
// as its OWN OS process: running it in-process would share this test
// process's own SIGTERM listener, so stopping it here would risk stopping
// the test runner itself. Real usage never hits that — the dashboard is
// already its own process — so this test matches reality instead of
// working around a test-only artifact.
//
// What this test actually proves, deterministically (no LLM/agent
// involved, since a real planner's reasoning can't be unit-tested):
//   1. A bug created via yano dash sits queued, gets dequeued/claimed by the
//      SAME mechanism a real planner relies on (claimNextQueuedFeedback —
//      see smoke-test-feedback-queue-wake.mjs for its own focused
//      coverage), and once "finalized" (simulating worktree_finalize)
//      lands on the dashboard's "resolved" column for bugs — the terminal
//      state the Bug tab actually renders.
//   2. A suggestion created via yano dash is claimed by that SAME
//      mechanism (this used to be impossible — see the queue-wake test's
//      regression check) and, once approved+implemented (simulating
//      worktree_finalize for a SUG- id), lands on the dashboard's
//      "processed" column for suggestions.
//   3. The two collections stay strictly isolated per type/project — a bug
//      never leaks into the suggestions listing or vice versa.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-feedback-e2e-"));
const missingConfig = path.join(dataDir, "does-not-exist.env");
// yano dash runs as a CHILD PROCESS (spawn() below with this env), but this
// test process ALSO imports yano-feedback.mjs directly (to call
// claimNextQueuedFeedback, simulating the planner). openDatabase()/dbPath()
// resolve from process.env, not from a variable passed only to the child —
// so process.env itself must carry the same isolation, or this process's
// own openDatabase() call silently resolves to the real machine's default
// Yano data directory instead of this test's temp one (a real safety
// hazard, not just a test bug: without this, a bug/suggestion planted here
// could read or mutate genuine production feedback records on whatever
// machine runs this).
process.env.YANO_DATA_DIR = dataDir;
process.env.YANO_CONFIG_FILE = missingConfig;
process.env.YANO_FEEDBACK_SKIP_NOTIFY = "1";
const env = { ...process.env };
const PROJECT = "e2e-flow-project";

console.log("E2E: bug-report flow leads to resolution, suggestion flow leads to a new-feature record");
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ok — ${name}`); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dashStatePath() { return path.join(dataDir, "dashboards", "dash.json"); }

async function startDash() {
	const child = spawn("node", [path.join(root, "bin", "yano.mjs"), "dash", "start", "--project-id", PROJECT, "--no-open", "--port", "0"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(dashStatePath())) {
			try {
				const state = JSON.parse(fs.readFileSync(dashStatePath(), "utf8"));
				if (state.port && state.pid) return { child, port: state.port };
			} catch { /* file mid-write, retry */ }
		}
		if (child.exitCode !== null) throw new Error(`yano dash exited early (code ${child.exitCode}): ${stderr}`);
		await sleep(50);
	}
	throw new Error(`yano dash never wrote its state file within the deadline. stderr: ${stderr}`);
}

async function stopDash(handle) {
	if (!handle) return;
	if (handle.child.exitCode !== null) return;
	try { handle.child.kill("SIGTERM"); } catch { return; }
	await Promise.race([
		new Promise((resolve) => handle.child.once("exit", resolve)),
		sleep(3_000),
	]);
	if (handle.child.exitCode === null) { try { handle.child.kill("SIGKILL"); } catch { /* already gone */ } }
}

async function api(port, urlPath, options) {
	const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, options);
	const body = await response.json();
	if (!response.ok) throw new Error(`${options?.method || "GET"} ${urlPath} -> ${response.status}: ${body.error || JSON.stringify(body)}`);
	return body;
}

let dash = null;
let feedbackDb = null;

try {
	await check("yano dash starts as a real, separate OS process and reports a live port", async () => {
		// --port 0 (see startDash) lets the OS assign any free ephemeral port
		// instead of Yano's declared 11000-11999 range, so this test never
		// collides with a real always-on yano-dash instance already running
		// on the developer's machine.
		dash = await startDash();
		assert.ok(dash.port > 0, "yano dash must report the port it actually bound");
		const health = await api(dash.port, "/healthz");
		assert.deepEqual(health, { ok: true, service: "yano-dash" });
	});

	// Opened AFTER the dashboard has created the sqlite file (openDatabase()
	// runs the CREATE TABLE IF NOT EXISTS on first open), from the test's own
	// process — a separate OS process from the dashboard, exactly like a
	// real planner's Pi process would be relative to the dashboard server.
	const { openDatabase, claimNextQueuedFeedback, terminalStatusForFeedbackId } = await import("./yano-feedback.mjs");
	feedbackDb = openDatabase();

	let bugId = null;
	let suggestionId = null;

	await check("BUG REPORT FLOW — step 1: a bug is filed through yano dash's real HTTP API and starts life queued for the planner", async () => {
		const created = await api(dash.port, `/${encodeURIComponent(PROJECT)}/bugs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				title: "Il pulsante Salva non risponde",
				message: "Nella pagina /settings/haccp, cliccando Salva non succede nulla e la console mostra un 404.",
				severity: "high",
				route: "/settings/haccp",
				resolution: "automatic",
				test_username: "e2e-user",
				test_password: "e2e-password",
				created_by: "e2e-test",
			}),
		});
		bugId = created.id;
		assert.match(bugId, /^BUG-/);
		assert.ok(["pending_planner", "queued"].includes(created.status), `unexpected initial status: ${created.status}`);
		const listed = await api(dash.port, `/${encodeURIComponent(PROJECT)}/bugs`);
		assert.ok(listed.some((item) => item.id === bugId), "the freshly created bug must be visible in the dashboard's own bugs listing");
	});

	await check("BUG REPORT FLOW — step 2: the planner's real dequeue mechanism claims the bug (this is what wakeNextQueuedFeedback does in production)", () => {
		const result = claimNextQueuedFeedback(feedbackDb, PROJECT);
		assert.ok(result, "a queued bug must be claimable");
		assert.equal(result.type, "bug");
		assert.equal(result.claimed.id, bugId);
		assert.equal(result.claimed.status, "processing");
		assert.match(result.message, /Classifica prima l'impatto/, "the planner must receive bug-specific triage instructions");
	});

	await check("BUG REPORT FLOW — step 3: finalizing the fix (simulating worktree_finalize) moves it to the dashboard's actual terminal column for bugs — RESOLVED", async () => {
		const terminal = terminalStatusForFeedbackId(bugId);
		assert.equal(terminal, "resolved", "a BUG- id must close to 'resolved', the only terminal column the Bug tab exposes");
		const updated = await api(dash.port, `/${encodeURIComponent(PROJECT)}/bugs/${bugId}`, {
			method: "PUT",
			headers: { "content-type": "application/json", "x-yano-user": "e2e-test" },
			body: JSON.stringify({ status: terminal, audit_reason: "Backend puro, test e regressioni verdi, nessuna operazione distruttiva (simulazione worktree_finalize automatic_backend)" }),
		});
		assert.equal(updated.status, "resolved");
		const listed = await api(dash.port, `/${encodeURIComponent(PROJECT)}/bugs`);
		const resolvedBug = listed.find((item) => item.id === bugId);
		assert.ok(resolvedBug, "the bug must still be listed after closing it");
		assert.equal(resolvedBug.status, "resolved", "THE bug-report-leads-to-resolution assertion the user asked to verify");
	});

	await check("SUGGEST FLOW — step 1: a suggestion is filed through yano dash's real HTTP API and starts life queued for the planner", async () => {
		const created = await api(dash.port, `/${encodeURIComponent(PROJECT)}/suggestions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				title: "Esportazione turni in PDF",
				message: "Sarebbe utile poter esportare il calendario turni del mese in un PDF stampabile.",
				severity: "medium",
				route: "/turni",
				created_by: "e2e-test",
			}),
		});
		suggestionId = created.id;
		assert.match(suggestionId, /^SUG-/);
		assert.equal(created.resolution, "user_confirmation", "a suggestion is never automatic, regardless of what the client sends");
		assert.ok(["pending_planner", "queued"].includes(created.status), `unexpected initial status: ${created.status}`);
		const listed = await api(dash.port, `/${encodeURIComponent(PROJECT)}/suggestions`);
		assert.ok(listed.some((item) => item.id === suggestionId), "the freshly created suggestion must be visible in the dashboard's own suggestions listing");
	});

	await check("SUGGEST FLOW — step 2: the SAME dequeue mechanism now claims the suggestion too — this is the exact regression that used to make suggestions unreachable forever", () => {
		const result = claimNextQueuedFeedback(feedbackDb, PROJECT, { preferredType: "suggestion" });
		assert.ok(result, "a queued suggestion must be claimable — before the 2026-09-06 fix this was always null");
		assert.equal(result.type, "suggestion");
		assert.equal(result.claimed.id, suggestionId);
		assert.equal(result.claimed.status, "processing");
		assert.match(result.message, /conferma esplicita dell'utente/, "the planner must be told this always needs explicit user confirmation");
		assert.match(result.message, /nuova feature/, "the planner must be told an approved suggestion becomes a new feature");
	});

	await check("SUGGEST FLOW — step 3: after user confirmation and implementation (simulating worktree_finalize), it moves to the dashboard's actual terminal column for suggestions — PROCESSED, i.e. turned into a new feature", async () => {
		const terminal = terminalStatusForFeedbackId(suggestionId);
		assert.equal(terminal, "processed", "a SUG- id must close to 'processed', the only terminal column the Suggestion tab exposes");
		const updated = await api(dash.port, `/${encodeURIComponent(PROJECT)}/suggestions/${suggestionId}`, {
			method: "PUT",
			headers: { "content-type": "application/json", "x-yano-user": "e2e-test" },
			body: JSON.stringify({ status: terminal, audit_reason: "Utente ha confermato: implementata come nuova feature e mergiata (simulazione worktree_finalize)" }),
		});
		assert.equal(updated.status, "processed");
		const listed = await api(dash.port, `/${encodeURIComponent(PROJECT)}/suggestions`);
		const processedSuggestion = listed.find((item) => item.id === suggestionId);
		assert.ok(processedSuggestion, "the suggestion must still be listed after closing it");
		assert.equal(processedSuggestion.status, "processed", "THE suggestion-leads-to-a-new-feature assertion the user asked to verify");
	});

	await check("bugs and suggestions stay strictly isolated per collection: the resolved bug never leaks into the suggestions listing and the processed suggestion never leaks into the bugs listing", async () => {
		const suggestionsList = await api(dash.port, `/${encodeURIComponent(PROJECT)}/suggestions`);
		assert.ok(!suggestionsList.some((item) => item.id === bugId), "a bug must not appear in the suggestions collection");
		const bugsList = await api(dash.port, `/${encodeURIComponent(PROJECT)}/bugs`);
		assert.ok(!bugsList.some((item) => item.id === suggestionId), "a suggestion must not appear in the bugs collection");
	});

	console.log(`\nsmoke-test-feedback-e2e-flow: ${passed} passed`);
} catch (error) {
	console.error(`\nFAILED after ${passed} passed checks: ${error?.stack || error}`);
	process.exitCode = 1;
} finally {
	try { feedbackDb?.close(); } catch { /* best effort */ }
	// Wait for the child process to actually exit before removing the temp
	// dir — its own SIGTERM handler still writes a final "stopped" state
	// file (see writeDashState in yano-dash.mjs), and racing that write
	// against rmSync intermittently threw ENOTEMPTY.
	await stopDash(dash);
	try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort cleanup */ }
}
