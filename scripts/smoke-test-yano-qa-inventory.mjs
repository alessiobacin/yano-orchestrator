// Smoke test for `yano qa-inventory scan` (Ticket #124): the deterministic
// replacement for step 2 ("Raccogli le fonti dichiarate") of
// prompts/qa-inventory-analyst.md's protocol — mechanical source-gathering
// only, never the judgment calls (expected result, downstream effects,
// ambiguity) that stay the agent's job.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runYanoQaInventory } from "./yano-qa-inventory.mjs";

function scratchProject() {
	return mkdtempSync(path.join(os.tmpdir(), "qa-inventory-smoke-"));
}

async function main() {
	console.log("1. extracts CLI invocations from fenced code blocks in README.md, scoped to the declared bin name...");
	{
		const dir = scratchProject();
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", bin: { demo: "./bin/demo.mjs" } }));
		writeFileSync(
			path.join(dir, "README.md"),
			[
				"# Demo",
				"",
				"```bash",
				"demo init --name X",
				"demo start --instance foo",
				"# a comment, not a command",
				"unrelated-tool do-something   # must NOT be picked up, not the declared CLI",
				"```",
				"",
				"```powershell",
				"demo status --json",
				"```",
			].join("\n"),
		);
		const report = await runYanoQaInventory({ cwd: dir, argv: ["scan", "--json"] });
		const commands = report.command_candidates.map((c) => c.command);
		assert.ok(commands.includes("demo init"), `expected "demo init" in ${JSON.stringify(commands)}`);
		assert.ok(commands.includes("demo start"), `expected "demo start" in ${JSON.stringify(commands)}`);
		assert.ok(commands.includes("demo status"), "must scan powershell fences too, not just bash");
		assert.ok(!commands.some((c) => c.startsWith("unrelated-tool")), "must not pick up a CLI invocation that isn't the project's declared bin");
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("2. also scans docs/guides/**/*.md recursively, not just README.md...");
	{
		const dir = scratchProject();
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", bin: { demo: "./bin/demo.mjs" } }));
		mkdirSync(path.join(dir, "docs", "guides", "nested"), { recursive: true });
		writeFileSync(path.join(dir, "docs", "guides", "nested", "advanced.md"), "```bash\ndemo advanced-thing --flag\n```\n");
		const report = await runYanoQaInventory({ cwd: dir, argv: ["scan", "--json"] });
		assert.ok(report.command_candidates.some((c) => c.command === "demo advanced-thing" && c.source.includes("advanced.md")), "must find and correctly attribute the nested guide's command");
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("3. captures real --help output for a declared bin entry point that exists on disk...");
	{
		const dir = scratchProject();
		mkdirSync(path.join(dir, "bin"), { recursive: true });
		writeFileSync(path.join(dir, "bin", "demo.mjs"), "#!/usr/bin/env node\nconsole.log('demo --help output: usage demo <command>');\n", { mode: 0o755 });
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", bin: { demo: "./bin/demo.mjs" } }));
		const report = await runYanoQaInventory({ cwd: dir, argv: ["scan", "--json"] });
		assert.equal(report.help_outputs.length, 1);
		assert.ok(report.help_outputs[0].help_output && report.help_outputs[0].help_output.includes("usage demo"), "must actually capture the real --help output, not fake it");
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("4. a declared bin whose entry point doesn't exist on disk is skipped, not crashed on...");
	{
		const dir = scratchProject();
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", bin: { demo: "./bin/does-not-exist.mjs" } }));
		const report = await runYanoQaInventory({ cwd: dir, argv: ["scan", "--json"] });
		assert.equal(report.ok, true, "a missing bin entry point must not fail the scan — read-only discovery never errors out");
		assert.equal(report.help_outputs.length, 0);
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("5. --yano-self-audit lists agents/roles.yaml roles and playbooks/*.yaml ids, omitted by default...");
	{
		const dir = scratchProject();
		mkdirSync(path.join(dir, "agents"), { recursive: true });
		writeFileSync(path.join(dir, "agents", "roles.yaml"), "roles:\n  coder:\n    label: Coder\n    playbook: default\n    activation: always\n  reviewer:\n    label: Reviewer\n");
		mkdirSync(path.join(dir, "playbooks"), { recursive: true });
		writeFileSync(path.join(dir, "playbooks", "backend-change.yaml"), "id: backend-change\nstates: {}\n");

		const withoutFlag = await runYanoQaInventory({ cwd: dir, argv: ["scan", "--json"] });
		assert.equal(withoutFlag.yano_roles.length, 0, "without --yano-self-audit, role/playbook enumeration must be skipped");
		assert.equal(withoutFlag.yano_playbooks.length, 0);

		const withFlag = await runYanoQaInventory({ cwd: dir, argv: ["scan", "--yano-self-audit", "--json"] });
		assert.equal(withFlag.yano_roles.length, 2);
		assert.ok(withFlag.yano_roles.some((r) => r.role === "coder" && r.playbook === "default"));
		assert.equal(withFlag.yano_playbooks.length, 1);
		assert.equal(withFlag.yano_playbooks[0].id, "backend-change");
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("6. --project-root points the scan at a different directory than cwd...");
	{
		const dir = scratchProject();
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", bin: { demo: "./bin/demo.mjs" } }));
		writeFileSync(path.join(dir, "README.md"), "```bash\ndemo foo\n```\n");
		const report = await runYanoQaInventory({ cwd: "/", argv: ["scan", "--project-root", dir, "--json"] });
		assert.ok(report.command_candidates.some((c) => c.command === "demo foo"));
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("7. never crashes and always reports ok:true (read-only discovery) even with nothing to scan at all...");
	{
		const dir = scratchProject();
		const report = await runYanoQaInventory({ cwd: dir, argv: ["scan", "--json"] });
		assert.equal(report.ok, true);
		assert.equal(report.command_candidates.length, 0);
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("   OK");

	console.log("\nYANO QA-INVENTORY SMOKE TEST PASSED");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : String(err));
	process.exit(1);
});
