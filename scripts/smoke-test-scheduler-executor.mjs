#!/usr/bin/env node
// Smoke T1 scheduler-executor: brief-routing (niente più rifiuto),
// delega bidirezionale senza loop, CRUD regole, triage con blocklist.
// Deterministico: YANO_DATA_DIR isolato, bridge MCP e fetch LLM mockati,
// nessuna rete, nessun effetto reale. Pattern: assert/strict come gli altri
// smoke-test-*.mjs (eseguiti da scripts/test-all.mjs via readdir).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-executor-"));
const data = path.join(root, "data");
const baseEnv = {
	YANO_DATA_DIR: data,
	YANO_MAIL_ALLOW_NON_DARWIN: "1",
	YANO_TEST_MODE: "1",
	YANO_MAIL_CONFIRM_GATE: "0",
};

const { runYanoInvoke } = await import("./yano-invoke.mjs");
const rules = await import("./yano-scheduler-rules.mjs");
const triage = await import("./yano-mail-triage.mjs");

// ── 1. brief-routing: invoke --role scheduler non più rifiutato ─────────────
{
	const result = await runYanoInvoke({ argv: ["--role", "scheduler", "--prompt", "ricordamelo ogni giorno"] });
	assert.equal(result.role, "scheduler");
	assert.equal(result.status, 0);
	assert.match(String(result.command || ""), /--role scheduler/);
	console.log("ok 1 — invoke --role scheduler compone il lancio (niente più rifiuto)");
}

// ── 2. delega senza loop: hop esaurito rifiuta il rimbalzo ──────────────────
{
	process.env.YANO_DELEGATION_HOPS = "1";
	process.env.YANO_DELEGATION_ORIGIN = "scheduler";
	try {
		await assert.rejects(
			runYanoInvoke({ argv: ["--role", "scheduler", "--prompt", "rimbalzo vietato"] }),
			/hop esaurito/,
		);
		console.log("ok 2a — scheduler→scheduler col hop esaurito rifiutato (mai loop)");
	} finally {
		delete process.env.YANO_DELEGATION_HOPS;
		delete process.env.YANO_DELEGATION_ORIGIN;
	}
	process.env.YANO_DELEGATION_HOPS = "1";
	process.env.YANO_DELEGATION_ORIGIN = "yano-local-pc";
	try {
		await assert.rejects(
			runYanoInvoke({ argv: ["--role", "yano-local-pc", "--prompt", "rimbalzo vietato"] }),
			/hop esaurito/,
		);
		console.log("ok 2b — local-pc→local-pc col hop esaurito rifiutato (mai loop)");
	} finally {
		delete process.env.YANO_DELEGATION_HOPS;
		delete process.env.YANO_DELEGATION_ORIGIN;
	}
}

// ── 3. CRUD regole: seed idempotente + add/list/query/update/remove ─────────
{
	const env = { ...baseEnv };
	const first = rules.ensureDefaultEmailRules(env);
	assert.equal(first.created, 2);
	const second = rules.ensureDefaultEmailRules(env);
	assert.equal(second.created, 0, "seed idempotente");
	const added = rules.addRule({ pattern: "newsletter@example.com", kind: "blocklist", action: "trash", note: "test" }, env);
	assert.match(added.id, /^SRULE-/);
	assert.equal(rules.listRules({}, env).length, 3);
	const found = rules.queryRules("quali regole cancellazione sono attive?", {}, env);
	assert.ok(found.some((rule) => rule.action === "trash"), "query semantica trova le regole cestino");
	assert.ok(rules.matchRules("From: support@mail.xtb.com\nSubject: ciao", {}, env).some((rule) => rule.id === "email-blocklist-xtb-support"));
	const updated = rules.updateRule(added.id, { note: "aggiornata", enabled: false }, env);
	assert.equal(updated.note, "aggiornata");
	assert.equal(rules.listRules({}, env).length, 2, "regola disabilitata esclusa dal default");
	assert.equal(rules.removeRule(added.id, env).removed, added.id);
	assert.equal(rules.listRules({ include_disabled: true }, env).length, 2);
	console.log("ok 3 — schedule-rules CRUD + query semantica + match");
}

// ── 4. triage con blocklist in dry-run: niente LLM, solo Cestino ────────────
function fakeFetch(promo, reason = "test") {
	return async () => ({
		ok: true,
		json: async () => ({ content: [{ type: "text", text: `ok\n${JSON.stringify({ promo, reason })}` }] }),
	});
}
function fakeBridge({ deleted = [] } = {}) {
	const boxes = [{ name: "INBOX", account: "Test", unreadCount: 1 }];
	return {
		async call(tool, args = {}) {
			if (tool === "list_mailboxes") return { content: [{ type: "text", text: JSON.stringify(boxes) }] };
			if (tool === "list_messages") return { content: [{ type: "text", text: JSON.stringify([{ id: 7, subject: "Promo XTB", sender: "support@mail.xtb.com", date: "oggi", isRead: false }]) }] };
			if (tool === "get_message") return { content: [{ type: "text", text: JSON.stringify({ id: args.message_id, subject: "Promo XTB", sender: "support@mail.xtb.com", date: "oggi", content: "offerta speciale, nessun footer" }) }] };
			if (tool === "delete_message") { deleted.push(args.message_id); return { content: [{ type: "text", text: "Message deleted (moved to trash)" }] }; }
			throw new Error(`tool inatteso: ${tool}`);
		},
		stop() {},
	};
}
{
	const deleted = [];
	let llmCalls = 0;
	const countingFetch = async (...args) => { llmCalls += 1; return fakeFetch(true)(...args); };
	const report = await triage.runMailTriage({
		env: { ...baseEnv, YANO_MAIL_DRY_RUN: "1" },
		fetchImpl: countingFetch,
		bridge: fakeBridge({ deleted }),
		notify: false,
	});
	assert.equal(report.ok, true);
	assert.equal(report.deleted.length, 1, "blocklist xtb → Cestino");
	assert.equal(report.deleted[0].dry_run, true, "dry-run: nessun effetto reale");
	assert.equal(deleted.length, 0, "dry-run non chiama delete_message");
	assert.equal(llmCalls, 0, "blocklist non scomoda l'LLM");
	assert.equal(report.rules_applied, 1);
	assert.ok(report.report_file && fs.existsSync(report.report_file), "report per-run persistito");
	console.log("ok 4 — triage blocklist dry-run (niente LLM, solo Cestino, report salvato)");
}

// ── 5. gate primo giro: senza conferma, giro reale → dry-run + nota ─────────
{
	const report = await triage.runMailTriage({
		env: { YANO_DATA_DIR: data, YANO_MAIL_ALLOW_NON_DARWIN: "1" },
		fetchImpl: fakeFetch(false),
		bridge: fakeBridge(),
		notify: false,
	});
	assert.equal(report.gate_pending, true);
	assert.equal(report.dry_run, true, "primo giro senza conferma = dry-run");
	assert.ok(report.errors.join(" ").includes("gate di conferma"));
	const confirmed = triage.confirmMailTriageGate({ YANO_DATA_DIR: data });
	assert.equal(confirmed.confirmed, true);
	assert.equal(triage.isMailTriageConfirmed({ YANO_DATA_DIR: data }), true);
	console.log("ok 5 — gate primo giro + conferma persistente");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("smoke-test-scheduler-executor: ok (routing, anti-loop, regole, triage, gate)");
