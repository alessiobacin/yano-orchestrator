// Fase 6 / M2 — feedback_create/api_request/notify_whatsapp/notify_all/
// benchmark_record/package_manifest_audit tool handlers, extracted from
// extensions/orchestrator.ts. vi.mock of yano-feedback.mjs and
// yano-api-registry.mjs (pure modules these handlers import directly),
// plain mock storage + vi.fn() spies otherwise, same pattern as
// decision-holds.test.mjs (Fase 4/M0).
import { beforeEach, describe, expect, it, vi } from "vitest";

const feedbackDbCloseMock = vi.fn();
const openDatabaseMock = vi.fn(() => ({ close: feedbackDbCloseMock }));
const createFeedbackMock = vi.fn();
const claimFeedbackMock = vi.fn();
const listFeedbackMock = vi.fn();
vi.mock("../yano-feedback.mjs", () => ({
	openDatabase: (...args) => openDatabaseMock(...args),
	createFeedback: (...args) => createFeedbackMock(...args),
	claimFeedback: (...args) => claimFeedbackMock(...args),
	listFeedback: (...args) => listFeedbackMock(...args),
}));

const getProjectApiMock = vi.fn();
const resolveApiSecretMock = vi.fn();
vi.mock("../yano-api-registry.mjs", () => ({
	getProjectApi: (...args) => getProjectApiMock(...args),
	resolveApiSecret: (...args) => resolveApiSecretMock(...args),
}));

const { createMiscTools } = await import("./misc.ts");

function makeDeps(overrides = {}) {
	const storage = {
		recordBenchmark: vi.fn((input) => ({ name: input.name, status: "pass" })),
		auditPackageManifest: vi.fn(() => ({ status: "ok" })),
	};
	const deps = {
		getIdentity: () => ({ role: "planner", cwd: "/p", project: "demo", instance: "planner-01" }),
		ensureYanoStorage: () => storage,
		logEvent: vi.fn(),
		sendWhatsAppNotification: vi.fn(async () => ({ ok: true, detail: "sent" })),
		sendNotifications: vi.fn(async () => ({ ok: true, detail: "sent", channels: {} })),
		takeInputScreenshots: vi.fn(() => []),
		...overrides,
	};
	return { deps, storage };
}

function toolByName(deps, name) {
	return createMiscTools(deps).find((t) => t.name === name);
}

