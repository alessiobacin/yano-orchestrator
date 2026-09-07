#!/usr/bin/env node

import assert from "node:assert/strict";
import vm from "node:vm";
import { page, DASHBOARD_MODES } from "./yano-feedback-dashboard.mjs";

// 2026-09-06 — before this, the served <script> had TWO fatal SyntaxErrors
// (a single- instead of double-escaped \n/\s/\[/\]/\(/\)/\/ inside the outer
// yano-feedback-dashboard.mjs template literal, which the browser then saw
// as literal characters instead of regex escapes; and an arrow function
// using `await` without being declared `async`). Both killed the ENTIRE
// inline script — the board never rendered in any browser, ever — yet every
// prior assertion here only substring-matched the served HTML text, which
// can't detect "the JavaScript inside doesn't parse." This function is the
// permanent guard: it actually parses the served <script> content the same
// way a browser would, so a future escaping mistake fails a test instead of
// only ever surfacing as a silent blank page.
function assertScriptParses(html, label) {
	const match = html.match(/<script>([\s\S]*)<\/script>/);
	assert.ok(match, `${label}: must contain an inline <script> block`);
	try {
		new vm.Script(match[1], { filename: `${label}-inline-script.js` });
	} catch (error) {
		throw new Error(`${label}: served <script> is not valid JavaScript — a browser would fail to run ANY of it: ${error.message}`);
	}
}

const html = page("bug", "project-123", "newMioDOC");
assertScriptParses(html, "bug-dash");
assert.match(html, /timeZone:'Europe\/Rome'/);
assert.match(html, /Messaggio \*/);
assert.match(html, /multiple/);
assert.match(html, /dropzone/);
assert.match(html, /data-file-preview/);
assert.match(html, /position:sticky/);
assert.match(html, /card-main/);
assert.match(html, /function cleanUrl/);
assert.doesNotMatch(html, /test_password/);
assert.doesNotMatch(html, /test_username/);

// 2026-09-06 visual/functional overhaul: real drag & drop between columns,
// severity color-coding, per-column counts, empty-state, and a search box —
// previously draggable="true" was purely decorative (no ondragover/ondrop
// wired anywhere), every card had the exact same teal border regardless of
// severity, and there was no way to see how many items sat in a column or to
// filter a crowded board.
assert.match(html, /wireColumns/, "columns must have a drop handler, not just draggable cards");
assert.match(html, /col\.ondrop/, "dropping a card onto a column must be wired to an actual handler");
assert.match(html, /drag & drop/, "a drag-triggered status change must supply its own audit_reason (updateFeedback requires one)");
assert.match(html, /sev-critical/, "severity must map to a visual class, not just a form field");
assert.match(html, /class="count"/, "each column must show how many items it holds");
assert.match(html, /class="empty"/, "an empty column must say so instead of just being blank");
assert.match(html, /id="search"/, "a search/filter box must exist for a crowded board");
assert.match(html, /id="synced"/, "a last-refresh indicator must exist so the 5s polling isn't invisible");
assert.match(html, /data-status="/, "each column must carry its own status so a drop knows the target");

// The status column list is now used both by the served page (for its
// dropdown/Kanban columns) AND by the e2e test as the source of truth for
// which statuses are actually reachable per type — assert they still agree.
assert.equal(DASHBOARD_MODES.bug.label, "bug-dash");
assert.equal(DASHBOARD_MODES.suggestion.label, "suggest-dash");
assert.match(html, /<option value="resolved">/, "bug-dash must expose the 'resolved' terminal column that worktree_finalize now writes for a BUG- id");
assert.doesNotMatch(html, /<option value="processed">/, "bug-dash intentionally has no 'processed' column — a bug is 'resolved', not 'processed'");

const suggestionHtml = page("suggestion", "project-123", "newMioDOC");
assertScriptParses(suggestionHtml, "suggest-dash");
assert.match(suggestionHtml, /<option value="processed">/, "suggest-dash must expose the 'processed' terminal column that worktree_finalize now writes for a SUG- id");
assert.doesNotMatch(suggestionHtml, /<option value="resolved">/, "suggest-dash intentionally has no 'resolved' column — a suggestion is 'processed' (turned into a feature), not 'resolved'");

// createFeedback() lands a fresh record in 'pending_planner' whenever no live
// planner happened to be subscribed at creation time (the common case — see
// notifyPlanner in yano-feedback.mjs) — a column list missing this status
// made every such record invisible on its own board until something else
// moved it forward.
assert.doesNotMatch(html, /<option value="pending_planner">/, "bug-dash must not expose the obsolete pending_planner column");
assert.doesNotMatch(suggestionHtml, /<option value="pending_planner">/, "suggest-dash must not expose the obsolete pending_planner column");
assert.match(html, /onerror="this\.remove\(\)"/, "broken screenshot images must disappear instead of rendering a broken-image card");
assert.match(html, /attachments/, "local screenshot attachments must be served by the dashboard");
assert.match(html, /form\.reportValidity\(\)/, "validation must run on the HTML form, not on FormData");
assert.match(html, /new FormData\(form\)/, "the validated form must then be serialized for the request");
assert.doesNotMatch(html, /f\.reportValidity\(\)/, "FormData has no reportValidity method");
assert.match(html, /function renderExistingShots\(\)/, "editing a record must render already stored screenshots");
assert.match(html, /Rimuovi screenshot/, "stored screenshots must be removable from the edit dialog");
assert.match(html, /existingShots\.splice\(index,1\)/, "removing an existing screenshot must update the submitted collection");
assert.match(html, /!candidate\.unavailable/, "cards must not render screenshots marked unavailable");

console.log("FEEDBACK DASHBOARD SMOKE TEST PASSED");
