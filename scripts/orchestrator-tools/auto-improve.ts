// Fase 6 / M1 — auto_improve_web_search/web_fetch/complete, extracted from
// extensions/orchestrator.ts. All 3 share the auto-improver role gate and
// are genuinely cohesive despite being labeled "misc" in earlier planning
// — worth their own module. searchPublicAlternatives/fetchPublicSource
// (from yano-auto-improve-web.mjs) and traceRoot/projectKey (from
// yano-trace-storage.mjs) are pure, imported directly — no closure to
// preserve, same reasoning as redactRuntimeProjection throughout Fase 4/5.
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fetchPublicSource, searchPublicAlternatives } from "../yano-auto-improve-web.mjs";
import { projectKey, traceRoot } from "../yano-trace-storage.mjs";

export interface Identity {
	role: string;
	cwd: string;
	project: string;
	instance: string;
}

export interface AutoImproveToolsDeps {
	getIdentity: () => Identity | null;
}

export function createAutoImproveTools(deps: AutoImproveToolsDeps) {
	const { getIdentity } = deps;
	return [
		{
			name: "auto_improve_web_search",
			label: "Auto-Improve Web Search",
			description: "Search public GitHub and npm indexes for comparable software. Read-only, bounded and available only to auto-improver.",
			parameters: Type.Object({ query: Type.String({ description: "Capability-focused comparison query, not a secret." }) }),
			async execute(_callId: string, params: { query: string }) {
				const identity = getIdentity();
				if (!identity || identity.role !== "auto-improver") throw new Error("auto_improve_web_search: tool riservato al ruolo auto-improver.");
				try {
					const result = await searchPublicAlternatives({ query: params.query });
					return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: { query: params.query, result_count: result.results.length, read_only: true } };
				} catch (error) {
					return { content: [{ type: "text" as const, text: `auto_improve_web_search: ${error instanceof Error ? error.message : String(error)}` }], details: { query: params.query, read_only: true, error: true } };
				}
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("auto_improve_web_search ")) + theme.fg("accent", (args as any).query ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { const d = result.details as any; return new Text(theme.fg(d?.error ? "error" : "success", d?.error ? "✗ web search failed" : `✓ ${d?.result_count ?? 0} candidates`), 0, 0); },
		},

		{
			name: "auto_improve_web_fetch",
			label: "Auto-Improve Web Fetch",
			description: "Fetch one explicit public HTTPS source for the comparison report. Read-only, bounded and available only to auto-improver.",
			parameters: Type.Object({ url: Type.String({ description: "Official HTTPS repository, documentation or package URL to verify." }) }),
			async execute(_callId: string, params: { url: string }) {
				const identity = getIdentity();
				if (!identity || identity.role !== "auto-improver") throw new Error("auto_improve_web_fetch: tool riservato al ruolo auto-improver.");
				try {
					const result = await fetchPublicSource({ url: params.url });
					return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: { url: params.url, status: result.status, read_only: true } };
				} catch (error) {
					return { content: [{ type: "text" as const, text: `auto_improve_web_fetch: ${error instanceof Error ? error.message : String(error)}` }], details: { url: params.url, read_only: true, error: true } };
				}
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("auto_improve_web_fetch ")) + theme.fg("accent", (args as any).url ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { const d = result.details as any; return new Text(theme.fg(d?.error ? "error" : "success", d?.error ? "✗ source fetch failed" : `✓ HTTP ${d?.status ?? "?"}`), 0, 0); },
		},

		{
			name: "auto_improve_complete",
			label: "Auto-Improve Complete",
			description: "Complete an auto-improve audit by writing its Markdown report to the current project's docs/reports directory. Available only to the auto-improver role.",
			parameters: Type.Object({
				audit_id: Type.String(),
				report_file: Type.String(),
				report_markdown: Type.String(),
				summary: Type.String(),
			}),
			async execute(_callId: string, params: { audit_id: string; report_file: string; report_markdown: string; summary: string }) {
				const identity = getIdentity();
				if (!identity || identity.role !== "auto-improver") throw new Error("auto_improve_complete: tool riservato al ruolo auto-improver.");
				if (!/^AUDIT-[A-Z0-9-]+$/i.test(params.audit_id)) throw new Error("auto_improve_complete: audit_id non valido.");
				const globalRoot = path.resolve(path.join(traceRoot(), "auto-improver"));
				// Pi commonly returns the report path relative to the project's data
				// root ("reports/AUDIT-....md"). Resolve that form explicitly; an
				// absolute path is still accepted only after the same containment check.
				const projectRoot = path.resolve(path.join(globalRoot, "projects", projectKey(identity.cwd, identity.project)));
				const projectReportsRoot = path.resolve(path.join(identity.cwd, "docs", "reports"));
				const rawReportFile = String(params.report_file || "");
				const reportFile = path.resolve(path.isAbsolute(rawReportFile) ? rawReportFile : path.join(projectRoot, rawReportFile));
				const inGlobalRoot = reportFile === globalRoot || reportFile.startsWith(`${globalRoot}${path.sep}`);
				const inProjectReports = reportFile.startsWith(`${projectReportsRoot}${path.sep}`);
				if (!inGlobalRoot && !inProjectReports) {
					throw new Error("auto_improve_complete: report_file deve restare nel data-root auto-improver o in docs/reports del progetto.");
				}
				if ((!inGlobalRoot && !path.basename(reportFile).startsWith("auto-improvement-")) || (inGlobalRoot && !reportFile.endsWith(`${path.sep}reports${path.sep}${params.audit_id}.md`))) {
					throw new Error("auto_improve_complete: report_file non corrisponde all'audit richiesto.");
				}
				fs.mkdirSync(path.dirname(reportFile), { recursive: true });
				fs.writeFileSync(reportFile, params.report_markdown.endsWith("\n") ? params.report_markdown : `${params.report_markdown}\n`, { mode: 0o600 });
				const output = execFileSync("yano", ["auto-improve", "complete", "--project-root", identity.cwd, "--audit-id", params.audit_id, "--report-file", reportFile, "--summary", params.summary, "--json"], { cwd: identity.cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
				return { content: [{ type: "text" as const, text: output.trim() || `auto-improve ${params.audit_id}: completed` }], details: { audit_id: params.audit_id, report_file: reportFile, read_only_project: true } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("auto_improve_complete ")) + theme.fg("accent", (args as any).audit_id ?? "?"), 0, 0); },
			renderResult(_result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "✓ audit completed (project docs/reports)"), 0, 0); },
		},
	];
}
