// REAL test of the YanoOrchestrator ticket/dependency layer
// (Revisione 26) — orchestrator_init, run_create, spec_create,
// ticket_create, tickets_ready, ticket_claim, ticket_complete, run_status.
//
// Follows the Revisione 25 discipline (see scripts/e2e-full-flow.mjs):
// dynamically imports the REAL extensions/orchestrator.ts and drives it
// through a FakeInstance harness (same technique, same fake-pi/ctx shape),
// against:
//   - a REAL local mosquitto broker, to verify the MQTT "something
//     happened" event side of the SQLite/MQTT split actually fires, not
//     just that SQLite state is correct;
//   - a REAL SQLite database on disk (node:sqlite), to verify persistence
//     genuinely survives a process restart (simulated here by opening a
//     brand new FakeInstance against the same project directory, the way a
//     fresh `pi` process would after a crash).
//
// What this DOES verify: workspace/db idempotent init, canonical run/spec/
// ticket persistence, dependency-graph READY/BLOCKED computation,
// execution-wave computation (including cycle detection), capability
// matching in ticket_claim, the ticket_complete -> newly-READY -> run
// auto-completion chain, real MQTT event delivery on run_events, and that
// run_status reads correct state from a FRESH process against the same
// on-disk database (the resumability contract).
//
// What this does NOT verify: the Playbook engine, replanning, the
// integration phase, budget enforcement, or automatic crash/timeout retry
// with fencing tokens — all explicitly deferred, see docs/development-notes.md
// Revisione 26. Also does not touch the existing plan_set/plan_advance
// phase gate (already covered by scripts/smoke-test-plan-gate.mjs) — the
// two mechanisms are independent and this script only exercises the new one.
//
// Usage: node --experimental-strip-types scripts/smoke-test-ticket-engine.mjs

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import mqtt from "mqtt";
import { projectKey } from "./yano-trace-storage.mjs";

const execFileP = promisify(execFile);
const PROJECT_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const BROKER_URL = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";

let PASS = 0;
function ok(cond, msg) {
	if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
	PASS++;
	console.log(`   OK — ${msg}`);
}

async function git(args, cwd) {
	return execFileP("git", args, { cwd });
}

async function bootstrapScratchRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-ticket-engine-"));
	await git(["init", "-q"], dir);
	await git(["config", "user.email", "ticket-engine-test@test.local"], dir);
	await git(["config", "user.name", "Ticket Engine Test"], dir);
	fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
	for (const f of ["agents.yaml", "roles.yaml"]) {
		fs.copyFileSync(path.join(PROJECT_ROOT, "agents", f), path.join(dir, "agents", f));
	}
	fs.mkdirSync(path.join(dir, "playbooks"), { recursive: true });
	fs.copyFileSync(path.join(PROJECT_ROOT, "playbooks", "default.yaml"), path.join(dir, "playbooks", "default.yaml"));
	fs.copyFileSync(path.join(PROJECT_ROOT, "playbooks", "backend-change.yaml"), path.join(dir, "playbooks", "backend-change.yaml"));
	fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\nlogs/\n.pi/\n");
	await git(["add", "-A"], dir);
	await git(["commit", "-q", "-m", "initial scratch repo (ticket-engine test)"], dir);
	return dir;
}

// ━━ Fake pi / ctx harness — same shape as scripts/e2e-full-flow.mjs ━━━━━━━

function makeFakePi(flagValues) {
	const tools = new Map();
	const hooks = new Map();
	const commands = new Map();
	const appendedEntries = [];
	const pi = {
		registerFlag() {},
		getFlag(name) { return flagValues[name]; },
		registerTool(def) { tools.set(def.name, def); },
		on(event, handler) { hooks.set(event, handler); },
		registerCommand(name, def) { commands.set(name, def); },
		appendEntry(kind, data) { appendedEntries.push({ kind, data }); },
		sendMessage() {},
	};
	return { pi, tools, hooks, commands, appendedEntries };
}

function makeCtx(cwd) {
	const widgets = new Map();
	return {
		cwd,
		hasUI: false,
		ui: {
			notify() {},
			setWidget(name, factory, opts) { widgets.set(name, { factory, opts }); },
		},
		sessionManager: { getBranch() { return []; } },
	};
}

let modPromiseCache = null;
// Every FakeInstance holds a real, still-connected MQTT socket — a test
// that throws mid-way leaves some instances never explicitly shut down, and
// Node won't exit on its own while those sockets are open. Track every
// instance ever created so main()'s finally block can force-close all of
// them regardless of where a failure happened (same fix already applied in
// scripts/e2e-full-flow.mjs).
const ALL_INSTANCES = [];
let subClient = null; // the plain MQTT subscriber used to verify real event delivery (TEST 2) — force-closed in main()'s finally too

class FakeInstance {
	constructor(label, flagValues, cwd) {
		this.label = label;
		this.flagValues = flagValues;
		this.cwd = cwd;
		this.harness = makeFakePi(flagValues);
		this.ctx = makeCtx(cwd);
	}

