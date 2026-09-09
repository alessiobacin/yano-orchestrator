// Fase 2 / M2 — multi-channel notifications (WhatsApp, Telegram, SendGrid),
// extracted from extensions/orchestrator.ts per the original audit's
// recommendation ("Spacchetta orchestrator.ts in storage/, watchdog/,
// notifications/, terminal-integration/, tools/{worktree,plan,ticket}").
//
// Unlike Fase 2/M0-M1 (module-level code with zero orchestrator state),
// these functions were declared INSIDE the default-exported extension
// function and closed over `identity` directly. Extracted here with
// `identity` as an explicit parameter of the same name, so every function
// body is otherwise unchanged — this is a dedent-and-inject move, not a
// rewrite. extensions/orchestrator.ts keeps thin wrappers
// (`sendNotifications = (msg) => notif.sendNotifications(msg, identity)`,
// etc.) so its ~15 existing call sites are untouched.
//
// Loaded as a plain .ts file under Node's --experimental-strip-types, same
// as scripts/yano-orchestrator-storage.ts and scripts/
// yano-terminal-integration.ts (Fase 2 / M0-M1).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { globalConfigPath, loadConfigFile } from "./yano-config.mjs";
import { formatNotification } from "./yano-notification-format.mjs";

export type NotificationIdentity = { cwd: string; instance?: string | null; role?: string | null; project?: string | null } | null;

// Same computation as extensions/orchestrator.ts's own copy (both files are
// one directory below the package root, so the relative path resolves to
// the same package.json either way) — kept as an independent copy rather
// than imported back from orchestrator.ts, since orchestrator.ts uses this
// constant in several places unrelated to notifications (trace/status
// tooling) and re-importing it here would create a needless two-way
// dependency for a single version string.
function loadRuntimePackageVersion(): string | null {
	try {
		const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
		return typeof packageJson.version === "string" ? packageJson.version : null;
	} catch {
		return null;
	}
}

const YANO_RUNTIME_PACKAGE_VERSION = loadRuntimePackageVersion();

// ━━ Multi-channel notifications (WhatsApp, Telegram, SendGrid) ━━
// When a task finishes or a watchdog needs the operator's attention, the
// same message is dispatched independently to every configured channel.
// All channels are optional and best-effort: a missing credential or failed
// provider never fails the task itself and is recorded per channel in trace.
//
// NAMING NOTE: Evolution API's own docs call a single WhatsApp
// connection/session an "instance" — a COMPLETELY different concept from
// THIS project's "instance" (an individual pi agent like coder-01).
// EVOLUTION_INSTANCE_NAME below refers only to the former (which
// WhatsApp connection to send FROM), never to a pi agent instance.
//
// Expected .env keys (see .env.example):
//   EVOLUTION_API_URL         base URL of the Evolution API server
//   EVOLUTION_API_KEY         sent as the `apikey` header
//   EVOLUTION_INSTANCE_NAME   which WhatsApp connection to send FROM
//   DESTINATION_PHONE_NUMBER  who to send TO (digits + country code, no "+")
//   TELEGRAM_BOT_TOKEN        Telegram bot token
//   TELEGRAM_DESTINATION_CHAT_ID  Telegram chat/channel id
//   SENDGRID_API_KEY          SendGrid API key
//   SENDGRID_FROM_EMAIL       verified SendGrid sender
//   SENDGRID_TO_EMAIL         recipient email(s), comma-separated
export function loadEnvFile(cwd: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const raw = fs.readFileSync(path.join(cwd, ".env"), "utf-8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim();
			let value = trimmed.slice(eq + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			result[key] = value;
		}
	} catch {
		// no .env in this project — fine, falls through to process.env only
	}
	return result;
}

// Cached for the lifetime of the process: the global config file is only
// ever changed via `yano config set`/`unset`, never by a running agent, so
// re-reading it on every notification send would be pure overhead.
let cachedGlobalConfig: Record<string, string> | null = null;
export function globalYanoConfig(): Record<string, string> {
	if (!cachedGlobalConfig) cachedGlobalConfig = loadConfigFile(globalConfigPath());
	return cachedGlobalConfig;
}

export function getEnvVar(cwd: string, key: string): string | undefined {
	// Precedence: process.env (shell/CI override) > this project's own .env
	// > the global `yano config` default (see yano-config.mjs's CONFIG_SPECS
	// — EVOLUTION_*/TELEGRAM_*/SENDGRID_* are already valid global keys).
	// A project that configures its own channel is never overridden by the
	// global default; a project with none configured falls back to it —
	// this is what lets the user set ONE default notification channel once
	// (`yano config set TELEGRAM_BOT_TOKEN ...`) instead of repeating it in
	// every project's .env, while still letting a specific project opt into
	// its own separate channel.
	return process.env[key] || loadEnvFile(cwd)[key] || globalYanoConfig()[key] || undefined;
}

