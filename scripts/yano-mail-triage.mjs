#!/usr/bin/env node
// Motore di triage della posta per i job scheduler in mode "self".
//
// Lo scheduler-service esegue MATERIALMENTE le schedulazioni: questo modulo
// implementa l'intero flusso "leggi INBOX → classifica → sposta nel Cestino"
// senza passare da yano-local-pc. La classificazione usa llmProxy via HTTP
// (stessa convenzione degli agenti Pi: header `x-api-key: proxy-local` sul
// loopback locale, override con YANO_LLMPROXY_URL / YANO_LLMPROXY_API_KEY a
// runtime) e l'accesso a Mail.app passa dal server MCP apple-mail
// (@griches/apple-mail-mcp: puro wrapper osascript, ZERO credenziali)
// pilotato qui direttamente su stdio (JSON-RPC) — nessuna duplicazione di
// segreti, nessun token negli script.
//
// Sicurezza (stessi vincoli dei job scheduler):
// - nessuna shell: gli unici spawn sono node/npx con argv fissi, mai stringhe;
// - nessun token incorporato: solo env a runtime;
// - solo Cestino: delete_message di Mail sposta nel Cestino (recuperabile);
//   MAI cancellazione definitiva, MAI svuotare il Cestino;
// - il dubbio prevale sempre la NON cancellazione; cap 200 delete/run;
// - solo messaggi recenti (default ultime 48h, come il job storico).
//
// Uso dallo stub registrato in <data>/scheduler/scripts/ (pattern digest):
//   import { runMailTriage } from "file://<package>/scripts/yano-mail-triage.mjs";
//   const report = await runMailTriage();
//   console.log(JSON.stringify(report));
//   process.exit(report.ok ? 0 : 1);
//
// Env:
//   YANO_MAIL_DRY_RUN=1        classifica soltanto, nessuna delete
//   YANO_MAIL_MAX_DELETE=N     cap cancellazioni (default 200)
//   YANO_MAIL_PER_BOX=N        messaggi listati per INBOX (default 25)
//   YANO_MAIL_MAX_EXAMINE=N    cap messaggi esaminati per run (default 60)
//   YANO_MAIL_SINCE_HOURS=N    finestra recentezza in ore (default 48)
//   YANO_LLMPROXY_URL          default http://127.0.0.1:7045
//   YANO_LLMPROXY_API_KEY      default "proxy-local" (placeholder loopback Pi)
//   YANO_APPLE_MAIL_MCP_BIN    override path diretto al server MCP
//   YANO_DATA_DIR              data-root (per lo stato seen)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendGlobalNotification } from "./yano-notify.mjs";

const DEFAULT_LLM_URL = "http://127.0.0.1:7045";
const DEFAULT_MAX_DELETE = 200;
const DEFAULT_PER_BOX = 25;
const DEFAULT_MAX_EXAMINE = 60;
const DEFAULT_SINCE_HOURS = 48;
const BODY_CHARS_FOR_LLM = 6000;
const SEEN_RETENTION_DAYS = 30;

// Parole/frasi che marcano un messaggio come NON promozionale (esclusioni
// deterministiche: niente chiamata LLM, KEEP immediato). Stessa lista del
// prompt storico del job (fatture, ricevute, ordini, banche, fisco, ...).
const EXCLUSION_RE = /(fattur|ricevut|scontrin|ordin[ei]|spedizion|tracking|consegn|banc|estratto conto|assicurazion|fisco|agenzia delle entrate|bollett|utenz|contratt|prenotazion|booking|credenzial|password|otp|verific|codice di sicurezza|calendario|invito|cedolino|busta paga|mutuo|finanziament)/i;

// Segnali di unsubscribe cercati in oggetto+mittente+corpo (get_message non
// espone gli header: la valutazione avviene sul corpo/footer, come da regola
// storica "in caso di dubbio prevale la NON cancellazione").
const UNSUBSCRIBE_RE = /(unsubscribe|disiscriv|annulla (l')?iscrizione|cancella (l')?iscrizione|gestisci( le)? preferenze|email preferences|modifica( le)? (tue |le )?preferenze|opt-?out|list-unsubscribe|rimuovimi|cancellami|non ricevere pi)/i;

