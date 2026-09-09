// Fase 2 / M0 — SQLite storage layer for the YanoOrchestrator ticket/DAG
// layer, extracted mechanically (zero logic change) from
// extensions/orchestrator.ts's SQLiteOrchestratorStorage class per the
// original audit's recommendation ("Spacchetta orchestrator.ts in storage/,
// watchdog/, notifications/, terminal-integration/, tools/{worktree,plan,
// ticket} — mantenendo il comportamento, non riscrivendolo").
//
// This class had ZERO references to `identity`/`pi`/`ctx`/`mqttClient`/
// `sendNotifications` in orchestrator.ts (verified before extraction) — it
// only ever touched `this.db` and its constructor argument, making it the
// lowest-risk, highest-value region to pull out first.
//
// Loaded as a plain .ts file under Node's --experimental-strip-types (the
// same mechanism orchestrator.ts itself already runs under) — verified
// working both for extensions/orchestrator.ts importing this file AND for
// Vitest importing it directly in unit tests, so this is a true
// byte-for-byte mechanical move of the original TypeScript source, not a
// transpile-and-hope: nothing here was retyped or manually converted to
// JavaScript+JSDoc.
//
// Planner/tool code only ever talks to the OrchestratorStorage interface,
// never to raw SQL — the operator's plan asked explicitly for this so a
// future storage backend could be swapped in without touching orchestration
// logic. SQLite is the only implementation for this slice.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const yanoRequire = createRequire(import.meta.url);

