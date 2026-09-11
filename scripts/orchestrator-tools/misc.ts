// Fase 6 / M2 — feedback_create/api_request/notify_whatsapp/notify_all/
// benchmark_record/package_manifest_audit, extracted from
// extensions/orchestrator.ts. Confirmed zero coupling between these 6 and
// zero coupling with everything else already extracted (Fase 5 plan's
// "misc" framing, verified again for Fase 6 by an Explore agent). Only
// real wrinkle: feedback_create reads AND resets currentInputScreenshots,
// a module `let` in orchestrator.ts also written by the unrelated
// pi.on("input", ...) hook that stays there — the first handler in the
// whole refactor series that can't use a plain read-only getter. Deps
// carry `takeInputScreenshots: () => unknown[]`, a closure-correct
// function defined in orchestrator.ts right alongside the other getters
// that reads the array and resets it to [] atomically; the other write
// site (the input hook) is untouched.
// sendWhatsAppNotification/sendNotifications/ensureYanoStorage are
// closure functions already correctly bound at their own definition site
// — passed as direct references, same pattern as every Fase 4/5/6 module.
// getProjectApi/resolveApiSecret (yano-api-registry.mjs) and
// openFeedbackDatabase/createFeedbackRecord/claimFeedback/listFeedback
// (yano-feedback.mjs) are pure, imported directly.
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getProjectApi, resolveApiSecret } from "../yano-api-registry.mjs";
import { openDatabase as openFeedbackDatabase, createFeedback as createFeedbackRecord, claimFeedback, listFeedback } from "../yano-feedback.mjs";
import type { OrchestratorStorage } from "../yano-orchestrator-storage.ts";
import { redactRuntimeProjection } from "./redact.ts";

export interface Identity {
	role: string;
	cwd: string;
	project: string;
	instance: string;
}

export interface MiscToolsDeps {
	getIdentity: () => Identity | null;
	ensureYanoStorage: () => OrchestratorStorage;
	logEvent: (type: string, data?: Record<string, unknown>) => void;
	sendWhatsAppNotification: (message: string) => Promise<{ ok: boolean; detail: string }>;
	sendNotifications: (message: string) => Promise<{ ok: boolean; detail: string; channels: Record<string, { ok: boolean; detail: string }> }>;
	takeInputScreenshots: () => unknown[];
}

