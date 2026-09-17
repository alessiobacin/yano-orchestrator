#!/usr/bin/env node
// Regole persistenti dello scheduler-service (T1 scheduler executor).
//
// Le regole utente per gli schedule vivono nel data-root globale
// (<data>/scheduler/scheduler-rules.json) — lo stesso root di jobs.json —
// quindi SOPRAVVIVONO al reset della chat. Lo scheduler-service le legge a
// ogni tick/run; le query semantiche ("quali schedule?", "quali regole
// cancellazione attive?") e la modifica/cancellazione semantica passano da
// questo modulo, mai da rimozioni manuali del file.
//
// Sicurezza: i pattern sono DATI confrontati con includes()/token-overlap,
// mai shell, mai regex utente, mai eval. Solo Cestino: nessuna regola può
// chiedere cancellazione definitiva (le action ammesse sono chiuse).
//
// Uso: yano schedule-rules <add|list|query|update|remove|seed> [...]
// Libreria: addRule/listRules/queryRules/updateRule/removeRule/matchRules/
//           resolveScheduleRules/ensureDefaultEmailRules.

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalDataPath } from "./yano-config.mjs";

export const RULE_KINDS = ["blocklist", "unsubscribe", "keep", "generic"];
export const RULE_ACTIONS = ["trash", "unsubscribe_then_trash", "review", "keep"];

export function schedulerRulesFile(env = process.env) {
	const root = env.YANO_DATA_DIR
		? path.resolve(env.YANO_DATA_DIR)
		: path.join(os.homedir(), "Library", "Application Support", "yano", "data");
	return path.join(root, "scheduler", "scheduler-rules.json");
}

function blankStore() { return { version: 1, rules: [] }; }

export function loadRuleStore(env = process.env) {
	try {
		const parsed = JSON.parse(readFileSync(schedulerRulesFile(env), "utf8"));
		if (parsed && Array.isArray(parsed.rules)) return { version: 1, rules: parsed.rules };
	} catch { /* prima esecuzione: store vuoto */ }
	return blankStore();
}

export function saveRuleStore(store, env = process.env) {
	const file = schedulerRulesFile(env);
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, file);
	return file;
}

function nowIso() { return new Date().toISOString(); }
function norm(text) { return String(text || "").toLowerCase().trim(); }
function tokens(text) { return norm(text).split(/[^a-zà-ÿ0-9@.]+/i).filter((w) => w.length >= 3); }
// Query semantica leggera italiano: stemming per prefisso (regole/regola) +
// famiglie di sinonimi (cancellazione/cestino/trash/delete/elimina, ...).
function stem(token) { return token.slice(0, 5); }
const TOKEN_FAMILIES = [
	["cance", "cesti", "trash", "delet", "elimi", "spost"],
	["regol", "rule"],
	["unsub", "disis", "iscri"],
	["bloc", "block"],
	["sched"],
	["email", "posta", "mail"],
	["promo", "pubbl"],
	["attiv", "enabl"],
];
function familyOf(stemmed) {
	return TOKEN_FAMILIES.findIndex((family) => family.some((prefix) => stemmed.startsWith(prefix) || prefix.startsWith(stemmed)));
}
function tokenMatch(queryStem, hayStems) {
	if (hayStems.has(queryStem)) return true;
	const family = familyOf(queryStem);
	if (family < 0) return false;
	for (const hay of hayStems) if (familyOf(hay) === family) return true;
	return false;
}

function validateRule({ kind, action, pattern }) {
	if (!pattern || !norm(pattern)) throw new Error("yano schedule-rules: pattern obbligatorio.");
	if (!RULE_KINDS.includes(kind)) throw new Error(`yano schedule-rules: kind non valido (${kind}); ammessi: ${RULE_KINDS.join(", ")}.`);
	if (!RULE_ACTIONS.includes(action)) throw new Error(`yano schedule-rules: action non valida (${action}); ammesse: ${RULE_ACTIONS.join(", ")}.`);
	// Mai cancellazione definitiva: l'unico esito distruttivo è il Cestino.
}

