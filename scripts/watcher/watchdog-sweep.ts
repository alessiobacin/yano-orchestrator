// Fase 2 / M3 — the in-process watchdog sweep, extracted from extensions/
// orchestrator.ts per the original audit's recommendation ("Spacchetta
// orchestrator.ts in storage/, watchdog/, notifications/, terminal-
// integration/, tools/{worktree,plan,ticket}"). The LAST and riskiest of
// the four Fase 2 extractions — deliberately done last, after M0-M2 proved
// the dedent-and-inject pattern on progressively more coupled code.
//
// watchdogSweep() closes over several `let`-reassigned variables in the
// original file (identity, yanoStorage, client, T) — each starts unset (or
// gets reassigned later, e.g. yanoStorage on first orchestrator_init,
// client on reconnect/shutdown). A plain value snapshot at factory-creation
// time would go stale the moment any of them changed after that point, so
// each is injected as a GETTER (`getIdentity`, `getYanoStorage`,
// `getClient`, `getTopics`) that orchestrator.ts defines inline where the
// original `let` bindings are still in scope — reading the getter inside
// watchdogSweep() reproduces the exact live-closure semantics of the
// original code. `presence` (a `const` Map, only ever mutated in place) and
// `pi`/`logEvent`/`yanoPublishEvent`/`withTimeout` (stable function
// references, never reassigned — verified before extraction) are passed
// directly, no getter needed.
//
// The four alert-dedup Map/Set caches (watchdogAlertLevel/
// watchdogOrphanAlerted/watchdogAutoTerminated/watchdogRunAlerted) move
// from module-level state in orchestrator.ts to factory-closure state here
// — created once per createWatchdogSweep() call (which orchestrator.ts
// itself only calls once, at session_start), same lifetime as before.
//
// yanoFindStalledTickets/yanoFindUnfinalizedRuns/yanoFindOrphanedTickets and
// their WATCHDOG_*_MS thresholds stay in orchestrator.ts (used by several
// OTHER tool handlers too, not exclusive to the watchdog) and are injected
// as parameters rather than imported back — importing them here would
// create a real circular module dependency; StalledTicketInfo/
// UnfinalizedRunInfo/OrphanedTicketInfo/TerminateEnvelope are small object
// shapes duplicated locally for the same reason (avoiding a type-only
// import cycle), matching the duplication precedent already set in Fase 2/
// M0 (YANO_EXTENSION_VERSION) and M2 (loadRuntimePackageVersion).
//
// Loaded as a plain .ts file under Node's --experimental-strip-types, same
// as the other three Fase 2 modules.

export type StalledTicketInfo = {
	run_id: string;
	ticket_id: string;
	title: string;
	assigned_instance: string | null;
	running_since: string;
	elapsed_ms: number;
};

export type UnfinalizedRunInfo = {
	run_id: string;
	objective: string;
	completed_at: string;
	elapsed_ms: number;
};

export type OrphanedTicketInfo = {
	run_id: string;
	ticket_id: string;
	title: string;
	assigned_instance: string;
	running_since: string;
};

type TerminateEnvelope = {
	type: "terminate";
	requested_by_instance: string;
	requested_by_role: string;
	reason: string;
	timestamp: string;
};

export type WatchdogSweepDeps = {
	getIdentity: () => { role: string; cwd: string; project: string; instance: string } | null;
	getYanoStorage: () => unknown | null;
	getClient: () => { publishAsync: (topic: string, payload: string, opts?: unknown) => Promise<unknown> } | null;
	getTopics: () => { agentCommands: (instance: string) => string } | null;
	presence: Map<string, { status: string }>;
	pi: { sendMessage: (message: unknown, opts?: unknown) => void };
	logEvent: (type: string, data?: Record<string, unknown>) => void;
	yanoPublishEvent: (runId: string, type: string, payload: unknown) => Promise<void>;
	sendNotifications: (message: string) => Promise<{ ok: boolean; detail: string; channels: Record<string, { ok: boolean; detail: string }> }>;
	withTimeout: <T>(p: Promise<T>, ms: number) => Promise<T | undefined>;
	projectKey: (cwd: string, project: string) => string;
	writeWatchdogHeartbeat: (key: string, nowMs: number) => void;
	yanoFindStalledTickets: (storage: any, project: string, nowMs: number, stallMs: number) => StalledTicketInfo[];
	yanoFindUnfinalizedRuns: (storage: any, project: string, nowMs: number, graceMs: number) => UnfinalizedRunInfo[];
	yanoFindOrphanedTickets: (storage: any, project: string, presence: Map<string, { status: string }>, options?: { ignoreOpenDecisionHolds?: boolean }) => OrphanedTicketInfo[];
	WATCHDOG_STALL_MS: number;
	WATCHDOG_AUTO_TERMINATE_ENABLED: boolean;
	WATCHDOG_AUTO_TERMINATE_MS: number;
	WATCHDOG_FINALIZE_GRACE_MS: number;
};

