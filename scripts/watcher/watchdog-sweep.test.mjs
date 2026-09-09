// Fase 2 / M3 — the in-process watchdog sweep, extracted from extensions/
// orchestrator.ts. The real end-to-end behavior (escalation levels, MQTT
// publish, SQLite events, planner wake-up) is already covered thoroughly by
// scripts/smoke-test-watchdog.mjs against the REAL extension + broker +
// SQLite — these tests focus on what's NEW about this extraction: the
// dependency-injection contract itself, especially that getIdentity/
// getYanoStorage/getClient/getTopics are read FRESH on every call (the
// entire reason they're getters instead of plain values — see this file's
// header).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWatchdogSweep } from "./watchdog-sweep.ts";

function makeStorage(overrides = {}) {
	return {
		expireDecisionHolds: vi.fn(() => []),
		drainDecisionHoldOutbox: vi.fn(() => []),
		updateTicketStatus: vi.fn(),
		recordEvent: vi.fn(),
		...overrides,
	};
}

function makeDeps(overrides = {}) {
	const identity = { role: "planner", cwd: "/project", project: "demo", instance: "planner-01" };
	const storage = makeStorage();
	return {
		getIdentity: vi.fn(() => identity),
		getYanoStorage: vi.fn(() => storage),
		getClient: vi.fn(() => null),
		getTopics: vi.fn(() => null),
		presence: new Map(),
		pi: { sendMessage: vi.fn() },
		logEvent: vi.fn(),
		yanoPublishEvent: vi.fn(async () => {}),
		sendNotifications: vi.fn(async () => ({ ok: true, detail: "inviato", channels: {} })),
		withTimeout: (p) => p,
		projectKey: vi.fn((cwd, project) => `workspace-${cwd}-${project}`),
		writeWatchdogHeartbeat: vi.fn(),
		yanoFindStalledTickets: vi.fn(() => []),
		yanoFindUnfinalizedRuns: vi.fn(() => []),
		yanoFindOrphanedTickets: vi.fn(() => []),
		WATCHDOG_STALL_MS: 900_000,
		WATCHDOG_AUTO_TERMINATE_ENABLED: false,
		WATCHDOG_AUTO_TERMINATE_MS: 1_200_000,
		WATCHDOG_FINALIZE_GRACE_MS: 600_000,
		...overrides,
		_identity: identity,
		_storage: storage,
	};
}