export async function sendWhatsAppNotification(message: string, identity: NotificationIdentity): Promise<{ ok: boolean; detail: string }> {
	if (!identity) return { ok: false, detail: "orchestrator not initialised" };
	const apiUrl = getEnvVar(identity.cwd, "EVOLUTION_API_URL");
	const apiKey = getEnvVar(identity.cwd, "EVOLUTION_API_KEY");
	const instanceName = getEnvVar(identity.cwd, "EVOLUTION_INSTANCE_NAME");
	const destination = getEnvVar(identity.cwd, "DESTINATION_PHONE_NUMBER");
	const missing = [
		!apiUrl && "EVOLUTION_API_URL",
		!apiKey && "EVOLUTION_API_KEY",
		!instanceName && "EVOLUTION_INSTANCE_NAME",
		!destination && "DESTINATION_PHONE_NUMBER",
	].filter(Boolean) as string[];
	if (missing.length > 0) {
		return { ok: false, detail: `non configurato — variabili mancanti nel .env: ${missing.join(", ")}` };
	}
	const contextualMessage = userMessageContext(message, identity);
	const url = `${apiUrl!.replace(/\/+$/, "")}/message/sendText/${encodeURIComponent(instanceName!)}`;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", apikey: apiKey! },
			body: JSON.stringify({ number: destination, text: contextualMessage }),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return { ok: false, detail: `Evolution API ha risposto ${res.status}: ${body.slice(0, 200)}` };
		}
		return { ok: true, detail: "inviato" };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

export async function sendTelegramNotification(message: string, identity: NotificationIdentity): Promise<{ ok: boolean; detail: string }> {
	if (!identity) return { ok: false, detail: "orchestrator not initialised" };
	const token = getEnvVar(identity.cwd, "TELEGRAM_BOT_TOKEN");
	const chatId = getEnvVar(identity.cwd, "TELEGRAM_DESTINATION_CHAT_ID");
	if (!token || !chatId) {
		const missing = [!token && "TELEGRAM_BOT_TOKEN", !chatId && "TELEGRAM_DESTINATION_CHAT_ID"].filter(Boolean);
		return { ok: false, detail: `non configurato — variabili mancanti nel .env: ${missing.join(", ")}` };
	}
	try {
		const contextualMessage = userMessageContext(message, identity);
		const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text: contextualMessage, disable_web_page_preview: true }),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return { ok: false, detail: `Telegram ha risposto ${res.status}: ${body.slice(0, 200)}` };
		}
		const payload = await res.json().catch(() => null) as any;
		return payload?.ok === false
			? { ok: false, detail: `Telegram ha rifiutato il messaggio: ${String(payload.description || "errore sconosciuto")}` }
			: { ok: true, detail: "inviato" };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

export async function sendEmailNotification(message: string, identity: NotificationIdentity): Promise<{ ok: boolean; detail: string }> {
	if (!identity) return { ok: false, detail: "orchestrator not initialised" };
	const apiKey = getEnvVar(identity.cwd, "SENDGRID_API_KEY");
	const from = getEnvVar(identity.cwd, "SENDGRID_FROM_EMAIL");
	const to = getEnvVar(identity.cwd, "SENDGRID_TO_EMAIL");
	if (!apiKey || !from || !to) {
		const missing = [!apiKey && "SENDGRID_API_KEY", !from && "SENDGRID_FROM_EMAIL", !to && "SENDGRID_TO_EMAIL"].filter(Boolean);
		return { ok: false, detail: `non configurato — variabili mancanti nel .env: ${missing.join(", ")}` };
	}
	const recipients = to.split(",").map((email) => email.trim()).filter(Boolean).map((email) => ({ email }));
	if (!recipients.length) return { ok: false, detail: "non configurato — SENDGRID_TO_EMAIL è vuoto" };
	try {
		const contextualMessage = userMessageContext(message, identity);
		const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				personalizations: [{ to: recipients }],
				from: { email: from },
				subject: getEnvVar(identity.cwd, "SENDGRID_SUBJECT") || "Yano notification",
				content: [{ type: "text/plain", value: contextualMessage }],
			}),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return { ok: false, detail: `SendGrid ha risposto ${res.status}: ${body.slice(0, 200)}` };
		}
		return { ok: true, detail: "inviato" };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

export function userMessageContext(message: string, identity: NotificationIdentity): string {
	return formatNotification(message, {
		sender: identity?.instance || "yano",
		role: identity?.role || "system",
		project: identity?.project || "sconosciuto",
		server: os.hostname(),
		currentVersion: YANO_RUNTIME_PACKAGE_VERSION,
	});
}

export async function sendNotifications(message: string, identity: NotificationIdentity): Promise<{ ok: boolean; detail: string; channels: Record<string, { ok: boolean; detail: string }> }> {
	// Automated scratch/E2E runs must never reach real WhatsApp, Telegram or
	// email credentials inherited from the developer machine. Keep the event
	// path observable in traces, but make delivery an explicit opt-in.
	if (process.env.YANO_TEST_MODE === "1") {
		const channels = {
			whatsapp: { ok: false, detail: "soppresso in YANO_TEST_MODE" },
			telegram: { ok: false, detail: "soppresso in YANO_TEST_MODE" },
			email: { ok: false, detail: "soppresso in YANO_TEST_MODE" },
		};
		return { ok: false, detail: "notifiche esterne soppresse in YANO_TEST_MODE", channels };
	}
	const [whatsapp, telegram, email] = await Promise.all([
		sendWhatsAppNotification(message, identity),
		sendTelegramNotification(message, identity),
		sendEmailNotification(message, identity),
	]);
	const channels = { whatsapp, telegram, email };
	const ok = Object.values(channels).some((result) => result.ok);
	const detail = Object.entries(channels).map(([channel, result]) => `${channel}: ${result.detail}`).join("; ");
	return { ok, detail, channels };
}
