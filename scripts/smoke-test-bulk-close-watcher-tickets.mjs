// Fase 1 / M0 — copre scripts/watcher/bulk-close-watcher-tickets.mjs: la
// pulizia una tantum del backlog di ticket auto-generati dal watcher.
// Verifica: dry-run non scrive nulla; la run reale archivia solo i ticket
// created_by:yano-watcher + status:open + senza commenti umani; nulla viene
// mai cancellato dal disco; il breakdown per segnale è corretto.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyBulkClose, planBulkClose, runBulkCloseWatcherTickets } from "./watcher/bulk-close-watcher-tickets.mjs";

const ticketsDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-bulk-close-"));

function ticket({ createdBy, status, signal, comments = "" }) {
	return `---\ntype: human\nkind: task\ncreated_by: ${createdBy}\nstatus: ${status}\nsignal: ${signal}\nfingerprint: fp-${signal}-${createdBy}-${status}\n---\n\n# fixture\n\n## Comments\n${comments}\n`;
}

const fileA = path.join(ticketsDir, "01-a.md"); // yano-watcher, open, no comments → archive
const fileB = path.join(ticketsDir, "02-b.md"); // yano-watcher, open, WITH comments → skip
const fileC = path.join(ticketsDir, "03-c.md"); // yano-watcher, open, no comments → archive
const fileD = path.join(ticketsDir, "04-d.md"); // human-authored, open → never touched
const fileE = path.join(ticketsDir, "05-e.md"); // yano-watcher, already closed → never touched

fs.writeFileSync(fileA, ticket({ createdBy: "yano-watcher", status: "open", signal: "tool_failure" }));
fs.writeFileSync(fileB, ticket({ createdBy: "yano-watcher", status: "open", signal: "tool_failure", comments: "Sto guardando questo, non toccarlo.\n" }));
fs.writeFileSync(fileC, ticket({ createdBy: "yano-watcher", status: "open", signal: "no_live_target" }));
fs.writeFileSync(fileD, ticket({ createdBy: "human", status: "open", signal: "n/a" }));
fs.writeFileSync(fileE, ticket({ createdBy: "yano-watcher", status: "auto-closed-stale", signal: "tool_failure" }));

const originals = Object.fromEntries([fileA, fileB, fileC, fileD, fileE].map((file) => [file, fs.readFileSync(file, "utf8")]));

// planBulkClose: correct classification and per-signal breakdown.
const plan = planBulkClose({ ticketsDir });
assert.equal(plan.scanned, 3, "only created_by:yano-watcher + status:open tickets count as scanned (A, B, C)");
assert.equal(plan.archive.length, 2, "A and C have no human comments and must be archived");
assert.deepEqual(plan.archive.map((item) => item.path).sort(), [fileA, fileC].sort());
assert.equal(plan.skippedWithComments.length, 1, "B has human comments and must be skipped");
assert.equal(plan.skippedWithComments[0].path, fileB);
assert.equal(plan.scannedBySignal.get("tool_failure"), 2);
assert.equal(plan.scannedBySignal.get("no_live_target"), 1);

// Dry-run must never write anything.
const dryRunResult = await runBulkCloseWatcherTickets({ argv: ["--dry-run", "--tickets-dir", ticketsDir] });
assert.equal(dryRunResult.applied, false);
for (const file of [fileA, fileB, fileC, fileD, fileE]) {
	assert.equal(fs.readFileSync(file, "utf8"), originals[file], `--dry-run must not modify ${path.basename(file)}`);
}

// Real run: only A and C change, and nothing is ever deleted from disk.
const applied = applyBulkClose(plan);
assert.deepEqual(applied.archived.sort(), [fileA, fileC].sort());

const afterA = fs.readFileSync(fileA, "utf8");
assert.match(afterA, /^status: archived-bulk-cleanup$/m);
assert.match(afterA, /## Archiviato \(pulizia manuale\)/);

const afterC = fs.readFileSync(fileC, "utf8");
assert.match(afterC, /^status: archived-bulk-cleanup$/m);

assert.equal(fs.readFileSync(fileB, "utf8"), originals[fileB], "a commented ticket must never be rewritten");
assert.equal(fs.readFileSync(fileD, "utf8"), originals[fileD], "a human-authored ticket must never be touched");
assert.equal(fs.readFileSync(fileE, "utf8"), originals[fileE], "an already-closed ticket must never be touched");

for (const file of [fileA, fileB, fileC, fileD, fileE]) {
	assert.equal(fs.existsSync(file), true, `${path.basename(file)} must never be deleted from disk`);
}

console.log("Bulk-close watcher tickets smoke test passed.");