describe("createWatchdogSweep — guards", () => {
	it("returns [] and does nothing when identity is null", async () => {
		const deps = makeDeps({ getIdentity: vi.fn(() => null) });
		const sweep = createWatchdogSweep(deps);
		const result = await sweep(Date.now());
		expect(result).toEqual([]);
		expect(deps.writeWatchdogHeartbeat).not.toHaveBeenCalled();
	});

	it("returns [] for a non-planner role, even with valid identity and storage", async () => {
		const deps = makeDeps({ getIdentity: vi.fn(() => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" })) });
		const sweep = createWatchdogSweep(deps);
		expect(await sweep(Date.now())).toEqual([]);
		expect(deps.writeWatchdogHeartbeat).not.toHaveBeenCalled();
	});

	it("returns [] when yanoStorage is not yet initialised (null)", async () => {
		const deps = makeDeps({ getYanoStorage: vi.fn(() => null) });
		const sweep = createWatchdogSweep(deps);
		expect(await sweep(Date.now())).toEqual([]);
	});
});

describe("createWatchdogSweep — getter freshness (the reason these are getters, not values)", () => {
	it("a role change reported by getIdentity between calls is honored on the next call, not stuck on the first snapshot", async () => {
		let role = "coder";
		const deps = makeDeps({ getIdentity: vi.fn(() => ({ role, cwd: "/p", project: "demo", instance: "x" })) });
		const sweep = createWatchdogSweep(deps);
		expect(await sweep(Date.now())).toEqual([]); // coder: no-op
		role = "planner";
		expect(await sweep(Date.now())).toEqual([]); // now planner: proceeds (no stalls seeded, so still [])
		expect(deps.writeWatchdogHeartbeat).toHaveBeenCalledTimes(1); // only on the planner pass
	});

	it("yanoStorage becoming available between calls (lazy orchestrator_init) is picked up without recreating the sweep", async () => {
		let storage = null;
		const deps = makeDeps({ getYanoStorage: vi.fn(() => storage) });
		const sweep = createWatchdogSweep(deps);
		expect(await sweep(Date.now())).toEqual([]);
		storage = makeStorage();
		await sweep(Date.now());
		expect(deps.writeWatchdogHeartbeat).toHaveBeenCalledTimes(1); // only the second call reached the heartbeat write
	});
});

describe("createWatchdogSweep — heartbeat + decision holds", () => {
	it("writes the watchdog heartbeat under this project's key on every successful pass", async () => {
		const deps = makeDeps();
		const sweep = createWatchdogSweep(deps);
		await sweep(12345);
		expect(deps.projectKey).toHaveBeenCalledWith("/project", "demo");
		expect(deps.writeWatchdogHeartbeat).toHaveBeenCalledWith("workspace-/project-demo", 12345);
	});

	it("expired decision holds are recorded, published, and logged", async () => {
		const deps = makeDeps();
		deps._storage.expireDecisionHolds = vi.fn(() => [{ id: "hold-1", run_id: "run-1", ticket_id: "t-1", generation: 2, expires_at: "2026-01-01T00:00:00.000Z" }]);
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		expect(deps._storage.recordEvent).toHaveBeenCalledWith("run-1", "decision_hold_expired", expect.objectContaining({ hold_id: "hold-1" }), "t-1");
		expect(deps.yanoPublishEvent).toHaveBeenCalledWith("run-1", "decision_hold_expired", expect.objectContaining({ hold_id: "hold-1" }));
		expect(deps.logEvent).toHaveBeenCalledWith("decision_hold_expired", expect.objectContaining({ run_id: "run-1", hold_id: "hold-1" }));
	});

	it("a storage failure expiring holds does not prevent the rest of the sweep from running", async () => {
		const deps = makeDeps();
		deps._storage.expireDecisionHolds = vi.fn(() => { throw new Error("db locked"); });
		const sweep = createWatchdogSweep(deps);
		await expect(sweep(Date.now())).resolves.toEqual([]);
		expect(deps.writeWatchdogHeartbeat).toHaveBeenCalled(); // heartbeat already happened before the throwing call
	});

	it("drains the decision-hold outbox and wakes the planner's own turn for each resume", async () => {
		const deps = makeDeps();
		deps._storage.drainDecisionHoldOutbox = vi.fn(() => [{ id: 1, run_id: "run-1", hold_id: "hold-1", payload: { hold_id: "hold-1", generation: 3, needs_replan: true } }]);
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		expect(deps.yanoPublishEvent).toHaveBeenCalledWith("run-1", "decision_hold_resume_requested", expect.objectContaining({ hold_id: "hold-1", outbox_id: 1 }));
		expect(deps.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "decision-hold-resume", display: true }),
			expect.objectContaining({ deliverAs: "followUp", triggerTurn: true }),
		);
	});
});

describe("createWatchdogSweep — stalled tickets", () => {
	function stalledTicket(overrides = {}) {
		return { run_id: "run-1", ticket_id: "t-1", title: "fix bug", assigned_instance: "coder-01", running_since: "2026-01-01T00:00:00.000Z", elapsed_ms: 1_000_000, ...overrides };
	}

	it("a fresh stall is recorded, published, notified, and wakes the planner", async () => {
		const deps = makeDeps({ yanoFindStalledTickets: vi.fn(() => [stalledTicket()]) });
		const sweep = createWatchdogSweep(deps);
		const result = await sweep(Date.now());
		expect(result).toHaveLength(1);
		expect(deps._storage.recordEvent).toHaveBeenCalledWith("run-1", "ticket_stalled", expect.objectContaining({ ticket_id: "t-1" }), "t-1");
		expect(deps.yanoPublishEvent).toHaveBeenCalledWith("run-1", "ticket_stalled", expect.objectContaining({ ticket_id: "t-1" }));
		expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
		expect(deps.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "orchestrator-watchdog", display: true }),
			expect.objectContaining({ deliverAs: "followUp", triggerTurn: true }),
		);
	});

	it("does not re-alert the same running episode at the same escalation threshold on a second sweep", async () => {
		const deps = makeDeps({ yanoFindStalledTickets: vi.fn(() => [stalledTicket({ elapsed_ms: 1_000_000 })]) });
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
		await sweep(Date.now()); // same elapsed_ms -> same threshold level -> no new alert
		expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
	});

	it("escalates when the ticket crosses into a new WATCHDOG_STALL_MS multiple", async () => {
		let elapsed = 1_000_000; // just over 1x WATCHDOG_STALL_MS (900_000)
		const deps = makeDeps({ yanoFindStalledTickets: vi.fn(() => [stalledTicket({ elapsed_ms: elapsed })]) });
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
		elapsed = 1_900_000; // crosses into the 2nd multiple of WATCHDOG_STALL_MS
		deps.yanoFindStalledTickets.mockImplementation(() => [stalledTicket({ elapsed_ms: elapsed })]);
		await sweep(Date.now());
		expect(deps.sendNotifications).toHaveBeenCalledTimes(2);
	});

	it("a fresh ticket_claim after reassignment (new running_since) re-arms alerting for what looks like the same ticket_id", async () => {
		const deps = makeDeps({ yanoFindStalledTickets: vi.fn(() => [stalledTicket({ running_since: "2026-01-01T00:00:00.000Z" })]) });
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
		deps.yanoFindStalledTickets.mockImplementation(() => [stalledTicket({ running_since: "2026-02-01T00:00:00.000Z" })]);
		await sweep(Date.now());
		expect(deps.sendNotifications).toHaveBeenCalledTimes(2);
	});

	it("a detector failure is treated as no findings this pass, not a crash", async () => {
		const deps = makeDeps({ yanoFindStalledTickets: vi.fn(() => { throw new Error("query failed"); }) });
		const sweep = createWatchdogSweep(deps);
		await expect(sweep(Date.now())).resolves.toEqual([]);
	});
});

