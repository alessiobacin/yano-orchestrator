#!/usr/bin/env node

// Standalone (no live Pi agent required) notification sender used by
// scheduled system jobs — the daily digest (Fase 9) is the first caller.
// A "self"-mode scheduler job is a bare Node script; it has no access to
// orchestrator.ts's per-agent sendNotifications() closure. Rather than
// duplicating the three provider integrations again, this ports the exact
// same logic (same env var names, same message-framing convention) against
// resolveYanoConfig() — which already merges the global config file with
// process.env — so it reads only the GLOBAL notification channel, matching
// Decision 2 ("il digest usa sempre il canale globale").

import os from "node:os";
import { resolveYanoConfig } from "./yano-config.mjs";

async function sendWhatsAppNotification(message, config, fetchImpl) {
	const apiUrl = config.EVOLUTION_API_URL;
	const apiKey = config.EVOLUTION_API_KEY;
	const instanceName = config.EVOLUTION_INSTANCE_NAME;
	const destination = config.DESTINATION_PHONE_NUMBER;
	const missing = [!apiUrl && "EVOLUTION_API_URL", !apiKey && "EVOLUTION_API_KEY", !instanceName && "EVOLUTION_INSTANCE_NAME", !destination && "DESTINATION_PHONE_NUMBER"].filter(Boolean);
	if (missing.length) return { ok: false, detail: `non configurato — variabili mancanti nella config globale: ${missing.join(", ")}` };
	try {
		const url = `${apiUrl.replace(/\/+$/, "")}/message/sendText/${encodeURIComponent(instanceName)}`;
		const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", apikey: apiKey }, body: JSON.stringify({ number: destination, text: message }) });
		if (!res.ok) return { ok: false, detail: `Evolution API ha risposto ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` };
		return { ok: true, detail: "inviato" };
	} catch (err) { return { ok: false, detail: err instanceof Error ? err.message : String(err) }; }
}

async function sendTelegramNotification(message, config, fetchImpl) {
	const token = config.TELEGRAM_BOT_TOKEN;
	const chatId = config.TELEGRAM_DESTINATION_CHAT_ID;
	if (!token || !chatId) return { ok: false, detail: `non configurato — variabili mancanti nella config globale: ${[!token && "TELEGRAM_BOT_TOKEN", !chatId && "TELEGRAM_DESTINATION_CHAT_ID"].filter(Boolean).join(", ")}` };
	try {
		const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }) });
		if (!res.ok) return { ok: false, detail: `Telegram ha risposto ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` };
		const payload = await res.json().catch(() => null);
		return payload?.ok === false ? { ok: false, detail: `Telegram ha rifiutato il messaggio: ${String(payload.description || "errore sconosciuto")}` } : { ok: true, detail: "inviato" };
	} catch (err) { return { ok: false, detail: err instanceof Error ? err.message : String(err) }; }
}

async function sendEmailNotification(message, config, fetchImpl) {
	const apiKey = config.SENDGRID_API_KEY;
	const from = config.SENDGRID_FROM_EMAIL;
	const to = config.SENDGRID_TO_EMAIL;
	if (!apiKey || !from || !to) return { ok: false, detail: `non configurato — variabili mancanti nella config globale: ${[!apiKey && "SENDGRID_API_KEY", !from && "SENDGRID_FROM_EMAIL", !to && "SENDGRID_TO_EMAIL"].filter(Boolean).join(", ")}` };
	const recipients = to.split(",").map((email) => email.trim()).filter(Boolean).map((email) => ({ email }));
	if (!recipients.length) return { ok: false, detail: "non configurato — SENDGRID_TO_EMAIL è vuoto" };
	try {
		const res = await fetchImpl("https://api.sendgrid.com/v3/mail/send", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ personalizations: [{ to: recipients }], from: { email: from }, subject: config.SENDGRID_SUBJECT || "Yano notification", content: [{ type: "text/plain", value: message }] }),
		});
		if (!res.ok) return { ok: false, detail: `SendGrid ha risposto ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` };
		return { ok: true, detail: "inviato" };
	} catch (err) { return { ok: false, detail: err instanceof Error ? err.message : String(err) }; }
}

export async function sendGlobalNotification(message, { env = process.env, sender = "yano", fetchImpl = globalThis.fetch } = {}) {
	const config = resolveYanoConfig({ env });
	const contextual = [`Mittente: ${sender}`, `Server: ${os.hostname()}`, "", message].join("\n");
	const [whatsapp, telegram, email] = await Promise.all([
		sendWhatsAppNotification(contextual, config, fetchImpl),
		sendTelegramNotification(contextual, config, fetchImpl),
		sendEmailNotification(contextual, config, fetchImpl),
	]);
	const channels = { whatsapp, telegram, email };
	const ok = Object.values(channels).some((result) => result.ok);
	const detail = Object.entries(channels).map(([channel, result]) => `${channel}: ${result.detail}`).join("; ");
	return { ok, detail, channels };
}
