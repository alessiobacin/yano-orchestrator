#!/usr/bin/env node

// Regression guard for a critical latent bug found on 2026-09-06 while
// building the "structured lessons" feature: `writeBounded(files.role,
// previousRole || header + roleBody, ...)` — JS `+` binds tighter than `||`,
// so this parsed as `previousRole || (header + roleBody)`. Once role.md (or
// user-preferences.md, same pattern) had ANY content, every subsequent
// updateAgentMemory() call for that role silently rewrote the file with its
// OWN unchanged previous content, discarding the new turn's entry entirely.
// In production this meant role memory froze after the very first turn of
// the very first instance of a role, for the entire lifetime of a project —
// completely defeating the purpose of a persistent, evolving memory. The
// existing smoke-test-agent-memory.mjs never caught this because it only
// asserts "Round 1 is still present" after a second call, which is true
// whether or not Round 2 was ever actually appended.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryPaths, updateAgentMemory } from "./yano-agent-memory.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-agent-memory-accum-"));
try {
	const common = { root, project: "accum-project", role: "coder", instance: "coder-01" };
	const files = memoryPaths(common);

	updateAgentMemory({ ...common, turnIndex: 1, branch: [{ role: "assistant", content: "Primo turno completato." }] });
	updateAgentMemory({ ...common, turnIndex: 2, branch: [{ role: "assistant", content: "Secondo turno completato." }] });
	updateAgentMemory({ ...common, turnIndex: 3, branch: [{ role: "assistant", content: "Terzo turno completato." }] });
	const roleContent = fs.readFileSync(files.role, "utf8");
	assert.match(roleContent, /Round 1/, "round 1 must still be present");
	assert.match(roleContent, /Round 2/, "round 2 must actually be appended, not silently dropped by the previousRole||header+body precedence bug");
	assert.match(roleContent, /Round 3/, "round 3 must actually be appended too");
	assert.match(roleContent, /Secondo turno completato/, "round 2's own content must be present, not just its header");
	assert.match(roleContent, /Terzo turno completato/, "round 3's own content must be present, not just its header");

	updateAgentMemory({ ...common, turnIndex: 4, branch: [{ role: "user", content: "Preferisco sempre usare pnpm invece di npm." }] });
	updateAgentMemory({ ...common, turnIndex: 5, branch: [{ role: "user", content: "Non voglio mai che tu tocchi il branch main direttamente." }] });
	const preferencesContent = fs.readFileSync(files.preferences, "utf8");
	assert.match(preferencesContent, /pnpm/, "the first recorded preference must be present");
	assert.match(preferencesContent, /branch main direttamente/, "a SECOND, later preference must also be appended, not dropped by the same precedence bug");

	console.log("smoke-test-agent-memory-accumulation: ok");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