// Mesi italiani per il filtro recentezza ("16 settembre 2026 alle ore 10:00").
const MONTHS_IT = {
	gennaio: 0, febbraio: 1, marzo: 2, aprile: 3, maggio: 4, giugno: 5,
	luglio: 6, agosto: 7, settembre: 8, ottobre: 9, novembre: 10, dicembre: 11,
};

export function parseItalianDate(text) {
	const match = String(text || "").match(/(\d{1,2})\s+([a-zà]+)\s+(\d{4})\s+alle\s+ore\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
	if (!match) return null;
	const month = MONTHS_IT[match[2].toLowerCase()];
	if (month === undefined) return null;
	return new Date(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
}

function llmConfig(env = process.env) {
	return {
		baseUrl: (env.YANO_LLMPROXY_URL || DEFAULT_LLM_URL).replace(/\/+$/, ""),
		apiKey: env.YANO_LLMPROXY_API_KEY || "proxy-local",
	};
}

function stateFile(env = process.env) {
	const root = env.YANO_DATA_DIR
		? path.resolve(env.YANO_DATA_DIR)
		: path.join(os.homedir(), "Library", "Application Support", "yano", "data");
	return path.join(root, "scheduler", "mail-triage-seen.json");
}

export function loadSeen(env = process.env) {
	try {
		const parsed = JSON.parse(readFileSync(stateFile(env), "utf8"));
		if (parsed && typeof parsed === "object") return parsed;
	} catch { /* nessuno stato: prima esecuzione */ }
	return {};
}

export function saveSeen(seen, env = process.env) {
	const file = stateFile(env);
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const cutoff = Date.now() - SEEN_RETENTION_DAYS * 24 * 3600 * 1000;
	for (const [key, entry] of Object.entries(seen)) {
		if (!entry || Number.isNaN(Date.parse(entry.at || "")) || Date.parse(entry.at) < cutoff) delete seen[key];
	}
	writeFileSync(file, `${JSON.stringify(seen, null, 2)}\n`, { mode: 0o600 });
}

export function seenKey(account, mailbox, id) {
	return `${account}|||${mailbox}|||${id}`;
}

export function hasUnsubscribeSignal({ subject = "", sender = "", body = "" } = {}) {
	return UNSUBSCRIBE_RE.test(`${subject}\n${sender}\n${body}`);
}

export function isExcluded({ subject = "", sender = "" } = {}) {
	return EXCLUSION_RE.test(`${subject}\n${sender}`);
}

// llmProxy avvolge la risposta del modello tra un preambolo di routing
// ([INTENT: ...]) e un trailer di metering ([llmproxy] ...): il JSON sta in
// mezzo. Estrazione con parentesi bilanciate dal primo `{` — mai lastIndexOf
// (il trailer potrebbe contenere a sua volta parentesi in futuro).
export function extractJson(text) {
	const raw = String(text || "");
	const start = raw.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i++) {
		const char = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
		} else if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
			}
		}
	}
	return null;
}

