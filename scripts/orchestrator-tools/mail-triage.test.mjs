// T1 scheduler autonomous — unit test del motore di triage posta
// (scripts/yano-mail-triage.mjs). Bridge MCP e fetch LLM sempre mockati:
// nessun accesso a Mail.app, nessuna rete. Stesso pattern degli altri
// orchestrator-tools/*.test.mjs.
import { describe, expect, it, vi } from "vitest";

const {
	classifyPromo,
	hasUnsubscribeSignal,
	isExcluded,
	loadSeen,
	parseItalianDate,
	runMailTriage,
	saveSeen,
	seenKey,
} = await import("../yano-mail-triage.mjs");

const boxes = [
	{ name: "INBOX", account: "Google", unreadCount: 2 },
	{ name: "INBOX", account: "iCloud", unreadCount: 0 },
	{ name: "Sent", account: "Google", unreadCount: 0 },
];

function fakeFetch(promo, reason = "test") {
	return vi.fn(async () => ({
		ok: true,
		json: async () => ({ content: [{ type: "text", text: `ok\n${JSON.stringify({ promo, reason })}` }] }),
	}));
}

function fakeBridge({ full = {}, deleted = [] } = {}) {
	return {
		started: true,
		async call(tool, args = {}) {
			if (tool === "list_mailboxes") return { content: [{ type: "text", text: JSON.stringify(boxes) }] };
			if (tool === "list_messages") {
				const list = args.account === "Google"
					? [{ id: 1, subject: "Promo", sender: "shop@example.com", date: "mercoledì 16 settembre 2026 alle ore 10:00:00", isRead: false }]
					: [{ id: 2, subject: "Fattura", sender: "f@example.com", date: "mercoledì 16 settembre 2026 alle ore 09:00:00", isRead: true }];
				return { content: [{ type: "text", text: JSON.stringify(list) }] };
			}
			if (tool === "get_message") {
				return {
					content: [{
						type: "text",
						text: JSON.stringify(full[args.message_id] || { id: args.message_id, subject: "Promo", sender: "shop@example.com", date: "oggi", isRead: false, content: "OFFERTA -50% solo per te. Disiscriviti qui." }),
					}],
				};
			}
			if (tool === "delete_message") { deleted.push(args.message_id); return { content: [{ type: "text", text: "Message deleted (moved to trash)" }] }; }
			throw new Error(`tool inatteso: ${tool}`);
		},
		stop() {},
	};
}

describe("mail-triage: regole deterministiche", () => {
	it("isExcluded blocca fatture/banche/fisco senza chiamare LLM", () => {
		expect(isExcluded({ subject: "Fattura n. 42", sender: "x@y" })).toBe(true);
		expect(isExcluded({ subject: "Estratto conto", sender: "banca" })).toBe(true);
		expect(isExcluded({ subject: "-50% solo per te", sender: "shop" })).toBe(false);
	});
	it("hasUnsubscribeSignal trova unsubscribe nel corpo/footer", () => {
		expect(hasUnsubscribeSignal({ body: "Per disiscriverti clicca qui" })).toBe(true);
		expect(hasUnsubscribeSignal({ body: "List-Unsubscribe: <mailto:x>" })).toBe(true);
		expect(hasUnsubscribeSignal({ body: "La tua fattura di settembre" })).toBe(false);
	});
	it("seenKey è stabile per account+mailbox+id", () => {
		expect(seenKey("Google", "INBOX", 5)).toBe(seenKey("Google", "INBOX", 5));
		expect(seenKey("Google", "INBOX", 5)).not.toBe(seenKey("iCloud", "INBOX", 5));
	});
	it("parseItalianDate legge le date di Mail in italiano", () => {
		const date = parseItalianDate("mercoledì 16 settembre 2026 alle ore 10:00:26");
		expect(date?.getFullYear()).toBe(2026);
		expect(date?.getMonth()).toBe(8);
		expect(parseItalianDate("not a date")).toBe(null);
	});
	it("loadSeen/saveSeen girano su YANO_DATA_DIR isolato", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const env = { YANO_DATA_DIR: mkdtempSync(join(tmpdir(), "triage-seen-")) };
		expect(loadSeen(env)).toEqual({});
		saveSeen({ "a|||INBOX|||1": { verdict: "KEEP", reason: "x", at: new Date().toISOString() } }, env);
		expect(Object.keys(loadSeen(env))).toHaveLength(1);
	});
});

describe("mail-triage: classifyPromo", () => {
	it("legge promo+reason dal JSON LLM", async () => {
		const result = await classifyPromo({ subject: "x", sender: "y", body: "z" }, { env: {}, fetchImpl: fakeFetch(true, "promo") });
		expect(result).toMatchObject({ ok: true, promo: true, reason: "promo" });
	});
	it("fallisce chiuso su HTTP non-ok (niente verdetto inventato)", async () => {
		const bad = vi.fn(async () => ({ ok: false, status: 500 }));
		const result = await classifyPromo({ subject: "x" }, { env: {}, fetchImpl: bad });
		expect(result.ok).toBe(false);
	});
	it("estrae il JSON anche dentro il wrapper llmProxy (preambolo+metering)", async () => {
		const wrapped = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				content: [{
					type: "text",
					text: "[llmp] provider: x | model: y | Intent: 1\n\n[INTENT: classify]\n\n" +
						'{"promo": true, "reason": "offerta con unsubscribe"}\n\n' +
						"[llmproxy] x/y (req 1, in 10, out 20) | credito residuo: n/a",
				}],
			}),
		}));
		const result = await classifyPromo({ subject: "x" }, { env: {}, fetchImpl: wrapped });
		expect(result).toMatchObject({ ok: true, promo: true, reason: "offerta con unsubscribe" });
	});
	it("fallisce chiuso su JSON senza promo", async () => {
		const bad = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ text: "ciao" }] }) }));
		const result = await classifyPromo({ subject: "x" }, { env: {}, fetchImpl: bad });
		expect(result.ok).toBe(false);
	});
});

