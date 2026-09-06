#!/usr/bin/env node

// Regression/feature guard for the "structured lessons" enhancement to
// yano-agent-memory.mjs (2026-09-06): before this, updateAgentMemory() only
// ever recorded a raw last-assistant-message snippet per turn — no explicit
// signal of WHAT failed, WHY, or that the SAME failure is being hit again.
// An agent instance restarted after a kill/compact had no structured way to
// know "I already tried this and it didn't work."
//
// toolFailures is a new, optional, purely additive parameter: an array of
// { tool, error } pairs the caller (extensions/orchestrator.ts, via its
// tool_execution_end hook) collects for the current turn. This module stays
// a pure, deterministic string-formatting layer — no LLM call, no new cost —
// which is what makes it safe to run on every single turn.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAgentMemory, memoryPaths, updateAgentMemory } from "./yano-agent-memory.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-agent-memory-lessons-"));
try {
	const common = { root, project: "lessons-project", role: "coder", instance: "coder-01" };
	const files = memoryPaths(common);

	updateAgentMemory({ ...common, turnIndex: 1, branch: [] });
	const afterEmpty = fs.readFileSync(files.role, "utf8");
	assert.doesNotMatch(afterEmpty, /TENTATIVO FALLITO|RIPETUTO/, "no toolFailures passed — the existing raw-log format must be completely unchanged (backward compatible)");

	updateAgentMemory({
		...common,
		turnIndex: 2,
		branch: [],
		toolFailures: [{ tool: "worktree_finalize", error: "merge conflict in src/util.ts: unresolved marker <<<<<<<" }],
	});
	const afterFirstFailure = fs.readFileSync(files.role, "utf8");
	assert.match(afterFirstFailure, /\[TENTATIVO FALLITO\] worktree_finalize: merge conflict in src\/util\.ts/, "a first-time failure must be recorded with tool name and error excerpt");
	assert.doesNotMatch(afterFirstFailure, /RIPETUTO/, "a failure seen for the first time must not be flagged as repeated");

	updateAgentMemory({
		...common,
		turnIndex: 3,
		branch: [],
		toolFailures: [{ tool: "worktree_finalize", error: "merge conflict in src/util.ts: unresolved marker <<<<<<<" }],
	});
	const afterRepeat = fs.readFileSync(files.role, "utf8");
	assert.match(afterRepeat, /\[RIPETUTO — NON RIPROVARE COSÌ\] worktree_finalize: merge conflict in src\/util\.ts/, "the EXACT SAME tool+error the next turn must be escalated to a repeat warning — this is the core 'do not retry what already failed' signal");

	updateAgentMemory({
		...common,
		turnIndex: 4,
		branch: [],
		toolFailures: [{ tool: "worktree_finalize", error: "dirty main checkout: uncommitted changes present" }],
	});
	const afterDifferentError = fs.readFileSync(files.role, "utf8");
	const round4 = afterDifferentError.slice(afterDifferentError.indexOf("Round 4"));
	assert.match(round4, /\[TENTATIVO FALLITO\] worktree_finalize: dirty main checkout/, "a DIFFERENT error for the same tool must not be misclassified as a repeat of the earlier, unrelated failure");
	assert.doesNotMatch(round4, /RIPETUTO/, "round 4's own entry must not claim a repeat it didn't have");

	const injected = loadAgentMemory(common);
	assert.match(injected, /RIPETUTO — NON RIPROVARE COSÌ/, "the repeat warning must actually reach the reinjected prompt content, not just sit unread in the file");

	console.log("smoke-test-agent-memory-lessons: ok");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
