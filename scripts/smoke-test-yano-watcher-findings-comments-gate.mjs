// Fase 1 / M0 — copre due comportamenti nuovi in yano-watcher-findings.mjs:
// 1) ogni ticket generato dal watcher include ora una sezione `## Comments`
//    (vuota alla creazione) rilevabile da `hasHumanComments()`;
// 2) `sweepStaleYanoWatcherTickets()` non chiude più automaticamente un
//    ticket su cui un umano ha scritto in quella sezione, anche se stale.
// Vedi piano Fase 1 (docs/adr in arrivo) — nessuna cancellazione, solo
// riscrittura additiva dei file markdown, stesso principio dello sweep
// esistente.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createYanoWatcherTicket, hasHumanComments, sweepStaleYanoWatcherTickets } from "./yano-watcher-findings.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-watcher-comments-gate-"));
const ticketsDir = path.join(tmpRoot, "issues");
const yanoRepo = tmpRoot; // only needs to be truthy; ticketsDir is passed explicitly

function makeFinding(overrides = {}) {
	return {
		severity: "high",
		category: "internal_tool",
		signal: "tool_failure",
		summary: "Un tool interno di Yano è terminato con errore.",
		fingerprint: "a".repeat(64),
		project_key: "workspace-test",
		run_id: "run-1",
		instance: "planner-01",
		round: 1,
		task: "t1",
		record_id: "rec-1",
		record_ts: new Date().toISOString(),
		payload: { ok: false },
		...overrides,
	};
}

// 1) A freshly-created ticket has a `## Comments` section and reads as
//    having no human comments yet.
const created = createYanoWatcherTicket({ finding: makeFinding(), yanoRepo, projectRoot: tmpRoot, project: "demo", ticketsDir });
assert.equal(created.created, true, "ticket should be created on first sighting of a fingerprint");
let content = fs.readFileSync(created.path, "utf8");
assert.match(content, /## Comments/, "ticket template must include a ## Comments section");
assert.equal(hasHumanComments(content), false, "an empty ## Comments section must not count as human-touched");

// 2) Writing real text under ## Comments flips hasHumanComments to true —
//    this is exactly what a human editing the file by hand would produce.
content = `${content}\nQualcuno ha già guardato questo ticket ieri.\n`;
fs.writeFileSync(created.path, content);
assert.equal(hasHumanComments(content), true, "non-empty content after ## Comments must count as human-touched");

// 3) The stale sweep must skip a stale ticket that has human comments, and
//    still close a stale ticket that has none.
const untouchedFinding = makeFinding({ fingerprint: "b".repeat(64), task: "t2" });
const untouched = createYanoWatcherTicket({ finding: untouchedFinding, yanoRepo, projectRoot: tmpRoot, project: "demo", ticketsDir });
assert.equal(untouched.created, true);

const commentedFinding = makeFinding({ fingerprint: "c".repeat(64), task: "t3" });
const commented = createYanoWatcherTicket({ finding: commentedFinding, yanoRepo, projectRoot: tmpRoot, project: "demo", ticketsDir });
assert.equal(commented.created, true);
fs.writeFileSync(commented.path, `${fs.readFileSync(commented.path, "utf8")}\nUn umano ha commentato questo, non chiuderlo in automatico.\n`);
assert.equal(hasHumanComments(fs.readFileSync(commented.path, "utf8")), true);

const farFuture = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000); // well past any staleDays threshold used below
const swept = sweepStaleYanoWatcherTickets({ ticketsDir, now: farFuture, staleDays: 14 });

const untouchedContentAfter = fs.readFileSync(untouched.path, "utf8");
assert.match(untouchedContentAfter, /^status: auto-closed-stale$/m, "a stale ticket with no human comments must still be auto-closed");

const commentedContentAfter = fs.readFileSync(commented.path, "utf8");
assert.match(commentedContentAfter, /^status: open$/m, "a stale ticket WITH human comments must never be auto-closed");
assert.equal(swept.closed.some((item) => item.path === commented.path), false, "the commented ticket must not appear in the sweep's closed list");
assert.equal(swept.closed.some((item) => item.path === untouched.path), true, "the uncommented stale ticket must appear in the sweep's closed list");

console.log("Watcher ticket comments-gate smoke test passed.");
