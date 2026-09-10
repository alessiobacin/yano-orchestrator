// Fase 4 / M5 — ticket_* tool handlers, extracted verbatim from
// extensions/orchestrator.ts. `ticket_create`/`ticket_claim` also call
// storage.getPlaybookBinding() — a public method of the already-shared
// OrchestratorStorage class, not a local function from the (already
// extracted in M4) playbook_* tool handlers, so this is zero real code
// coupling, same as scripts/orchestrator-tools/capability-cards.ts
// (Fase 4/M3). `ticket_claim`/`ticket_complete` also mutate the module-
// scope `activeTicketIds` Set and call `publishPresence`/
// `computeSelfStatus` directly (Revisione 40's "presence must reflect
// active ticket work immediately, not wait for the next heartbeat" fix) —
// these stay in orchestrator.ts and are passed through `deps`: the Set by
// direct reference (a `const`, only its contents mutate, so a shared
// reference is safe and correct — same object identity as the one seen
// elsewhere in orchestrator.ts), the two functions as direct references
// (they already close over orchestrator.ts's own state correctly at their
// definition site, same reasoning as
// scripts/orchestrator-tools/decision-holds.ts's ensureYanoStorage/
// logEvent/sendNotifications/yanoPublishEvent, Fase 4/M0).
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { recommend as recommendModel } from "../yano-model-advisor.mjs";
import type { OrchestratorStorage } from "../yano-orchestrator-storage.ts";
import { redactRuntimeProjection } from "./redact.ts";
import { yanoComputeReadyBlocked, yanoComputeExecutionWaves } from "./ticket-scheduling.ts";

// Not exported from orchestrator.ts (a local `type` alias there, line ~277)
// — duplicated here as a trivial one-liner rather than widening that
// file's export surface for a type with no other consumer outside it.
type PresenceStatus = "idle" | "busy" | "offline";

export type TicketToolsDeps = {
	getIdentity: () => { role: string; cwd: string; project: string; instance: string; playbook: string | null; skills: string[] } | null;
	ensureYanoStorage: () => OrchestratorStorage;
	logEvent: (type: string, data?: Record<string, unknown>) => void;
	yanoPublishEvent: (runId: string, type: string, payload: unknown) => Promise<void>;
	sendNotifications: (message: string) => Promise<{ ok: boolean; detail: string; channels: Record<string, { ok: boolean; detail: string }> }>;
	activeTicketIds: Set<string>;
	publishPresence: (requestedStatus: PresenceStatus) => Promise<void>;
	computeSelfStatus: () => PresenceStatus;
};

