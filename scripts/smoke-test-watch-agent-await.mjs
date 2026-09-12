import assert from "node:assert/strict";
import { detectAwaitStalls } from "./watch-stalls.mjs";

const assignment = "01M20PJM48600RME08HJFJZZRS";
const records = [
	{
		ts: "2026-09-08T14:55:57.905Z",
		type: "tool_execution_end_payload",
		instance: "planner-01",
		role: "planner",
		tool: "agent_await",
		args: { assignment_id: assignment },
		result: { details: { error: "timeout" }, content: [{ type: "text", text: "agent_await: error — timeout" }] },
	},
	{
		ts: "2026-09-08T14:57:39.365Z",
		type: "tool_execution_end_payload",
		instance: "planner-01",
		role: "planner",
		tool: "agent_await",
		args: { assignment_id: assignment },
		result: { details: { error: "timeout" }, content: [{ type: "text", text: "agent_await: error — timeout" }] },
	},
];

const findings = detectAwaitStalls(records, {
	now: Date.parse("2026-09-08T15:00:00.000Z"),
	minTimeouts: 2,
});

assert.equal(findings.length, 1);
assert.equal(findings[0].assignment_id, assignment);
assert.equal(findings[0].instance, "planner-01");
assert.equal(findings[0].timeouts, 2);
console.log("WATCH-AGENT-AWAIT SMOKE TEST PASSED");
