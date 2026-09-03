import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootIssues = path.join(repo, "issues");
const issueDir = path.join(repo, ".scratch", "optimize-orchestrator", "issues");

assert.equal(fs.existsSync(rootIssues), false, "la root issues/ non deve esistere");
const files = fs.readdirSync(issueDir).filter((file) => file.endsWith(".md"));
assert.ok(files.length > 0, "il tracker deve contenere issue");

for (const file of files) {
	const content = fs.readFileSync(path.join(issueDir, file), "utf8");
	const type = content.match(/^Type:\s*(\w+)\s*$/m)?.[1];
	const kind = content.match(/^Kind:\s*(\w+)\s*$/m)?.[1];
	assert.ok(["human"].includes(type), `${file}: Type deve essere human`);
	assert.ok(["research", "prototype", "grilling", "task"].includes(kind), `${file}: Kind non valido`);
	if (type === "human") assert.ok(kind, `: un issue human deve avere una categoria`);
}

console.log(`smoke-test-issue-layout: ok (${files.length} issue nel percorso canonico)`);
