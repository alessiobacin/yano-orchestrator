// Fase 1 / M7 — family-fingerprint aggregation. Real evidence from the audit:
// 33-39 `tool_failure` findings that are distinct-but-correlated (same
// project/category/signal, different tool/expected/actual) each opened their
// own ticket instead of collapsing into one. The exact `fingerprint` still
// dedupes true repeats (unchanged); a coarser `family_fingerprint =
// sha256(project_key|category|signal)` now groups correlated-but-distinct
// findings onto a single OPEN ticket as appended occurrences, instead of a
// new ticket per finding.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	appendFamilyOccurrence,
	createYanoWatcherTicket,
	detectYanoFindings,
	findExistingTicketByFamily,
	hasHumanComments,
	parseFrontmatter,
} from "./yano-watcher-findings.mjs";

function toolFailureRecord({ tool, expected, actual, id }) {
	return {
		id, ts: new Date().toISOString(), type: "tool_execution_end", ok: false,
		tool, expected, actual, tool_source: "internal",
	};
}

describe("family_fingerprint — same family for correlated findings, distinct fine fingerprint", () => {
	it("two tool_failure findings with the same project/category/signal but different tool/expected/actual share family_fingerprint but not fingerprint", () => {
		const context = { project: "demo", project_key: "workspace-demo" };
		const [a] = detectYanoFindings([toolFailureRecord({ id: "r1", tool: "ticket_claim", expected: "ok", actual: "timeout" })], context);
		const [b] = detectYanoFindings([toolFailureRecord({ id: "r2", tool: "agent_send", expected: "ok", actual: "refused" })], context);
		expect(a.family_fingerprint).toBeTruthy();
		expect(a.family_fingerprint).toBe(b.family_fingerprint);
		expect(a.fingerprint).not.toBe(b.fingerprint);
	});

	it("a different project_key produces a different family_fingerprint even for the same category/signal", () => {
		const [a] = detectYanoFindings([toolFailureRecord({ id: "r1", tool: "ticket_claim", expected: "ok", actual: "err" })], { project: "demo", project_key: "workspace-a" });
		const [b] = detectYanoFindings([toolFailureRecord({ id: "r2", tool: "ticket_claim", expected: "ok", actual: "err" })], { project: "demo", project_key: "workspace-b" });
		expect(a.family_fingerprint).not.toBe(b.family_fingerprint);
	});
});