export function createTicketTools(deps: TicketToolsDeps) {
	const { getIdentity, ensureYanoStorage, logEvent, yanoPublishEvent, sendNotifications, activeTicketIds, publishPresence, computeSelfStatus } = deps;
	return [
		{
			name: "ticket_create",
			label: "Ticket Create",
			description:
				"Create a canonical internal ticket for a run — planner-only. This is the To-Tickets-inspired decomposition " +
				"unit: platform-independent, never synced to GitHub/Linear/Jira (no Ticket Publisher exists or is planned). " +
				"depends_on lists OTHER ticket ids in the same run that must reach status \"done\" before this one becomes " +
				"READY — readiness is always computed by tickets_ready, never declared directly.",
			parameters: Type.Object({
				run_id: Type.String(),
				spec_id: Type.Optional(Type.String()),
				title: Type.String(),
				description: Type.Optional(Type.String()),
				domain: Type.Optional(Type.String()),
				required_capabilities: Type.Optional(Type.Array(Type.String(), { description: 'e.g. ["backend", "typescript"] — matched against the claiming agent\'s role + skills by ticket_claim.' })),
				required_playbook: Type.Optional(Type.String({ description: "Optional Playbook id required by this ticket; when present it must match the run's immutable binding." })),
				acceptance_criteria: Type.Optional(Type.Array(Type.String())),
				depends_on: Type.Optional(Type.Array(Type.String(), { description: "Ticket ids (in the same run) this ticket cannot start before." })),
			}),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner") throw new Error(`ticket_create: only the planner role may create tickets (this instance is "${identity.role}").`);
				const storage = ensureYanoStorage();
				const run = storage.getRun(params.run_id);
				if (!run) throw new Error(`ticket_create: no run "${params.run_id}" — call run_create first.`);
				if (params.spec_id && !storage.getSpec(params.spec_id)) throw new Error(`ticket_create: no spec "${params.spec_id}" in this run.`);
				const binding = storage.getPlaybookBinding(params.run_id);
				const requiredPlaybook = params.required_playbook || null;
				if (params.required_playbook && binding && binding.playbook_id !== params.required_playbook) {
					throw new Error(`ticket_create: required_playbook "${params.required_playbook}" does not match the run binding "${binding.playbook_id}".`);
				}
				// Validate every dependency BEFORE creating anything — an invalid
				// depends_on must leave NO trace (no orphan ticket row) when this
				// tool call fails, not just fail to wire the dependency. Found by
				// scripts/smoke-test-ticket-engine.mjs: creating the ticket first
				// and validating depends_on after left a ticket behind even though
				// the tool call itself threw.
				const depIds = params.depends_on ?? [];
				for (const depId of depIds) {
					const dep = storage.getTicket(depId);
					if (!dep || dep.run_id !== params.run_id) throw new Error(`ticket_create: depends_on references ticket "${depId}" which doesn't exist in run "${params.run_id}".`);
				}
				const ticket = storage.createTicket({
					run_id: params.run_id,
					spec_id: params.spec_id ?? null,
					title: params.title,
					description: params.description,
					domain: params.domain || run.domain,
					required_capabilities: params.required_capabilities,
					required_playbook: requiredPlaybook,
					acceptance_criteria: params.acceptance_criteria,
				});
				for (const depId of depIds) storage.addDependency(ticket.id, depId);
				storage.recordEvent(run.id, "ticket_created", { ticket_id: ticket.id, title: ticket.title, depends_on: depIds }, ticket.id);
				logEvent("yano_ticket_created", { run_id: run.id, ticket_id: ticket.id, depends_on: depIds });
				await yanoPublishEvent(run.id, "ticket_created", { ticket_id: ticket.id, title: ticket.title });
				if (depIds.length === 0) {
					storage.recordEvent(run.id, "ticket_ready", { ticket_id: ticket.id }, ticket.id);
					await yanoPublishEvent(run.id, "ticket_ready", { ticket_id: ticket.id, title: ticket.title });
				}
				return {
					content: [{ type: "text" as const, text: `ticket_create: "${ticket.title}" created (${ticket.id})${depIds.length ? `, depends on ${depIds.join(", ")}` : " — READY immediately (no dependencies)"}.` }],
					details: { ticket },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("ticket_create ")) + theme.fg("accent", (args as any).title ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const ticket = (result.details as any)?.ticket;
				return new Text(theme.fg("success", "→ ticket ") + theme.fg("accent", ticket?.id ?? "?"), 0, 0);
			},
		},

		{
			name: "tickets_ready",
			label: "Tickets Ready",
			description:
				"Deterministically compute which tickets in a run are READY (all dependencies done, not yet started), BLOCKED, " +
				"RUNNING, DONE, FAILED, or CANCELLED, plus the execution waves (groups that could run in parallel) for what's " +
				"still outstanding. Pure computation over SQLite state, never a stored/stale status. Any role may call this.",
			parameters: Type.Object({ run_id: Type.String() }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const storage = ensureYanoStorage();
				const run = storage.getRun(params.run_id);
				if (!run) throw new Error(`tickets_ready: no run "${params.run_id}".`);
				const tickets = storage.listTickets(params.run_id);
				const deps = storage.listDependencies(params.run_id);
				const buckets = yanoComputeReadyBlocked(tickets, deps);
				const waves = yanoComputeExecutionWaves(tickets, deps);
				const byId = new Map(tickets.map((t) => [t.id, t]));
				const describe = (ids: string[]) => ids.map((id) => `${id} (${byId.get(id)?.title ?? "?"})`).join(", ") || "—";
				return {
					content: [
						{
							type: "text" as const,
							text:
								`ready: ${describe(buckets.ready)}\n` +
								`blocked: ${describe(buckets.blocked)}\n` +
								`running: ${describe(buckets.running)}\n` +
								`done: ${buckets.done.length}, failed: ${buckets.failed.length}, cancelled: ${buckets.cancelled.length}\n` +
								`execution waves (outstanding work): ${waves.map((w, i) => `[${i + 1}] ${w.join(", ")}`).join("  ") || "—"}`,
						},
					],
					details: { ...buckets, waves },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("tickets_ready ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const d = result.details as any;
				return new Text(theme.fg("success", "→ ") + theme.fg("accent", `${d?.ready?.length ?? 0} ready, ${d?.blocked?.length ?? 0} blocked`), 0, 0);
			},
		},

		{
			name: "ticket_claim",
			label: "Ticket Claim",
			description:
				"Claim a READY ticket to work on it — sets it to running and assigns it to this instance. Refuses if the " +
				"ticket isn't READY (blocked on dependencies, already running, done, etc.), or if it declares " +
				"required_capabilities this instance's role+skills don't cover. Planner-EXCLUDED (Revisione 42): the planner " +
				"never claims ticket work itself — see docs/notes/development-notes.md Revisione 42 for the real incident (a missing " +
				"coder led the planner to just do the coding itself instead of relaunching one) this closes structurally, not " +
				"just by instruction. If no live instance of the required role exists, relaunch one — never claim its ticket.",
			parameters: Type.Object({ ticket_id: Type.String() }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role === "planner") {
					throw new Error(
						"ticket_claim: the planner role may never claim a ticket — planning and delegating is the whole job, doing the " +
							"work yourself (even once, even to unblock a missing/dead instance) is exactly the failure Revisione 42 closed. " +
										"Relaunch the instance whose role this ticket needs through Herdr, following the initial team-selection flow, " +
							"then let THAT instance call ticket_claim.",
					);
				}
				const storage = ensureYanoStorage();
				const ticket = storage.getTicket(params.ticket_id);
				if (!ticket) throw new Error(`ticket_claim: no ticket "${params.ticket_id}".`);
				if (ticket.required_playbook) {
					const binding = storage.getPlaybookBinding(ticket.run_id);
					if (!binding || binding.playbook_id !== ticket.required_playbook) {
						throw new Error(`ticket_claim: ticket "${ticket.id}" requires playbook "${ticket.required_playbook}", but the run has no matching immutable binding.`);
					}
					if (identity.playbook && identity.playbook !== ticket.required_playbook) {
						// A role's default playbook describes its normal activation path,
						// but shared roles (notably reviewer and docs-sync) are also
						// deliberately selected by specialised playbooks.  An explicit
						// required_capabilities role is the run-scoped authorisation for
						// that assignment; keep rejecting an unqualified cross-playbook
						// claim so the contract is still meaningful.
						const explicitlyRequiredForRole = ticket.required_capabilities.some((capability) => capability.toLowerCase() === identity.role.toLowerCase());
						if (!explicitlyRequiredForRole) {
							throw new Error(`ticket_claim: role "${identity.role}" is mapped to playbook "${identity.playbook}" and cannot claim a "${ticket.required_playbook}" ticket without an explicit role capability.`);
						}
					}
				}
				const tickets = storage.listTickets(ticket.run_id);
				const deps = storage.listDependencies(ticket.run_id);
				const buckets = yanoComputeReadyBlocked(tickets, deps);
				if (!buckets.ready.includes(ticket.id)) {
					throw new Error(`ticket_claim: "${ticket.id}" is not READY right now (status: ${ticket.status}${buckets.blocked.includes(ticket.id) ? ", blocked on unfinished dependencies" : ""}).`);
				}
				if (ticket.required_capabilities.length > 0) {
					const have = new Set([identity.role.toLowerCase(), ...identity.skills.map((s) => s.toLowerCase())]);
					const missing = ticket.required_capabilities.filter((c) => !have.has(c.toLowerCase()));
					if (missing.length > 0) {
						throw new Error(`ticket_claim: this instance (role "${identity.role}") is missing required capabilities: ${missing.join(", ")}.`);
					}
				}
				const updated = storage.updateTicketStatus(ticket.id, "running", { assigned_instance: identity.instance });
				storage.recordEvent(ticket.run_id, "ticket_started", { ticket_id: ticket.id, assigned_instance: identity.instance }, ticket.id);
				logEvent("yano_ticket_claimed", { run_id: ticket.run_id, ticket_id: ticket.id });
				await yanoPublishEvent(ticket.run_id, "ticket_started", { ticket_id: ticket.id, assigned_instance: identity.instance });
				// Revisione 40 — see activeTicketIds declaration: this instance is now
				// genuinely doing ticket work regardless of whatever inboundQueue looks
				// like, so the MQTT presence widget must reflect that immediately, not
				// wait for the next heartbeat tick.
				activeTicketIds.add(ticket.id);
				void publishPresence(computeSelfStatus());
				return {
					content: [{ type: "text" as const, text: `ticket_claim: "${ticket.title}" (${ticket.id}) claimed by ${identity.instance}.` }],
					details: { ticket: updated },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("ticket_claim ")) + theme.fg("accent", (args as any).ticket_id ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const ticket = (result.details as any)?.ticket;
				return new Text(theme.fg("success", "→ claimed by ") + theme.fg("accent", ticket?.assigned_instance ?? "?"), 0, 0);
			},
		},

		{
			name: "ticket_complete",
			label: "Ticket Complete",
			description:
				"Mark a ticket done or failed and report the result. Only the instance that claimed it (or planner, who may " +
				"override) may call this — BY DESIGN it is normally the planner who calls this, not the worker: a ticket " +
				"represents a role's contribution to a phase, and that contribution is only truly \"done\" once the planner is " +
				"satisfied (see prompts/planner.md — call this alongside plan_advance, for every ticket in the phase you're " +
				"closing, not just whichever instance woke you last). On \"done\", recomputes which dependent tickets just " +
				"became READY and publishes ticket_ready for each; if every ticket in the run is now done, the run itself is " +
				"marked completed. On \"failed\", dependents stay blocked — no automatic cascade (replanning to route around a " +
				"failure is deferred, see docs/notes/development-notes.md Revisione 26).",
			parameters: Type.Object({
				ticket_id: Type.String(),
				status: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
				result_summary: Type.Optional(Type.String()),
			}),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const storage = ensureYanoStorage();
				const ticket = storage.getTicket(params.ticket_id);
				if (!ticket) throw new Error(`ticket_complete: no ticket "${params.ticket_id}".`);
				if (ticket.status !== "running") throw new Error(`ticket_complete: "${ticket.id}" is not running (status: ${ticket.status}) — only a running ticket can be completed.`);
				if (ticket.assigned_instance !== identity.instance && identity.role !== "planner") {
					throw new Error(`ticket_complete: "${ticket.id}" is assigned to "${ticket.assigned_instance}", not this instance ("${identity.instance}") — only the assignee or planner may complete it.`);
				}
				const updated = storage.updateTicketStatus(ticket.id, params.status, { result_summary: params.result_summary ?? null });
				storage.recordEvent(ticket.run_id, params.status === "done" ? "ticket_done" : "ticket_failed", { ticket_id: ticket.id, result_summary: params.result_summary ?? null }, ticket.id);
				logEvent("yano_ticket_completed", { run_id: ticket.run_id, ticket_id: ticket.id, status: params.status });
				await yanoPublishEvent(ticket.run_id, params.status === "done" ? "ticket_done" : "ticket_failed", { ticket_id: ticket.id });
				// Revisione 40 — counterpart of the activeTicketIds.add() in
				// ticket_claim: this ticket is no longer "why this instance is busy"
				// (done or failed, either way the running work stopped), so drop it
				// and re-publish immediately rather than waiting for the next
				// heartbeat — same reasoning as ticket_claim above.
				//
				// The local delete makes the same-instance path immediate. The heartbeat
				// reconciliation from SQLite also fixes the planner-override path: when
				// the planner completes a worker-owned ticket, that worker's next
				// presence publish rebuilds its set and becomes idle.
				activeTicketIds.delete(ticket.id);
				void publishPresence(computeSelfStatus());

				const newlyReady: string[] = [];
				if (params.status === "done") {
					const tickets = storage.listTickets(ticket.run_id);
					const deps = storage.listDependencies(ticket.run_id);
					const buckets = yanoComputeReadyBlocked(tickets, deps);
					for (const readyId of buckets.ready) {
						const dependsOnCompleted = deps.some((d) => d.ticket_id === readyId && d.depends_on_id === ticket.id);
						if (dependsOnCompleted) newlyReady.push(readyId);
					}
					for (const readyId of newlyReady) {
						storage.recordEvent(ticket.run_id, "ticket_ready", { ticket_id: readyId }, readyId);
						await yanoPublishEvent(ticket.run_id, "ticket_ready", { ticket_id: readyId });
					}
					const allTickets = storage.listTickets(ticket.run_id);
					const allDone = allTickets.length > 0 && allTickets.every((t) => t.status === "done");
					if (allDone) {
						storage.updateRunStatus(ticket.run_id, "completed");
						storage.recordEvent(ticket.run_id, "run_completed", {});
						await yanoPublishEvent(ticket.run_id, "run_completed", {});
					}
				}

				return {
					content: [{ type: "text" as const, text: `ticket_complete: "${ticket.title}" (${ticket.id}) marked ${params.status}.${newlyReady.length ? ` Newly READY: ${newlyReady.join(", ")}.` : ""}` }],
					details: { ticket: updated, newly_ready: newlyReady },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("ticket_complete ")) + theme.fg("accent", `${(args as any).ticket_id ?? "?"} → ${(args as any).status ?? "?"}`), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const ticket = (result.details as any)?.ticket;
				return new Text(theme.fg("success", "→ ") + theme.fg("accent", ticket?.status ?? "?"), 0, 0);
			},
		},

		{
			name: "ticket_requeue",
			label: "Requeue Ticket Recovery",
			description: "Requeue a failed ticket on the same id with a persisted recovery generation and bounded retry budget.",
			parameters: Type.Object({ ticket_id: Type.String(), reason: Type.String(), max_retries: Type.Integer({ minimum: 1 }), max_replans: Type.Optional(Type.Integer({ minimum: 1 })), current_provider_id: Type.Optional(Type.String({ description: "provider-id (from the pinned model@provider-id the failed worker used, if any) to exclude from the escalation suggestion — without this the recommendation can suggest the same provider that just failed" })) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("ticket_requeue: only planner may replace a failed worker.");
				let result: any;
				try {
					result = ensureYanoStorage().requeueTicketForRecovery(params.ticket_id, params);
				} catch (error) {
					// Final exhaustion (escalation already used and it also failed).
					// This used to fail the run silently — nobody heard about it
					// unless they happened to check run_status. Tell the human.
					const message = error instanceof Error ? error.message : String(error);
					if (/recovery budget exhausted/.test(message)) {
						const notifyText = `⚠️ Ticket "${params.ticket_id}" ha esaurito i tentativi anche dopo aver provato un modello/strategia diversa. Il run è stato marcato failed. Motivo: ${params.reason}`;
						const notifyResult = await sendNotifications(notifyText);
						logEvent("notification_dispatch", { ticket_id: params.ticket_id, ok: notifyResult.ok, detail: notifyResult.detail, channels: notifyResult.channels, reason: "recovery_budget_exhausted_final" });
					}
					throw error;
				}
				if (result.escalation?.active) {
					// First exhaustion: try a different provider before giving up.
					// recommend() never throws for a data/network problem — it
					// degrades to auto_fallback — so this is safe even when
					// llmProxy is unreachable; the escalation itself still
					// happens either way, just without a specific pin to suggest.
					let modelSuggestion: any = null;
					try { modelSuggestion = await recommendModel({ roleClass: "support", excludeProviderId: (params as any).current_provider_id || null }); } catch { modelSuggestion = null; }
					const pinned = modelSuggestion?.recommended?.pinned_id || null;
					const notifyText = pinned
						? `🔁 Ticket "${params.ticket_id}" ha esaurito i tentativi normali. Provo un modello diverso (${pinned}) e un approccio diverso prima di arrendermi. Motivo: ${params.reason}`
						: `🔁 Ticket "${params.ticket_id}" ha esaurito i tentativi normali. Provo un approccio diverso prima di arrendermi (nessun modello alternativo disponibile da llmProxy in questo momento). Motivo: ${params.reason}`;
					const notifyResult = await sendNotifications(notifyText);
					logEvent("notification_dispatch", { ticket_id: params.ticket_id, ok: notifyResult.ok, detail: notifyResult.detail, channels: notifyResult.channels, reason: "recovery_escalation_started" });
					result = { ...result, escalation: { ...result.escalation, recommended_model: pinned } };
				}
				const statusText = result.escalation?.active
					? `ticket_requeue: ${params.ticket_id} is pending after ESCALATION — try a different model/approach this time${result.escalation.recommended_model ? ` (suggested: ${result.escalation.recommended_model})` : ""}, not the same strategy that already failed twice (recovery generation ${result.recovery.recovery_generation}).`
					: `ticket_requeue: ${params.ticket_id} is pending (recovery generation ${result.recovery.recovery_generation}).`;
				return { content: [{ type: "text" as const, text: statusText }], details: { ...result, recovery: redactRuntimeProjection(result.recovery) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("ticket_requeue ")) + theme.fg("accent", (args as any).ticket_id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String((result.details as any)?.recovery?.recovery_generation ?? "?")), 0, 0); },
		},

		{
			name: "ticket_recovery_get",
			label: "Get Ticket Recovery",
			description: "Read the persisted retry/replan budget for a ticket.",
			parameters: Type.Object({ ticket_id: Type.String() }),
			async execute(_callId, params) {
				const recovery = ensureYanoStorage().getTicketRecovery(params.ticket_id);
				return { content: [{ type: "text" as const, text: recovery ? `ticket_recovery: ${params.ticket_id} retry ${recovery.retry_count}/${recovery.max_retries}.` : `ticket_recovery: no recovery record for ${params.ticket_id}.` }], details: { recovery: redactRuntimeProjection(recovery) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("ticket_recovery_get ")) + theme.fg("accent", (args as any).ticket_id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.recovery?.status ?? "none"), 0, 0); },
		},
	];
}
