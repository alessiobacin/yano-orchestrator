#!/usr/bin/env node
// `yano invoke` — deterministic bridge callable from registered scheduler
// scripts (spec scheduler-script-first, C) and from any other CLI context.
// It composes the same launch argv used by the historical scheduler dispatch
// (see dispatchPlanner in yano-scheduler.mjs) and reports the bounded,
// validated composition — no shell string, no free-form command, no broker
// required for the planner path.
//
//   yano invoke --role computer-locale --prompt "..." [--timeout-ms N]
//   yano invoke --role planner --project <scope> [--project-root <dir>] --prompt "..." [--timeout-ms N]
//   yano invoke --role planner:<scope> --project-root <dir> --prompt "..."   (alias)
//
// Role handling:
//   - planner / planner:<scope> — composes `yano start --herdr --role planner
//     --project <scope> --print-only --json` from the target project root
//     (script-driven wake of the project planner; same pattern the scheduler
//     uses at dispatch time). The command is printed for the caller: actual
//     execution belongs to the registered script / the planner launch flow.
//   - computer-locale — delegates to the existing MQTT-aware client
//     (`yano computer ask`), so the broker handshake stays inside the
//     broker-aware computer-local service.

import path from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function value(argv, flag) { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] || null; }
function fail(message) { throw new Error(`yano invoke: ${message}`); }

export function composePlannerInvoke({ projectScope, projectRoot }) {
	const cwd = projectRoot || process.cwd();
	if (!existsSync(cwd)) fail(`project root inesistente: ${cwd}`);
	const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, "bin", "yano.mjs"), "start", "--herdr", "--instance", "scheduled-invoke-planner", "--role", "planner", "--project", projectScope, "--json", "--print-only"], { cwd, encoding: "utf8", env: process.env });
	return new Promise((resolve, reject) => {
		let stdout = ""; let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

export async function runYanoInvoke({ argv = [] } = {}) {
	const role = value(argv, "--role");
	const prompt = value(argv, "--prompt");
	const project = value(argv, "--project");
	const projectRoot = value(argv, "--project-root");
	const timeoutMs = Number(value(argv, "--timeout-ms") || 120000);
	const json = argv.includes("--json");

	if (!role || !prompt) {
		console.log("Uso: yano invoke --role <planner[:<scope>]|computer-locale> --prompt \"...\" [--project <scope>|--project-root <dir>] [--timeout-ms N]");
		if (process.argv[1]?.endsWith("yano-invoke.mjs")) process.exitCode = 1;
		return;
	}
	if (!["planner", "computer-locale"].includes(role) && !/^planner:/.test(role)) fail(`ruolo non supportato: ${role} (usare planner[:<progetto>] o computer-locale)`);

	if (role === "computer-locale") {
		// Delegate to the existing MQTT-aware computer-local client. The bridge
		// reports status 0/1 with the output; a missing broker is a status-1
		// failure, never a hang.
		const { runYanoComputerLocal } = await import("./yano-computer-local.mjs");
		let output;
		try {
			output = await runYanoComputerLocal({ argv: ["ask", "--prompt", prompt, "--timeout-ms", String(timeoutMs)] });
		} catch (error) {
			output = { error: error instanceof Error ? error.message : String(error) };
		}
		const result = { role: "computer-locale", prompt, status: output?.running === false || output?.error ? 1 : 0, timeout_ms: timeoutMs, output };
		if (json) console.log(JSON.stringify(result)); else console.log(JSON.stringify(result));
		return result;
	}

	// planner / planner:<scope>
	const targetProject = project || (role.startsWith("planner:") ? role.split(":")[1] : (projectRoot ? path.basename(projectRoot) : null));
	if (!targetProject) fail("--project <scope> o planner:<progetto> richiesto per role planner.");
	const composed = await composePlannerInvoke({ projectScope: targetProject, projectRoot });
	const parsed = JSON.parse(composed.stdout || "{}");
	const args = parsed.args || [];
	if (!args.length) fail(`composizione comando planner fallita (${composed.stderr || "risposta vuota"}).`);
	const result = { role: "planner", project: targetProject, prompt, status: 0, timeout_ms: timeoutMs, command: `pi ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}` };
	if (json) console.log(JSON.stringify(result)); else console.log(JSON.stringify(result));
	return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runYanoInvoke({ argv: process.argv.slice(2) }).catch((error) => { console.error(error.message); process.exitCode = 1; });