describe("misc", () => {
	beforeEach(() => {
		openDatabaseMock.mockClear();
		feedbackDbCloseMock.mockClear();
		createFeedbackMock.mockReset();
		claimFeedbackMock.mockReset();
		listFeedbackMock.mockReset();
		getProjectApiMock.mockReset();
		resolveApiSecretMock.mockReset();
	});

	describe("feedback_create", () => {
		it("persists via takeInputScreenshots() when no screenshots were passed explicitly, and closes the db", async () => {
			createFeedbackMock.mockResolvedValue({ id: "fb-1", type: "bug", status: "processing", screenshots: ["a.png"] });
			listFeedbackMock.mockReturnValue([{ id: "fb-1", type: "bug", status: "processing", screenshots: ["a.png"] }]);
			const take = vi.fn(() => ["a.png"]);
			const { deps } = makeDeps({ takeInputScreenshots: take });
			const result = await toolByName(deps, "feedback_create").execute("c1", { type: "bug", message: "it breaks" });
			expect(take).toHaveBeenCalledTimes(1);
			expect(createFeedbackMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ screenshots: ["a.png"] }));
			expect(result.details.feedback_id).toBe("fb-1");
			expect(feedbackDbCloseMock).toHaveBeenCalledTimes(1);
		});

		it("prefers explicit screenshots over takeInputScreenshots() when provided", async () => {
			createFeedbackMock.mockResolvedValue({ id: "fb-2", type: "suggestion", status: "processing", screenshots: ["explicit.png"] });
			listFeedbackMock.mockReturnValue([{ id: "fb-2", type: "suggestion", status: "processing", screenshots: ["explicit.png"] }]);
			const take = vi.fn(() => ["should-not-be-used.png"]);
			const { deps } = makeDeps({ takeInputScreenshots: take });
			await toolByName(deps, "feedback_create").execute("c1", { type: "suggestion", message: "idea", screenshots: ["explicit.png"] });
			expect(createFeedbackMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ screenshots: ["explicit.png"] }));
		});

		it("closes the db even when createFeedback throws", async () => {
			createFeedbackMock.mockRejectedValue(new Error("db locked"));
			const { deps } = makeDeps();
			await expect(toolByName(deps, "feedback_create").execute("c1", { type: "bug", message: "x" })).rejects.toThrow("db locked");
			expect(feedbackDbCloseMock).toHaveBeenCalledTimes(1);
		});

		it("rejects a non-planner role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			await expect(toolByName(deps, "feedback_create").execute("c1", { type: "bug", message: "x" })).rejects.toThrow(/riservato al planner/);
		});
	});

	describe("api_request", () => {
		function registeredApi(overrides = {}) {
			return {
				name: "demo-api",
				enabled: true,
				methods: ["GET"],
				base_url: "https://api.example.com",
				endpoints: [{ method: "GET", path: "/status" }],
				auth_env: null,
				auth_header: null,
				...overrides,
			};
		}

		it("rejects an unregistered or disabled API", async () => {
			getProjectApiMock.mockReturnValue(null);
			const { deps } = makeDeps();
			await expect(toolByName(deps, "api_request").execute("c1", { api: "unknown", method: "GET", path: "/status" })).rejects.toThrow(/API registrata non disponibile/);
		});

		it("rejects a method not declared for the API", async () => {
			getProjectApiMock.mockReturnValue(registeredApi());
			const { deps } = makeDeps();
			await expect(toolByName(deps, "api_request").execute("c1", { api: "demo-api", method: "POST", path: "/status" })).rejects.toThrow(/non dichiarato/);
		});

		it("rejects a path that isn't relative/safe", async () => {
			getProjectApiMock.mockReturnValue(registeredApi());
			const { deps } = makeDeps();
			await expect(toolByName(deps, "api_request").execute("c1", { api: "demo-api", method: "GET", path: "status" })).rejects.toThrow(/deve essere relativo e sicuro/);
			await expect(toolByName(deps, "api_request").execute("c1", { api: "demo-api", method: "GET", path: "/../status" })).rejects.toThrow(/deve essere relativo e sicuro/);
		});

		it("rejects a path with no matching registered endpoint", async () => {
			getProjectApiMock.mockReturnValue(registeredApi());
			const { deps } = makeDeps();
			await expect(toolByName(deps, "api_request").execute("c1", { api: "demo-api", method: "GET", path: "/not-registered" })).rejects.toThrow(/endpoint non rilevato/);
		});

		it("rejects when the auth env is required but no secret resolves", async () => {
			getProjectApiMock.mockReturnValue(registeredApi({ auth_env: "DEMO_API_KEY" }));
			resolveApiSecretMock.mockReturnValue(null);
			const { deps } = makeDeps();
			await expect(toolByName(deps, "api_request").execute("c1", { api: "demo-api", method: "GET", path: "/status" })).rejects.toThrow(/credenziale mancante/);
		});
	});

	describe("notify_whatsapp / notify_all", () => {
		it("notify_whatsapp reports the send result and logs it", async () => {
			const { deps } = makeDeps();
			const result = await toolByName(deps, "notify_whatsapp").execute("c1", { message: "hello" });
			expect(result.details.ok).toBe(true);
			expect(deps.logEvent).toHaveBeenCalledWith("whatsapp_notify", expect.objectContaining({ ok: true, manual: true }));
		});

		it("notify_whatsapp surfaces a not-sent detail without throwing", async () => {
			const { deps } = makeDeps({ sendWhatsAppNotification: vi.fn(async () => ({ ok: false, detail: "no .env configured" })) });
			const result = await toolByName(deps, "notify_whatsapp").execute("c1", { message: "hello" });
			expect(result.content[0].text).toContain("NOT sent");
		});

		it("notify_all dispatches through sendNotifications and logs the channel breakdown", async () => {
			const { deps } = makeDeps({ sendNotifications: vi.fn(async () => ({ ok: true, detail: "2 channels", channels: { whatsapp: { ok: true, detail: "sent" } } })) });
			const result = await toolByName(deps, "notify_all").execute("c1", { message: "hello" });
			expect(result.details.ok).toBe(true);
			expect(deps.logEvent).toHaveBeenCalledWith("notification_dispatch", expect.objectContaining({ manual: true }));
		});
	});

	describe("benchmark_record / package_manifest_audit", () => {
		it("benchmark_record persists via storage and rejects a non-planner role", async () => {
			const { deps, storage } = makeDeps();
			const result = await toolByName(deps, "benchmark_record").execute("c1", { project: "p", name: "n", dataset: "d", metrics: { a: 1 }, thresholds: { a: 2 } });
			expect(result.details.benchmark.status).toBe("pass");
			expect(storage.recordBenchmark).toHaveBeenCalledTimes(1);
			const { deps: coderDeps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			await expect(toolByName(coderDeps, "benchmark_record").execute("c1", { project: "p", name: "n", dataset: "d", metrics: {}, thresholds: {} })).rejects.toThrow(/only planner/);
		});

		it("package_manifest_audit audits via storage and rejects a non-planner role", async () => {
			const { deps } = makeDeps();
			const result = await toolByName(deps, "package_manifest_audit").execute("c1", {});
			expect(result.details.audit.status).toBe("ok");
			const { deps: coderDeps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			await expect(toolByName(coderDeps, "package_manifest_audit").execute("c1", {})).rejects.toThrow(/only planner/);
		});
	});
});