export function createMiscTools(deps: MiscToolsDeps) {
	const { getIdentity, ensureYanoStorage, logEvent, sendWhatsAppNotification, sendNotifications, takeInputScreenshots } = deps;
	return [
		// The auto-improver is an observer. Prompt instructions alone are not a
		// sufficient safety boundary because a resumed/stale Pi transcript can still
		// request bash/edit/write. Give that role a narrow runtime tool surface and
		// keep the only write operation below inside the global Yano data directory.
		{
			name: "feedback_create",
			label: "Persist Bug or Suggestion",
			description: "Persist a user-reported bug or suggestion before analysing it. Planner-only. For a bug received with an image, include its local path or HTTPS URL in screenshots; the record is created before any fix is attempted.",
			parameters: Type.Object({
				type: Type.Union([Type.Literal("bug"), Type.Literal("suggestion")]),
				message: Type.String({ description: "Faithful user report, including route and observed behaviour." }),
				resolution: Type.Optional(Type.Union([Type.Literal("automatic"), Type.Literal("user_confirmation")])),
				screenshots: Type.Optional(Type.Array(Type.Any({ description: "Screenshot path, HTTPS URL, or attachment descriptor." }))),
				username: Type.Optional(Type.String({ description: "Credenziale utente per i test E2E; obbligatoria per i bug." })),
				password: Type.Optional(Type.String({ description: "Password per i test E2E; obbligatoria per i bug e salvata cifrata." })),
			}),
			async execute(_callId: string, params: { type: "bug" | "suggestion"; message: string; resolution?: string; screenshots?: unknown[]; username?: string; password?: string }) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("feedback_create: tool riservato al planner.");
				const db = openFeedbackDatabase();
				try {
					const result = await createFeedbackRecord(db, {
						type: params.type,
						project_id: identity.project,
						message: params.message,
						resolution: params.resolution,
						screenshots: params.screenshots?.length ? params.screenshots : takeInputScreenshots(),
						test_username: params.username,
						test_password: params.password,
						notify: false,
					});
					claimFeedback(db, result.id);
					const claimed = listFeedback(db, { project_id: identity.project, type: params.type, statuses: ["processing"] }).find((item: any) => item.id === result.id) || result;
					logEvent("feedback_persisted_from_planner_chat", { feedback_id: claimed.id, feedback_type: claimed.type, screenshot_count: claimed.screenshots?.length ?? 0 });
					return { content: [{ type: "text" as const, text: JSON.stringify({ feedback_id: claimed.id, status: claimed.status, screenshots: claimed.screenshots }, null, 2) }], details: { feedback_id: claimed.id, status: claimed.status, screenshot_count: claimed.screenshots?.length ?? 0 } };
				} finally { db.close(); }
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("feedback_create ")) + theme.fg("accent", `${(args as any).type ?? "bug"} · ${String((args as any).message ?? "").slice(0, 60)}`), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { const d = result.details as any; return new Text(theme.fg("success", `→ ${d?.feedback_id ?? "feedback"} persistito (${d?.screenshot_count ?? 0} screenshot)`), 0, 0); },
		},

		{
			name: "api_request",
			label: "Registered REST API Request",
			description: "Call one user-registered REST API. Only registered hosts, declared methods and configured credentials are allowed; never an arbitrary URL fetch.",
			parameters: Type.Object({
				api: Type.String({ description: "Registered API name from the REST API registry." }),
				method: Type.String({ description: "Declared HTTP method: GET, POST, PUT, PATCH or DELETE." }),
				path: Type.String({ description: "Path relative to the registered base URL, for example /api/status." }),
				body: Type.Optional(Type.Any({ description: "JSON request body when required by the API." })),
			}),
			async execute(_callId: string, params: { api: string; method: string; path: string; body?: unknown }) {
				const identity = getIdentity();
				if (!identity) throw new Error("api_request: identity non disponibile");
				const api = getProjectApi(identity.cwd, params.api);
				if (!api || api.enabled === false) throw new Error(`api_request: API registrata non disponibile: ${params.api}`);
				const method = String(params.method || "").toUpperCase();
				if (!api.methods.includes(method)) throw new Error(`api_request: metodo ${method} non dichiarato per ${api.name}`);
				if (!String(params.path || "").startsWith("/") || String(params.path).includes("\\") || String(params.path).includes("..")) throw new Error("api_request: path deve essere relativo e sicuro (inizia con /, senza ..)");
				const requestedPath = new URL(params.path, "https://placeholder.invalid").pathname;
				const endpoint = (api.endpoints || []).find((candidate: any) => candidate.method === method && candidate.path === requestedPath);
				if (!endpoint) throw new Error(`api_request: endpoint non rilevato nella sorgente registrata: ${method} ${requestedPath}`);
				const url = new URL(params.path, `${api.base_url}/`);
				if (url.origin !== new URL(api.base_url).origin) throw new Error("api_request: host fuori dal registro");
				const headers: Record<string, string> = { accept: "application/json, text/plain, */*" };
				const secret = resolveApiSecret(api);
				if (api.auth_env && !secret) throw new Error(`api_request: credenziale mancante; configura ${api.auth_env} con yano config set ${api.auth_env} --stdin`);
				if (secret) headers[api.auth_header || "x-api-key"] = secret;
				if (params.body !== undefined) headers["content-type"] = "application/json";
				const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
				try {
					const response = await fetch(url, { method, headers, body: params.body === undefined ? undefined : JSON.stringify(params.body), signal: controller.signal });
					const text = (await response.text()).slice(0, 50_000); let parsed: unknown = text; try { parsed = JSON.parse(text); } catch { /* plain response */ }
					return { content: [{ type: "text" as const, text: JSON.stringify({ api: api.name, method, path: params.path, status: response.status, ok: response.ok, response: parsed }, null, 2) }], details: { api: api.name, method, path: params.path, status: response.status, ok: response.ok, response_chars: text.length } };
				} finally { clearTimeout(timer); }
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("api_request ")) + theme.fg("accent", `${(args as any).api ?? "?"} ${(args as any).method ?? "GET"} ${(args as any).path ?? "/"}`), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { const d = result.details as any; return new Text(theme.fg(d?.ok ? "success" : "error", `${d?.ok ? "✓" : "✗"} ${d?.status ?? "?"} ${d?.api ?? "API"}`), 0, 0); },
		},

		{
			name: "notify_whatsapp",
			label: "Notify WhatsApp",
			description:
				"Send a WhatsApp-only message via Evolution API to the fixed destination number configured in .env (DESTINATION_PHONE_NUMBER), " +
				"from the WhatsApp connection named in EVOLUTION_INSTANCE_NAME. worktree_finalize already calls this automatically on " +
				"success (Revisione 19) — use this tool directly only for other cases, e.g. notifying the user when you escalate after " +
				"repeated failed correction rounds instead of finalizing. Silently reports back if .env isn't configured rather than " +
				"throwing, since WhatsApp notification is optional infrastructure, not a required part of any task.",
			parameters: Type.Object({
				message: Type.String({ description: "The WhatsApp message text to send." }),
			}),
			async execute(_callId: string, params: { message: string }) {
				const result = await sendWhatsAppNotification(params.message);
				logEvent("whatsapp_notify", { ok: result.ok, detail: result.detail, manual: true });
				return {
					content: [{ type: "text" as const, text: result.ok ? `notify_whatsapp: message sent.` : `notify_whatsapp: NOT sent — ${result.detail}` }],
					details: { ok: result.ok, detail: result.detail },
				};
			},
			renderCall(_args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("notify_whatsapp")), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const d = result.details as any;
				return d?.ok ? new Text(theme.fg("success", "✓ sent"), 0, 0) : new Text(theme.fg("error", `✗ ${d?.detail ?? "not sent"}`), 0, 0);
			},
		},

		{
			name: "notify_all",
			label: "Notify All Channels",
			description:
				"Send a notification through every configured channel: WhatsApp via Evolution API, Telegram via the Bot API, and email via SendGrid. " +
				"Each channel is optional; the tool reports the result independently and never fails the task because a channel is unavailable.",
			parameters: Type.Object({
				message: Type.String({ description: "The notification text to send through all configured channels." }),
			}),
			async execute(_callId: string, params: { message: string }) {
				const result = await sendNotifications(params.message);
				logEvent("notification_dispatch", { ok: result.ok, detail: result.detail, channels: result.channels, manual: true });
				return {
					content: [{ type: "text" as const, text: result.ok ? `notify_all: ${result.detail}` : `notify_all: no channel sent the message — ${result.detail}` }],
					details: result,
				};
			},
			renderCall(_args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("notify_all")), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const d = result.details as any;
				return d?.ok ? new Text(theme.fg("success", "✓ channels dispatched"), 0, 0) : new Text(theme.fg("warning", "⚠ no channel sent"), 0, 0);
			},
		},

		{
			name: "benchmark_record",
			label: "Record Benchmark",
			description: "Record a reproducible benchmark result against versioned hard thresholds.",
			parameters: Type.Object({ project: Type.String(), name: Type.String(), dataset: Type.String(), metrics: Type.Record(Type.String(), Type.Number()), thresholds: Type.Record(Type.String(), Type.Number()) }),
			async execute(_callId: string, params: { project: string; name: string; dataset: string; metrics: Record<string, number>; thresholds: Record<string, number> }) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("benchmark_record: only planner may record benchmarks.");
				const benchmark = ensureYanoStorage().recordBenchmark(params);
				return { content: [{ type: "text" as const, text: `benchmark_record: ${benchmark.name} ${benchmark.status}.` }], details: { benchmark: redactRuntimeProjection(benchmark) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("benchmark_record ")) + theme.fg("accent", (args as any).name ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.benchmark?.status ?? "?"), 0, 0); },
		},

		{
			name: "package_manifest_audit",
			label: "Audit Package Manifest",
			description: "Audit package name, public yano binary and distributed Playbook assets, recording checksum and findings.",
			parameters: Type.Object({}),
			async execute(_callId: string, _params: Record<string, never>) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("package_manifest_audit: only planner may audit the package.");
				const audit = ensureYanoStorage().auditPackageManifest();
				return { content: [{ type: "text" as const, text: `package_manifest_audit: ${audit.status}.` }], details: { audit: redactRuntimeProjection(audit) } };
			},
			renderCall(_args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("package_manifest_audit")), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.audit?.status ?? "?"), 0, 0); },
		},
	];
}