export async function classifyPromo({ subject = "", sender = "", body = "" } = {}, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
	const { baseUrl, apiKey } = llmConfig(env);
	const prompt = [
		"Sei un classificatore di email. Rispondi SOLO con un oggetto JSON.",
		"",
		`Oggetto: ${subject}`,
		`Mittente: ${sender}`,
		`Corpo (troncato):\n${String(body).slice(0, BODY_CHARS_FOR_LLM)}`,
		"",
		"La email è pubblicità/promozione? È promozionale SOLO se propone CHIARAMENTE un nuovo servizio",
		"('prova il nostro nuovo...', 'ti presentiamo...', nuovo piano/servizio/funzionalità a pagamento,",
		"attivazioni, upgrade commerciali), oppure newsletter commerciale, offerte, sconti, saldi, 'ultimi giorni',",
		"'solo per te', codice sconto, 'scopri di più'. NON è pubblicità: fatture, ricevute, ordini, spedizioni,",
		"banche, assicurazioni, fisco, bollette, contratti, prenotazioni, credenziali, inviti a calendario,",
		"email di lavoro o da persone reali, notifiche di servizi realmente usati, QUALSIASI dubbio.",
		'Rispondi SOLO: {"promo": true|false, "reason": "<breve motivazione in italiano>"}',
	].join("\n");
	// Due tentativi al massimo: se il primo non produce JSON valido, il secondo
	// riusa gli stessi dati con framing più stretto. Mai verdetti inventati:
	// se anche il retry fallisce, il messaggio resta non-giudicato e verrà
	// riprovato alla prossima ora (NON entra in seen).
	for (let attempt = 0; attempt < 2; attempt++) {
		const strict = attempt === 1;
		const content = strict
			? `Rispondi con un SOLO oggetto JSON, senza alcun altro testo prima o dopo: {"promo": <true o false>, "reason": "<motivo in italiano>"}. Email — Oggetto: ${subject} Mittente: ${sender} Corpo: ${String(body).slice(0, BODY_CHARS_FOR_LLM)}`
			: prompt;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetchImpl(`${baseUrl}/v1/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
				body: JSON.stringify({ model: "llmproxy", max_tokens: 2000, messages: [{ role: "user", content }] }),
				signal: controller.signal,
			});
			if (!res.ok) return { ok: false, error: `llmProxy ha risposto ${res.status}` };
			const payload = await res.json().catch(() => null);
			const text = payload?.content?.map((block) => block?.text || "").join("") || "";
			const parsed = extractJson(text);
			if (typeof parsed?.promo === "boolean") return { ok: true, promo: parsed.promo, reason: String(parsed.reason || "") };
			if (strict) return { ok: false, error: "risposta LLM non JSON o senza campo promo (dopo retry)" };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	}
	return { ok: false, error: "risposta LLM non JSON" };
}

// ── Bridge MCP apple-mail su stdio ───────────────────────────────────────────
// Nessuna shell: spawn diretto di node sul server (cache npx più recente),
// oppure npx con argv fissi come fallback.
function resolveMailServerBin(env = process.env) {
	if (env.YANO_APPLE_MAIL_MCP_BIN && existsSync(env.YANO_APPLE_MAIL_MCP_BIN)) {
		return { command: process.execPath, args: [env.YANO_APPLE_MAIL_MCP_BIN] };
	}
	try {
		const cache = path.join(os.homedir(), ".npm", "_npx");
		const candidates = [];
		for (const entry of readdirSync(cache)) {
			const index = path.join(cache, entry, "node_modules", "@griches", "apple-mail-mcp", "build", "index.js");
			try {
				if (existsSync(index)) candidates.push({ index, mtime: statSync(index).mtimeMs });
			} catch { /* voce non leggibile */ }
		}
		candidates.sort((a, b) => b.mtime - a.mtime);
		if (candidates[0]) return { command: process.execPath, args: [candidates[0].index] };
	} catch { /* cache non leggibile: fallback npx */ }
	return { command: "npx", args: ["-y", "@griches/apple-mail-mcp"] };
}

export class McpMailBridge {
	constructor(env = process.env) {
		this.env = env;
		this.child = null;
		this.buf = "";
		this.seq = 0;
		this.pending = new Map();
	}
	start(timeoutMs = 30000) {
		if (this.child) return Promise.resolve();
		const { command, args } = resolveMailServerBin(this.env);
		return new Promise((resolve, reject) => {
			let child;
			try {
				child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
			} catch (error) { reject(error); return; }
			this.child = child;
			const timer = setTimeout(() => reject(new Error("avvio server apple-mail MCP scaduto")), timeoutMs);
			child.on("error", (error) => { clearTimeout(timer); reject(error); });
			child.stdout.on("data", (chunk) => this.#onData(chunk));
			this.#send({ jsonrpc: "2.0", id: "hello", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "yano-mail-triage", version: "1.0.0" } } })
				.then(() => { clearTimeout(timer); this.#notify({ jsonrpc: "2.0", method: "notifications/initialized" }); resolve(); })
				.catch((error) => { clearTimeout(timer); reject(error); });
		});
	}
	#onData(chunk) {
		this.buf += String(chunk);
		let index;
		while ((index = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, index).trim();
			this.buf = this.buf.slice(index + 1);
			if (!line) continue;
			let message;
			try { message = JSON.parse(line); } catch { continue; }
			if (message?.id !== undefined && this.pending.has(message.id)) {
				const { resolve, reject } = this.pending.get(message.id);
				this.pending.delete(message.id);
				if (message.error) reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
				else resolve(message.result);
			}
		}
	}
	#send(message) {
		return new Promise((resolve, reject) => {
			if (message.id !== undefined) this.pending.set(message.id, { resolve, reject });
			this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
				if (error) { this.pending.delete(message.id); reject(error); }
				else if (message.id === undefined) resolve(null);
			});
		});
	}
	#notify(message) {
		try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* best effort */ }
	}
	call(tool, args = {}, timeoutMs = 90000) {
		this.seq += 1;
		const id = `triage-${this.seq}`;
		const timer = setTimeout(() => {
			if (this.pending.has(id)) { this.pending.get(id).reject(new Error(`timeout chiamata MCP ${tool}`)); this.pending.delete(id); }
		}, timeoutMs);
		return this.#send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } })
			.then((result) => { clearTimeout(timer); return result; })
			.catch((error) => { clearTimeout(timer); throw error; });
	}
	stop() {
		try { this.child?.kill(); } catch { /* già chiuso */ }
		this.child = null;
	}
}

function toolText(result) {
	return result?.content?.map((block) => block?.text || "").join("") || "";
}

function toolJson(result) {
	const text = toolText(result);
	try { return JSON.parse(text); } catch { return { _raw: text }; }
}

function formatSummary(report) {
	const lines = [
		`Triage posta ${report.dry_run ? "(dry-run) " : ""}— esaminate: ${report.examined}, tenute: ${report.kept}, spostate nel Cestino: ${report.deleted.length}, da verificare: ${report.review.length}.`,
	];
	for (const item of report.deleted.slice(0, 20)) lines.push(`  🗑 [${item.account}] ${item.sender} — ${item.subject}`);
	if (report.deleted.length > 20) lines.push(`  … +${report.deleted.length - 20} altre`);
	for (const item of report.review.slice(0, 20)) lines.push(`  ❓ [${item.account}] ${item.sender} — ${item.subject} (${item.note || item.reason})`);
	if (report.review.length > 20) lines.push(`  … +${report.review.length - 20} altre`);
	for (const error of report.errors.slice(0, 5)) lines.push(`  ⚠️ ${error}`);
	return lines.join("\n");
}

// ── Triage ───────────────────────────────────────────────────────────────────
export async function runMailTriage({ env = process.env, fetchImpl = globalThis.fetch, bridge = null, notify = true } = {}) {
	if (process.platform !== "darwin" && !env.YANO_MAIL_ALLOW_NON_DARWIN) {
		return { ok: false, at: new Date().toISOString(), examined: 0, kept: 0, deleted: [], review: [], errors: ["piattaforma non-macOS: Mail.app assente, triage impossibile"] };
	}
	const dryRun = env.YANO_MAIL_DRY_RUN === "1" || process.argv.includes("--dry-run");
	const maxDelete = Math.max(0, Number(env.YANO_MAIL_MAX_DELETE || DEFAULT_MAX_DELETE));
	const perBox = Math.max(1, Number(env.YANO_MAIL_PER_BOX || DEFAULT_PER_BOX));
	const maxExamine = Math.max(1, Number(env.YANO_MAIL_MAX_EXAMINE || DEFAULT_MAX_EXAMINE));
	const sinceHours = Math.max(0, Number(env.YANO_MAIL_SINCE_HOURS ?? DEFAULT_SINCE_HOURS));
	const cutoff = Date.now() - sinceHours * 3600 * 1000;
	const report = {
		ok: false, dry_run: dryRun, at: new Date().toISOString(),
		examined: 0, skipped_seen: 0, skipped_old: 0, skipped_excluded: 0,
		verdicts: 0, deleted: [], review: [], kept: 0, errors: [],
	};
	const seen = loadSeen(env);
	const owned = !bridge;
	if (owned) {
		bridge = new McpMailBridge(env);
		try { await bridge.start(); }
		catch (error) {
			report.errors.push(`avvio bridge mail: ${error instanceof Error ? error.message : String(error)}`);
			return report;
		}
	}
	try {
		let boxes;
		try { boxes = toolJson(await bridge.call("list_mailboxes")); }
		catch (error) { report.errors.push(`list_mailboxes: ${error.message}`); return report; }
		if (!Array.isArray(boxes)) { report.errors.push("list_mailboxes: risposta non lista"); return report; }
		const inboxes = boxes.filter((box) => /^inbox$/i.test(box?.name || ""));
		let deleted = 0;
		for (const box of inboxes) {
			if (report.examined >= maxExamine) break;
			let messages;
			try { messages = toolJson(await bridge.call("list_messages", { mailbox: box.name, account: box.account, limit: perBox })); }
			catch (error) { report.errors.push(`list_messages ${box.account}: ${error.message}`); continue; }
			if (!Array.isArray(messages)) continue;
			for (const summary of messages) {
				if (report.examined >= maxExamine) break;
				const key = seenKey(box.account, box.name, summary.id);
				if (seen[key]) { report.skipped_seen += 1; continue; }
				const sentAt = parseItalianDate(summary.date);
				if (sentAt && sentAt.getTime() < cutoff) { report.skipped_old += 1; continue; }
				if (isExcluded({ subject: summary.subject, sender: summary.sender })) {
					report.skipped_excluded += 1;
					seen[key] = { verdict: "KEEP", reason: "esclusione deterministica", at: report.at };
					continue;
				}
				let full;
				try { full = toolJson(await bridge.call("get_message", { mailbox: box.name, account: box.account, message_id: summary.id })); }
				catch (error) { report.errors.push(`get_message ${summary.id}: ${error.message}`); continue; }
				report.examined += 1;
				const body = full.content || "";
				if (isExcluded({ subject: full.subject, sender: full.sender })) {
					report.skipped_excluded += 1;
					seen[key] = { verdict: "KEEP", reason: "esclusione deterministica (corpo)", at: report.at };
					continue;
				}
				const classified = await classifyPromo({ subject: full.subject, sender: full.sender, body }, { env, fetchImpl });
				if (!classified.ok) {
					report.errors.push(`classificazione ${summary.id}: ${classified.error}`);
					continue; // NON in seen: riprova alla prossima ora
				}
				const unsub = hasUnsubscribeSignal({ subject: full.subject, sender: full.sender, body });
				const entry = { id: summary.id, account: box.account, mailbox: box.name, sender: full.sender, subject: full.subject, reason: classified.reason };
				if (classified.promo && unsub) {
					if (dryRun) {
						report.deleted.push({ ...entry, dry_run: true });
						report.verdicts += 1;
						// NON in seen in dry-run: la decisione va riverificata dal vivo
					} else if (deleted >= maxDelete) {
						report.errors.push(`cap ${maxDelete} cancellazioni raggiunto; resto rimandato alla prossima ora`);
						seen[key] = { verdict: "REVIEW", reason: "cap raggiunto", at: report.at };
						report.review.push({ ...entry, note: "cap raggiunto, da riverificare" });
						report.verdicts += 1;
					} else {
						try {
							await bridge.call("delete_message", { message_id: summary.id, mailbox: box.name, account: box.account });
							deleted += 1;
							report.deleted.push(entry);
							seen[key] = { verdict: "DELETE", reason: classified.reason, at: report.at };
							report.verdicts += 1;
						} catch (error) {
							report.errors.push(`delete_message ${summary.id}: ${error.message}`);
						}
					}
				} else if (classified.promo && !unsub) {
					seen[key] = { verdict: "REVIEW", reason: "promozionale ma senza unsubscribe", at: report.at };
					report.review.push({ ...entry, note: "sembra promozionale ma senza unsubscribe: lasciata intatta" });
					report.verdicts += 1;
				} else {
					seen[key] = { verdict: "KEEP", reason: classified.reason, at: report.at };
					report.kept += 1;
					report.verdicts += 1;
				}
			}
		}
		// ok = pipeline girata con almeno un verdetto, oppure niente di nuovo
		// da esaminare e nessun errore. Errori puri (LLM/MCP giù) → exit 1.
		report.ok = report.verdicts > 0 || (report.examined === 0 && report.errors.length === 0);
	} finally {
		try { saveSeen(seen, env); } catch { /* stato best-effort */ }
		if (owned) bridge.stop();
	}
	if (notify && (report.ok || report.errors.length)) {
		try {
			report.notification = await sendGlobalNotification(formatSummary(report), { env, sender: "yano-mail-triage", fetchImpl });
		} catch (error) {
			report.errors.push(`notifica: ${error instanceof Error ? error.message : String(error)}`);
			report.notification = { ok: false, detail: "invio fallito" };
		}
	}
	return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
	runMailTriage().then((report) => {
		console.log(JSON.stringify(report));
		process.exit(report.ok ? 0 : 1);
	}).catch((error) => {
		console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
		process.exit(1);
	});
}
