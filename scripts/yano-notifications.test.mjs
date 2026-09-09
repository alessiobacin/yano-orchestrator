// Fase 2 / M2 — multi-channel notifications (WhatsApp/Telegram/SendGrid),
// extracted from extensions/orchestrator.ts. These functions were declared
// inside the extension's closure and read `identity` directly; here
// `identity` is an explicit parameter instead, which is exactly what these
// tests exercise: per-channel missing-config detail strings, YANO_TEST_MODE
// suppression, and env precedence (process.env > project .env > global
// config).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate from the REAL machine's global Yano config (the same concern
// several e2e smoke tests already guard against — see e.g.
// scripts/smoke-test-watch-stalls.mjs's header comment): globalYanoConfig()
// caches its result in a module-level variable on first call, so this must
// be set before the module under test is ever imported below, not per-test.
if (!process.env.YANO_CONFIG_FILE) process.env.YANO_CONFIG_FILE = `${process.env.TMPDIR || "/tmp"}/yano-test-isolation-no-such-config.env`;

const ORIGINAL_ENV = { ...process.env };
const IDENTITY = { cwd: "", instance: "planner-01", role: "planner", project: "demo" };

describe("yano-notifications", () => {
	let projectDir;
	let fetchMock;
	beforeEach(() => {
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-notifications-test-"));
		IDENTITY.cwd = projectDir;
		process.env = { ...ORIGINAL_ENV };
		delete process.env.YANO_TEST_MODE;
		for (const key of ["EVOLUTION_API_URL", "EVOLUTION_API_KEY", "EVOLUTION_INSTANCE_NAME", "DESTINATION_PHONE_NUMBER", "TELEGRAM_BOT_TOKEN", "TELEGRAM_DESTINATION_CHAT_ID", "SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL", "SENDGRID_TO_EMAIL"]) delete process.env[key];
		fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) }));
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		fs.rmSync(projectDir, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});

	describe("getEnvVar precedence", () => {
		it("process.env wins over the project .env and the global config", async () => {
			fs.writeFileSync(path.join(projectDir, ".env"), "TELEGRAM_BOT_TOKEN=from-project-env\n");
			process.env.TELEGRAM_BOT_TOKEN = "from-process-env";
			const { getEnvVar } = await import("./yano-notifications.ts");
			expect(getEnvVar(projectDir, "TELEGRAM_BOT_TOKEN")).toBe("from-process-env");
		});

		it("a project's own .env is never overridden by the global default", async () => {
			fs.writeFileSync(path.join(projectDir, ".env"), "TELEGRAM_BOT_TOKEN=from-project-env\n");
			const { getEnvVar } = await import("./yano-notifications.ts");
			expect(getEnvVar(projectDir, "TELEGRAM_BOT_TOKEN")).toBe("from-project-env");
		});

		it("returns undefined when the key is configured nowhere", async () => {
			const { getEnvVar } = await import("./yano-notifications.ts");
			expect(getEnvVar(projectDir, "TELEGRAM_BOT_TOKEN")).toBeUndefined();
		});
	});

	describe("sendWhatsAppNotification", () => {
		it("reports the exact missing .env keys when unconfigured", async () => {
			const { sendWhatsAppNotification } = await import("./yano-notifications.ts");
			const result = await sendWhatsAppNotification("hi", IDENTITY);
			expect(result.ok).toBe(false);
			expect(result.detail).toContain("EVOLUTION_API_URL");
			expect(result.detail).toContain("DESTINATION_PHONE_NUMBER");
		});

		it("returns ok:false with a clear detail when identity is null", async () => {
			const { sendWhatsAppNotification } = await import("./yano-notifications.ts");
			const result = await sendWhatsAppNotification("hi", null);
			expect(result).toEqual({ ok: false, detail: "orchestrator not initialised" });
		});

		it("posts to the Evolution API endpoint when fully configured", async () => {
			process.env.EVOLUTION_API_URL = "https://evo.example.com";
			process.env.EVOLUTION_API_KEY = "key-1";
			process.env.EVOLUTION_INSTANCE_NAME = "inst-1";
			process.env.DESTINATION_PHONE_NUMBER = "391234567890";
			const { sendWhatsAppNotification } = await import("./yano-notifications.ts");
			const result = await sendWhatsAppNotification("hi there", IDENTITY);
			expect(result.ok).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, opts] = fetchMock.mock.calls[0];
			expect(url).toBe("https://evo.example.com/message/sendText/inst-1");
			expect(opts.headers.apikey).toBe("key-1");
		});
	});

	describe("sendTelegramNotification", () => {
		it("reports missing keys when unconfigured", async () => {
			const { sendTelegramNotification } = await import("./yano-notifications.ts");
			const result = await sendTelegramNotification("hi", IDENTITY);
			expect(result.ok).toBe(false);
			expect(result.detail).toContain("TELEGRAM_BOT_TOKEN");
		});

		it("posts to the Telegram Bot API when configured", async () => {
			process.env.TELEGRAM_BOT_TOKEN = "bot-token";
			process.env.TELEGRAM_DESTINATION_CHAT_ID = "chat-1";
			const { sendTelegramNotification } = await import("./yano-notifications.ts");
			const result = await sendTelegramNotification("hi there", IDENTITY);
			expect(result.ok).toBe(true);
			expect(fetchMock.mock.calls[0][0]).toBe("https://api.telegram.org/botbot-token/sendMessage");
		});

		it("treats a Telegram-side ok:false payload as a failure, not a thrown error", async () => {
			process.env.TELEGRAM_BOT_TOKEN = "bot-token";
			process.env.TELEGRAM_DESTINATION_CHAT_ID = "chat-1";
			fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "", json: async () => ({ ok: false, description: "chat not found" }) });
			const { sendTelegramNotification } = await import("./yano-notifications.ts");
			const result = await sendTelegramNotification("hi", IDENTITY);
			expect(result.ok).toBe(false);
			expect(result.detail).toContain("chat not found");
		});
	});

	describe("sendEmailNotification", () => {
		it("reports missing keys when unconfigured", async () => {
			const { sendEmailNotification } = await import("./yano-notifications.ts");
			const result = await sendEmailNotification("hi", IDENTITY);
			expect(result.ok).toBe(false);
			expect(result.detail).toContain("SENDGRID_API_KEY");
		});

		it("posts to SendGrid with comma-separated recipients split into an array", async () => {
			process.env.SENDGRID_API_KEY = "sg-key";
			process.env.SENDGRID_FROM_EMAIL = "from@example.com";
			process.env.SENDGRID_TO_EMAIL = "a@example.com, b@example.com";
			const { sendEmailNotification } = await import("./yano-notifications.ts");
			const result = await sendEmailNotification("hi there", IDENTITY);
			expect(result.ok).toBe(true);
			const body = JSON.parse(fetchMock.mock.calls[0][1].body);
			expect(body.personalizations[0].to).toEqual([{ email: "a@example.com" }, { email: "b@example.com" }]);
		});
	});

	describe("sendNotifications (fan-out)", () => {
		it("suppresses every channel under YANO_TEST_MODE=1 without ever calling fetch", async () => {
			process.env.YANO_TEST_MODE = "1";
			process.env.TELEGRAM_BOT_TOKEN = "bot-token";
			process.env.TELEGRAM_DESTINATION_CHAT_ID = "chat-1";
			const { sendNotifications } = await import("./yano-notifications.ts");
			const result = await sendNotifications("hi", IDENTITY);
			expect(result.ok).toBe(false);
			expect(result.detail).toContain("YANO_TEST_MODE");
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("is ok:true when at least one channel succeeds, even if the others are unconfigured", async () => {
			process.env.TELEGRAM_BOT_TOKEN = "bot-token";
			process.env.TELEGRAM_DESTINATION_CHAT_ID = "chat-1";
			const { sendNotifications } = await import("./yano-notifications.ts");
			const result = await sendNotifications("hi", IDENTITY);
			expect(result.ok).toBe(true);
			expect(result.channels.telegram.ok).toBe(true);
			expect(result.channels.whatsapp.ok).toBe(false);
			expect(result.channels.email.ok).toBe(false);
		});

		it("dispatches to all three channels in parallel (fetch called once per configured channel)", async () => {
			process.env.EVOLUTION_API_URL = "https://evo.example.com";
			process.env.EVOLUTION_API_KEY = "key-1";
			process.env.EVOLUTION_INSTANCE_NAME = "inst-1";
			process.env.DESTINATION_PHONE_NUMBER = "391234567890";
			process.env.TELEGRAM_BOT_TOKEN = "bot-token";
			process.env.TELEGRAM_DESTINATION_CHAT_ID = "chat-1";
			const { sendNotifications } = await import("./yano-notifications.ts");
			const result = await sendNotifications("hi", IDENTITY);
			expect(result.channels.whatsapp.ok).toBe(true);
			expect(result.channels.telegram.ok).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
	});

	describe("userMessageContext", () => {
		it("falls back to sensible defaults when identity is null", async () => {
			const { userMessageContext } = await import("./yano-notifications.ts");
			const text = userMessageContext("hello", null);
			expect(typeof text).toBe("string");
			expect(text.length).toBeGreaterThan(0);
		});
	});
});
