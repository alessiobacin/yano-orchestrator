// Regression smoke test for the global active-project inventory.
// The command must count distinct initialized Yano roots, not external workers
// only, retained MQTT cards, or every visible terminal in Herdr.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listYanoProjects } from "./yano-projects.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-projects-smoke-"));
const projectRoots = ["alpha-app", "beta-app", "not-yano"]
	.map((name) => path.join(tempRoot, name));

try {
	for (const root of projectRoots) fs.mkdirSync(path.join(root, "agents"), { recursive: true });
	for (const root of projectRoots.slice(0, 2)) {
		fs.writeFileSync(path.join(root, "agents", "roles.yaml"), "roles: {}\n");
	}

	const snapshot = {
		workspaces: [{ workspace_id: "w1", label: "alpha" }],
		tabs: [{ tab_id: "w1:t1", label: "alpha-planner" }],
		panes: [
			{ pane_id: "p1", agent: "pi", agent_status: "idle", agent_instance: "planner-01", cwd: projectRoots[0], workspace_id: "w1", tab_id: "w1:t1" },
			{ pane_id: "p2", agent: "pi", agent_status: "busy", agent_instance: "coder-01", cwd: projectRoots[0], workspace_id: "w1", tab_id: "w1:t1" },
			{ pane_id: "p3", agent: "pi", status: "running", instance: "reviewer-01", cwd: projectRoots[1] },
			{ pane_id: "p4", agent: "pi", agent_status: "offline", agent_instance: "planner-old", cwd: projectRoots[1] },
			{ pane_id: "p5", agent: "codex", agent_status: "busy", instance: "codex-01", cwd: projectRoots[2] },
			{ pane_id: "p6", agent: "pi", agent_status: "idle", agent_instance: "planner-orphan", cwd: projectRoots[2] },
		],
		// Herdr may expose identity details in `agents`; the same pane must not
		// be counted twice when it is present in both collections.
		agents: [
			{ pane_id: "p1", agent: "pi", agent_status: "idle", agent_instance: "planner-01" },
			{ pane_id: "p3", agent: "pi", agent_status: "running", agent_instance: "reviewer-01" },
		],
	};

	const result = listYanoProjects({ snapshot });
	assert.equal(result.herdr_reachable, true);
	assert.equal(result.project_count, 2, "deve contare due root Yano distinte");
	assert.deepEqual(result.projects.map((project) => project.name), ["alpha-app", "beta-app"]);
	const alpha = result.projects.find((project) => project.name === "alpha-app");
	const beta = result.projects.find((project) => project.name === "beta-app");
	assert.equal(alpha.live_agent_count, 2, "planner e coder live della stessa root sono un solo progetto");
	assert.equal(beta.live_agent_count, 1, "la pane offline non deve risultare live");
	assert.equal(alpha.agents.find((agent) => agent.role === "planner")?.instance, "planner-01");
	assert.equal(beta.agents[0].role, "reviewer");

	const unavailable = listYanoProjects({ snapshot: null });
	assert.equal(unavailable.herdr_reachable, false);
	assert.equal(unavailable.project_count, null, "Herdr irraggiungibile non equivale a zero progetti");

	console.log("smoke-test-yano-projects: ok");
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