describe("createWatchdogSweep — orphaned tickets", () => {
	it("marks an orphaned ticket failed, records the event, notifies, and instructs a mandatory relaunch", async () => {
		const orphan = { run_id: "run-1", ticket_id: "t-1", title: "fix bug", assigned_instance: "coder-01", running_since: "2026-01-01T00:00:00.000Z" };
		const deps = makeDeps({ yanoFindOrphanedTickets: vi.fn(() => [orphan]) });
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		expect(deps._storage.updateTicketStatus).toHaveBeenCalledWith("t-1", "failed", expect.objectContaining({ result_summary: expect.any(String) }));
		expect(deps._storage.recordEvent).toHaveBeenCalledWith("run-1", "ticket_failed", expect.objectContaining({ ticket_id: "t-1", auto: true }), "t-1");
		expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
		const [msg] = deps.pi.sendMessage.mock.calls[0];
		expect(msg.content).toContain("NON eseguire tu il lavoro");
	});

	it("does not re-alert the same orphaned episode twice", async () => {
		const orphan = { run_id: "run-1", ticket_id: "t-1", title: "x", assigned_instance: "coder-01", running_since: "2026-01-01T00:00:00.000Z" };
		const deps = makeDeps({ yanoFindOrphanedTickets: vi.fn(() => [orphan]) });
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		await sweep(Date.now());
		expect(deps._storage.updateTicketStatus).toHaveBeenCalledTimes(1);
	});
});