function nowIso(): string {
	return new Date().toISOString();
}

export function createWatchdogSweep(deps: WatchdogSweepDeps) {
	const watchdogAlertLevel = new Map<string, number>();
	const watchdogRunAlerted = new Set<string>();
	const watchdogOrphanAlerted = new Set<string>();
	const watchdogAutoTerminated = new Set<string>();

	// Planner-only (a coder/specialist instance can't act on a stalled ticket
	// anyway — reassignment/escalation is a planning decision). No-op for every
	// other role and a no-op until the workspace/DB actually exists (yanoStorage
	// null before the first orchestrator_init/run_create) — the timer below
	// runs unconditionally from session_start, this function is what makes it
	// harmless before there's anything to watch. Never throws: every side
	// effect here (SQLite event, MQTT publish, WhatsApp, waking the planner's
	// own turn) is independently best-effort, same discipline as the rest of
	// this file — a watchdog that can itself crash the planner defeats its
	// purpose.
	return async function watchdogSweep(nowMs: number): Promise<StalledTicketInfo[]> {
		const identity = deps.getIdentity();
		const yanoStorage = deps.getYanoStorage();
		const client = deps.getClient();
		const T = deps.getTopics();
		const { presence, pi, logEvent, yanoPublishEvent, sendNotifications, withTimeout, projectKey, writeWatchdogHeartbeat, yanoFindStalledTickets, yanoFindUnfinalizedRuns, yanoFindOrphanedTickets, WATCHDOG_STALL_MS, WATCHDOG_AUTO_TERMINATE_ENABLED, WATCHDOG_AUTO_TERMINATE_MS, WATCHDOG_FINALIZE_GRACE_MS } = deps;
		if (!identity || identity.role !== "planner" || !yanoStorage) return [];
		// Fase 1 / M5: mark that the in-process watchdog is alive and just ran a
		// pass for this project — regardless of whether anything is stalled.
		// scripts/watch-stalls.mjs checks this heartbeat before publishing
		// `ticket_stalled` to MQTT, so the two watchers stop double-publishing
		// the same event when both are covering the same project at once. See
		// scripts/watcher/heartbeat.mjs for the fail-open contract.
		try { writeWatchdogHeartbeat(projectKey(identity.cwd, identity.project), nowMs); } catch { /* best effort, never block the real sweep */ }
		try {
			const expired = yanoStorage.expireDecisionHolds(new Date(nowMs).toISOString());
			for (const hold of expired) {
				yanoStorage.recordEvent(hold.run_id, "decision_hold_expired", { hold_id: hold.id, generation: hold.generation, expires_at: hold.expires_at }, hold.ticket_id);
				void yanoPublishEvent(hold.run_id, "decision_hold_expired", { hold_id: hold.id, generation: hold.generation });
				logEvent("decision_hold_expired", { run_id: hold.run_id, hold_id: hold.id, ticket_id: hold.ticket_id });
			}
		} catch {
			// Hold expiry is best-effort within the watchdog; a storage failure must
			// not suppress the independent stalled-ticket sweep below.
		}
		try {
			for (const item of yanoStorage.drainDecisionHoldOutbox()) {
				const payload = item.payload as { hold_id?: string; generation?: number; needs_replan?: boolean };
				const message = `[decision-hold-resume] hold ${payload.hold_id ?? item.hold_id} answered (generation ${payload.generation ?? "?"}). ` +
					(payload.needs_replan ? "Replan is required before dispatch." : "Resume the current plan from persisted state.");
				void yanoPublishEvent(item.run_id, "decision_hold_resume_requested", { ...payload, outbox_id: item.id });
				try {
					pi.sendMessage({ customType: "decision-hold-resume", content: message, display: true, details: { run_id: item.run_id, ...payload, outbox_id: item.id } }, { deliverAs: "followUp", triggerTurn: true });
				} catch {
					logEvent("decision_hold_resume_delivery_failed", { run_id: item.run_id, hold_id: item.hold_id, outbox_id: item.id });
				}
			}
		} catch {
			// Keep the ticket watchdog alive if outbox delivery encounters a DB or
			// transport failure; the durable answer/audit state remains intact.
		}
		let stalled: StalledTicketInfo[];
		try {
			stalled = yanoFindStalledTickets(yanoStorage, identity.project, nowMs, WATCHDOG_STALL_MS);
		} catch {
			return [];
		}
		for (const s of stalled) {
			const episodeKey = `${s.ticket_id}::${s.running_since}`;
			const thresholdLevel = Math.floor(s.elapsed_ms / WATCHDOG_STALL_MS); // 1 at first stall, 2 after another full stall period unresolved, ...
			const lastLevel = watchdogAlertLevel.get(episodeKey) ?? 0;
			if (thresholdLevel <= lastLevel) continue; // already alerted at this severity for this running episode
			watchdogAlertLevel.set(episodeKey, thresholdLevel);

			const minutes = Math.round(s.elapsed_ms / 60_000);
			try {
				yanoStorage.recordEvent(s.run_id, "ticket_stalled", { ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms }, s.ticket_id);
			} catch {
				// best-effort — never let a logging failure hide a real stall from the other channels below
			}
			// Await the publish (with a bound) before completing this sweep. A
			// fire-and-forget publish could be overtaken by the next turn or by
			// shutdown, leaving the planner notified locally while peers never
			// receive the durable `ticket_stalled` signal.
			await withTimeout(
				yanoPublishEvent(s.run_id, "ticket_stalled", { ticket_id: s.ticket_id, title: s.title, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms }),
				2000,
			);
			logEvent("watchdog_stall_detected", { run_id: s.run_id, ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms, threshold_level: thresholdLevel });

			const waMessage =
				`⚠️ watchdog: il ticket "${s.title}" (${s.ticket_id}), assegnato a ${s.assigned_instance ?? "?"}, è RUNNING da ${minutes} min ` +
				`senza un ticket_complete — probabile blocco dell'istanza (turno bloccato o troncato). Il planner è stato informato, nessuna azione automatica presa.`;
			void sendNotifications(waMessage).then((r) => logEvent("notification_dispatch", { ok: r.ok, detail: r.detail, channels: r.channels, reason: "watchdog_stall", ticket_id: s.ticket_id }));

			try {
				pi.sendMessage(
					{
						customType: "orchestrator-watchdog",
						content:
							`[watchdog] Il ticket "${s.title}" (${s.ticket_id}), assegnato a ${s.assigned_instance ?? "istanza sconosciuta"}, risulta RUNNING da ${minutes} minuti ` +
							`senza alcun evento di completamento — probabile blocco dell'istanza (turno bloccato o con risposta troncata dal provider). ` +
							`Decidi tu come procedere: un ping via agent_send verso quell'istanza per capire se è ancora viva, marcare il ticket come fallito con ` +
							`ticket_complete (status: "failed") e ripianificarlo su una nuova istanza dello stesso ruolo, oppure escalare all'utente se non riesci a ` +
							`sbloccarlo. L'utente è già stato avvisato tramite i canali configurati (se presenti). Annota cosa decidi nel report, così resta nell'audit trail.`,
						display: true,
						details: { run_id: s.run_id, ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms, threshold_level: thresholdLevel },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch {
				// best-effort — the SQLite event + MQTT publish + notifications above already happened regardless
			}
		}

		// Revisione 42 — orphaned tickets: assigned instance confirmably not
		// connected (see yanoFindOrphanedTickets() above). Fires independently of
		// the elapsed-time stall check above — no waiting needed, the presence
		// snapshot already tells us the instance is gone. Deterministic,
		// code-only action: mark the ticket "failed" itself (freeing the slot)
		// and force a mandatory relaunch instruction into the planner's own
		// turn — not a suggestion, since the real incident this closes was
		// exactly the planner treating "the coder never showed up" as license
		// to do the work itself instead of relaunching one.
		try {
			const orphaned = yanoFindOrphanedTickets(yanoStorage, identity.project, presence, { ignoreOpenDecisionHolds: true });
			for (const o of orphaned) {
				const episodeKey = `${o.ticket_id}::${o.running_since}`;
				if (watchdogOrphanAlerted.has(episodeKey)) continue;
				watchdogOrphanAlerted.add(episodeKey);

				const summary = `istanza "${o.assigned_instance}" risultata offline/disconnessa (nessuna presence viva) — rilevato dal watchdog, ticket riportato a failed automaticamente.`;
				try {
					yanoStorage.updateTicketStatus(o.ticket_id, "failed", { result_summary: summary });
					yanoStorage.recordEvent(o.run_id, "ticket_failed", { ticket_id: o.ticket_id, result_summary: summary, auto: true, reason: "orphaned_instance" }, o.ticket_id);
				} catch {
					// best-effort — the notification below still fires even if the DB write fails
				}
				void yanoPublishEvent(o.run_id, "ticket_failed", { ticket_id: o.ticket_id, auto: true, reason: "orphaned_instance" });
				logEvent("watchdog_orphaned_ticket_auto_failed", { run_id: o.run_id, ticket_id: o.ticket_id, assigned_instance: o.assigned_instance });

				const waMessage =
					`🔴 watchdog: l'istanza "${o.assigned_instance}", assegnataria del ticket "${o.title}" (${o.ticket_id}), risulta OFFLINE — ` +
					`il ticket è stato automaticamente riportato a "failed". Il planner è stato svegliato con l'istruzione di rilanciare l'istanza.`;
				void sendNotifications(waMessage).then((r) => logEvent("notification_dispatch", { ok: r.ok, detail: r.detail, channels: r.channels, reason: "watchdog_orphaned_instance", ticket_id: o.ticket_id }));

				try {
					pi.sendMessage(
						{
							customType: "orchestrator-watchdog",
							content:
								`[watchdog] L'istanza "${o.assigned_instance}", a cui era assegnato il ticket "${o.title}" (${o.ticket_id}), risulta OFFLINE (nessuna ` +
								`presence MQTT viva) — il ticket è già stato riportato automaticamente a "failed" per liberare lo slot. AZIONE OBBLIGATORIA: rilancia ` +
								`ora "${o.assigned_instance}" (stesso nome o uno nuovo dello stesso ruolo) con Herdr, usando la selezione ` +
								`iniziale del team, poi ripianifica questo lavoro (ticket_create/ticket_claim) su quell'istanza una volta che agent_list la mostra ` +
								`viva. NON eseguire tu il lavoro di questo ticket: sei il planner, il tuo compito è pianificare e delegare, mai scrivere codice al ` +
								`posto di un coder assente. L'utente è già stato avvisato tramite i canali configurati (se presenti).`,
							display: true,
							details: { run_id: o.run_id, ticket_id: o.ticket_id, assigned_instance: o.assigned_instance },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} catch {
					// best-effort
				}
			}
		} catch {
			// best-effort — never let this new check take down the rest of the sweep
		}

		// Revisione 42 — opt-in hard-stuck auto-terminate
		// (PI_ORCH_WATCHDOG_AUTO_TERMINATE=true — see WATCHDOG_AUTO_TERMINATE_*
		// above for the trade-off this is deliberately NOT on by default for).
		// Only ever considers tickets that are BOTH past the harder threshold
		// AND still presence-live (not offline) — an already-gone instance is
		// handled by the orphan block above instead, nothing left to terminate.
		if (WATCHDOG_AUTO_TERMINATE_ENABLED && client && T) {
			try {
				const hardStuck = yanoFindStalledTickets(yanoStorage, identity.project, nowMs, WATCHDOG_AUTO_TERMINATE_MS);
				for (const s of hardStuck) {
					if (!s.assigned_instance) continue;
					const episodeKey = `${s.ticket_id}::${s.running_since}`;
					if (watchdogAutoTerminated.has(episodeKey)) continue;
					const card = presence.get(s.assigned_instance);
					if (!card || card.status === "offline") continue; // already-gone — the orphan block above already handled it
					watchdogAutoTerminated.add(episodeKey);

					const minutes = Math.round(s.elapsed_ms / 60_000);
					const env: TerminateEnvelope = {
						type: "terminate",
						requested_by_instance: identity.instance,
						requested_by_role: identity.role,
						reason: `watchdog: ticket "${s.ticket_id}" running da ${minutes} min senza ticket_complete (soglia auto-terminate superata)`,
						timestamp: nowIso(),
					};
					try {
						await client.publishAsync(T.agentCommands(s.assigned_instance), JSON.stringify(env), { qos: 1 });
					} catch {
						// best-effort — the notification/log below still happen regardless
					}
					try {
						yanoStorage.recordEvent(s.run_id, "ticket_auto_terminated", { ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms });
					} catch {
						// best-effort
					}
					logEvent("watchdog_auto_terminate", { run_id: s.run_id, ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms });

					const waMessage =
						`🔴 watchdog: istanza "${s.assigned_instance}" bloccata da ${minutes} min sul ticket "${s.title}" (${s.ticket_id}) — terminazione ` +
						`automatica inviata (PI_ORCH_WATCHDOG_AUTO_TERMINATE=true). Il planner deve rilanciarla.`;
					void sendNotifications(waMessage).then((r) => logEvent("notification_dispatch", { ok: r.ok, detail: r.detail, channels: r.channels, reason: "watchdog_auto_terminate", ticket_id: s.ticket_id }));

					try {
						pi.sendMessage(
							{
								customType: "orchestrator-watchdog",
								content:
									`[watchdog] Ho appena inviato una terminazione automatica a "${s.assigned_instance}" (bloccata da ${minutes} minuti sul ticket ` +
									`"${s.title}", ${s.ticket_id}, senza ticket_complete — soglia PI_ORCH_WATCHDOG_AUTO_TERMINATE_MS superata). AZIONE OBBLIGATORIA: ` +
									`verifica con agent_list che sia sparita, poi rilanciala con Herdr e marca ` +
									`questo ticket come failed con ticket_complete prima di ripianificarlo — NON eseguire tu il lavoro del ticket.`,
								display: true,
								details: { run_id: s.run_id, ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms },
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					} catch {
						// best-effort
					}
				}
			} catch {
				// best-effort — never let this take down the rest of the sweep
			}
		}

		// Revisione 40 — see yanoFindUnfinalizedRuns() above. Independent of the
		// ticket-stall loop above: a run can be fully "completed" at the DAG
		// layer (nothing running, nothing to flag there) while still missing its
		// operator-facing follow-up. `pi.sendMessage(..., {triggerTurn: true})`
		// below is the actual "awake" half of this fix — if the planner's own
		// turn-loop merely went idle (rather than the process having genuinely
		// exited), this forces a fresh turn instead of waiting for one that may
		// never come on its own. The WhatsApp send is a plain fetch, independent
		// of this planner's own LLM turn entirely, so it still reaches the
		// operator even if that revival attempt does nothing (process actually
		// dead, or wedged deeper than a turn boundary).
		try {
			const unfinalized = yanoFindUnfinalizedRuns(yanoStorage, identity.project, nowMs, WATCHDOG_FINALIZE_GRACE_MS);
			for (const r of unfinalized) {
				if (watchdogRunAlerted.has(r.run_id)) continue;
				watchdogRunAlerted.add(r.run_id);

				const minutes = Math.round(r.elapsed_ms / 60_000);
				try {
					yanoStorage.recordEvent(r.run_id, "run_unfinalized_stall", { elapsed_ms: r.elapsed_ms });
				} catch {
					// best-effort — never let a logging failure hide this from the other channels below
				}
				logEvent("watchdog_unfinalized_run_detected", { run_id: r.run_id, objective: r.objective, elapsed_ms: r.elapsed_ms });

				const waMessage =
					`⚠️ watchdog: il run "${r.objective}" (${r.run_id}) risulta con TUTTI i ticket completati da ${minutes} min, ma nessun ` +
					`worktree_finalize/notifica di chiusura risulta ancora arrivato — possibile blocco del planner (es. turno interrotto dal ` +
					`provider LLM) subito dopo l'ultimo ticket_complete. Se il merge/la notifica finale sono già stati fatti manualmente, ignora ` +
					`questo avviso — è un'euristica sul tempo trascorso, non una certezza.`;
				void sendNotifications(waMessage).then((r2) => logEvent("notification_dispatch", { ok: r2.ok, detail: r2.detail, channels: r2.channels, reason: "watchdog_unfinalized_run", run_id: r.run_id }));

				try {
					pi.sendMessage(
						{
							customType: "orchestrator-watchdog",
							content:
								`[watchdog] Il run "${r.objective}" (${r.run_id}) ha tutti i ticket completati da ${minutes} minuti, ma non risulta ancora ` +
								`nessun worktree_finalize né notifica di chiusura per questo lavoro. Se il task ha un worktree associato ancora aperto, ` +
								`chiama worktree_finalize ora; se è già stato finalizzato per un'altra via, non serve fare nulla — annota nel report cosa ` +
								`hai verificato. L'utente è già stato avvisato tramite i canali configurati (se presenti).`,
							display: true,
							details: { run_id: r.run_id, objective: r.objective, elapsed_ms: r.elapsed_ms },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} catch {
					// best-effort — the SQLite event + notifications above already happened regardless
				}
			}
		} catch {
			// best-effort — never let this second check take down the ticket-stall loop above
		}

		return stalled;
	}
}