function ulid(): string {
	// Same Crockford-base32 ULID generator used by coms.ts/coms-net.ts (and,
	// until this extraction, duplicated in extensions/orchestrator.ts) — kept
	// so assignment_id/session identifiers stay time-sortable.
	const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

function nowIso(): string {
	return new Date().toISOString();
}

const YANO_STORAGE_SCHEMA_VERSION = 11;

export type RunStatus = "active" | "completed" | "failed" | "cancelled";
export type RunFinalizationStatus = "not_started" | "pending_finalize" | "accepted_pending_finalize" | "finalized" | "abandoned" | "not_applicable";
export type TicketStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type DecisionHoldStatus = "open" | "answered" | "expired" | "cancelled" | "blocked";

export interface RunRecord {
	id: string;
	project: string;
	objective: string;
	domain: string;
	status: RunStatus;
	finalization_status: RunFinalizationStatus;
	created_at: string;
	updated_at: string;
}

export interface SpecRecord {
	id: string;
	run_id: string;
	title: string;
	content: string;
	file_path: string | null;
	created_at: string;
}

export interface TicketRecord {
	id: string;
	run_id: string;
	spec_id: string | null;
	title: string;
	description: string;
	domain: string;
	status: TicketStatus;
	required_capabilities: string[];
	required_playbook: string | null;
	acceptance_criteria: string[];
	assigned_instance: string | null;
	result_summary: string | null;
	created_at: string;
	updated_at: string;
}

export interface DependencyRecord {
	ticket_id: string;
	depends_on_id: string;
}

export interface DecisionHoldRecord {
	id: string;
	run_id: string;
	ticket_id: string | null;
	generation: number;
	question: string;
	context: unknown;
	owner: string;
	playbook_checksum?: string | null;
	escalated_to?: string | null;
	escalation_version?: number;
	status: DecisionHoldStatus;
	answer: string | null;
	resolution_metadata: unknown;
	created_at: string;
	expires_at: string | null;
	updated_at: string;
}

export interface EventRecord {
	id: number;
	run_id: string;
	ticket_id: string | null;
	type: string;
	payload: unknown;
	created_at: string;
}

// ━━ OrchestratorStorage abstraction ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Planner/tool code below only ever talks to this interface, never to raw
// SQL — the operator's plan (§6) asked explicitly for this so a future
// storage backend could be swapped in without touching orchestration logic.
// SQLite is the only implementation for this slice; nothing else is planned
// for V1.

export interface OrchestratorStorage {
	init(): void;
	getSchemaVersion(): number;
	createRun(input: { id?: string; project: string; objective: string; domain?: string }): RunRecord;
	getRun(id: string): RunRecord | null;
	listRuns(project?: string): RunRecord[];
	updateRunStatus(id: string, status: RunStatus): void;
	updateRunFinalizationStatus(id: string, status: RunFinalizationStatus): void;
	createSpec(input: { id?: string; run_id: string; title: string; content: string; file_path?: string | null }): SpecRecord;
	getSpec(id: string): SpecRecord | null;
	createTicket(input: {
		id?: string;
		run_id: string;
		spec_id?: string | null;
		title: string;
		description?: string;
		domain?: string;
		required_capabilities?: string[];
		acceptance_criteria?: string[];
		required_playbook?: string | null;
	}): TicketRecord;
	getTicket(id: string): TicketRecord | null;
	listTickets(run_id: string): TicketRecord[];
	updateTicketStatus(id: string, status: TicketStatus, extra?: { assigned_instance?: string | null; result_summary?: string | null }): TicketRecord;
	touchTicketProgress(id: string, instance: string, kind?: string): TicketRecord | null;
	requeueTicketForRecovery(id: string, input: { reason: string; max_retries: number; max_replans?: number }): unknown;
	getTicketRecovery(id: string): unknown;
	recordFinalizeEvidence(input: { run_id?: string | null; slug: string; kind: string; source: string; observed_value: string; commit_hash?: string | null; status: string; idempotency_key: string }): unknown;
	listFinalizeEvidence(slug: string): unknown[];
	setRetentionPolicy(input: { project: string; event_days: number; evidence_days: number; outbox_days: number; dead_letter_days: number; policy_version: number }): unknown;
	previewRetention(project: string): unknown;
	applyRetention(project: string): unknown;
	recordBenchmark(input: { project: string; name: string; dataset: string; metrics: Record<string, number>; thresholds: Record<string, number> }): unknown;
	createGovernanceProposal(input: { kind: string; identifier: string; document: string; required_capabilities?: string[] }): unknown;
	listGovernanceProposals(kind?: string): unknown[];
	validateGovernanceProposal(id: number): unknown;
	approveGovernanceProposal(id: number): unknown;
	rejectGovernanceProposal(id: number, reason: string): unknown;
	auditPackageManifest(): unknown;
	addDependency(ticket_id: string, depends_on_id: string): void;
	listDependencies(run_id: string): DependencyRecord[];
	recordEvent(run_id: string, type: string, payload?: unknown, ticket_id?: string | null): EventRecord;
	listEvents(run_id: string, opts?: { since_id?: number; limit?: number }): EventRecord[];
	createCheckpoint(run_id: string, label: string, payload?: unknown): void;
	listCheckpoints(run_id: string): Array<{ id: number; run_id: string; label: string; payload: unknown; created_at: string }>;
	bindPlaybook(run_id: string, playbook: { id: string; schema_version: number; metadata: { origin: string; checksum: string }; snapshot: unknown }): { run_id: string; playbook_id: string; schema_version: number; origin: string; checksum: string; snapshot: unknown; created_at: string };
	getPlaybookBinding(run_id: string): { run_id: string; playbook_id: string; schema_version: number; origin: string; checksum: string; snapshot: unknown; created_at: string } | null;
	getPlaybookRuntimeState(run_id: string): { run_id: string; state_id: string; generation: number; updated_at: string } | null;
	recordPlaybookEvidence(run_id: string, input: { requirement: string; source: string; idempotency_key: string; cwd?: string }): unknown;
	listPlaybookEvidence(run_id: string): unknown[];
	upsertCapabilityCard(input: { run_id: string; role: string; instance: string; capability: string; source: string; scope: string; fingerprint: string; playbook_checksum: string; status: string; verified_at?: string | null; expires_at?: string | null; last_error?: string | null }): unknown;
	listCapabilityCards(run_id: string): unknown[];
	invalidateCapabilityCard(run_id: string, role: string, instance: string, capability: string, reason: string): unknown;
	transitionPlaybook(run_id: string, input: { transition_id: string; actor: string; expected_generation?: number }): { run_id: string; from: string; to: string; transition_id: string; generation: number; updated_at: string; effects: unknown[] };
	listPlaybookEffects(run_id: string, status?: string): unknown[];
	claimPlaybookEffect(id: number, input: { owner: string; token: string; lease_until: string }): unknown;
	failPlaybookEffect(id: number, input: { owner: string; token: string; error: string; max_attempts: number; next_attempt_at?: string }): unknown;
	ackPlaybookEffect(id: number, input: { idempotency_key: string; generation: number; actor_role?: string }): unknown;
	createDecisionHold(input: { id?: string; idempotency_key: string; run_id: string; ticket_id?: string | null; generation?: number; question: string; context?: unknown; owner: string; expires_at?: string | null }): DecisionHoldRecord & { created: boolean };
	getDecisionHold(id: string): DecisionHoldRecord | null;
	listDecisionHolds(run_id: string, status?: DecisionHoldStatus): DecisionHoldRecord[];
	answerDecisionHold(id: string, input: { generation: number; idempotency_key: string; answer: string; resolution_metadata?: unknown; expected_checksum?: string; principal?: string }): DecisionHoldRecord;
	cancelDecisionHold(id: string, input: { generation: number; idempotency_key: string; reason?: string; expected_checksum?: string; principal?: string }): DecisionHoldRecord;
	escalateDecisionHold(id: string, input: { generation: number; idempotency_key: string; escalated_to: string; expected_checksum?: string }): DecisionHoldRecord;
	expireDecisionHolds(now: string): DecisionHoldRecord[];
	drainDecisionHoldOutbox(): Array<{ id: number; run_id: string; hold_id: string; payload: unknown }>;
	close(): void;
}

const YANO_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	project TEXT NOT NULL,
	objective TEXT NOT NULL,
	domain TEXT NOT NULL DEFAULT 'generic',
	status TEXT NOT NULL DEFAULT 'active',
	finalization_status TEXT NOT NULL DEFAULT 'not_started',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS specs (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	file_path TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	spec_id TEXT REFERENCES specs(id),
	title TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	domain TEXT NOT NULL DEFAULT 'generic',
	status TEXT NOT NULL DEFAULT 'pending',
	required_capabilities TEXT NOT NULL DEFAULT '[]',
	required_playbook TEXT,
	acceptance_criteria TEXT NOT NULL DEFAULT '[]',
	assigned_instance TEXT,
	result_summary TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_dependencies (
	ticket_id TEXT NOT NULL REFERENCES tickets(id),
	depends_on_id TEXT NOT NULL REFERENCES tickets(id),
	PRIMARY KEY (ticket_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS ticket_recovery_state (
	 ticket_id TEXT PRIMARY KEY REFERENCES tickets(id),
	 run_id TEXT NOT NULL REFERENCES runs(id),
	 retry_count INTEGER NOT NULL DEFAULT 0,
	 replan_round INTEGER NOT NULL DEFAULT 0,
	 max_retries INTEGER NOT NULL DEFAULT 3,
	 max_replans INTEGER NOT NULL DEFAULT 3,
	 recovery_generation INTEGER NOT NULL DEFAULT 0,
	 status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','exhausted')),
	 escalation_used INTEGER NOT NULL DEFAULT 0,
	 last_failure TEXT,
	 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_recovery_run ON ticket_recovery_state(run_id, status);

CREATE TABLE IF NOT EXISTS finalize_evidence (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 run_id TEXT,
	 slug TEXT NOT NULL,
	 kind TEXT NOT NULL CHECK (kind IN ('test','workspace','commit','merge','push')),
	 source TEXT NOT NULL,
	 observed_value TEXT NOT NULL,
	 commit_hash TEXT,
	 status TEXT NOT NULL CHECK (status IN ('verified','stale','failed')),
	 idempotency_key TEXT NOT NULL,
	 created_at TEXT NOT NULL,
	 UNIQUE(slug, kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_finalize_evidence_slug_kind ON finalize_evidence(slug, kind, status);
CREATE TABLE IF NOT EXISTS retention_policies (
	 project TEXT PRIMARY KEY,
	 event_days INTEGER NOT NULL,
	 evidence_days INTEGER NOT NULL,
	 outbox_days INTEGER NOT NULL,
	 dead_letter_days INTEGER NOT NULL,
	 policy_version INTEGER NOT NULL,
	 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS benchmark_runs (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 project TEXT NOT NULL,
	 name TEXT NOT NULL,
	 dataset TEXT NOT NULL,
	 metrics TEXT NOT NULL,
	 thresholds TEXT NOT NULL,
	 status TEXT NOT NULL CHECK (status IN ('passed','failed')),
	 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS governance_proposals (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 kind TEXT NOT NULL CHECK (kind IN ('playbook','role')),
	 identifier TEXT NOT NULL,
	 document TEXT NOT NULL,
	 checksum TEXT NOT NULL,
	 required_capabilities TEXT NOT NULL DEFAULT '[]',
	 status TEXT NOT NULL DEFAULT 'sandbox' CHECK (status IN ('sandbox','validated','approved','rejected')),
	 created_at TEXT NOT NULL,
	 approved_at TEXT,
	 UNIQUE(kind, identifier, checksum)
);
CREATE TABLE IF NOT EXISTS package_manifest_audits (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 package_name TEXT NOT NULL,
	 package_version TEXT NOT NULL,
	 checksum TEXT NOT NULL,
	 status TEXT NOT NULL CHECK (status IN ('passed','failed')),
	 findings TEXT NOT NULL DEFAULT '[]',
	 created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_holds (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	ticket_id TEXT REFERENCES tickets(id),
	generation INTEGER NOT NULL DEFAULT 0,
	question TEXT NOT NULL,
	context TEXT NOT NULL DEFAULT '{}',
	owner TEXT NOT NULL,
	playbook_checksum TEXT,
	escalated_to TEXT,
	escalation_version INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'expired', 'cancelled', 'blocked')),
	answer TEXT,
	resolution_metadata TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	expires_at TEXT,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_hold_operations (
	hold_id TEXT NOT NULL REFERENCES decision_holds(id),
	operation TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (hold_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	ticket_id TEXT,
	type TEXT NOT NULL,
	payload TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	label TEXT NOT NULL,
	payload TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_run ON tickets(run_id);
CREATE INDEX IF NOT EXISTS idx_decision_holds_run_status ON decision_holds(run_id, status);
CREATE TABLE IF NOT EXISTS decision_hold_outbox (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 run_id TEXT NOT NULL REFERENCES runs(id),
	 hold_id TEXT NOT NULL REFERENCES decision_holds(id),
	 dedupe_key TEXT NOT NULL UNIQUE,
	 payload TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched')),
	created_at TEXT NOT NULL,
	 dispatched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_hold_outbox_pending ON decision_hold_outbox(status, id);
CREATE TABLE IF NOT EXISTS playbook_bindings (
	 run_id TEXT PRIMARY KEY REFERENCES runs(id),
	 playbook_id TEXT NOT NULL,
	 schema_version INTEGER NOT NULL,
	 origin TEXT NOT NULL,
	 checksum TEXT NOT NULL,
	 snapshot TEXT NOT NULL,
	 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playbook_runtime_state (
	 run_id TEXT PRIMARY KEY REFERENCES runs(id),
	 state_id TEXT NOT NULL,
	 generation INTEGER NOT NULL DEFAULT 0,
	 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playbook_evidence (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 run_id TEXT NOT NULL REFERENCES runs(id),
	 requirement TEXT NOT NULL,
	 source TEXT NOT NULL,
	 idempotency_key TEXT NOT NULL,
	 created_at TEXT NOT NULL,
	 UNIQUE(run_id, requirement, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_playbook_evidence_run_requirement ON playbook_evidence(run_id, requirement);
CREATE TABLE IF NOT EXISTS playbook_capability_cards (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 run_id TEXT NOT NULL REFERENCES runs(id),
	 role TEXT NOT NULL,
	 instance TEXT NOT NULL,
	 capability TEXT NOT NULL,
	 source TEXT NOT NULL,
	 scope TEXT NOT NULL,
	 fingerprint TEXT NOT NULL,
	 playbook_checksum TEXT NOT NULL,
	 status TEXT NOT NULL CHECK (status IN ('declared','probing','verified','failed','expired','blocked')),
	 verified_at TEXT,
	 expires_at TEXT,
	 last_error TEXT,
	 UNIQUE(run_id, role, instance, capability)
);
CREATE INDEX IF NOT EXISTS idx_playbook_capability_cards_run_status ON playbook_capability_cards(run_id, status);
CREATE TABLE IF NOT EXISTS playbook_effect_outbox (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 run_id TEXT NOT NULL REFERENCES runs(id),
	 transition_id TEXT NOT NULL,
	 generation INTEGER NOT NULL,
	 effect_id TEXT NOT NULL,
	 kind TEXT NOT NULL,
	 payload TEXT NOT NULL DEFAULT '{}',
	 dedupe_key TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched')),
	delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','leased','delivered','failed','dead_letter')),
	attempts INTEGER NOT NULL DEFAULT 0,
	lease_owner TEXT,
	lease_token TEXT,
	lease_until TEXT,
	last_error TEXT,
	next_attempt_at TEXT,
	created_at TEXT NOT NULL,
	 dispatched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_playbook_effect_outbox_run_status ON playbook_effect_outbox(run_id, status, id);
CREATE TABLE IF NOT EXISTS playbook_effect_operations (
	 effect_id INTEGER NOT NULL REFERENCES playbook_effect_outbox(id),
	 operation TEXT NOT NULL,
	 idempotency_key TEXT NOT NULL,
	 created_at TEXT NOT NULL,
	 PRIMARY KEY (effect_id, operation, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_deps_ticket ON ticket_dependencies(ticket_id);
CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON ticket_dependencies(depends_on_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
`;

function retentionCutoffs(policy: { event_days: number; evidence_days: number; outbox_days: number; dead_letter_days: number }) {
	const cutoff = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
	return {
		events: cutoff(policy.event_days),
		evidence: cutoff(policy.evidence_days),
		outbox: cutoff(policy.outbox_days),
		dead_letter: cutoff(policy.dead_letter_days),
	};
}

export class SQLiteOrchestratorStorage implements OrchestratorStorage {
	private db: import("node:sqlite").DatabaseSync;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		// Lazy require via createRequire so a module that never touches the
		// ticket layer (every existing tool) never pays for resolving
		// node:sqlite at all, and a missing/incompatible node:sqlite only
		// breaks the ticket tools, not the whole extension — same "never let
		// an optional piece take down the rest" discipline as herdr/paseo
		// detection elsewhere in this file.
		const { DatabaseSync } = yanoRequire("node:sqlite") as typeof import("node:sqlite");
		this.db = new DatabaseSync(dbPath);
	}

	init(): void {
		this.db.exec(YANO_SCHEMA_SQL);
		const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
		if (!row) {
			this.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(YANO_STORAGE_SCHEMA_VERSION));
		} else if (!Number.isInteger(Number(row.value)) || Number(row.value) < 1) {
			throw new Error(`orchestrator.db schema_version is invalid: ${row.value} — refusing to open.`);
		} else if (Number(row.value) > YANO_STORAGE_SCHEMA_VERSION) {
			// This code is OLDER than the schema it's opening — refuse rather
			// than risk silently misreading a newer layout. No migration engine
			// exists yet for the reverse case (older schema, newer code) either
			// — deferred per plan §44, this is just the safety guard that would
			// need to grow migrations behind it.
			throw new Error(
				`orchestrator.db schema_version ${row.value} is newer than this extension supports (${YANO_STORAGE_SCHEMA_VERSION}) — refusing to open. Update the extension.`,
			);
		} else if (Number(row.value) < YANO_STORAGE_SCHEMA_VERSION) {
			const current = Number(row.value);
			if (current < 3) {
				for (const sql of [
					"ALTER TABLE playbook_effect_outbox ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','leased','delivered','failed','dead_letter'))",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN lease_owner TEXT",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN lease_token TEXT",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN lease_until TEXT",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN last_error TEXT",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN next_attempt_at TEXT",
				]) this.db.exec(sql);
			}
			if (current < 4) {
				for (const sql of [
					"ALTER TABLE decision_holds ADD COLUMN playbook_checksum TEXT",
					"ALTER TABLE decision_holds ADD COLUMN escalated_to TEXT",
					"ALTER TABLE decision_holds ADD COLUMN escalation_version INTEGER NOT NULL DEFAULT 0",
				]) this.db.exec(sql);
			}
			if (current < 5) {
				// v5 adds ticket_recovery_state; YANO_SCHEMA_SQL created it above.
				// Keep the marker advance after the CREATE batch so old databases
				// never advertise recovery support before the table exists.
				this.db.prepare("SELECT 1 FROM ticket_recovery_state LIMIT 1").get();
			}
			if (current < 6) this.db.prepare("SELECT 1 FROM finalize_evidence LIMIT 1").get();
			if (current < 7) {
				this.db.prepare("SELECT 1 FROM retention_policies LIMIT 1").get();
				this.db.prepare("SELECT 1 FROM benchmark_runs LIMIT 1").get();
			}
			if (current < 8) {
				this.db.prepare("SELECT 1 FROM governance_proposals LIMIT 1").get();
				this.db.prepare("SELECT 1 FROM package_manifest_audits LIMIT 1").get();
			}
			if (current < 9) this.db.exec("ALTER TABLE tickets ADD COLUMN required_playbook TEXT");
			if (current < 10) this.db.exec("ALTER TABLE runs ADD COLUMN finalization_status TEXT NOT NULL DEFAULT 'not_started'");
			if (current < 11) this.db.exec("ALTER TABLE ticket_recovery_state ADD COLUMN escalation_used INTEGER NOT NULL DEFAULT 0");
			// Advance the marker only after every additive statement succeeds.
			this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(String(YANO_STORAGE_SCHEMA_VERSION));
		}
	}

	getSchemaVersion(): number {
		const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
		return row ? Number(row.value) : 0;
	}

	createRun(input: { id?: string; project: string; objective: string; domain?: string }): RunRecord {
		const now = nowIso();
		const rec: RunRecord = { id: input.id || ulid(), project: input.project, objective: input.objective, domain: input.domain || "generic", status: "active", finalization_status: "not_started", created_at: now, updated_at: now };
		this.db
			.prepare("INSERT INTO runs (id, project, objective, domain, status, finalization_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(rec.id, rec.project, rec.objective, rec.domain, rec.status, rec.finalization_status, rec.created_at, rec.updated_at);
		return rec;
	}

	getRun(id: string): RunRecord | null {
		const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRecord | undefined;
		return row ?? null;
	}

	listRuns(project?: string): RunRecord[] {
		if (project) return this.db.prepare("SELECT * FROM runs WHERE project = ? ORDER BY created_at DESC").all(project) as RunRecord[];
		return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as RunRecord[];
	}

	updateRunStatus(id: string, status: RunStatus): void {
		const finalization = status === "completed" ? "pending_finalize" : status === "active" ? "not_started" : "not_applicable";
		this.db.prepare("UPDATE runs SET status = ?, finalization_status = ?, updated_at = ? WHERE id = ?").run(status, finalization, nowIso(), id);
	}

	updateRunFinalizationStatus(id: string, status: RunFinalizationStatus): void {
		this.db.prepare("UPDATE runs SET finalization_status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
	}

	createSpec(input: { id?: string; run_id: string; title: string; content: string; file_path?: string | null }): SpecRecord {
		const rec: SpecRecord = { id: input.id || ulid(), run_id: input.run_id, title: input.title, content: input.content, file_path: input.file_path ?? null, created_at: nowIso() };
		this.db.prepare("INSERT INTO specs (id, run_id, title, content, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(rec.id, rec.run_id, rec.title, rec.content, rec.file_path, rec.created_at);
		return rec;
	}

	getSpec(id: string): SpecRecord | null {
		const row = this.db.prepare("SELECT * FROM specs WHERE id = ?").get(id) as SpecRecord | undefined;
		return row ?? null;
	}

	createTicket(input: {
		id?: string;
		run_id: string;
		spec_id?: string | null;
		title: string;
		description?: string;
		domain?: string;
		required_capabilities?: string[];
		acceptance_criteria?: string[];
	}): TicketRecord {
		const now = nowIso();
		const rec: TicketRecord = {
			id: input.id || ulid(),
			run_id: input.run_id,
			spec_id: input.spec_id ?? null,
			title: input.title,
			description: input.description ?? "",
			domain: input.domain ?? "generic",
			status: "pending",
			required_capabilities: input.required_capabilities ?? [],
			required_playbook: input.required_playbook ?? null,
			acceptance_criteria: input.acceptance_criteria ?? [],
			assigned_instance: null,
			result_summary: null,
			created_at: now,
			updated_at: now,
		};
		this.db
			.prepare(
				"INSERT INTO tickets (id, run_id, spec_id, title, description, domain, status, required_capabilities, required_playbook, acceptance_criteria, assigned_instance, result_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(rec.id, rec.run_id, rec.spec_id, rec.title, rec.description, rec.domain, rec.status, JSON.stringify(rec.required_capabilities), rec.required_playbook, JSON.stringify(rec.acceptance_criteria), rec.assigned_instance, rec.result_summary, rec.created_at, rec.updated_at);
		return rec;
	}

	private rowToTicket(row: any): TicketRecord {
		return {
			...row,
			required_capabilities: JSON.parse(row.required_capabilities || "[]"),
			acceptance_criteria: JSON.parse(row.acceptance_criteria || "[]"),
		};
	}

	getTicket(id: string): TicketRecord | null {
		const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as any;
		return row ? this.rowToTicket(row) : null;
	}

	listTickets(run_id: string): TicketRecord[] {
		const rows = this.db.prepare("SELECT * FROM tickets WHERE run_id = ? ORDER BY created_at ASC").all(run_id) as any[];
		return rows.map((r) => this.rowToTicket(r));
	}

	updateTicketStatus(id: string, status: TicketStatus, extra?: { assigned_instance?: string | null; result_summary?: string | null }): TicketRecord {
		const now = nowIso();
		if (extra && (extra.assigned_instance !== undefined || extra.result_summary !== undefined)) {
			const current = this.getTicket(id);
			if (!current) throw new Error(`updateTicketStatus: no ticket "${id}"`);
			const assigned_instance = extra.assigned_instance !== undefined ? extra.assigned_instance : current.assigned_instance;
			const result_summary = extra.result_summary !== undefined ? extra.result_summary : current.result_summary;
			this.db.prepare("UPDATE tickets SET status = ?, assigned_instance = ?, result_summary = ?, updated_at = ? WHERE id = ?").run(status, assigned_instance, result_summary, now, id);
		} else {
			this.db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
		}
		const updated = this.getTicket(id);
		if (!updated) throw new Error(`updateTicketStatus: no ticket "${id}"`);
		return updated;
	}

	touchTicketProgress(id: string, instance: string, kind = "tool_execution_start"): TicketRecord | null {
		const ticket = this.getTicket(id);
		if (!ticket || ticket.status !== "running" || ticket.assigned_instance !== instance) return ticket;
		const updatedAt = nowIso();
		this.db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(updatedAt, id);
		this.recordEvent(ticket.run_id, "ticket_progress", { ticket_id: id, instance, kind, observed_at: updatedAt }, id);
		return this.getTicket(id);
	}

	getTicketRecovery(id: string) {
		return this.db.prepare("SELECT * FROM ticket_recovery_state WHERE ticket_id = ?").get(id) as any ?? null;
	}

	requeueTicketForRecovery(id: string, input: { reason: string; max_retries: number; max_replans?: number }) {
		if (!input.reason.trim()) throw new Error("ticket_requeue: reason is required.");
		if (!Number.isInteger(input.max_retries) || input.max_retries < 1) throw new Error("ticket_requeue: max_retries must be a positive integer.");
		const ticket = this.getTicket(id);
		if (!ticket) throw new Error(`ticket_requeue: no ticket "${id}".`);
		if (ticket.status !== "failed") throw new Error(`ticket_requeue: "${id}" is ${ticket.status}; only failed tickets can be requeued.`);
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const current = this.getTicketRecovery(id) ?? { retry_count: 0, replan_round: 0, recovery_generation: 0, max_replans: input.max_replans ?? 3, status: "available", escalation_used: 0 };
			const retries = Number(current.retry_count) + 1;
			const maxReplans = input.max_replans ?? Number(current.max_replans ?? 3);
			const budgetExhausted = retries > input.max_retries || Number(current.replan_round ?? 0) >= maxReplans || current.status === "exhausted";
			const escalationAlreadyUsed = Number(current.escalation_used ?? 0) > 0;
			if (budgetExhausted && escalationAlreadyUsed) {
				this.db.prepare("INSERT INTO ticket_recovery_state (ticket_id, run_id, retry_count, replan_round, max_retries, max_replans, recovery_generation, status, last_failure, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'exhausted', ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET retry_count=excluded.retry_count, max_retries=excluded.max_retries, max_replans=excluded.max_replans, status='exhausted', last_failure=excluded.last_failure, updated_at=excluded.updated_at").run(id, ticket.run_id, retries, Number(current.replan_round ?? 0), input.max_retries, maxReplans, Number(current.recovery_generation ?? 0), input.reason, now);
				this.db.prepare("UPDATE runs SET status = 'failed', finalization_status = 'not_applicable', updated_at = ? WHERE id = ? AND status = 'active'").run(now, ticket.run_id);
				this.db.prepare("INSERT INTO checkpoints (run_id, label, payload, created_at) VALUES (?, 'recovery_budget_exhausted', ?, ?)").run(ticket.run_id, JSON.stringify({ ticket_id: id, retry_count: retries, max_retries: input.max_retries, reason: input.reason, escalation_used: true }), now);
				this.recordEvent(ticket.run_id, "recovery_budget_exhausted", { ticket_id: id, retry_count: retries, max_retries: input.max_retries, reason: input.reason, escalation_used: true }, id);
				this.db.exec("COMMIT");
				throw new Error(`ticket_requeue: recovery budget exhausted for "${id}".`);
			}
			if (budgetExhausted) {
				// First time this ticket hits its budget: the same strategy
				// clearly is not working, but failing the whole run outright
				// here — before ever trying something different — is exactly
				// the silent dead-end this escalation step exists to avoid.
				// Give the escalated attempt a CLEAN retry/replan budget (not
				// a continuation of the exhausted one) so it is judged on its
				// own merits, and mark escalation_used so a second exhaustion
				// after this one is final — no infinite escalation loop.
				const generation = Number(current.recovery_generation ?? 0) + 1;
				this.db.prepare("INSERT INTO ticket_recovery_state (ticket_id, run_id, retry_count, replan_round, max_retries, max_replans, recovery_generation, status, escalation_used, last_failure, updated_at) VALUES (?, ?, 0, 0, ?, ?, ?, 'available', 1, ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET retry_count=0, replan_round=0, max_retries=excluded.max_retries, max_replans=excluded.max_replans, recovery_generation=excluded.recovery_generation, status='available', escalation_used=1, last_failure=excluded.last_failure, updated_at=excluded.updated_at").run(id, ticket.run_id, input.max_retries, maxReplans, generation, input.reason, now);
				this.db.prepare("UPDATE tickets SET status = 'pending', assigned_instance = NULL, result_summary = ?, updated_at = ? WHERE id = ? AND status = 'failed'").run(`requeued (escalation): ${input.reason}`, now, id);
				const updatedTicket = this.getTicket(id);
				this.recordEvent(ticket.run_id, "recovery_escalation_started", { ticket_id: id, recovery_generation: generation, retry_count: retries, reason: input.reason }, id);
				this.db.exec("COMMIT");
				return { ticket: updatedTicket, recovery: this.getTicketRecovery(id), escalation: { active: true, reason: input.reason } };
			}
			const generation = Number(current.recovery_generation ?? 0) + 1;
			this.db.prepare("INSERT INTO ticket_recovery_state (ticket_id, run_id, retry_count, replan_round, max_retries, max_replans, recovery_generation, status, last_failure, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET retry_count=excluded.retry_count, max_retries=excluded.max_retries, max_replans=excluded.max_replans, recovery_generation=excluded.recovery_generation, status='available', last_failure=excluded.last_failure, updated_at=excluded.updated_at").run(id, ticket.run_id, retries, Number(current.replan_round ?? 0), input.max_retries, maxReplans, generation, input.reason, now);
			this.db.prepare("UPDATE tickets SET status = 'pending', assigned_instance = NULL, result_summary = ?, updated_at = ? WHERE id = ? AND status = 'failed'").run(`requeued: ${input.reason}`, now, id);
			const updated = this.getTicket(id);
			this.recordEvent(ticket.run_id, "ticket_requeued", { ticket_id: id, recovery_generation: generation, retry_count: retries, reason: input.reason }, id);
			this.db.exec("COMMIT");
			return { ticket: updated, recovery: this.getTicketRecovery(id) };
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	recordFinalizeEvidence(input: { run_id?: string | null; slug: string; kind: string; source: string; observed_value: string; commit_hash?: string | null; status: string; idempotency_key: string }) {
		if (!input.slug.trim() || !input.source.trim() || !input.observed_value.trim() || !input.idempotency_key.trim()) throw new Error("finalize_evidence: slug, source, observed_value and idempotency_key are required.");
		if (input.commit_hash) this.db.prepare("UPDATE finalize_evidence SET status = 'stale' WHERE slug = ? AND status = 'verified' AND commit_hash IS NOT NULL AND commit_hash <> ?").run(input.slug, input.commit_hash);
		this.db.prepare("INSERT OR IGNORE INTO finalize_evidence (run_id, slug, kind, source, observed_value, commit_hash, status, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(input.run_id ?? null, input.slug, input.kind, input.source, input.observed_value, input.commit_hash ?? null, input.status, input.idempotency_key, nowIso());
		return this.db.prepare("SELECT * FROM finalize_evidence WHERE slug = ? AND kind = ? AND idempotency_key = ?").get(input.slug, input.kind, input.idempotency_key);
	}

	listFinalizeEvidence(slug: string) {
		return this.db.prepare("SELECT * FROM finalize_evidence WHERE slug = ? ORDER BY id ASC").all(slug);
	}

	setRetentionPolicy(input: { project: string; event_days: number; evidence_days: number; outbox_days: number; dead_letter_days: number; policy_version: number }) {
		if (!input.project.trim() || !Number.isInteger(input.policy_version) || input.policy_version < 1 || [input.event_days, input.evidence_days, input.outbox_days, input.dead_letter_days].some((value) => !Number.isInteger(value) || value < 1)) throw new Error("retention_policy: project, positive day values and policy_version are required.");
		this.db.prepare("INSERT INTO retention_policies (project, event_days, evidence_days, outbox_days, dead_letter_days, policy_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project) DO UPDATE SET event_days=excluded.event_days, evidence_days=excluded.evidence_days, outbox_days=excluded.outbox_days, dead_letter_days=excluded.dead_letter_days, policy_version=excluded.policy_version, updated_at=excluded.updated_at").run(input.project, input.event_days, input.evidence_days, input.outbox_days, input.dead_letter_days, input.policy_version, nowIso());
		return this.db.prepare("SELECT * FROM retention_policies WHERE project = ?").get(input.project);
	}

	previewRetention(project: string) {
		const policy = this.db.prepare("SELECT * FROM retention_policies WHERE project = ?").get(project) as any;
		if (!policy) throw new Error(`retention_policy: no policy for project "${project}".`);
		const cutoffs = retentionCutoffs(policy);
		const events = this.db.prepare("SELECT COUNT(*) AS count FROM events e JOIN runs r ON r.id = e.run_id WHERE r.project = ? AND r.status <> 'active' AND e.created_at < ?").get(project, cutoffs.events) as any;
		const evidence = this.db.prepare("SELECT COUNT(*) AS count FROM playbook_evidence e JOIN runs r ON r.id = e.run_id WHERE r.project = ? AND e.created_at < ?").get(project, cutoffs.evidence) as any;
		const outbox = this.db.prepare("SELECT COUNT(*) AS count FROM playbook_effect_outbox e JOIN runs r ON r.id = e.run_id WHERE r.project = ? AND e.delivery_state IN ('delivered','failed') AND e.created_at < ?").get(project, cutoffs.outbox) as any;
		const pending = this.db.prepare("SELECT COUNT(*) AS count FROM playbook_effect_outbox e JOIN runs r ON r.id = e.run_id WHERE r.project = ? AND e.delivery_state IN ('pending','leased')").get(project) as any;
		const deadLetter = this.db.prepare("SELECT COUNT(*) AS count FROM playbook_effect_outbox e JOIN runs r ON r.id = e.run_id WHERE r.project = ? AND e.delivery_state = 'dead_letter' AND e.created_at < ?").get(project, cutoffs.dead_letter) as any;
		return { policy, cutoffs, counts: { events: Number(events.count), evidence: Number(evidence.count), outbox: Number(outbox.count), pending_outbox: Number(pending.count), dead_letter: Number(deadLetter.count) }, destructive_apply_required: true };
	}

	applyRetention(project: string) {
		const preview = this.previewRetention(project) as any;
		const { cutoffs } = preview;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const events = this.db.prepare("DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE project = ? AND status <> 'active') AND created_at < ?").run(project, cutoffs.events);
			const evidence = this.db.prepare("DELETE FROM playbook_evidence WHERE run_id IN (SELECT id FROM runs WHERE project = ?) AND created_at < ?").run(project, cutoffs.evidence);
			const outbox = this.db.prepare("DELETE FROM playbook_effect_outbox WHERE run_id IN (SELECT id FROM runs WHERE project = ?) AND delivery_state IN ('delivered','failed') AND created_at < ?").run(project, cutoffs.outbox);
			const deadLetter = this.db.prepare("DELETE FROM playbook_effect_outbox WHERE run_id IN (SELECT id FROM runs WHERE project = ?) AND delivery_state = 'dead_letter' AND created_at < ?").run(project, cutoffs.dead_letter);
			const result = { project, cutoffs, deleted: { events: Number(events.changes), evidence: Number(evidence.changes), outbox: Number(outbox.changes), dead_letter: Number(deadLetter.changes) }, applied_at: nowIso() };
			this.db.exec("COMMIT");
			return result;
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	recordBenchmark(input: { project: string; name: string; dataset: string; metrics: Record<string, number>; thresholds: Record<string, number> }) {
		const keys = Object.keys(input.thresholds);
		const status = keys.every((key) => typeof input.metrics[key] === "number" && input.metrics[key] <= input.thresholds[key]) ? "passed" : "failed";
		this.db.prepare("INSERT INTO benchmark_runs (project, name, dataset, metrics, thresholds, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.project, input.name, input.dataset, JSON.stringify(input.metrics), JSON.stringify(input.thresholds), status, nowIso());
		const row = this.db.prepare("SELECT * FROM benchmark_runs WHERE id = last_insert_rowid()").get() as any;
		return { ...row, metrics: JSON.parse(row.metrics), thresholds: JSON.parse(row.thresholds) };
	}

	createGovernanceProposal(input: { kind: string; identifier: string; document: string; required_capabilities?: string[] }) {
		if (!['playbook', 'role'].includes(input.kind) || !input.identifier.trim() || !input.document.trim()) throw new Error("governance_proposal: kind, identifier and document are required.");
		const checksum = crypto.createHash("sha256").update(input.document).digest("hex");
		this.db.prepare("INSERT OR IGNORE INTO governance_proposals (kind, identifier, document, checksum, required_capabilities, status, created_at) VALUES (?, ?, ?, ?, ?, 'sandbox', ?)").run(input.kind, input.identifier, input.document, checksum, JSON.stringify(input.required_capabilities ?? []), nowIso());
		return this.db.prepare("SELECT * FROM governance_proposals WHERE kind = ? AND identifier = ? AND checksum = ?").get(input.kind, input.identifier, checksum);
	}

	listGovernanceProposals(kind?: string) {
		const rows = (kind ? this.db.prepare("SELECT * FROM governance_proposals WHERE kind = ? ORDER BY id ASC").all(kind) : this.db.prepare("SELECT * FROM governance_proposals ORDER BY id ASC").all()) as any[];
		return rows.map((row) => ({ ...row, required_capabilities: JSON.parse(row.required_capabilities || "[]") }));
	}

	validateGovernanceProposal(id: number) {
		const result = this.db.prepare("UPDATE governance_proposals SET status = 'validated' WHERE id = ? AND status = 'sandbox'").run(id) as any;
		if (Number(result.changes ?? 0) !== 1) throw new Error(`governance_proposal: proposal "${id}" is not sandboxed.`);
		return this.db.prepare("SELECT * FROM governance_proposals WHERE id = ?").get(id);
	}

	approveGovernanceProposal(id: number) {
		const result = this.db.prepare("UPDATE governance_proposals SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'validated'").run(nowIso(), id) as any;
		if (Number(result.changes ?? 0) !== 1) throw new Error(`governance_proposal: proposal "${id}" must be validated before approval.`);
		return this.db.prepare("SELECT * FROM governance_proposals WHERE id = ?").get(id);
	}

	rejectGovernanceProposal(id: number, reason: string) {
		if (!reason.trim()) throw new Error("governance_proposal: rejection reason is required.");
		const result = this.db.prepare("UPDATE governance_proposals SET status = 'rejected' WHERE id = ? AND status IN ('sandbox','validated')").run(id) as any;
		if (Number(result.changes ?? 0) !== 1) throw new Error(`governance_proposal: proposal "${id}" cannot be rejected.`);
		return this.db.prepare("SELECT * FROM governance_proposals WHERE id = ?").get(id) as any;
	}

	auditPackageManifest() {
		const packagePath = path.resolve(process.cwd(), "package.json");
		const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
		const findings: string[] = [];
		if (pkg.name !== "yano-orchestrator") findings.push("package name is not yano-orchestrator");
		if (pkg.bin?.yano !== "./bin/yano.mjs") findings.push("public bin yano is missing");
		if (!Array.isArray(pkg.files) || !pkg.files.includes("playbooks")) findings.push("playbooks are not included in package files");
		const checksum = crypto.createHash("sha256").update(fs.readFileSync(packagePath)).digest("hex");
		const status = findings.length ? "failed" : "passed";
		this.db.prepare("INSERT INTO package_manifest_audits (package_name, package_version, checksum, status, findings, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(pkg.name ?? "", pkg.version ?? "", checksum, status, JSON.stringify(findings), nowIso());
		return { package_name: pkg.name, package_version: pkg.version, checksum, status, findings };
	}

	addDependency(ticket_id: string, depends_on_id: string): void {
		if (ticket_id === depends_on_id) throw new Error(`addDependency: ticket "${ticket_id}" cannot depend on itself.`);
		this.db.prepare("INSERT OR IGNORE INTO ticket_dependencies (ticket_id, depends_on_id) VALUES (?, ?)").run(ticket_id, depends_on_id);
	}

	listDependencies(run_id: string): DependencyRecord[] {
		return this.db
			.prepare("SELECT d.ticket_id, d.depends_on_id FROM ticket_dependencies d JOIN tickets t ON t.id = d.ticket_id WHERE t.run_id = ?")
			.all(run_id) as DependencyRecord[];
	}

	recordEvent(run_id: string, type: string, payload?: unknown, ticket_id?: string | null): EventRecord {
		const created_at = nowIso();
		const payloadJson = JSON.stringify(payload ?? {});
		const result = this.db.prepare("INSERT INTO events (run_id, ticket_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(run_id, ticket_id ?? null, type, payloadJson, created_at);
		return { id: Number(result.lastInsertRowid), run_id, ticket_id: ticket_id ?? null, type, payload: payload ?? {}, created_at };
	}

	listEvents(run_id: string, opts?: { since_id?: number; limit?: number }): EventRecord[] {
		const sinceId = opts?.since_id ?? 0;
		const limit = opts?.limit ?? 200;
		const rows = this.db.prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?").all(run_id, sinceId, limit) as any[];
		return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload || "{}") }));
	}

	createCheckpoint(run_id: string, label: string, payload?: unknown): void {
		this.db.prepare("INSERT INTO checkpoints (run_id, label, payload, created_at) VALUES (?, ?, ?, ?)").run(run_id, label, JSON.stringify(payload ?? {}), nowIso());
	}

	listCheckpoints(run_id: string) {
		const rows = this.db.prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY id ASC").all(run_id) as any[];
		return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload || "{}") }));
	}

	bindPlaybook(run_id: string, playbook: { id: string; schema_version: number; metadata: { origin: string; checksum: string }; snapshot: unknown }) {
		if (!this.getRun(run_id)) throw new Error(`playbook_bind: no run "${run_id}".`);
		const existing = this.getPlaybookBinding(run_id);
		if (existing) {
			if (existing.checksum !== playbook.metadata.checksum) throw new Error(`playbook_bind: run "${run_id}" is already bound to checksum ${existing.checksum}; refusing ${playbook.metadata.checksum}.`);
			return existing;
		}
		const record = { run_id, playbook_id: playbook.id, schema_version: playbook.schema_version, origin: playbook.metadata.origin, checksum: playbook.metadata.checksum, snapshot: playbook.snapshot, created_at: nowIso() };
		this.db.prepare("INSERT INTO playbook_bindings (run_id, playbook_id, schema_version, origin, checksum, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(record.run_id, record.playbook_id, record.schema_version, record.origin, record.checksum, JSON.stringify(record.snapshot), record.created_at);
		const initialState = (playbook.snapshot as any)?.states?.[0]?.id;
		if (initialState) this.db.prepare("INSERT INTO playbook_runtime_state (run_id, state_id, generation, updated_at) VALUES (?, ?, 0, ?)").run(run_id, initialState, record.created_at);
		return record;
	}

	getPlaybookBinding(run_id: string) {
		const row = this.db.prepare("SELECT * FROM playbook_bindings WHERE run_id = ?").get(run_id) as any;
		return row ? { ...row, schema_version: Number(row.schema_version), snapshot: JSON.parse(row.snapshot || "{}") } : null;
	}

	getPlaybookRuntimeState(run_id: string) {
		const row = this.db.prepare("SELECT * FROM playbook_runtime_state WHERE run_id = ?").get(run_id) as any;
		return row ? { ...row, generation: Number(row.generation) } : null;
	}

	recordPlaybookEvidence(run_id: string, input: { requirement: string; source: string; idempotency_key: string; cwd?: string }) {
		const run = this.getRun(run_id);
		if (!run) throw new Error(`playbook_evidence_record: no run "${run_id}".`);
		if (!this.getPlaybookBinding(run_id)) throw new Error(`playbook_evidence_record: run "${run_id}" has no bound Playbook.`);
		if (!input.requirement.trim() || !input.source.trim() || !input.idempotency_key.trim()) throw new Error("playbook_evidence_record: requirement, source and idempotency_key are required.");
		const sourceParts = input.source.split(":");
		if (input.source === "run:objective_present") {
			if (!run.objective.trim()) throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
		} else if (sourceParts.length === 3 && sourceParts[0] === "ticket" && sourceParts[2] === "done") {
			const ticket = this.getTicket(sourceParts[1]);
			if (!ticket || ticket.run_id !== run_id || ticket.status !== "done") throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
		} else if (sourceParts.length === 3 && sourceParts[0] === "hold" && sourceParts[2] === "answered") {
			const hold = this.getDecisionHold(sourceParts[1]);
			if (!hold || hold.run_id !== run_id || hold.status !== "answered") throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
		} else if (sourceParts.length === 4 && sourceParts[0] === "capability" && sourceParts[1] === "cli" && sourceParts[3] === "available") {
			if (!/^[A-Za-z0-9._-]+$/.test(sourceParts[2])) throw new Error(`playbook_evidence_record: invalid CLI capability source "${input.source}".`);
			try { execFileSync(sourceParts[2], ["--version"], { stdio: "ignore", timeout: 5000 }); }
			catch { throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`); }
		} else if (sourceParts.length === 4 && sourceParts[0] === "capability" && sourceParts[1] === "mcp" && sourceParts[3] === "handshake") {
			if (!/^[A-Za-z0-9._-]+$/.test(sourceParts[2])) throw new Error(`playbook_evidence_record: invalid MCP capability source "${input.source}".`);
			const probeCwd = input.cwd ?? process.cwd();
			const configPath = [path.join(probeCwd, ".mcp.json"), path.join(probeCwd, ".pi", "mcp.json"), path.join(probeCwd, "mcp.json")].find((file) => fs.existsSync(file));
			let server: any;
			try {
				const config = configPath ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null;
				server = config?.mcpServers?.[sourceParts[2]];
			} catch { server = null; }
			if (!server || typeof server.command !== "string" || !Array.isArray(server.args) || server.args.some((arg: unknown) => typeof arg !== "string")) throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
			// Fase 2 / M0: this was `YANO_EXTENSION_VERSION`, a module-level
			// constant in extensions/orchestrator.ts also used for the unrelated
			// workspace-config `extension_version` field there. Inlined on
			// extraction rather than re-importing it back from orchestrator.ts
			// (which would create a needless two-way dependency for a version
			// string sent only in this MCP capability-probe handshake). Keep this
			// in sync with orchestrator.ts's YANO_EXTENSION_VERSION by hand if it
			// ever changes — it hasn't since the extension's 0.1.0-slice1 vertical
			// slice (Revisione 26).
			const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "yano", version: "0.1.0-slice1" } } }) + "\n";
			try {
				const output = execFileSync(server.command, server.args, { cwd: probeCwd, input: request, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
				const initialized = output.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((message: any) => message?.id === 1 && message?.result?.protocolVersion && message?.result?.serverInfo);
				if (!initialized) throw new Error("invalid MCP initialize response");
			} catch { throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`); }
		} else if (sourceParts.length === 4 && sourceParts[0] === "capability" && sourceParts[1] === "credential" && sourceParts[3] === "present") {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceParts[2])) throw new Error(`playbook_evidence_record: invalid credential capability source "${input.source}".`);
			const envPath = path.join(input.cwd ?? process.cwd(), ".env");
			let value: string | undefined;
			try {
				const line = fs.readFileSync(envPath, "utf8").split(/\r?\n/).find((candidate) => candidate.startsWith(`${sourceParts[2]}=`));
				value = line?.slice(sourceParts[2].length + 1).trim();
			} catch { value = undefined; }
			if (!value || /^<[^>]+>$/.test(value) || /^(YOUR_|REPLACE_|CHANGEME)/i.test(value)) throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
		} else if (sourceParts.length === 4 && sourceParts[0] === "capability" && sourceParts[1] === "skill" && sourceParts[3] === "loadable") {
			if (!/^[A-Za-z0-9._-]+$/.test(sourceParts[2])) throw new Error(`playbook_evidence_record: invalid skill capability source "${input.source}".`);
			const roots = [
				path.join(input.cwd ?? process.cwd(), ".agents", "skills"),
				path.join(input.cwd ?? process.cwd(), ".codex", "skills"),
				...(process.env.HOME ? [path.join(process.env.HOME, ".agents", "skills"), path.join(process.env.HOME, ".codex", "skills")] : []),
			];
			const skillFile = roots.map((root) => path.join(root, sourceParts[2], "SKILL.md")).find((file) => fs.existsSync(file));
			if (!skillFile) throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
			try { if (fs.readFileSync(skillFile, "utf8").trim().length < 20) throw new Error("empty skill"); }
			catch { throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`); }
		} else {
			throw new Error(`playbook_evidence_record: unsupported source "${input.source}". Use run:objective_present, ticket:<id>:done, hold:<id>:answered, capability:cli:<name>:available, capability:mcp:<name>:handshake, capability:credential:<name>:present or capability:skill:<name>:loadable.`);
		}
		const created_at = nowIso();
		const insert = this.db.prepare("INSERT OR IGNORE INTO playbook_evidence (run_id, requirement, source, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)").run(run_id, input.requirement, input.source, input.idempotency_key, created_at) as any;
		const row = this.db.prepare("SELECT * FROM playbook_evidence WHERE run_id = ? AND requirement = ? AND idempotency_key = ?").get(run_id, input.requirement, input.idempotency_key) as any;
		return { ...row, created: Number(insert.changes ?? 0) > 0 };
	}

	listPlaybookEvidence(run_id: string) {
		return this.db.prepare("SELECT * FROM playbook_evidence WHERE run_id = ? ORDER BY id ASC").all(run_id);
	}

	upsertCapabilityCard(input: { run_id: string; role: string; instance: string; capability: string; source: string; scope: string; fingerprint: string; playbook_checksum: string; status: string; verified_at?: string | null; expires_at?: string | null; last_error?: string | null }) {
		if (!this.getRun(input.run_id)) throw new Error(`capability_card: no run "${input.run_id}".`);
		this.db.prepare("INSERT INTO playbook_capability_cards (run_id, role, instance, capability, source, scope, fingerprint, playbook_checksum, status, verified_at, expires_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, role, instance, capability) DO UPDATE SET source=excluded.source, scope=excluded.scope, fingerprint=excluded.fingerprint, playbook_checksum=excluded.playbook_checksum, status=excluded.status, verified_at=excluded.verified_at, expires_at=excluded.expires_at, last_error=excluded.last_error")
			.run(input.run_id, input.role, input.instance, input.capability, input.source, input.scope, input.fingerprint, input.playbook_checksum, input.status, input.verified_at ?? null, input.expires_at ?? null, input.last_error ?? null);
		return this.db.prepare("SELECT * FROM playbook_capability_cards WHERE run_id = ? AND role = ? AND instance = ? AND capability = ?").get(input.run_id, input.role, input.instance, input.capability);
	}

	listCapabilityCards(run_id: string) {
		return this.db.prepare("SELECT * FROM playbook_capability_cards WHERE run_id = ? ORDER BY id ASC").all(run_id);
	}

	invalidateCapabilityCard(run_id: string, role: string, instance: string, capability: string, reason: string) {
		const result = this.db.prepare("UPDATE playbook_capability_cards SET status = 'blocked', last_error = ? WHERE run_id = ? AND role = ? AND instance = ? AND capability = ?").run(reason, run_id, role, instance, capability) as any;
		if (Number(result.changes ?? 0) !== 1) throw new Error(`capability_card: no card for ${role}/${instance}/${capability}.`);
		return this.db.prepare("SELECT * FROM playbook_capability_cards WHERE run_id = ? AND role = ? AND instance = ? AND capability = ?").get(run_id, role, instance, capability);
	}

	transitionPlaybook(run_id: string, input: { transition_id: string; actor: string; expected_generation?: number }) {
		const binding = this.getPlaybookBinding(run_id);
		if (!binding) throw new Error(`playbook_transition: run "${run_id}" has no bound Playbook.`);
		const current = this.getPlaybookRuntimeState(run_id);
		if (!current) throw new Error(`playbook_transition: run "${run_id}" has no runtime state.`);
		const playbook = binding.snapshot as any;
		const transition = (playbook.transitions ?? []).find((candidate: any) => candidate.id === input.transition_id);
		if (!transition) throw new Error(`playbook_transition: unknown transition "${input.transition_id}".`);
		const from = Array.isArray(transition.from) ? transition.from : [transition.from];
		if (!from.includes(current.state_id)) throw new Error(`playbook_transition: transition "${input.transition_id}" cannot start from "${current.state_id}".`);
		if (transition.actor !== input.actor) throw new Error(`playbook_transition: actor "${input.actor}" is not authorised; expected "${transition.actor}".`);
		const evidence = new Set((this.listPlaybookEvidence(run_id) as any[]).map((row) => row.requirement));
		for (const requirement of transition.requires ?? []) if (!evidence.has(requirement)) throw new Error(`playbook_transition: guard "${requirement}" has no persisted evidence.`);
		if (input.expected_generation !== undefined && input.expected_generation !== current.generation) throw new Error(`playbook_transition: generation mismatch (expected ${current.generation}, received ${input.expected_generation}).`);
		const updated_at = nowIso();
		const generation = current.generation + 1;
		const effects = transition.effects ?? [];
		const approval_holds: string[] = [];
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const stateUpdate = this.db.prepare("UPDATE playbook_runtime_state SET state_id = ?, generation = ?, updated_at = ? WHERE run_id = ? AND generation = ?").run(transition.to, generation, updated_at, run_id, current.generation) as any;
			if (Number(stateUpdate.changes ?? 0) !== 1) throw new Error(`playbook_transition: concurrent state change detected for run "${run_id}"; refusing effects and audit.`);
			for (const effect of effects) {
				const payload = effect.payload ?? {};
				if (effect.kind === "human_approval") {
					const holdId = `playbook-${run_id}-${transition.id}-${generation}-${effect.id}`;
					this.db.prepare("INSERT OR IGNORE INTO decision_holds (id, run_id, ticket_id, generation, question, context, owner, playbook_checksum, status, answer, resolution_metadata, created_at, expires_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'open', NULL, '{}', ?, ?, ?)").run(holdId, run_id, generation, payload.question, JSON.stringify(payload), payload.owner ?? "user", binding.checksum, updated_at, payload.expires_at ?? null, updated_at);
					approval_holds.push(holdId);
					this.recordEvent(run_id, "decision_hold_created", { hold_id: holdId, generation, owner: payload.owner ?? "user", source: "playbook_effect", transition_id: transition.id });
				}
				this.db.prepare("INSERT OR IGNORE INTO playbook_effect_outbox (run_id, transition_id, generation, effect_id, kind, payload, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(run_id, transition.id, generation, effect.id, effect.kind, JSON.stringify(payload), `playbook:${run_id}:${transition.id}:${generation}:${effect.id}`, updated_at);
			}
			this.recordEvent(run_id, "playbook_transition", { transition_id: transition.id, from: current.state_id, to: transition.to, actor: input.actor, generation });
			this.db.exec("COMMIT");
			return { run_id, from: current.state_id, to: transition.to, transition_id: transition.id, generation, updated_at, effects, approval_holds };
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			throw error;
		}
	}

	listPlaybookEffects(run_id: string, status?: string) {
		const rows = (status
			? this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE run_id = ? AND status = ? ORDER BY id ASC").all(run_id, status)
			: this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE run_id = ? ORDER BY id ASC").all(run_id)) as any[];
		return rows.map((row) => ({ ...row, generation: Number(row.generation), payload: JSON.parse(row.payload || "{}") }));
	}

	claimPlaybookEffect(id: number, input: { owner: string; token: string; lease_until: string }) {
		if (!input.owner.trim() || !input.token.trim() || !input.lease_until.trim()) throw new Error("playbook_effect_claim: owner, token and lease_until are required.");
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const effect = this.db.prepare("SELECT run_id FROM playbook_effect_outbox WHERE id = ?").get(id) as { run_id: string } | undefined;
			if (!effect) throw new Error(`playbook_effect_claim: no effect "${id}".`);
			const run = this.getRun(effect.run_id);
			const runtime = this.getPlaybookRuntimeState(effect.run_id);
			if (!run || run.status !== "active" || runtime?.state_id === "blocked") throw new Error(`playbook_effect_claim: dispatch is blocked for run "${effect.run_id}".`);
			const result = this.db.prepare("UPDATE playbook_effect_outbox SET delivery_state = 'leased', lease_owner = ?, lease_token = ?, lease_until = ? WHERE id = ? AND delivery_state IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (lease_until IS NULL OR lease_until <= ?)").run(input.owner, input.token, input.lease_until, id, now, now) as any;
			if (Number(result.changes ?? 0) !== 1) throw new Error(`playbook_effect_claim: effect "${id}" is unavailable or already leased.`);
			const row = this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE id = ?").get(id) as any;
			this.recordEvent(row.run_id, "playbook_effect_leased", { effect_id: id, owner: input.owner, lease_until: input.lease_until });
			this.db.exec("COMMIT");
			return { ...row, generation: Number(row.generation), payload: JSON.parse(row.payload || "{}") };
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	failPlaybookEffect(id: number, input: { owner: string; token: string; error: string; max_attempts: number; next_attempt_at?: string }) {
		if (!input.owner.trim() || !input.token.trim() || !input.error.trim()) throw new Error("playbook_effect_fail: owner, token and error are required.");
		if (!Number.isInteger(input.max_attempts) || input.max_attempts < 1) throw new Error("playbook_effect_fail: max_attempts must be a positive integer.");
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE id = ?").get(id) as any;
			if (!row) throw new Error(`playbook_effect_fail: no effect "${id}".`);
			if (row.delivery_state !== "leased" || row.lease_owner !== input.owner || row.lease_token !== input.token || !row.lease_until || row.lease_until <= now) throw new Error(`playbook_effect_fail: lease fencing rejected for effect "${id}".`);
			const attempts = Number(row.attempts ?? 0) + 1;
			const dead = attempts >= input.max_attempts;
			this.db.prepare("UPDATE playbook_effect_outbox SET delivery_state = ?, attempts = ?, last_error = ?, next_attempt_at = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL WHERE id = ? AND delivery_state = 'leased' AND lease_owner = ? AND lease_token = ?").run(dead ? "dead_letter" : "failed", attempts, input.error, dead ? null : (input.next_attempt_at ?? now), id, input.owner, input.token);
			let outcome = "retry";
			if (dead) {
				const binding = this.getPlaybookBinding(row.run_id);
				const runtime = this.getPlaybookRuntimeState(row.run_id);
				const blockedState = (binding?.snapshot as any)?.states?.find((state: any) => state.id === "blocked");
				if (runtime && blockedState && runtime.state_id !== "blocked") {
					const nextGeneration = runtime.generation + 1;
					this.db.prepare("UPDATE playbook_runtime_state SET state_id = 'blocked', generation = ?, updated_at = ? WHERE run_id = ? AND generation = ?").run(nextGeneration, now, row.run_id, runtime.generation);
					outcome = "blocked";
				} else {
					this.db.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'active'").run(now, row.run_id);
					outcome = "needs_replan";
				}
				this.createCheckpoint(row.run_id, "playbook_failure", { outcome, failure_class: "effect_dead_letter", effect_id: id, attempts, error: input.error, observed_at: now });
			}
			this.recordEvent(row.run_id, "playbook_effect_failed", { effect_id: id, attempts, dead_letter: dead, outcome, error: input.error });
			const updated = this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE id = ?").get(id) as any;
			this.db.exec("COMMIT");
			return { ...updated, generation: Number(updated.generation), payload: JSON.parse(updated.payload || "{}"), outcome };
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	ackPlaybookEffect(id: number, input: { idempotency_key: string; generation: number; actor_role?: string }) {
		if (!input.idempotency_key.trim()) throw new Error("playbook_effect_ack: idempotency_key is required.");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE id = ?").get(id) as any;
			if (!row) throw new Error(`playbook_effect_ack: no effect "${id}".`);
			if ((row.kind === "mqtt_event" || row.kind === "notification") && input.actor_role !== "effect-adapter") throw new Error(`playbook_effect_ack: effect kind "${row.kind}" requires runtime role "effect-adapter".`);
			if (Number(row.generation) !== input.generation) throw new Error(`playbook_effect_ack: generation mismatch (expected ${row.generation}, received ${input.generation}).`);
			if (row.delivery_state === "dead_letter") throw new Error(`playbook_effect_ack: effect "${id}" is dead-lettered and requires replan.`);
			const prior = this.db.prepare("SELECT 1 FROM playbook_effect_operations WHERE effect_id = ? AND operation = 'ack' AND idempotency_key = ?").get(id, input.idempotency_key);
			if (prior) { this.db.exec("COMMIT"); return { ...row, payload: JSON.parse(row.payload || "{}"), generation: Number(row.generation) }; }
			if (row.status !== "pending") throw new Error(`playbook_effect_ack: effect "${id}" is already ${row.status}.`);
			if (row.kind === "human_approval") {
				const holdId = `playbook-${row.run_id}-${row.transition_id}-${row.generation}-${row.effect_id}`;
				const hold = this.db.prepare("SELECT status FROM decision_holds WHERE id = ?").get(holdId) as { status: string } | undefined;
				if (!hold) throw new Error(`playbook_effect_ack: approval effect "${id}" has no decision hold.`);
				if (hold.status !== "answered") throw new Error(`playbook_effect_ack: approval effect "${id}" requires hold "${holdId}" to be answered (current status: ${hold.status}).`);
			}
			const now = nowIso();
			this.db.prepare("INSERT INTO playbook_effect_operations (effect_id, operation, idempotency_key, created_at) VALUES (?, 'ack', ?, ?)").run(id, input.idempotency_key, now);
			this.db.prepare("UPDATE playbook_effect_outbox SET status = 'dispatched', delivery_state = 'delivered', dispatched_at = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL WHERE id = ? AND status = 'pending'").run(now, id);
			this.recordEvent(row.run_id, "playbook_effect_acknowledged", { effect_id: id, generation: input.generation, idempotency_key: input.idempotency_key, actor_role: input.actor_role ?? "unknown" });
			const updated = this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE id = ?").get(id) as any;
			this.db.exec("COMMIT");
			return { ...updated, payload: JSON.parse(updated.payload || "{}"), generation: Number(updated.generation) };
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			throw error;
		}
	}

	private rowToDecisionHold(row: any): DecisionHoldRecord {
		return {
			...row,
			generation: Number(row.generation),
			context: JSON.parse(row.context || "{}"),
			resolution_metadata: JSON.parse(row.resolution_metadata || "{}"),
			status: row.status as DecisionHoldStatus,
		};
	}

	createDecisionHold(input: { id?: string; idempotency_key: string; run_id: string; ticket_id?: string | null; generation?: number; question: string; context?: unknown; owner: string; expires_at?: string | null }): DecisionHoldRecord & { created: boolean } {
		if (!input.idempotency_key.trim()) throw new Error("decision_hold_create: idempotency_key is required.");
		if (!this.getRun(input.run_id)) throw new Error(`decision_hold_create: no run "${input.run_id}".`);
		if (input.ticket_id) {
			const ticket = this.getTicket(input.ticket_id);
			if (!ticket) throw new Error(`decision_hold_create: no ticket "${input.ticket_id}".`);
			if (ticket.run_id !== input.run_id) throw new Error("decision_hold_create: ticket belongs to another run.");
		}
		const id = input.id || `hold-${crypto.createHash("sha256").update(`${input.run_id}:${input.idempotency_key}`).digest("hex").slice(0, 32)}`;
		// `created` distinguishes a genuinely new hold from an idempotent replay
		// of the same (run_id, idempotency_key) — the caller (the
		// decision_hold_create tool) uses it to guarantee the "I'm waiting for
		// your reply" notification fires exactly once per hold, never once per
		// call.
		const existing = this.getDecisionHold(id);
		if (existing) return { ...existing, created: false };
		const now = nowIso();
		const rec: DecisionHoldRecord = {
			id, run_id: input.run_id, ticket_id: input.ticket_id ?? null, generation: input.generation ?? 0,
			question: input.question, context: input.context ?? {}, owner: input.owner, status: "open",
			answer: null, resolution_metadata: {}, created_at: now, expires_at: input.expires_at ?? null, updated_at: now,
		};
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("INSERT INTO decision_holds (id, run_id, ticket_id, generation, question, context, owner, status, answer, resolution_metadata, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(rec.id, rec.run_id, rec.ticket_id, rec.generation, rec.question, JSON.stringify(rec.context), rec.owner, rec.status, null, JSON.stringify(rec.resolution_metadata), rec.created_at, rec.expires_at, rec.updated_at);
			this.db.prepare("INSERT INTO decision_hold_operations (hold_id, operation, idempotency_key, created_at) VALUES (?, 'create', ?, ?)").run(rec.id, input.idempotency_key, now);
			this.db.exec("COMMIT");
			return { ...rec, created: true };
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			const retry = this.getDecisionHold(id);
			if (retry) return { ...retry, created: false };
			throw error;
		}
	}

	getDecisionHold(id: string): DecisionHoldRecord | null {
		const row = this.db.prepare("SELECT * FROM decision_holds WHERE id = ?").get(id) as any;
		return row ? this.rowToDecisionHold(row) : null;
	}

	listDecisionHolds(run_id: string, status?: DecisionHoldStatus): DecisionHoldRecord[] {
		const rows = (status
			? this.db.prepare("SELECT * FROM decision_holds WHERE run_id = ? AND status = ? ORDER BY created_at ASC").all(run_id, status)
			: this.db.prepare("SELECT * FROM decision_holds WHERE run_id = ? ORDER BY created_at ASC").all(run_id)) as any[];
		return rows.map((row) => this.rowToDecisionHold(row));
	}

	private resolveDecisionHold(id: string, input: { generation: number; idempotency_key: string; status: "answered" | "cancelled"; answer?: string | null; resolution_metadata?: unknown; expected_checksum?: string; principal?: string }): DecisionHoldRecord {
		if (!input.idempotency_key.trim()) throw new Error("decision hold resolution: idempotency_key is required.");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT * FROM decision_holds WHERE id = ?").get(id) as any;
			if (!row) throw new Error(`decision hold: no hold "${id}".`);
			const prior = this.db.prepare("SELECT 1 FROM decision_hold_operations WHERE hold_id = ? AND operation = ? AND idempotency_key = ?").get(id, input.status, input.idempotency_key);
			if (prior) { this.db.exec("COMMIT"); return this.rowToDecisionHold(row); }
			if (Number(row.generation) !== input.generation) throw new Error(`decision hold "${id}": generation mismatch (expected ${row.generation}, received ${input.generation}).`);
			if (input.expected_checksum && row.playbook_checksum !== input.expected_checksum) throw new Error(`decision hold "${id}": Playbook checksum mismatch.`);
			if (row.playbook_checksum && input.principal && row.owner !== input.principal && row.escalated_to !== input.principal) throw new Error(`decision hold "${id}": principal is not authorised.`);
			if (row.status !== "open") throw new Error(`decision hold "${id}" is already ${row.status}.`);
			const now = nowIso();
			const metadata = input.resolution_metadata ?? (input.status === "cancelled" ? { reason: input.answer } : {});
			this.db.prepare("INSERT INTO decision_hold_operations (hold_id, operation, idempotency_key, created_at) VALUES (?, ?, ?, ?)").run(id, input.status, input.idempotency_key, now);
			this.db.prepare("UPDATE decision_holds SET status = ?, answer = ?, resolution_metadata = ?, updated_at = ? WHERE id = ?").run(input.status, input.answer ?? null, JSON.stringify(metadata), now, id);
			if (input.status === "answered") {
				const needsReplan = typeof metadata === "object" && metadata !== null && (metadata as any).needs_replan === false ? false : true;
				this.db.prepare("INSERT OR IGNORE INTO decision_hold_outbox (run_id, hold_id, dedupe_key, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(row.run_id, id, `decision-hold-resume:${id}:${input.generation}:${input.idempotency_key}`, JSON.stringify({ hold_id: id, generation: input.generation, needs_replan: needsReplan }), now);
			}
			const updated = this.getDecisionHold(id);
			if (!updated) throw new Error(`decision hold: hold "${id}" disappeared during resolution.`);
			this.db.exec("COMMIT");
			return updated;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			throw error;
		}
	}

	answerDecisionHold(id: string, input: { generation: number; idempotency_key: string; answer: string; resolution_metadata?: unknown; expected_checksum?: string; principal?: string }): DecisionHoldRecord {
		return this.resolveDecisionHold(id, { ...input, status: "answered", answer: input.answer });
	}

	cancelDecisionHold(id: string, input: { generation: number; idempotency_key: string; reason?: string; expected_checksum?: string; principal?: string }): DecisionHoldRecord {
		return this.resolveDecisionHold(id, { ...input, status: "cancelled", answer: null, resolution_metadata: { reason: input.reason ?? "cancelled" } });
	}

	escalateDecisionHold(id: string, input: { generation: number; idempotency_key: string; escalated_to: string; expected_checksum?: string }): DecisionHoldRecord {
		if (!input.escalated_to.trim() || !input.idempotency_key.trim()) throw new Error("decision hold escalation: escalated_to and idempotency_key are required.");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT * FROM decision_holds WHERE id = ?").get(id) as any;
			if (!row) throw new Error(`decision hold: no hold "${id}".`);
			const prior = this.db.prepare("SELECT 1 FROM decision_hold_operations WHERE hold_id = ? AND operation = 'escalate' AND idempotency_key = ?").get(id, input.idempotency_key);
			if (prior) { this.db.exec("COMMIT"); return this.rowToDecisionHold(row); }
			if (Number(row.generation) !== input.generation) throw new Error(`decision hold "${id}": generation mismatch (expected ${row.generation}, received ${input.generation}).`);
			if (input.expected_checksum && row.playbook_checksum !== input.expected_checksum) throw new Error(`decision hold "${id}": Playbook checksum mismatch.`);
			if (row.status !== "open") throw new Error(`decision hold "${id}" is already ${row.status}.`);
			const now = nowIso();
			this.db.prepare("INSERT INTO decision_hold_operations (hold_id, operation, idempotency_key, created_at) VALUES (?, 'escalate', ?, ?)").run(id, input.idempotency_key, now);
			this.db.prepare("UPDATE decision_holds SET escalated_to = ?, escalation_version = escalation_version + 1, updated_at = ? WHERE id = ? AND status = 'open'").run(input.escalated_to, now, id);
			const updated = this.getDecisionHold(id);
			if (!updated) throw new Error(`decision hold: hold "${id}" disappeared during escalation.`);
			this.db.exec("COMMIT");
			return updated;
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	expireDecisionHolds(now: string): DecisionHoldRecord[] {
		const rows = this.db.prepare("SELECT * FROM decision_holds WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?").all(now) as any[];
		if (!rows.length) return [];
		this.db.prepare("UPDATE decision_holds SET status = 'expired', updated_at = ? WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?").run(now, now);
		return rows.map((row) => this.rowToDecisionHold({ ...row, status: "expired", updated_at: now }));
	}

	drainDecisionHoldOutbox(): Array<{ id: number; run_id: string; hold_id: string; payload: unknown }> {
		const rows = this.db.prepare("SELECT * FROM decision_hold_outbox WHERE status = 'pending' ORDER BY id ASC").all() as any[];
		if (!rows.length) return [];
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const row of rows) this.db.prepare("UPDATE decision_hold_outbox SET status = 'dispatched', dispatched_at = ? WHERE id = ? AND status = 'pending'").run(now, row.id);
			this.db.exec("COMMIT");
			return rows.map((row) => ({ id: Number(row.id), run_id: row.run_id, hold_id: row.hold_id, payload: JSON.parse(row.payload || "{}") }));
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			throw error;
		}
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// best-effort
		}
	}
}
