// REAL functional test of scripts/launch-planner.mjs's Revisione 44
// generalization — launching ANY role (not just planner) through the same
// `-e` detection logic, with mattpocock skill flags attached ONLY for
// planner. Real incident this closes (see docs/development-notes.md,
// Revisione 44): the planner's own prompt (prompts/planner.md) hand-composed
// `pi -e extensions/orchestrator.ts --instance <nome> --role <ruolo>` to
// launch coder/reviewer/specialist instances via herdr/tmux — stale advice
// since Revisione 33 (a scaffolded project has no local extensions/orchestrator.ts
// any more), so the spawned `pi` process errored out immediately and the
// herdr pane/tmux session died on the spot. This script (and `yano start`)
// previously refused any --role other than "planner" outright, pointing
// operators/the planner right back at that same stale command. Fixed: any
// role now goes through the identical, already-correct `-e`
// detection/composition logic used for planner.
//
// Revisione 49: reviewer now DOES receive a --skill flag (chrome-devtools,
// vendored skill (see VERSION.md there), same mechanism as
// planner's mattpocock skills. TEST 2 below was updated accordingly: it now
// asserts reviewer gets exactly the chrome-devtools skill plus the shared Yano
// trace skill and NONE of the mattpocock ones.
//
// Spawns the REAL scripts/launch-planner.mjs as a child process (never a
// hand-copied mirror), same as `yano start --instance <x> --role <y>
// --print-only` would.
//
// Usage: node scripts/smoke-test-launch-any-role.mjs

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const LAUNCH_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "launch-planner.mjs");

let PASS = 0;
function ok(cond, msg) {
	if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
	PASS++;
	console.log(`   OK — ${msg}`);
}

function run(cwd, args) {
	const result = spawnSync("node", [LAUNCH_SCRIPT, ...args], { cwd, encoding: "utf8" });
	return `${result.stdout || ""}${result.stderr || ""}`;
}

function scratchDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function modernScaffold() {
	const dir = scratchDir("moa-any-role-scaffold");
	fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "any-role-test-project" }, null, 2));
	fs.writeFileSync(path.join(dir, "agents", "roles.yaml"), "roles: {}\n");
	return dir;
}

function main() {
	const dir = modernScaffold();

	console.log("\n=== TEST 1 — --role coder composes correctly, WITHOUT the mattpocock skill flags ===");
	const coderOut = run(dir, ["--instance", "coder-01", "--role", "coder", "--print-only"]);
	ok(/comando composto/.test(coderOut), "coder: command is printed (launch not refused, unlike pre-Revisione-44 behavior)");
	ok(coderOut.includes("--role coder"), "coder: composed command carries --role coder");
	ok(coderOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "yano", "yano-planner-trace-analysis")), "coder: receives the shared Yano trace skill");
	ok(!coderOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "mattpocock")), "coder: receives no planner-only mattpocock skills");
	ok(!coderOut.includes("-e extensions/orchestrator.ts"), "coder: no stale -e flag (modern scaffold, relies on global install)");

	console.log("\n=== TEST 2 — --role reviewer: backend reviewer gets no frontend browser skill ===");
	const reviewerOut = run(dir, ["--instance", "reviewer-01", "--role", "reviewer", "--print-only"]);
	ok(reviewerOut.includes("--role reviewer"), "reviewer: composed command carries --role reviewer");
	ok(!reviewerOut.includes("chrome-devtools"), "reviewer: does not receive chrome-devtools");
	for (const name of ["wayfinder", "to-spec", "grilling", "domain-modeling", "setup-matt-pocock-skills"]) {
		ok(
			!reviewerOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "mattpocock", name)),
			`reviewer: does NOT receive the mattpocock skill '${name}' (stays planner-only)`,
		);
	}

	console.log("\n=== TEST 2b — --role frontend-developer: gets chrome-devtools ===");
	const frontendOut = run(dir, ["--instance", "frontend-01", "--role", "frontend-developer", "--print-only"]);
	ok(frontendOut.includes("--role frontend-developer"), "frontend-developer: composed command carries --role frontend-developer");
	ok(
		frontendOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "awesome-copilot", "chrome-devtools")),
		"frontend-developer: DOES receive --skill chrome-devtools (Revisione 49)",
	);
	console.log("\n=== TEST 2c — --role frontend-reviewer: gets chrome-devtools ===");
	const frontendReviewerOut = run(dir, ["--instance", "frontend-reviewer-01", "--role", "frontend-reviewer", "--print-only"]);
	ok(frontendReviewerOut.includes("--role frontend-reviewer"), "frontend-reviewer: composed command carries role");
	ok(frontendReviewerOut.includes("chrome-devtools"), "frontend-reviewer: receives chrome-devtools");

	console.log("\n=== TEST 3 — --role omitted still defaults to planner WITH the skill flags (backward compatible) ===");
	const defaultOut = run(dir, ["--instance", "planner-01", "--print-only"]);
	ok(defaultOut.includes("--role planner"), "default (no --role passed): resolves to planner");
	ok(defaultOut.includes("--skill"), "default (no --role passed): mattpocock skill flags ARE attached, exactly as before Revisione 44");
	ok(defaultOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "yano", "yano-planner-trace-analysis")), "planner: receives the mandatory Yano trace-analysis skill");
	ok(
		!defaultOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "awesome-copilot", "chrome-devtools")),
		"planner: does NOT receive --skill chrome-devtools (Revisione 49 — reviewer/frontend-developer only)",
	);

	console.log("\n=== TEST 4 — a --session <id> (or any other unrecognized flag) passes through untouched ===");
	const sessionOut = run(dir, ["--instance", "coder-01", "--role", "coder", "--session", "01M0JKKF0YYBJZWZKCDPG3AM1D", "--print-only"]);
	ok(sessionOut.includes("--session 01M0JKKF0YYBJZWZKCDPG3AM1D"), "generic passthrough: --session <id> reaches the composed pi command verbatim (nothing in launch-planner.mjs intercepts it)");

	console.log("\n=== TEST 5 — --role as the last argument, with no value at all, is rejected clearly ===");
	const missingRoleResult = spawnSync("node", [LAUNCH_SCRIPT, "--instance", "x-01", "--role"], { cwd: dir, encoding: "utf8" });
	ok(missingRoleResult.status !== 0, "--role with no value at all: exits non-zero");
	ok(/richiede un valore/.test(`${missingRoleResult.stdout || ""}${missingRoleResult.stderr || ""}`), "--role with no value at all: clear error message, not a silent default");

	console.log(`\n${PASS} assertions passed.`);
}

try {
	main();
	console.log("LAUNCH-ANY-ROLE SMOKE TEST PASSED");
	process.exit(0);
} catch (err) {
	console.error("\nLAUNCH-ANY-ROLE SMOKE TEST FAILED:", err);
	process.exit(1);
}