export function addRule({ pattern, kind = "generic", action = "review", schedule_id = null, note = "" } = {}, env = process.env) {
	validateRule({ kind, action, pattern });
	const store = loadRuleStore(env);
	const rule = {
		id: `SRULE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
		pattern: String(pattern).trim(),
		kind, action,
		schedule_id: schedule_id || null,
		note: String(note || ""),
		enabled: true,
		created_at: nowIso(),
		updated_at: nowIso(),
	};
	store.rules.push(rule);
	saveRuleStore(store, env);
	return rule;
}

export function listRules({ schedule_id = null, include_disabled = false } = {}, env = process.env) {
	const { rules } = loadRuleStore(env);
	return rules.filter((rule) => {
		if (!include_disabled && rule.enabled === false) return false;
		if (schedule_id && rule.schedule_id !== null && rule.schedule_id !== schedule_id) return false;
		return true;
	});
}

// Query semantica: substring diretta vince (score alto), altrimenti overlap
// di token. Ritorna le regole ordinate per rilevanza. Query vuota = tutte.
export function queryRules(query, { schedule_id = null } = {}, env = process.env) {
	const q = norm(query);
	const qTokens = new Set(tokens(q));
	const scored = [];
	for (const rule of listRules({ schedule_id }, env)) {
		const hay = `${rule.pattern} ${rule.note} ${rule.kind} ${rule.action} ${rule.schedule_id || ""} ${rule.enabled === false ? "disabilitata" : "attiva"}`;
		const hayNorm = norm(hay);
		let score = 0;
		if (!q) score = 1;
		else if (hayNorm.includes(q)) score = 100 + q.length;
		else {
			const hayStems = new Set(tokens(hay).map(stem));
			let overlap = 0;
			for (const token of qTokens) if (tokenMatch(stem(token), hayStems)) overlap += 1;
			if (overlap > 0) score = overlap;
		}
		if (score > 0) scored.push({ rule, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.map((entry) => entry.rule);
}

export function updateRule(id, patch = {}, env = process.env) {
	const store = loadRuleStore(env);
	const rule = store.rules.find((candidate) => candidate.id === id);
	if (!rule) throw new Error(`yano schedule-rules: regola non trovata: ${id}`);
	const next = { ...rule };
	if (patch.pattern !== undefined) next.pattern = String(patch.pattern).trim();
	if (patch.kind !== undefined) next.kind = patch.kind;
	if (patch.action !== undefined) next.action = patch.action;
	if (patch.note !== undefined) next.note = String(patch.note);
	if (patch.schedule_id !== undefined) next.schedule_id = patch.schedule_id || null;
	if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
	validateRule(next);
	if (!next.pattern) throw new Error("yano schedule-rules: pattern non può essere vuoto.");
	next.updated_at = nowIso();
	Object.assign(rule, next);
	saveRuleStore(store, env);
	return rule;
}

export function removeRule(id, env = process.env) {
	const store = loadRuleStore(env);
	const before = store.rules.length;
	store.rules = store.rules.filter((rule) => rule.id !== id);
	if (store.rules.length === before) throw new Error(`yano schedule-rules: regola non trovata: ${id}`);
	saveRuleStore(store, env);
	return { removed: id };
}

// Regole attive che matchano il testo (mittente+oggetto+corpo): prima le
// specifiche dello schedule, poi le globali. Usato dal triage email.
export function matchRules(text, { schedule_id = null } = {}, env = process.env) {
	const hay = norm(text);
	const matched = [];
	for (const rule of listRules({ schedule_id, include_disabled: false }, env)) {
		if (!rule.pattern || !hay.includes(norm(rule.pattern))) continue;
		matched.push(rule);
	}
	matched.sort((a, b) => Number(b.schedule_id !== null) - Number(a.schedule_id !== null));
	return matched;
}

// Vista per schedule: regole globali + regole dello schedule.
export function resolveScheduleRules(schedule_id, env = process.env) {
	const { rules } = loadRuleStore(env);
	const active = rules.filter((rule) => rule.enabled !== false);
	return {
		schedule_id,
		global: active.filter((rule) => rule.schedule_id === null),
		schedule: active.filter((rule) => rule.schedule_id === schedule_id),
	};
}

// Regole email iniziali confermate dall'utente (idempotenti per id stabile):
// (a) support@mail.xtb.com → sempre Cestino; (b) pubblicità con unsubscribe
// → tentativo disiscrizione, altrimenti Cestino. Mai delete definitiva.
export const DEFAULT_EMAIL_RULES = [
	{
		id: "email-blocklist-xtb-support",
		pattern: "support@mail.xtb.com",
		kind: "blocklist",
		action: "trash",
		note: "Mittente sempre cestinato (regola iniziale confermata). Solo Cestino, mai definitiva.",
	},
	{
		id: "email-unsubscribe-ads",
		pattern: "unsubscribe",
		kind: "unsubscribe",
		action: "unsubscribe_then_trash",
		note: "Pubblicità con segnale unsubscribe: tenta disiscrizione (link diretto, poi browser se serve), altrimenti Cestino.",
	},
];

export function ensureDefaultEmailRules(env = process.env) {
	const store = loadRuleStore(env);
	let created = 0;
	for (const seed of DEFAULT_EMAIL_RULES) {
		if (store.rules.some((rule) => rule.id === seed.id)) continue;
		store.rules.push({ ...seed, schedule_id: null, enabled: true, created_at: nowIso(), updated_at: nowIso() });
		created += 1;
	}
	if (created) saveRuleStore(store, env);
	return { created };
}

function value(argv, flag) { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] || null; }
function fail(message) { throw new Error(message); }

function usage() {
	return [
		"Uso: yano schedule-rules <add|list|query|update|remove|seed> [opzioni]",
		"  Regole persistenti dello scheduler (sopravvivono al reset chat). Solo Cestino, mai delete definitiva.",
		"  add --pattern <testo> [--kind blocklist|unsubscribe|keep|generic] [--action trash|unsubscribe_then_trash|review|keep]",
		"      [--schedule-id <id>] [--note <testo>] [--json]",
		"  list [--schedule-id <id>] [--all] [--json]",
		"  query <testo> [--schedule-id <id>] [--json]   Ricerca semantica (es. \"quali regole cancellazione attive?\")",
		"  update --id <id> [--pattern ...] [--kind ...] [--action ...] [--note ...] [--schedule-id ...] [--enable|--disable] [--json]",
		"  remove --id <id> [--json]",
		"  seed [--json]   Installa le regole email iniziali (idempotente)",
	].join("\n");
}

export function runYanoSchedulerRules({ argv = [], env = process.env } = {}) {
	const [sub, ...rest] = argv;
	const json = rest.includes("--json");
	if (!sub || sub === "--help" || sub === "-h") { console.log(usage()); return { help: true }; }
	let result;
	if (sub === "seed") {
		result = ensureDefaultEmailRules(env);
	} else if (sub === "add") {
		const pattern = value(rest, "--pattern") || rest.filter((v) => !v.startsWith("--")).join(" ").trim();
		if (!pattern) fail("yano schedule-rules add: --pattern <testo> obbligatorio.");
		result = { added: addRule({
			pattern,
			kind: value(rest, "--kind") || "generic",
			action: value(rest, "--action") || "review",
			schedule_id: value(rest, "--schedule-id") || null,
			note: value(rest, "--note") || "",
		}, env) };
	} else if (sub === "list") {
		const scheduleId = value(rest, "--schedule-id") || null;
		result = listRules({ schedule_id: scheduleId, include_disabled: rest.includes("--all") }, env);
	} else if (sub === "query") {
		const text = rest.filter((v) => !v.startsWith("--") && v !== "query").join(" ").trim();
		result = queryRules(text, { schedule_id: value(rest, "--schedule-id") || null }, env);
	} else if (sub === "update") {
		const id = value(rest, "--id") || fail("yano schedule-rules update: --id obbligatorio.");
		const patch = {};
		if (value(rest, "--pattern")) patch.pattern = value(rest, "--pattern");
		if (value(rest, "--kind")) patch.kind = value(rest, "--kind");
		if (value(rest, "--action")) patch.action = value(rest, "--action");
		if (value(rest, "--note")) patch.note = value(rest, "--note");
		if (value(rest, "--schedule-id")) patch.schedule_id = value(rest, "--schedule-id");
		if (rest.includes("--enable")) patch.enabled = true;
		if (rest.includes("--disable")) patch.enabled = false;
		if (!Object.keys(patch).length) fail("yano schedule-rules update: niente da aggiornare (passa --pattern/--kind/--action/--note/--enable/--disable).");
		result = { updated: updateRule(id, patch, env) };
	} else if (sub === "remove") {
		const id = value(rest, "--id") || fail("yano schedule-rules remove: --id obbligatorio.");
		result = removeRule(id, env);
	} else {
		console.log(usage());
		fail(`sottocomando sconosciuto: ${sub}`);
	}
	if (json) console.log(JSON.stringify(result, null, 2));
	else if (Array.isArray(result)) console.log(result.map((rule) => `${rule.enabled === false ? "–" : "✓"} ${rule.id} [${rule.kind}/${rule.action}]${rule.schedule_id ? ` @${rule.schedule_id}` : ""} — ${rule.pattern}`).join("\n") || "nessuna regola");
	else console.log(JSON.stringify(result, null, 2));
	return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
	try { runYanoSchedulerRules({ argv: process.argv.slice(2) }); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
