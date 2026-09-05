// REAL functional test of scripts/launch-planner.mjs's Revisione 44
// generalization — launching ANY role (not just planner) through the same
// `-e` detection logic, with mattpocock skill flags attached ONLY for
// planner. Real incident this closes (see docs/notes/development-notes.md,
// Revisione 44): the planner's own prompt (prompts/planner.md) hand-composed
// `pi -e extensions/orchestrator.ts --instance <nome> --role <ruolo>` to
// launch coder/reviewer/specialist instances via Herdr — stale advice
// since Revisione 33 (a scaffolded project has no local extensions/orchestrator.ts
// any more), so the spawned `pi` process errored out immediately and the
// Herdr pane died on the spot. This script (and `yano start`)
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

// Isolate from the REAL machine's global Yano config. Fase 0 made
// sendNotifications() fall back to the global notification channel when a
// project has no local .env — on a real developer machine with real
// Telegram/WhatsApp credentials configured globally, an unisolated test
// that reaches a notification code path WILL send a real message. Must be
// set before extensions/orchestrator.ts is imported anywhere below.
// (Dependency-free: does not assume node:path/node:os are imported here.)
if (!process.env.YANO_CONFIG_FILE) process.env.YANO_CONFIG_FILE = `${process.env.TMPDIR || "/tmp"}/yano-test-isolation-no-such-config.env`;


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const LAUNCH_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "launch-planner.mjs");

let PASS = 0;
function ok(cond, msg) {
	if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
	PASS++;
	console.log(`   OK — ${msg}`);
}

function run(cwd, args, extraEnv = {}) {
	const result = spawnSync("node", [LAUNCH_SCRIPT, ...args], { cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
	return `${result.stdout || ""}${result.stderr || ""}`;
}

function scratchDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function modernScaffold() {
	const dir = scratchDir("yano-any-role-scaffold");
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
	ok(coderOut.includes("--project any-role-test-project"), "coder: derived project scope is passed explicitly to the child Pi process");
	ok(!coderOut.includes("--config-dir .pi/agents"), "coder: modern root roster does not inherit a legacy config directory");
	ok(coderOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "yano", "yano-planner-trace-analysis")), "coder: receives the shared Yano trace skill");
	ok(!coderOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "mattpocock")), "coder: receives no planner-only mattpocock skills");
ok(!coderOut.includes("-e extensions/orchestrator.ts"), "coder: no stale -e flag (modern scaffold, relies on global install)");

	console.log("\n=== TEST 1a — --herdr is a launcher-owned, scoped mode ===");
	const herdrOut = run(dir, ["--herdr", "--instance", "coder-01", "--role", "coder", "--print-only", "--json"]);
	const herdrPlan = JSON.parse(herdrOut.trim());
	ok(herdrPlan.command === "herdr agent start", "--herdr selects the scoped Herdr launcher instead of a raw Pi process");
	ok(herdrPlan.args.includes("--project") && herdrPlan.args.includes("any-role-test-project"), "--herdr preserves the derived project scope for the child agent");

	console.log("\n=== TEST 1b — a human project name cannot fork the MQTT scope ===");
	const namedDir = scratchDir("yano-display-name-scope");
	fs.mkdirSync(path.join(namedDir, ".pi", "extensions", "yano-orchestrator", "config"), { recursive: true });
	fs.writeFileSync(path.join(namedDir, "package.json"), JSON.stringify({ name: "display-name-scope-test" }, null, 2));
	fs.writeFileSync(path.join(namedDir, ".pi", "extensions", "yano-orchestrator", "config", "project.json"), JSON.stringify({ project: "Manual E2E 08 Refactor Playbook" }));
	const displayNameOut = run(namedDir, ["--instance", "coder-01", "--role", "coder", "--project", "Manual E2E 08 Refactor Playbook", "--print-only"]);
	ok(displayNameOut.includes("--project manual-e2e-08-refactor-playbook"), "display project name is normalized to the root's canonical MQTT scope");
	ok(!displayNameOut.includes("--project \"Manual E2E 08 Refactor Playbook\""), "display project name is not passed verbatim to the child Pi process");

