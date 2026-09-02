// Smoke test for `yano docs-check` (Ticket #124): the deterministic-script
// replacement for the mechanical part of docs-sync's "verify the eight
// canonical categories" checklist. Verifies against real scratch project
// trees (mkdtemp), not mocks — the categories/legacy-path list must stay in
// sync with prompts/docs-sync.md and
// scripts/smoke-test-clean-repo-documentation-contract.mjs.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runYanoDocsCheck } from "./yano-docs-check.mjs";

function scratchProject() {
	return mkdtempSync(path.join(os.tmpdir(), "docs-check-smoke-"));
}

async function main() {
	console.log("1. a project with none of the eight categories reports every one as unsatisfied...");
	{
		const dir = scratchProject();
		const report = await runYanoDocsCheck({ cwd: dir, argv: ["--json"] });
		assert.equal(report.ok, false, "no docs/ at all — must report gaps");
		assert.equal(report.categories.length, 8, "must check all eight canonical categories");
		for (const c of report.categories) {
			assert.equal(c.exists, false, `${c.name} should not exist yet`);
			assert.equal(c.satisfied, false, `${c.name} should be unsatisfied`);
		}
		// No backend signal in an empty scratch dir — postman is not required.
		assert.equal(report.categories.find((c) => c.name === "postman").required, false, "postman should not be required without a backend signal");
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("2. a fully-satisfied project (all eight categories, each with a real non-empty file) reports ok:true...");
	{
		const dir = scratchProject();
		const docsRoot = path.join(dir, "docs");
		for (const category of ["architecture", "guides", "quick-guides", "adr", "notes", "postman", "cheat-sheet", "diagram"]) {
			const catDir = path.join(docsRoot, category);
			mkdirSync(catDir, { recursive: true });
			writeFileSync(path.join(catDir, "index.md"), `# ${category}\n\nreal content, not empty.\n`);
		}
		// Give it a backend signal so postman is actually required and still counts.
		mkdirSync(path.join(dir, "src", "api"), { recursive: true });
		const report = await runYanoDocsCheck({ cwd: dir, argv: ["--json"] });
		assert.equal(report.ok, true, `expected ok:true, got gaps: ${JSON.stringify(report.unsatisfied_required_categories)}`);
		assert.equal(report.postman_backend_heuristic.backend_likely, true, "src/api/ should trip the backend heuristic");
		assert.equal(report.categories.find((c) => c.name === "postman").required, true, "postman should be required once a backend is detected");
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("3. an empty category directory (created but no real file inside) is NOT satisfied — matches docs-sync's 'a directory created without a file does not satisfy the playbook'...");
	{
		const dir = scratchProject();
		mkdirSync(path.join(dir, "docs", "guides"), { recursive: true });
		const report = await runYanoDocsCheck({ cwd: dir, argv: ["--json"] });
		const guides = report.categories.find((c) => c.name === "guides");
		assert.equal(guides.exists, true);
		assert.equal(guides.satisfied, false, "an empty directory must not count as satisfied");
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("4. legacy paths with real content are flagged for migration, quick-guides/diagram not double-counted as satisfied by them...");
	{
		const dir = scratchProject();
		mkdirSync(path.join(dir, "docs", "quick_guides"), { recursive: true });
		writeFileSync(path.join(dir, "docs", "quick_guides", "old.md"), "legacy content\n");
		const report = await runYanoDocsCheck({ cwd: dir, argv: ["--json"] });
		assert.equal(report.legacy_paths_needing_migration.length, 1);
		assert.equal(report.legacy_paths_needing_migration[0].canonical_replacement, "quick-guides");
		assert.equal(report.ok, false, "legacy content pending migration must fail the check");
		assert.equal(report.categories.find((c) => c.name === "quick-guides").satisfied, false, "content sitting in the legacy path must not satisfy the canonical category");
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("5. stray files directly under docs/ (other than README.md) are flagged, README.md itself is allowed...");
	{
		const dir = scratchProject();
		mkdirSync(path.join(dir, "docs"), { recursive: true });
		writeFileSync(path.join(dir, "docs", "README.md"), "index\n");
		writeFileSync(path.join(dir, "docs", "architecture.md"), "stray\n");
		const report = await runYanoDocsCheck({ cwd: dir, argv: ["--json"] });
		assert.deepEqual(report.stray_files_under_docs, ["docs/architecture.md"], "only the non-README stray file should be flagged");
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("6. --project-root points the check at a different directory than cwd...");
	{
		const dir = scratchProject();
		mkdirSync(path.join(dir, "docs", "adr"), { recursive: true });
		writeFileSync(path.join(dir, "docs", "adr", "0001.md"), "decision\n");
		const report = await runYanoDocsCheck({ cwd: "/", argv: ["--project-root", dir, "--json"] });
		assert.equal(report.categories.find((c) => c.name === "adr").satisfied, true);
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("7. is read-only — running it never creates docs/ or any file (verified: no directories exist after two runs on an empty scratch project)...");
	{
		const dir = scratchProject();
		await runYanoDocsCheck({ cwd: dir, argv: ["--json"] });
		await runYanoDocsCheck({ cwd: dir, argv: ["--json"] });
		const { existsSync } = await import("node:fs");
		assert.equal(existsSync(path.join(dir, "docs")), false, "yano docs-check must never create docs/ itself");
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("\nYANO DOCS-CHECK SMOKE TEST PASSED");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : String(err));
	process.exit(1);
});