describe("createYanoWatcherTicket — family aggregation on disk", () => {
	let yanoRepo;
	let ticketsDir;
	beforeEach(() => {
		yanoRepo = fs.mkdtempSync(path.join(os.tmpdir(), "yano-findings-test-"));
		ticketsDir = path.join(yanoRepo, ".scratch", "optimize-orchestrator", "issues");
	});
	afterEach(() => {
		fs.rmSync(yanoRepo, { recursive: true, force: true });
	});

	function ticketFiles() {
		if (!fs.existsSync(ticketsDir)) return [];
		return fs.readdirSync(ticketsDir).filter((f) => f.endsWith(".md")).sort();
	}

	it("N distinct-but-correlated tool_failure findings collapse into 1 ticket with N-1 appended occurrences", () => {
		const context = { project: "demo", project_key: "workspace-demo" };
		const findings = [
			toolFailureRecord({ id: "r1", tool: "ticket_claim", expected: "ok", actual: "timeout" }),
			toolFailureRecord({ id: "r2", tool: "agent_send", expected: "ok", actual: "refused" }),
			toolFailureRecord({ id: "r3", tool: "worktree_finalize", expected: "ok", actual: "conflict" }),
			toolFailureRecord({ id: "r4", tool: "run_status", expected: "ok", actual: "not_found" }),
		].flatMap((record) => detectYanoFindings([record], context));
		expect(findings).toHaveLength(4);

		const results = findings.map((finding) => createYanoWatcherTicket({ finding, yanoRepo, projectRoot: yanoRepo, project: "demo", ticketsDir }));

		expect(results[0].created).toBe(true);
		expect(results.slice(1).every((r) => r.created === false && r.appended === true)).toBe(true);
		expect(ticketFiles()).toHaveLength(1);

		const content = fs.readFileSync(path.join(ticketsDir, ticketFiles()[0]), "utf8");
		const occurrenceLines = content.split("\n").filter((line) => line.startsWith("- ") && line.includes("fingerprint"));
		expect(occurrenceLines).toHaveLength(3); // 4 findings - the 1 that created the ticket
	});

	it("exact-fingerprint dedup is unchanged: the SAME finding observed again does not append an occurrence", () => {
		const context = { project: "demo", project_key: "workspace-demo" };
		const [finding] = detectYanoFindings([toolFailureRecord({ id: "r1", tool: "ticket_claim", expected: "ok", actual: "timeout" })], context);
		const first = createYanoWatcherTicket({ finding, yanoRepo, projectRoot: yanoRepo, project: "demo", ticketsDir });
		const second = createYanoWatcherTicket({ finding, yanoRepo, projectRoot: yanoRepo, project: "demo", ticketsDir });

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.appended).toBeFalsy(); // exact repeat: touchExistingTicketRecurrence, not appendFamilyOccurrence
		expect(ticketFiles()).toHaveLength(1);
		const content = fs.readFileSync(path.join(ticketsDir, ticketFiles()[0]), "utf8");
		expect(content).not.toContain("## Occorrenze");
	});

	it("a family match only appends to an OPEN ticket — a non-open family match gets its own new ticket instead", () => {
		const context = { project: "demo", project_key: "workspace-demo" };
		const [a] = detectYanoFindings([toolFailureRecord({ id: "r1", tool: "ticket_claim", expected: "ok", actual: "timeout" })], context);
		const created = createYanoWatcherTicket({ finding: a, yanoRepo, projectRoot: yanoRepo, project: "demo", ticketsDir });
		// Simulate the family ticket having been closed (sweep/manual) since.
		const closed = fs.readFileSync(created.path, "utf8").replace(/^status: open$/m, "status: auto-closed-stale");
		fs.writeFileSync(created.path, closed);

		const [b] = detectYanoFindings([toolFailureRecord({ id: "r2", tool: "agent_send", expected: "ok", actual: "refused" })], context);
		const result = createYanoWatcherTicket({ finding: b, yanoRepo, projectRoot: yanoRepo, project: "demo", ticketsDir });

		expect(result.created).toBe(true);
		expect(ticketFiles()).toHaveLength(2);
	});

	it("appending an occurrence never writes into ## Comments — a family-matched ticket stays eligible for auto-close", () => {
		const context = { project: "demo", project_key: "workspace-demo" };
		const [a] = detectYanoFindings([toolFailureRecord({ id: "r1", tool: "ticket_claim", expected: "ok", actual: "timeout" })], context);
		const created = createYanoWatcherTicket({ finding: a, yanoRepo, projectRoot: yanoRepo, project: "demo", ticketsDir });
		const [b] = detectYanoFindings([toolFailureRecord({ id: "r2", tool: "agent_send", expected: "ok", actual: "refused" })], context);
		createYanoWatcherTicket({ finding: b, yanoRepo, projectRoot: yanoRepo, project: "demo", ticketsDir });

		const content = fs.readFileSync(created.path, "utf8");
		expect(hasHumanComments(content)).toBe(false);
		expect(content.indexOf("## Occorrenze")).toBeLessThan(content.indexOf("## Comments"));
	});

	it("the created ticket's frontmatter carries family_fingerprint so later findings can match it", () => {
		const context = { project: "demo", project_key: "workspace-demo" };
		const [a] = detectYanoFindings([toolFailureRecord({ id: "r1", tool: "ticket_claim", expected: "ok", actual: "timeout" })], context);
		const created = createYanoWatcherTicket({ finding: a, yanoRepo, projectRoot: yanoRepo, project: "demo", ticketsDir });
		const content = fs.readFileSync(created.path, "utf8");
		const meta = parseFrontmatter(content);
		expect(meta.family_fingerprint).toBe(a.family_fingerprint);
	});
});

describe("findExistingTicketByFamily / appendFamilyOccurrence — unit-level", () => {
	let ticketsDir;
	beforeEach(() => {
		ticketsDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-findings-family-test-"));
	});
	afterEach(() => {
		fs.rmSync(ticketsDir, { recursive: true, force: true });
	});

	it("returns null when the directory does not exist yet", () => {
		expect(findExistingTicketByFamily(path.join(ticketsDir, "nope"), "abc")).toBeNull();
	});

	it("returns null when no ticket matches the family fingerprint", () => {
		fs.writeFileSync(path.join(ticketsDir, "01-x.md"), "---\nfamily_fingerprint: other\nstatus: open\n---\nbody\n");
		expect(findExistingTicketByFamily(ticketsDir, "abc")).toBeNull();
	});

	it("appendFamilyOccurrence bumps last_seen_at and adds one bullet under ## Occorrenze", () => {
		const ticketPath = path.join(ticketsDir, "01-x.md");
		fs.writeFileSync(ticketPath, "---\nfamily_fingerprint: abc\nstatus: open\ndetected_at: 2026-01-01T00:00:00.000Z\n---\n\n# Title\n\n## Comments\n");
		const before = fs.readFileSync(ticketPath, "utf8");
		expect(before).not.toContain("last_seen_at");

		appendFamilyOccurrence(ticketPath, { fingerprint: "fp-1", tool: "x", expected: "ok", actual: "err" }, new Date("2026-01-02T00:00:00.000Z"));
		const after = fs.readFileSync(ticketPath, "utf8");
		expect(after).toContain("last_seen_at: 2026-01-02T00:00:00.000Z");
		expect(after).toContain("## Occorrenze");
		expect(after).toContain("fp-1");
		expect(after.indexOf("## Occorrenze")).toBeLessThan(after.indexOf("## Comments"));
	});
});