console.log("\n=== TEST 1b — an llmProxy catalog pin is translated to Pi's configured provider ===");
const pinnedOut = run(dir, ["--instance", "debater-01", "--role", "debater", "--llmproxy-pin", "z-ai/glm-5.3-flash@openrouter-glm", "--print-only"]);
ok(pinnedOut.includes("--provider llmproxy --model z-ai/glm-5.3-flash@openrouter-glm"), "llmProxy pin: composed command uses Pi provider llmproxy and the complete model@provider-id pin");
ok(!pinnedOut.includes("--provider openrouter-glm"), "llmProxy pin: catalog id is never emitted as a Pi provider");
ok(!pinnedOut.includes("--llmproxy-pin"), "llmProxy pin: Yano-only flag is consumed before Pi launch");

console.log("\n=== TEST 2 — --role reviewer: backend reviewer gets no frontend browser skill ===");
const reviewerOut = run(dir, ["--instance", "reviewer-01", "--role", "reviewer", "--print-only"]);
ok(reviewerOut.includes("--role reviewer"), "reviewer: composed command carries --role reviewer");
ok(!reviewerOut.includes("chrome-devtools"), "reviewer: does not receive chrome-devtools");
ok(reviewerOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "yano", "yano-code-review")), "reviewer: receives the Yano two-axis code-review adapter");
	for (const name of ["wayfinder", "to-spec", "to-tickets", "grilling", "domain-modeling", "setup-matt-pocock-skills"]) {
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
ok(frontendReviewerOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "yano", "yano-code-review")), "frontend-reviewer: receives the Yano two-axis code-review adapter");

	console.log("\n=== TEST 3 — --role omitted still defaults to planner WITH the skill flags (backward compatible) ===");
	const defaultOut = run(dir, ["--instance", "planner-01", "--print-only"]);
	ok(defaultOut.includes("--role planner"), "default (no --role passed): resolves to planner");
	ok(defaultOut.includes("--project any-role-test-project"), "planner: derived project scope is passed explicitly too");
	ok(defaultOut.includes("--skill"), "default (no --role passed): mattpocock skill flags ARE attached, exactly as before Revisione 44");
	ok(defaultOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "yano", "yano-planner-trace-analysis")), "planner: receives the mandatory Yano trace-analysis skill");
	ok(
		!defaultOut.includes(path.join(PACKAGE_ROOT, "skills-vendor", "awesome-copilot", "chrome-devtools")),
		"planner: does NOT receive --skill chrome-devtools (Revisione 49 — reviewer/frontend-developer only)",
	);

	console.log("\n=== TEST 3b — an Architect ephemeral role is launchable before promotion ===");
	const ephemeralData = scratchDir("yano-ephemeral-proposal");
	const proposalId = "PROP-EPHEMERAL-LAUNCH";
	const proposalDir = path.join(ephemeralData, "architect", "proposals", proposalId);
	fs.mkdirSync(proposalDir, { recursive: true });
	fs.writeFileSync(path.join(proposalDir, "playbook.yaml"), "schema_version: 1\nid: knowledge-authoring\nstates: []\n");
	fs.writeFileSync(path.join(proposalDir, "manifest.json"), JSON.stringify({
		proposal_id: proposalId,
		status: "ephemeral",
		project: { root: dir, name: "any-role-test-project" },
		playbook_id: "knowledge-authoring",
		role_id: "business-docs-author",
		roles: ["business-docs-author"],
		capabilities: { skills: [], cli: ["git"], mcp: [] },
	}, null, 2));
	fs.writeFileSync(path.join(proposalDir, "readiness.json"), JSON.stringify({ ready: true, operational: true, status: "ready_ephemeral", checks: [{ kind: "cli", name: "git", status: "ready" }] }, null, 2));
	const ephemeralOut = run(dir, ["--instance", "business-docs-author-01", "--role", "business-docs-author", "--proposal-id", proposalId, "--print-only"], { YANO_DATA_DIR: ephemeralData });
	ok(ephemeralOut.includes("--role business-docs-author"), "ephemeral role: role reaches the Pi command");
	ok(!ephemeralOut.includes(`--proposal-id ${proposalId}`), "ephemeral role: proposal control flag is consumed by Yano and not leaked to Pi");
	ok(ephemeralOut.includes(path.join(ephemeralData, "architect", "runtime-config")), "ephemeral role: runtime config is created outside the project");
	ok(fs.existsSync(path.join(ephemeralData, "architect", "runtime-config", "any-role-test-project", "business-docs-author", "roles.yaml")), "ephemeral role: runtime role manifest exists");
	ok(fs.existsSync(path.join(ephemeralData, "architect", "runtime-config", "any-role-test-project", "business-docs-author", "playbooks", "knowledge-authoring.yaml")), "ephemeral role: the generated playbook is exposed to the launched role");

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
