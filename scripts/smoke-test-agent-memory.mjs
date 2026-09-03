import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MEMORY_LIMITS, loadAgentMemory, memoryPaths, updateAgentMemory } from "./yano-agent-memory.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-agent-memory-"));
try {
	const common = { root, project: "memory-project", role: "coder", instance: "coder-01" };
	updateAgentMemory({ ...common, turnIndex: 1, branch: [{ role: "user", content: "Preferisco mantenere questa convenzione e non usare script distruttivi." }, { role: "assistant", content: "Ho applicato la convenzione richiesta." }] });
	const first = memoryPaths(common);
	assert.ok(fs.existsSync(first.role), "la memoria del ruolo viene creata come Markdown");
	assert.ok(fs.existsSync(first.preferences), "le preferenze esplicite hanno un file separato");
	assert.ok(fs.existsSync(first.instance), "la memoria diagnostica dell'istanza viene creata");
	assert.match(loadAgentMemory(common), /convenzione|Prima di una scelta/i, "la memoria viene reiniettata nel prompt");
	updateAgentMemory({ root, project: common.project, role: "coder", instance: "coder-02", turnIndex: 2, branch: [{ role: "assistant", content: "Ho ripreso il lavoro precedente." }] });
	assert.match(fs.readFileSync(first.role, "utf8"), /Round 1/, "la memoria è condivisa tra istanze dello stesso ruolo");
	assert.ok(fs.existsSync(memoryPaths({ ...common, instance: "coder-02" }).instance), "il nuovo coder ha la propria traccia diagnostica");
	assert.ok(fs.existsSync(first.instance), "la memoria del coder ucciso resta disponibile");
	assert.ok(fs.statSync(first.role).size <= MEMORY_LIMITS.role, "la memoria del ruolo resta entro il limite");
	assert.ok(fs.statSync(first.instance).size <= MEMORY_LIMITS.instance, "la memoria diagnostica resta entro il limite");
	console.log("smoke-test-agent-memory: ok");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
