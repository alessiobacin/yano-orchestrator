#!/usr/bin/env node

// Regression: updateFeedback() must not silently discard a requested status
// change just because the caller re-submitted the exact screenshots array it
// was handed by a prior GET. repairFeedbackScreenshots() (triggered on every
// read) adds server-only bookkeeping fields (`unavailable`, `checked_at`) to
// a `kind:"url"` screenshot once it's confirmed unreachable. materializeScreenshots()
// then strips those same fields back out when the client naturally re-submits
// them (any client that reads-then-writes does this — it is not a dash-ui-
// specific bug). The resulting JSON.stringify mismatch made updateFeedback()
// treat this as a genuine content edit and force status back to "queued",
// discarding whatever status the caller actually asked for — reproduced by
// hand against the real running dashboard on 2026-09-08 (a newMioDOC bug
// with a 404'd screenshot URL could never be moved out of its column).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-feedback-screenshot-status-"));
process.env.YANO_DATA_DIR = dataDir;
process.env.YANO_FEEDBACK_SKIP_NOTIFY = "1";

const { openDatabase, createFeedback, updateFeedback, getFeedback } = await import("./yano-feedback.mjs");

const db = openDatabase();

console.log("=== re-submitting an unchanged, already-repaired screenshot must not force status back to queued ===");
{
	const created = await createFeedback(db, {
		type: "bug",
		project_id: "demo",
		message: "il pulsante non funziona",
		screenshots: [{ url: "https://example.com/does-not-exist-404.png" }],
		require_credentials: false,
	});
	assert.equal(created.screenshots[0].kind, "url");

	// Force the exact shape repairFeedbackScreenshots() produces once it has
	// confirmed a URL is definitively unreachable (404/410) — set directly
	// against the DB so this assertion doesn't depend on network timing
	// (createFeedback() may or may not have already repaired it for real).
	const repaired = [{ ...created.screenshots[0], unavailable: true, checked_at: new Date().toISOString() }];
	db.prepare("UPDATE feedback SET screenshots=? WHERE id=?").run(JSON.stringify(repaired), created.id);
	const afterRepair = getFeedback(db, created.id);
	assert.equal(afterRepair.screenshots[0].unavailable, true, "sanity: repair marker is present before the update under test");

	// This mirrors exactly what a client does after GET-ing the item and
	// PUT-ing it back with only the status changed: it re-submits the
	// screenshots array verbatim, bookkeeping fields included.
	const updated = await updateFeedback(db, created.id, {
		message: afterRepair.message,
		title: afterRepair.title,
		severity: afterRepair.severity,
		route: afterRepair.route,
		environment: afterRepair.environment,
		screenshots: afterRepair.screenshots,
		status: "cancelled",
		audit_reason: "utente ha annullato il bug dal pannello di dettaglio",
	});

	assert.equal(updated.status, "cancelled", "il cambio di stato richiesto esplicitamente non deve mai essere scartato in silenzio");
}
console.log("   OK");

console.log("=== a GENUINE content edit (message actually changed) still correctly forces requeue ===");
{
	const created = await createFeedback(db, {
		type: "bug",
		project_id: "demo",
		message: "messaggio originale",
		require_credentials: false,
	});
	const updated = await updateFeedback(db, created.id, {
		message: "messaggio modificato davvero",
		status: "cancelled",
		audit_reason: "provo a modificare anche il messaggio",
	});
	assert.equal(updated.status, "queued", "una modifica di contenuto reale deve ancora forzare il rientro in coda — questo comportamento non va rimosso");
}
console.log("   OK");

db.close();
console.log("\nAll feedback screenshot/status-update regression tests passed.");
