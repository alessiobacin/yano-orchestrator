#!/usr/bin/env node
import assert from "node:assert/strict";
import { assertAgentIdentityAvailable, findAgentIdentityConflicts, liveAgentIdentities } from "./yano-agent-identity.mjs";

const root = process.cwd();
const snapshot = {
	tabs: [
		{ tab_id: "t1", label: "planner-01" },
		{ tab_id: "t2", label: "planner-01" },
		{ tab_id: "t3", label: "planner-02" },
	],
	agents: [
		{ agent: "pi", agent_status: "working", cwd: root, tab_id: "t1", pane_id: "p1" },
		{ agent: "pi", agent_status: "working", cwd: root, tab_id: "t2", pane_id: "p2" },
		{ agent: "pi", agent_status: "working", cwd: root, tab_id: "t3", pane_id: "p3" },
	],
};

assert.equal(liveAgentIdentities(snapshot).length, 3);
const conflicts = findAgentIdentityConflicts(snapshot);
assert.ok(conflicts.some((conflict) => conflict.type === "duplicate_instance" && conflict.name === "planner-01"));
assert.throws(() => assertAgentIdentityAvailable({ snapshot, root, instance: "planner-01", role: "planner" }), /già in uso/);
assert.throws(() => assertAgentIdentityAvailable({ snapshot: { agents: [] }, root, instance: "planner", role: "planner" }), /planner con nome non valido/);
assert.doesNotThrow(() => assertAgentIdentityAvailable({ snapshot: { agents: [] }, root, instance: "planner-01", role: "planner" }));
console.log("smoke-test-yano-agent-identity: ok");
