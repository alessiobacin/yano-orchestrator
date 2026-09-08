#!/usr/bin/env node
import assert from "node:assert/strict";
import { deriveCoderActivity, executionForFeedback } from "./yano-feedback-activity.mjs";

const now = Date.parse("2026-09-08T10:00:00.000Z");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

console.log("Regression: dashboard activity must show real coder evidence");
const runs = [{ id: "run-1", tickets: [{ id: "ticket-1", title: "BUG-abc fix", description: "", status: "running", assigned_instance: "coder-01", updated_at: "2026-09-08T09:59:00.000Z" }] }];
const heartbeats = [{ instance: "coder-01", role: "coder", status: "busy", found: true, observed_at: "2026-09-08T09:59:50.000Z" }];
const events = [{ instance: "coder-01", role: "coder", type: "tool_execution_start", tool: "bash", ts: "2026-09-08T09:59:55.000Z" }];

check("busy coder with a fresh heartbeat is active", () => {
	const activity = deriveCoderActivity({ runs, heartbeats, events, now });
	assert.equal(activity.state, "active");
	assert.equal(activity.coders[0].state, "active");
	assert.equal(activity.coders[0].current_tool, "bash");
});

check("a processing feedback without a matching ticket is explicitly not linked", () => {
	const activity = deriveCoderActivity({ runs, heartbeats, events, now });
	const execution = executionForFeedback({ id: "BUG-not-linked" }, activity);
	assert.equal(execution.state, "not_linked");
	assert.equal(execution.evidence, "planner_claim_only");
});

check("a feedback id in the ticket is linked to the actual coder", () => {
	const activity = deriveCoderActivity({ runs, heartbeats, events, now });
	const execution = executionForFeedback({ id: "BUG-abc" }, activity);
	assert.equal(execution.state, "active");
	assert.equal(execution.ticket.id, "ticket-1");
	assert.equal(execution.coder.instance, "coder-01");
});

check("a stale heartbeat cannot be reported as active", () => {
	const activity = deriveCoderActivity({ runs, heartbeats: [{ ...heartbeats[0], status: "busy", observed_at: "2026-09-08T09:55:00.000Z" }], events: [], now });
	const execution = executionForFeedback({ id: "BUG-abc" }, activity);
	assert.equal(execution.state, "offline");
});

console.log(`\nsmoke-test-feedback-activity: ${passed} passed`);