describe("createWatchdogSweep — auto-terminate (opt-in)", () => {
	function hardStuck(overrides = {}) {
		return { run_id: "run-1", ticket_id: "t-1", title: "x", assigned_instance: "coder-01", running_since: "2026-01-01T00:00:00.000Z", elapsed_ms: 2_000_000, ...overrides };
	}

	it("never publishes a terminate command when WATCHDOG_AUTO_TERMINATE_ENABLED is false, even with a hard-stuck ticket", async () => {
		const client = { publishAsync: vi.fn(async () => {}) };
		const deps = makeDeps({
			WATCHDOG_AUTO_TERMINATE_ENABLED: false,
			getClient: vi.fn(() => client),
			getTopics: vi.fn(() => ({ agentCommands: (i) => `pi/x/agents/${i}/commands` })),
			yanoFindStalledTickets: vi.fn((_s, _p, _n, ms) => (ms === deps_.WATCHDOG_AUTO_TERMINATE_MS ? [hardStuck()] : [])),
		});
		var deps_ = deps;
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		expect(client.publishAsync).not.toHaveBeenCalled();
	});

	it("terminates a hard-stuck but still-live instance when enabled, and skips an already-offline one (the orphan path owns that)", async () => {
		const client = { publishAsync: vi.fn(async () => {}) };
		const presence = new Map([["coder-01", { status: "working" }]]);
		const deps = makeDeps({
			WATCHDOG_AUTO_TERMINATE_ENABLED: true,
			getClient: vi.fn(() => client),
			getTopics: vi.fn(() => ({ agentCommands: (i) => `pi/x/agents/${i}/commands` })),
			presence,
			yanoFindStalledTickets: vi.fn((_s, _p, _n, ms) => (ms === 1_200_000 ? [hardStuck()] : [])),
		});
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		expect(client.publishAsync).toHaveBeenCalledTimes(1);
		const [topic, payload, opts] = client.publishAsync.mock.calls[0];
		expect(topic).toBe("pi/x/agents/coder-01/commands");
		expect(JSON.parse(payload)).toMatchObject({ type: "terminate", requested_by_role: "planner" });
		expect(opts).toMatchObject({ qos: 1 });
	});

	it("skips an offline instance — the orphan-ticket path is responsible for that case instead", async () => {
		const client = { publishAsync: vi.fn(async () => {}) };
		const presence = new Map([["coder-01", { status: "offline" }]]);
		const deps = makeDeps({
			WATCHDOG_AUTO_TERMINATE_ENABLED: true,
			getClient: vi.fn(() => client),
			getTopics: vi.fn(() => ({ agentCommands: (i) => `pi/x/agents/${i}/commands` })),
			presence,
			yanoFindStalledTickets: vi.fn((_s, _p, _n, ms) => (ms === 1_200_000 ? [hardStuck()] : [])),
		});
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		expect(client.publishAsync).not.toHaveBeenCalled();
	});
});

describe("createWatchdogSweep — unfinalized runs", () => {
	it("alerts once per run_id for a completed-but-never-finalized run", async () => {
		const run = { run_id: "run-1", objective: "ship it", completed_at: "2026-01-01T00:00:00.000Z", elapsed_ms: 700_000 };
		const deps = makeDeps({ yanoFindUnfinalizedRuns: vi.fn(() => [run]) });
		const sweep = createWatchdogSweep(deps);
		await sweep(Date.now());
		await sweep(Date.now());
		expect(deps._storage.recordEvent).toHaveBeenCalledWith("run-1", "run_unfinalized_stall", expect.objectContaining({ elapsed_ms: 700_000 }));
		expect(deps._storage.recordEvent.mock.calls.filter((c) => c[1] === "run_unfinalized_stall")).toHaveLength(1);
	});
});