describe("mail-triage: runMailTriage", () => {
	function isolatedEnv(extra = {}) {
		return { YANO_DATA_DIR: `/tmp/triage-ut-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, YANO_TEST_MODE: "1", ...extra };
	}
	it("promo+unsubscribe → delete (mock), fattura → KEEP senza LLM", async () => {
		const deleted = [];
		const fetchImpl = fakeFetch(true, "promo test");
		const report = await runMailTriage({
			env: isolatedEnv(),
			fetchImpl,
			bridge: fakeBridge({ deleted }),
			notify: false,
		});
		expect(report.ok).toBe(true);
		expect(report.deleted).toHaveLength(1);
		expect(deleted).toEqual([1]);
		expect(report.skipped_excluded).toBe(1);
		expect(fetchImpl).toHaveBeenCalledTimes(1); // solo la promo: la fattura mai all'LLM
	});
	it("promo SENZA unsubscribe → review, mai delete", async () => {
		const deleted = [];
		const bridge = fakeBridge({
			deleted,
			full: { 1: { id: 1, subject: "Promo", sender: "s", date: "oggi", isRead: false, content: "OFFERTA senza footer" } },
		});
		const report = await runMailTriage({ env: isolatedEnv(), fetchImpl: fakeFetch(true), bridge, notify: false });
		expect(report.ok).toBe(true);
		expect(report.deleted).toHaveLength(0);
		expect(report.review).toHaveLength(1);
		expect(deleted).toHaveLength(0);
	});
	it("non-promo → KEEP, mai delete", async () => {
		const deleted = [];
		const report = await runMailTriage({ env: isolatedEnv(), fetchImpl: fakeFetch(false, "lavoro"), bridge: fakeBridge({ deleted }), notify: false });
		expect(report.kept).toBe(1);
		expect(deleted).toHaveLength(0);
	});
	it("dry-run non cancella mai e non marca seen", async () => {
		const deleted = [];
		const env = isolatedEnv({ YANO_MAIL_DRY_RUN: "1" });
		const report = await runMailTriage({ env, fetchImpl: fakeFetch(true), bridge: fakeBridge({ deleted }), notify: false });
		expect(report.dry_run).toBe(true);
		expect(report.deleted).toHaveLength(1);
		expect(report.deleted[0].dry_run).toBe(true);
		expect(deleted).toHaveLength(0);
		// In dry-run le esclusioni deterministiche (KEEP, mai delete) vanno in
		// seen, ma nessun verdetto DELETE/REVIEW deve essere memorizzato.
		const verdicts = Object.values(loadSeen(env)).map((entry) => entry.verdict);
		expect(verdicts).not.toContain("DELETE");
		expect(verdicts).not.toContain("REVIEW");
	});
	it("errore LLM → errori riportati, ok=false, nessuna delete", async () => {
		const deleted = [];
		const bad = vi.fn(async () => { throw new Error("llm giù"); });
		const report = await runMailTriage({ env: isolatedEnv(), fetchImpl: bad, bridge: fakeBridge({ deleted }), notify: false });
		expect(report.ok).toBe(false);
		expect(report.errors.length).toBeGreaterThan(0);
		expect(deleted).toHaveLength(0);
	});
	it("cap YANO_MAIL_MAX_DELETE=0 → tutto in review", async () => {
		const deleted = [];
		const report = await runMailTriage({ env: isolatedEnv({ YANO_MAIL_MAX_DELETE: "0" }), fetchImpl: fakeFetch(true), bridge: fakeBridge({ deleted }), notify: false });
		expect(report.deleted).toHaveLength(0);
		expect(report.review).toHaveLength(1);
		expect(deleted).toHaveLength(0);
	});
	it("messaggi già visti vengono saltati (skipped_seen)", async () => {
		const deleted = [];
		const env = isolatedEnv();
		const first = await runMailTriage({ env, fetchImpl: fakeFetch(true), bridge: fakeBridge({ deleted }), notify: false });
		expect(first.deleted).toHaveLength(1);
		const second = await runMailTriage({ env, fetchImpl: fakeFetch(true), bridge: fakeBridge({ deleted: [] }), notify: false });
		expect(second.skipped_seen).toBeGreaterThan(0);
		expect(second.deleted).toHaveLength(0);
	});
	it("rifiuta non-macOS senza override", async () => {
		const { platform } = process;
		Object.defineProperty(process, "platform", { value: "linux" });
		try {
			const report = await runMailTriage({ env: isolatedEnv(), fetchImpl: fakeFetch(true), bridge: fakeBridge(), notify: false });
			expect(report.ok).toBe(false);
			expect(report.errors.join(" ")).toMatch(/non-macOS/);
		} finally {
			Object.defineProperty(process, "platform", { value: platform });
		}
	});
});