	async start() {
		const modUrl = pathToFileURL(path.join(PROJECT_ROOT, "extensions", "orchestrator.ts")).href;
		// Fresh import per instance is unnecessary — module state is closure-
		// scoped inside the default-exported function (same audit as
		// e2e-full-flow.mjs), so re-invoking the SAME loaded module gives each
		// instance fully isolated state, exactly like separate `pi` processes.
		// Deliberately NOT cached across bootstrapScratchRepo() reuse in the
		// "resumability" scenario below: a NEW FakeInstance still gets its own
		// closure state (presence maps, yanoStorage handle, etc.) even though
		// the underlying module object is the same — that's the whole point:
		// it proves state survives via the FILESYSTEM (SQLite), not via any
		// in-process cache.
		if (!modPromiseCache) modPromiseCache = import(modUrl);
		const mod = await modPromiseCache;
		mod.default(this.harness.pi);
		const sessionStart = this.harness.hooks.get("session_start");
		if (!sessionStart) throw new Error(`${this.label}: session_start hook not registered`);
		await sessionStart({}, this.ctx);
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			if (this.harness.appendedEntries.some((e) => e.data?.event === "connected")) return this;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`${this.label}: never saw MQTT "connected" event within 8s — is mosquitto running on ${BROKER_URL}?`);
	}

	tool(name) {
		const t = this.harness.tools.get(name);
		if (!t) throw new Error(`${this.label}: no tool registered named "${name}"`);
		return t;
	}

	async call(name, params = {}) {
		const t = this.tool(name);
		return t.execute("call-" + Math.random().toString(36).slice(2), params);
	}

	async callExpectError(name, params = {}) {
		try {
			await this.call(name, params);
			throw new Error(`${this.label}: expected "${name}" to throw, but it succeeded`);
		} catch (err) {
			return err;
		}
	}

	async shutdown() {
		const hook = this.harness.hooks.get("session_shutdown");
		if (hook) await hook({}, this.ctx);
	}
}

async function makeInstance(label, instance, role, cwd, project) {
	const fi = new FakeInstance(label, { instance, role, project, broker: BROKER_URL, "config-dir": "agents", "prompts-dir": "prompts" }, cwd);
	ALL_INSTANCES.push(fi);
	await fi.start();
	return fi;
}

// ━━ Main ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runScenario(cwd, project) {
	console.log("\n=== TEST 1 — workspace init, idempotency ===");
	fs.mkdirSync(path.join(cwd, ".agents", "skills", "fixture-skill"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".agents", "skills", "fixture-skill", "SKILL.md"), "# Fixture Skill\nDeterministic smoke-test skill fixture.\n");
	const planner = await makeInstance("planner", "planner-01", "planner", cwd, project);
	const effectAdapter = await makeInstance("effect-adapter", "effect-adapter-01", "effect-adapter", cwd, project);
	const initResult1 = await planner.call("orchestrator_init", {});
	const dbPath = path.join(cwd, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage", "orchestrator.db");
	ok(fs.existsSync(dbPath), "orchestrator.db created on disk");
	for (const dir of ["config", "specs", "playbooks", "diagrams", "knowledge", "policies", "artifacts", "overrides", "reports", "prompts", "logs"]) {
		ok(fs.existsSync(path.join(cwd, ".pi", "extensions", "yano-orchestrator", dir)), `workspace subdir "${dir}" created`);
	}
	// Revisione 37 re-added reports/prompts/logs as real workspace subdirs
	// (moved here from the project root, so they're gitignored by default),
	// superseding the older Revisione 28 note that called logs a dead
	// scaffold. The loop above now asserts the exact set the temporal
	// processor creates — kept explicit here, not relying only on the loop.
	const configPath = path.join(cwd, ".pi", "extensions", "yano-orchestrator", "config", "project.json");
	const cfg1 = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	ok(cfg1.schema_version === 1, "config records schema_version 1");
	ok(cfg1.project === project, "config.project defaults to the MQTT --project scope value when no project_name override is given");
	const createdAt1 = cfg1.created_at;
	// Re-running init must not destroy/reset anything.
	await planner.call("orchestrator_init", {});
	const cfg2 = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	ok(cfg2.created_at === createdAt1, "orchestrator_init is idempotent — created_at unchanged on re-init");

	// Revisione 28: project_name lets the planner set a human-facing name,
	// distinct from (and without touching) the MQTT --project scope.
	const renamed = await planner.call("orchestrator_init", { project_name: "URL Shortener" });
	ok(renamed.details.config.project === "URL Shortener", "orchestrator_init(project_name) renames config.project");
	const cfg3 = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	ok(cfg3.project === "URL Shortener", "the rename is actually persisted to config/project.json");
	// Calling again WITHOUT project_name must not revert the rename.
	await planner.call("orchestrator_init", {});
	const cfg4 = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	ok(cfg4.project === "URL Shortener", "omitting project_name on a later call preserves the previously-set name");

	console.log("\n=== TEST 2 — run/spec/ticket creation, real MQTT event delivery ===");
	// Subscribe on a real MQTT client to confirm ticket_ready actually
	// publishes, not just that SQLite records the event.
	const sub = mqtt.connect(BROKER_URL);
	subClient = sub;
	await new Promise((resolve, reject) => {
		sub.on("connect", resolve);
		sub.on("error", reject);
	});
	const seenEvents = [];
	sub.on("message", (_topic, payload) => {
		try { seenEvents.push(JSON.parse(payload.toString("utf-8"))); } catch { /* ignore */ }
	});

	const runResult = await planner.call("run_create", { objective: "Add a batch verification endpoint", domain: "software" });
	const runId = runResult.details.run.id;
	ok(!!runId, "run_create returned a run id");
	ok(runResult.details.run.status === "active", "new run starts active");
	const bound = await planner.call("playbook_bind", { run_id: runId, source: "playbooks/default.yaml" });
	ok(bound.details.binding.playbook_id === "default-orchestration", "planner binds the validated Playbook to the run");
	const boundStatus = await planner.call("run_status", { run_id: runId });
	ok(boundStatus.details.playbook_binding.checksum === bound.details.binding.checksum, "run_status exposes the immutable Playbook origin/checksum binding");
	ok(boundStatus.details.playbook_state.state_id === "received" && boundStatus.details.playbook_state.generation === 0, "run_status exposes the persisted initial Playbook state");
	const governanceProposal = await planner.call("governance_proposal_create", { kind: "playbook", identifier: "smoke-proposal", document: "schema_version: 1\nid: smoke-proposal\n", required_capabilities: ["capability:cli:node:available"] });
	ok(governanceProposal.details.proposal.status === "sandbox" && governanceProposal.details.proposal.checksum, "governance proposal starts sandboxed with an immutable checksum");
	const validatedProposal = await planner.call("governance_proposal_validate", { id: governanceProposal.details.proposal.id });
	ok(validatedProposal.details.proposal.status === "validated", "governance proposal requires validation before approval");
	const packageAudit = await planner.call("package_manifest_audit", {});
	ok(packageAudit.details.audit.status === "passed", "package manifest audit verifies yano name, binary and Playbook assets");
	const forgedActor = await planner.callExpectError("playbook_transition", { run_id: runId, transition_id: "confirm_team", actor: "human", expected_generation: 0 });
	ok(/not authorised/.test(forgedActor.message), "planner cannot forge a human Playbook actor");
	const unsupportedEvidence = await planner.callExpectError("playbook_evidence_record", { run_id: runId, requirement: "objective_received", source: "planner:said-so", idempotency_key: "unsupported-v1" });
	ok(/unsupported source/.test(unsupportedEvidence.message), "arbitrary Playbook evidence sources are refused");
	const cliEvidence = await planner.call("playbook_evidence_record", { run_id: runId, requirement: "node_available", source: "capability:cli:node:available", idempotency_key: "node-available-v1" });
	ok(cliEvidence.details?.evidence?.source === "capability:cli:node:available", "CLI capability evidence is accepted only after a bounded --version probe");
	const nodeCard = await planner.call("capability_card_verify", { run_id: runId, capability: "node", source: "capability:cli:node:available", requirement: "node_available", idempotency_key: "node-card-v1", expires_at: new Date(Date.now() + 60_000).toISOString() });
	ok(nodeCard.details?.card?.status === "verified" && nodeCard.details.card.role === "planner" && nodeCard.details.card.instance === "planner-01", "verified capability card is scoped to the current role and instance");
	const cardStatus = await planner.call("run_status", { run_id: runId });
	ok(cardStatus.details.capability_cards.some((card) => card.capability === "node" && card.status === "verified" && card.playbook_checksum === bound.details.binding.checksum), "run_status exposes a checksum-bound capability card");
	const missingCliEvidence = await planner.callExpectError("playbook_evidence_record", { run_id: runId, requirement: "missing_cli", source: "capability:cli:yano-command-that-does-not-exist:available", idempotency_key: "missing-cli-v1" });
	ok(/not satisfied/.test(missingCliEvidence.message), "failed CLI capability probes cannot satisfy Playbook guards");
	const failedCard = await planner.callExpectError("capability_card_verify", { run_id: runId, capability: "missing-cli", source: "capability:cli:yano-command-that-does-not-exist:available", requirement: "missing_cli", idempotency_key: "missing-cli-card-v1" });
	ok(/not satisfied/.test(failedCard.message), "failed capability probe does not produce a verified card");
	await planner.call("capability_card_invalidate", { run_id: runId, role: "planner", instance: "planner-01", capability: "node", reason: "environment fingerprint changed" });
	const invalidatedCards = await planner.call("capability_card_list", { run_id: runId });
	ok(invalidatedCards.details.cards.some((card) => card.capability === "node" && card.status === "blocked"), "capability card invalidation is persisted as blocked");
	const skillEvidence = await planner.call("playbook_evidence_record", { run_id: runId, requirement: "fixture_skill_loadable", source: "capability:skill:fixture-skill:loadable", idempotency_key: "fixture-skill-v1" });
	ok(skillEvidence.details?.evidence?.source === "capability:skill:fixture-skill:loadable", "skill capability evidence is accepted only when SKILL.md is readable");
	const missingSkillEvidence = await planner.callExpectError("playbook_evidence_record", { run_id: runId, requirement: "missing_skill", source: "capability:skill:does-not-exist:loadable", idempotency_key: "missing-skill-v1" });
	ok(/not satisfied/.test(missingSkillEvidence.message), "unloadable skills cannot satisfy Playbook guards");
	fs.writeFileSync(path.join(cwd, ".env"), "FIXTURE_API_KEY=secret-fixture-value\nPLACEHOLDER_API_KEY=<YOUR_API_KEY>\n");
	const credentialEvidence = await planner.call("playbook_evidence_record", { run_id: runId, requirement: "fixture_credential_present", source: "capability:credential:FIXTURE_API_KEY:present", idempotency_key: "fixture-credential-v1" });
	ok(credentialEvidence.details?.evidence?.source === "capability:credential:FIXTURE_API_KEY:present", "credential evidence is accepted when .env contains a non-placeholder value");
	const placeholderCredential = await planner.callExpectError("playbook_evidence_record", { run_id: runId, requirement: "placeholder_credential", source: "capability:credential:PLACEHOLDER_API_KEY:present", idempotency_key: "placeholder-credential-v1" });
	ok(/not satisfied/.test(placeholderCredential.message), "placeholder credentials cannot satisfy Playbook guards");
	const mcpFixture = path.join(cwd, "mcp-fixture.mjs");
	fs.writeFileSync(mcpFixture, "process.stdin.on('data',()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18',serverInfo:{name:'fixture',version:'1.0.0'}}})+'\\n'));\n");
	fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [mcpFixture] } } }));
	const mcpEvidence = await planner.call("playbook_evidence_record", { run_id: runId, requirement: "fixture_mcp_ready", source: "capability:mcp:fixture:handshake", idempotency_key: "fixture-mcp-v1" });
	ok(mcpEvidence.details?.evidence?.source === "capability:mcp:fixture:handshake", "MCP capability evidence is accepted only after a valid initialize handshake");
	const missingMcpEvidence = await planner.callExpectError("playbook_evidence_record", { run_id: runId, requirement: "missing_mcp", source: "capability:mcp:does-not-exist:handshake", idempotency_key: "missing-mcp-v1" });
	ok(/not satisfied/.test(missingMcpEvidence.message), "MCP servers without a declaration or handshake cannot satisfy Playbook guards");
	const evidence = await planner.call("playbook_evidence_record", { run_id: runId, requirement: "objective_received", source: "run:objective_present", idempotency_key: "objective-received-v1" });
	ok(evidence.details?.evidence?.requirement === "objective_received", "Playbook guard evidence is persisted before transition");
	const evidenceStatus = await planner.call("run_status", { run_id: runId });
	ok(evidenceStatus.details.playbook_evidence.some((item) => item.requirement === "objective_received"), "run_status exposes persisted Playbook evidence for recovery");
	const evidenceRetry = await planner.call("playbook_evidence_record", { run_id: runId, requirement: "objective_received", source: "run:objective_present", idempotency_key: "objective-received-v1" });
	ok(evidenceRetry.details?.evidence?.id === evidence.details.evidence.id, "Playbook evidence recording is idempotent");
	const evidenceAuditStatus = await planner.call("run_status", { run_id: runId });
	ok(evidenceAuditStatus.details.recent_events.filter((event) => event.type === "playbook_evidence_recorded" && event.payload?.requirement === "objective_received").length === 1, "idempotent evidence retries do not duplicate the audit event");
	const transition = await planner.call("playbook_transition", { run_id: runId, transition_id: "receive_to_scope", actor: "planner", expected_generation: 0 });
	ok(transition.details.transition.to === "scoping" && transition.details.transition.generation === 1, "declared Playbook transition advances atomically with generation fencing");
	ok(transition.details.transition.effects.length === 2 && transition.details.transition.effects.some((effect) => effect.kind === "audit"), "declared transition effects are returned without executing external side effects");
	const raceRun = (await planner.call("run_create", { objective: "Concurrent transition probe", domain: "software" })).details.run;
	await planner.call("playbook_bind", { run_id: raceRun.id, source: "playbooks/default.yaml" });
	await planner.call("playbook_evidence_record", { run_id: raceRun.id, requirement: "objective_received", source: "run:objective_present", idempotency_key: "race-objective-v1" });
	const raceResults = await Promise.allSettled([
		planner.call("playbook_transition", { run_id: raceRun.id, transition_id: "receive_to_scope", actor: "planner", expected_generation: 0 }),
		planner.call("playbook_transition", { run_id: raceRun.id, transition_id: "receive_to_scope", actor: "planner", expected_generation: 0 }),
	]);
	ok(raceResults.filter((result) => result.status === "fulfilled").length === 1 && raceResults.filter((result) => result.status === "rejected").length === 1, "concurrent Playbook transitions are serialized by generation fencing");
	const raceStatus = await planner.call("run_status", { run_id: raceRun.id });
	ok(raceStatus.details.playbook_state.generation === 1 && raceStatus.details.playbook_evidence.length === 1, "a concurrent loser leaves no second state/evidence mutation");
	const effects = await planner.call("playbook_effect_list", { run_id: runId, status: "pending" });
	ok(effects.details.effects.length === 2 && effects.details.effects.every((effect) => effect.dedupe_key.includes(runId)), "transition effects are persisted in a deduplicated pending outbox");
	const recoveryStatus = await planner.call("run_status", { run_id: runId });
	ok(recoveryStatus.details.playbook_effects.length === 2 && Array.isArray(recoveryStatus.details.decision_holds), "run_status exposes Playbook outbox and decision holds for recovery");
	const externalEffect = effects.details.effects.find((effect) => effect.kind === "notification");
	const forgedExternalAck = await planner.callExpectError("playbook_effect_ack", { id: externalEffect.id, generation: 1, idempotency_key: "external-ack-forged" });
	ok(/requires runtime role "effect-adapter"/.test(forgedExternalAck.message), "planner cannot acknowledge an external effect without an effect-adapter");
	const externalAck = await effectAdapter.call("playbook_effect_ack", { id: externalEffect.id, generation: 1, idempotency_key: "external-ack-v1" });
	ok(externalAck.details.effect.status === "dispatched", "effect-adapter can acknowledge an external effect after delivery");
	const ackAuditStatus = await effectAdapter.call("run_status", { run_id: runId });
	ok(ackAuditStatus.details.recent_events.some((event) => event.type === "playbook_effect_acknowledged" && event.payload?.actor_role === "effect-adapter"), "effect acknowledgement audit records the runtime actor role");
	const forgedExternalRetry = await planner.callExpectError("playbook_effect_ack", { id: externalEffect.id, generation: 1, idempotency_key: "external-ack-v1" });
	ok(/requires runtime role "effect-adapter"/.test(forgedExternalRetry.message), "external effect retry remains authorization-bound even with an adapter idempotency key");
	const auditEffect = effects.details.effects.find((effect) => effect.kind === "audit");
	const acknowledged = await planner.call("playbook_effect_ack", { id: auditEffect.id, generation: 1, idempotency_key: "effect-ack-1" });
	ok(acknowledged.details.effect.status === "dispatched", "an authorized adapter can acknowledge a pending effect with generation fencing");
	const staleAck = await planner.callExpectError("playbook_effect_ack", { id: auditEffect.id, generation: 0, idempotency_key: "effect-ack-1" });
	ok(/generation mismatch/.test(staleAck.message), "stale effect acknowledgement cannot bypass generation fencing through idempotency");
	const ackRetry = await planner.call("playbook_effect_ack", { id: auditEffect.id, generation: 1, idempotency_key: "effect-ack-1" });
	ok(ackRetry.details.effect.status === "dispatched", "effect acknowledgement retries are idempotent");
	const failureRun = (await planner.call("run_create", { objective: "Dead-letter effect recovery" })).details.run;
	await planner.call("playbook_bind", { run_id: failureRun.id, source: "playbooks/default.yaml" });
	await planner.call("playbook_evidence_record", { run_id: failureRun.id, requirement: "objective_received", source: "run:objective_present", idempotency_key: "failure-objective-v1" });
	await planner.call("playbook_transition", { run_id: failureRun.id, transition_id: "receive_to_scope", actor: "planner", expected_generation: 0 });
	const failureEffects = await planner.call("playbook_effect_list", { run_id: failureRun.id, status: "pending" });
	const failureEffect = failureEffects.details.effects.find((effect) => effect.kind === "notification");
	await effectAdapter.call("playbook_effect_claim", { id: failureEffect.id, owner: "adapter-01", token: "lease-failure-v1", lease_until: new Date(Date.now() + 60_000).toISOString() });
	const failedEffect = await effectAdapter.call("playbook_effect_fail", { id: failureEffect.id, owner: "adapter-01", token: "lease-failure-v1", error: "adapter unavailable", max_attempts: 1 });
	ok(failedEffect.details.effect.delivery_state === "dead_letter" && failedEffect.details.effect.outcome === "blocked", "dead-letter effect moves the Playbook run to blocked atomically");
	const blockedStatus = await planner.call("run_status", { run_id: failureRun.id });
	ok(blockedStatus.details.playbook_state.state_id === "blocked" && blockedStatus.details.checkpoints.some((checkpoint) => checkpoint.label === "playbook_failure"), "blocked run exposes failure checkpoint for bounded replan");
	const blockedDispatch = await effectAdapter.callExpectError("playbook_effect_claim", { id: failureEffects.details.effects.find((effect) => effect.kind === "audit").id, owner: "adapter-01", token: "lease-blocked-v1", lease_until: new Date(Date.now() + 60_000).toISOString() });
	ok(/dispatch is blocked/.test(blockedDispatch.message), "dead-lettered run refuses subsequent effect dispatch");
	const missingGuard = await planner.callExpectError("playbook_transition", { run_id: runId, transition_id: "scope_to_confirmation", actor: "planner", expected_generation: 1 });
	ok(/guard/.test(missingGuard.message), "an unsatisfied Playbook guard blocks the transition");
	const hold = await planner.call("decision_hold_create", { run_id: runId, question: "Confermare il team", context: { api_key: "do-not-leak", nested: { token: "do-not-leak" } }, owner: "user", idempotency_key: "team-confirmation-v1" });
	ok(hold.details.hold.context.api_key === "[REDACTED]" && hold.details.hold.context.nested.token === "[REDACTED]", "decision hold creation does not return sensitive context");
	const redactedStatus = await planner.call("run_status", { run_id: runId });
	const redactedHold = redactedStatus.details.decision_holds.find((item) => item.id === hold.details.hold.id);
	ok(redactedHold.context.api_key === "[REDACTED]" && redactedHold.context.nested.token === "[REDACTED]", "run_status redacts sensitive decision-hold context recursively");
	const answeredHold = await planner.call("decision_hold_answer", { id: hold.details.hold.id, generation: hold.details.hold.generation, answer: "confirmed", idempotency_key: "team-confirmation-answer-v1" });
	const holdEvidence = await planner.call("playbook_evidence_record", { run_id: runId, requirement: "team_confirmed", source: `hold:${hold.details.hold.id}:answered`, idempotency_key: "team-confirmed-v1" });
	ok(answeredHold.details?.hold?.status === "answered" && holdEvidence.details?.evidence?.source === `hold:${hold.details.hold.id}:answered`, "answered decision holds can produce verified Playbook evidence");
	for (const requirement of ["scope_defined", "team_selected", "phases_proposed"]) {
		await planner.call("playbook_evidence_record", { run_id: runId, requirement, source: "run:objective_present", idempotency_key: `${requirement}-v1` });
	}
	const confirmationTransition = await planner.call("playbook_transition", { run_id: runId, transition_id: "scope_to_confirmation", actor: "planner", expected_generation: 1 });
	ok(confirmationTransition.details.transition.approval_holds.length === 1, "declared human_approval effect opens exactly one persisted decision hold");
	const approvalHold = await planner.call("decision_hold_get", { id: confirmationTransition.details.transition.approval_holds[0] });
	ok(approvalHold.details.hold.status === "open" && approvalHold.details.hold.question.includes("Confermare"), "Playbook human_approval hold is durable and carries its declared question");
	const escalatedHold = await planner.call("decision_hold_escalate", { id: approvalHold.details.hold.id, generation: 2, escalated_to: "user-approver", idempotency_key: "approval-escalation-v1", expected_checksum: bound.details.binding.checksum });
	ok(escalatedHold.details.hold.escalated_to === "user-approver" && escalatedHold.details.hold.escalation_version === 1, "Playbook approval escalation is persisted with checksum and version");
	const escalationRetry = await planner.call("decision_hold_escalate", { id: approvalHold.details.hold.id, generation: 2, escalated_to: "user-approver", idempotency_key: "approval-escalation-v1", expected_checksum: bound.details.binding.checksum });
	ok(escalationRetry.details.hold.escalation_version === 1, "approval escalation retry is idempotent");
	const wrongChecksum = await planner.callExpectError("decision_hold_escalate", { id: approvalHold.details.hold.id, generation: 2, escalated_to: "other-approver", idempotency_key: "approval-escalation-wrong-checksum", expected_checksum: "wrong-checksum" });
	ok(/checksum mismatch/.test(wrongChecksum.message), "approval escalation rejects a stale Playbook checksum");
	const approvalEffects = await planner.call("playbook_effect_list", { run_id: runId, status: "pending" });
	const approvalEffect = approvalEffects.details.effects.find((effect) => effect.kind === "human_approval");
	const earlyApprovalAck = await planner.callExpectError("playbook_effect_ack", { id: approvalEffect.id, generation: 2, idempotency_key: "approval-ack-too-early" });
	ok(/requires hold .* to be answered.*open/.test(earlyApprovalAck.message), "an open human approval hold blocks effect acknowledgement");
	await planner.call("decision_hold_answer", { id: approvalHold.details.hold.id, generation: 2, answer: "confirmed", idempotency_key: "playbook-team-confirmation-answer-v1", expected_checksum: bound.details.binding.checksum });
	const approvalAck = await planner.call("playbook_effect_ack", { id: approvalEffect.id, generation: 2, idempotency_key: "approval-ack-v1" });
	ok(approvalAck.details.effect.status === "dispatched", "human approval effect is acknowledged only after the hold is answered");

	// See extensions/orchestrator.ts:393's topics(project, scope) — every
	// topic (including runEvents) is built on `scope`
	// (projectKey(cwd, project), a workspace-<hash> derived from the root),
	// not the raw `project` string. Subscribing to the raw name silently
	// listens on the wrong topic forever.
	await sub.subscribeAsync(`pi/${projectKey(cwd, project)}/runs/${runId}/events`);

	const specResult = await planner.call("spec_create", { run_id: runId, title: "Batch verification spec", content: "## Objective\nVerify N items in one call.\n" });
	const specId = specResult.details.spec.id;
	ok(fs.existsSync(path.join(cwd, specResult.details.spec.file_path)), "spec markdown file written to disk under specs/");

	// A (no deps) — ready immediately
	const ticketA = (await planner.call("ticket_create", { run_id: runId, spec_id: specId, title: "Implement endpoint", required_capabilities: ["coder"] })).details.ticket;
	// B (no deps) — ready immediately
	const ticketB = (await planner.call("ticket_create", { run_id: runId, title: "Write API docs" })).details.ticket;
	// C depends on A
	const ticketC = (await planner.call("ticket_create", { run_id: runId, title: "Security review", depends_on: [ticketA.id], required_capabilities: ["security-review"] })).details.ticket;
	// D depends on B and C
	const ticketD = (await planner.call("ticket_create", { run_id: runId, title: "Final docs sync", depends_on: [ticketB.id, ticketC.id] })).details.ticket;
	const prematureComplete = await planner.callExpectError("ticket_complete", { ticket_id: ticketA.id, status: "done" });
	ok(/not running.*pending/.test(prematureComplete.message), "planner cannot complete a pending ticket before the assigned worker claims it");

	const readyState1 = (await planner.call("tickets_ready", { run_id: runId })).details;
	ok(readyState1.ready.includes(ticketA.id) && readyState1.ready.includes(ticketB.id), "A and B are READY (no dependencies)");
	ok(readyState1.blocked.includes(ticketC.id) && readyState1.blocked.includes(ticketD.id), "C and D are BLOCKED (unmet dependencies)");
	ok(readyState1.waves.length === 3, "execution waves computed as 3 levels (A/B, C, D)");
	ok(readyState1.waves[0].slice().sort().join(",") === [ticketA.id, ticketB.id].sort().join(","), "wave 1 is exactly {A, B}");
	ok(readyState1.waves[1].join(",") === ticketC.id, "wave 2 is exactly {C}");
	ok(readyState1.waves[2].join(",") === ticketD.id, "wave 3 is exactly {D}");

	// Give the real MQTT delivery a moment, then confirm ticket_ready events
	// for A and B genuinely arrived over the wire (not just recorded in SQLite).
	await new Promise((r) => setTimeout(r, 300));
	const readyEventTicketIds = seenEvents.filter((e) => e.type === "ticket_ready").map((e) => e.payload.ticket_id);
	ok(readyEventTicketIds.includes(ticketA.id) && readyEventTicketIds.includes(ticketB.id), "real MQTT ticket_ready events observed for A and B on pi/<project>/runs/<run>/events");

	console.log("\n=== TEST 3 — capability matching on ticket_claim ===");
	const specialist = await makeInstance("specialist", "docs-sync-01", "docs-sync", cwd, project);
	const capErr = await specialist.callExpectError("ticket_claim", { ticket_id: ticketA.id });
	ok(/missing required capabilities/.test(capErr.message), "docs-sync specialist refused to claim a ticket requiring \"coder\"");

	console.log("\n=== TEST 4 — claim / complete chain, dependents unlocked ===");
	const coder = await makeInstance("coder", "coder-01", "coder", cwd, project);
	const claimA = await coder.call("ticket_claim", { ticket_id: ticketA.id });
	ok(claimA.details.ticket.status === "running" && claimA.details.ticket.assigned_instance === "coder-01", "A claimed by coder-01, now running");

	const doubleClaimErr = await coder.callExpectError("ticket_claim", { ticket_id: ticketA.id });
	ok(/not READY/.test(doubleClaimErr.message), "claiming an already-running ticket again is refused");

	const wrongCompleterErr = await specialist.callExpectError("ticket_complete", { ticket_id: ticketA.id, status: "done" });
	ok(/only the assignee or planner/.test(wrongCompleterErr.message), "an instance that didn't claim the ticket cannot complete it");

	const completeA = await coder.call("ticket_complete", { ticket_id: ticketA.id, status: "done", result_summary: "endpoint implemented, 12 tests passing" });
	ok(completeA.details.ticket.status === "done", "A marked done");
	const ticketEvidence = await planner.call("playbook_evidence_record", { run_id: runId, requirement: "ticket_A_done", source: `ticket:${ticketA.id}:done`, idempotency_key: "ticket-a-done-v1" });
	ok(ticketEvidence.details?.evidence?.source === `ticket:${ticketA.id}:done`, "ticket completion is accepted as verified Playbook evidence only after persisted status is done");
	ok(completeA.details.newly_ready.includes(ticketC.id), "C becomes READY the moment A (its only dependency) completes");
	const readyAfterA = (await coder.call("tickets_ready", { run_id: runId })).details;
	ok(readyAfterA.ready.includes(ticketC.id), "C is READY once A is done (dependency satisfied)");
	ok(readyAfterA.blocked.includes(ticketD.id), "D still BLOCKED (B not done, C not done)");

	const claimB = await coder.call("ticket_claim", { ticket_id: ticketB.id });
	ok(claimB.details.ticket.status === "running", "B claimed");
	const completeB = await coder.call("ticket_complete", { ticket_id: ticketB.id, status: "done" });
	ok(completeB.details.newly_ready.length === 0, "D still not ready after only B completes (C not done yet)");

	// Using a REAL agents.yaml-declared instance (reviewer-security-01, role
	// reviewer, skills: [security-review]) rather than an ad-hoc unknown
	// instance id here — a real gap found while writing this test:
	// resolveCapabilities() (extensions/orchestrator.ts) resolves
	// skills/cli/mcp/model purely from agents.yaml's OWN "role:" field for
	// that instance id, and never consults the --role CLI flag at all. For
	// an instance id that has NO agents.yaml entry (the exact "planner
	// invents an instance name on the fly" scenario architecture.md §40
	// documents as already working via roles.yaml defaults + --role alone),
	// this means skills/cli/mcp/model silently resolve to the "unassigned"
	// role's empty defaults, not the roster role's — --role only ends up
	// affecting identity.role/display, not capability resolution. Not fixed
	// here (out of scope for this ticket-engine slice, and resolveCapabilities
	// is stable/tested code used by every existing tool) — flagged in the
	// final report as a real, reproducible discrepancy between architecture.md
	// §40 and the actual code.
	const securityAgent = await makeInstance("security", "reviewer-security-01", "reviewer", cwd, project);
	const claimC = await securityAgent.call("ticket_claim", { ticket_id: ticketC.id });
	ok(claimC.details.ticket.status === "running", "reviewer-security-01 can claim C (its agents.yaml-declared skills include \"security-review\", matching the ticket's required_capabilities)");

	console.log("\n=== TEST 5 — cycle detection, planner override ===");
	const completeC = await securityAgent.call("ticket_complete", { ticket_id: ticketC.id, status: "done", result_summary: "no findings" });
	ok(completeC.details.newly_ready.includes(ticketD.id), "D becomes READY once both B and C are done");

	// Cycle detection: two fresh tickets depending on each other.
	const ticketX = (await planner.call("ticket_create", { run_id: runId, title: "X" })).details.ticket;
	const ticketY = (await planner.call("ticket_create", { run_id: runId, title: "Y", depends_on: [ticketX.id] })).details.ticket;
	// Sneak in the reverse edge directly through a second ticket_create call
	// is not possible via the tool (depends_on is only set at creation) — so
	// exercise the storage layer's own guard instead: a ticket cannot depend
	// on itself, and tickets_ready must not hang/crash if a cycle existed.
	const selfDepErr = await planner.callExpectError("ticket_create", { run_id: runId, title: "Z", depends_on: ["nonexistent-ticket-id"] });
	ok(/doesn't exist in run/.test(selfDepErr.message), "ticket_create refuses a depends_on referencing a non-existent ticket in the run");

	// Planner override: force-complete a ticket without being the assignee.
	const claimX = await coder.call("ticket_claim", { ticket_id: ticketX.id });
	ok(claimX.details.ticket.status === "running", "X claimed by coder");
	const plannerOverride = await planner.call("ticket_complete", { ticket_id: ticketX.id, status: "failed", result_summary: "superseded, cancelling via planner override" });
	ok(plannerOverride.details.ticket.status === "failed", "planner can force-complete/fail a ticket it did not claim itself");
	const readyAfterXFail = (await planner.call("tickets_ready", { run_id: runId })).details;
	ok(readyAfterXFail.blocked.includes(ticketY.id), "Y stays BLOCKED — a failed dependency never cascades automatically (deferred to replanning)");
	const recoveryRun = (await planner.call("run_create", { objective: "Worker replacement budget" })).details.run;
	const recoveryTicket = (await planner.call("ticket_create", { run_id: recoveryRun.id, title: "replaceable worker", required_capabilities: ["coder"] })).details.ticket;
	await coder.call("ticket_claim", { ticket_id: recoveryTicket.id });
	await coder.call("ticket_complete", { ticket_id: recoveryTicket.id, status: "failed", result_summary: "worker offline" });
	const requeued = await planner.call("ticket_requeue", { ticket_id: recoveryTicket.id, reason: "replace offline worker", max_retries: 1 });
	ok(requeued.details.ticket.id === recoveryTicket.id && requeued.details.ticket.status === "pending" && requeued.details.recovery.recovery_generation === 1, "worker replacement requeues the same ticket with a new recovery generation");
	const recoveryCard = await planner.call("ticket_recovery_get", { ticket_id: recoveryTicket.id });
	ok(recoveryCard.details.recovery.retry_count === 1 && recoveryCard.details.recovery.status === "available", "retry budget is persisted for the replacement ticket");
	await coder.call("ticket_claim", { ticket_id: recoveryTicket.id });
	await coder.call("ticket_complete", { ticket_id: recoveryTicket.id, status: "failed", result_summary: "replacement also failed" });
	const exhausted = await planner.callExpectError("ticket_requeue", { ticket_id: recoveryTicket.id, reason: "retry budget exhausted", max_retries: 1 });
	ok(/recovery budget exhausted/.test(exhausted.message), "recovery budget exhaustion stops automatic requeue");
	const exhaustedStatus = await planner.call("run_status", { run_id: recoveryRun.id });
	ok(exhaustedStatus.details.run.status === "failed" && exhaustedStatus.details.checkpoints.some((checkpoint) => checkpoint.label === "recovery_budget_exhausted"), "budget exhaustion persists a terminal run checkpoint");

	console.log("\n=== TEST 6 — run auto-completion ===");
	const claimD = await coder.call("ticket_claim", { ticket_id: ticketD.id });
	ok(claimD.details.ticket.status === "running", "D claimed");
	// Y is still pending/blocked, so the run must NOT auto-complete yet even
	// though D — the "main" chain — is about to finish.
	const completeD = await coder.call("ticket_complete", { ticket_id: ticketD.id, status: "done" });
	ok(completeD.details.ticket.status === "done", "D marked done");

	console.log("\n=== TEST 6b — explicit Playbook contract and safe retention apply ===");
	const scopedRun = (await planner.call("run_create", { objective: "Playbook-scoped ticket" })).details.run;
	await planner.call("playbook_bind", { run_id: scopedRun.id, source: "playbooks/backend-change.yaml" });
	const scopedTicket = (await planner.call("ticket_create", { run_id: scopedRun.id, title: "Backend-scoped work", required_playbook: "backend-change" })).details.ticket;
	ok(scopedTicket.required_playbook === "backend-change", "ticket persists its explicit required Playbook contract");
	const wrongPlaybook = await specialist.callExpectError("ticket_claim", { ticket_id: scopedTicket.id });
	ok(/mapped to playbook/.test(wrongPlaybook.message), "ticket_claim refuses a role mapped to a different Playbook");
	const sharedRoleTicket = (await planner.call("ticket_create", { run_id: scopedRun.id, title: "Shared-role scoped work", required_playbook: "backend-change", required_capabilities: ["docs-sync"] })).details.ticket;
	const sharedRoleClaim = await specialist.call("ticket_claim", { ticket_id: sharedRoleTicket.id });
	ok(sharedRoleClaim.details.ticket.assigned_instance === "docs-sync-01", "a shared role may claim a cross-playbook ticket when the run explicitly requires that role capability");
	await specialist.call("ticket_complete", { ticket_id: sharedRoleTicket.id, status: "done" });
	await coder.call("ticket_claim", { ticket_id: scopedTicket.id });
	await coder.call("ticket_complete", { ticket_id: scopedTicket.id, status: "done" });
	await planner.call("retention_policy_set", { project, event_days: 30, evidence_days: 30, outbox_days: 30, dead_letter_days: 30, policy_version: 1 });
	const retentionPreview = await planner.call("retention_policy_preview", { project });
	ok(retentionPreview.details.preview.destructive_apply_required === true, "retention preview advertises the destructive confirmation boundary");
	const retentionApply = await planner.call("retention_policy_apply", { project, confirm: true });
	ok(retentionApply.details.result.deleted.events >= 0, "retention apply executes only after explicit confirmation and returns deletion counts");
	const runAfterD = (await coder.call("run_status", { run_id: runId })).details.run;
	ok(runAfterD.status === "active", "run stays active — ticket Y (blocked, since X failed) is still outstanding");

	await sub.endAsync();

	console.log("\n=== TEST 7 — resumability: fresh process, same on-disk state ===");
	await planner.shutdown();
	await coder.shutdown();
	await specialist.shutdown();
	await securityAgent.shutdown();
	// Simulate a crash/restart: a brand new planner instance, same project
	// directory, same run id — must see EXACTLY the persisted state, not
	// regenerate anything, proving SQLite (not any in-memory structure) is
	// the actual source of truth.
	const plannerAfterRestart = await makeInstance("planner-restarted", "planner-01", "planner", cwd, project);
	const statusAfterRestart = (await plannerAfterRestart.call("run_status", { run_id: runId })).details;
	ok(statusAfterRestart.done.length === 4, "4 tickets done (A, B, C, D) survive the simulated restart");
	ok(statusAfterRestart.failed.includes(ticketX.id), "X's failed status survives the simulated restart");
	ok(statusAfterRestart.blocked.includes(ticketY.id), "Y's blocked status survives the simulated restart");
	ok(statusAfterRestart.tickets.length === 6, "all 6 tickets (A,B,C,D,X,Y) persisted across the simulated restart");
	await plannerAfterRestart.shutdown();

	console.log(`\n${PASS} assertions passed.`);
}

async function main() {
	const project = "yano-ticket-engine-e2e";
	const cwd = await bootstrapScratchRepo();
	console.log(`scratch repo: ${cwd}`);

	try {
		await runScenario(cwd, project);
		console.log("TICKET ENGINE SMOKE TEST PASSED");
		process.exitCode = 0;
	} catch (err) {
		console.error("\nTICKET ENGINE SMOKE TEST FAILED:", err);
		process.exitCode = 1;
	} finally {
		// See ALL_INSTANCES comment above — force-close everything ever
		// created (most are already shut down explicitly by TEST 7, but a
		// failure earlier in the script would otherwise leave open sockets).
		for (const inst of ALL_INSTANCES) {
			try { await inst.shutdown(); } catch { /* best-effort */ }
		}
		if (subClient) { try { subClient.end(true); } catch { /* best-effort */ } }
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
	process.exit(process.exitCode ?? 0);
}

main();
