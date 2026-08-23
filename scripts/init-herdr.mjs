#!/usr/bin/env node
// Helper for `yano init --herdr`.
// Creates (or safely reuses) a Herdr workspace rooted at the directory from
// which the command was requested, then runs the real init and planner start
// inside its root pane. Herdr remains the only process supervisor; this file
// never backgrounds a terminal or starts a second launcher.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";

function decode(stdout) {
	if (!stdout || !String(stdout).trim()) return null;
	try {
		const parsed = JSON.parse(String(stdout));
		const result = parsed?.result ?? parsed;
		return result?.snapshot ?? result;
	} catch {
		return null;
	}
}

function invokeHerdr(args, { herdrBin = "herdr", runner = spawnSync } = {}) {
	const result = runner(herdrBin, args, { encoding: "utf8" });
	if (result.status !== 0) {
		const detail = String(result.stderr || result.stdout || "").trim();
		throw new Error(`Herdr ha rifiutato "${args.join(" ")}"${detail ? `: ${detail}` : "."}`);
	}
	return decode(result.stdout);
}

function tryInvokeHerdr(args, options) {
	try {
		return invokeHerdr(args, options);
	} catch {
		return null;
	}
}

function focusWorkspace(workspaceId, options) {
	try {
		invokeHerdr(["workspace", "focus", workspaceId], options);
		return true;
	} catch (error) {
		console.error(`yano init --herdr: impossibile portare in primo piano il workspace: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

function openHerdrClient(projectRoot, { herdrBin = "herdr", runner = spawnSync } = {}) {
	// Dentro un pane Herdr il client è già visibile: workspace focus sopra è
	// sufficiente e avviare un Herdr annidato renderebbe inutilizzabile il pane.
	if (process.env.HERDR_ENV === "1") return false;
	console.log("yano init --herdr: apro/aggancio il client Herdr...");
	const result = runner(herdrBin, [], { cwd: projectRoot, stdio: "inherit" });
	if (result.status !== 0) {
		console.error(`yano init --herdr: il client Herdr non si è aperto (exit ${result.status ?? "sconosciuto"}).`);
		return false;
	}
	return true;
}

function normalizedDirectory(value) {
	const absolute = path.resolve(value);
	try {
		return fs.realpathSync(absolute);
	} catch {
		return absolute;
	}
}

function shellQuote(value, platform) {
	const text = String(value);
	if (platform === "win32") return `"${text.replaceAll("\"", "\\\"")}"`;
	return `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function buildHerdrInitCommand({ initArgs, plannerInstance = "planner-01", platform = process.platform }) {
	const quote = (value) => shellQuote(value, platform);
	// `herdr pane run` accepts one shell command string after the pane id. It
	// does not accept an executable plus argv in the style of spawn(2): passing
	// `sh`, `-lc` and a pre-quoted script makes Herdr quote the script again and
	// breaks the command (for example: `sh -lc 'yano 'init' ...'`). Keep the
	// shell syntax here, but pass the complete command as one argument.
	const init = ["yano", "init", ...initArgs]
		.map((value, index) => (index < 2 || value.startsWith("--") ? value : quote(value)))
		.join(" ");
	const planner = ["yano", "start", "--instance", plannerInstance, "--role", "planner"]
		.map((value) => (value.startsWith("--") || value === "yano" || value === "start" ? value : quote(value)))
		.join(" ");
	return { command: platform === "win32" ? `${init} && ${planner}` : `${init} && exec ${planner}` };
}

function rootPaneForWorkspace(snapshot, workspace, cwd) {
	return (snapshot?.panes ?? []).find((pane) => pane.workspace_id === workspace.workspace_id && normalizedDirectory(pane.cwd || "") === cwd);
}

function existingWorkspace(snapshot, label, cwd) {
	const matches = (snapshot?.workspaces ?? []).filter((workspace) => workspace.label === label);
	if (!matches.length) return null;
	const sameRoot = matches.find((workspace) => rootPaneForWorkspace(snapshot, workspace, cwd));
	if (sameRoot) return { workspace: sameRoot, pane: rootPaneForWorkspace(snapshot, sameRoot, cwd), reused: true };
	throw new Error(`esiste già un workspace Herdr chiamato "${label}" ma associato a un'altra directory; rinominalo o chiudilo prima di ripetere l'init`);
}

export function runHerdrInit({ cwd, initArgs, plannerInstance = "planner-01", herdrBin = "herdr", runner = spawnSync, platform = process.platform, launchClient = process.env.HERDR_ENV !== "1" }) {
	const projectRoot = normalizedDirectory(cwd);
	if (!fs.statSync(projectRoot).isDirectory()) throw new Error(`la directory corrente non è valida: ${projectRoot}`);
	const label = path.basename(projectRoot) || projectRoot;
	const options = { herdrBin, runner };

	// Snapshot is best-effort: workspace create is also the command that can
	// bring up Herdr's local server on a fresh machine. If a server is already
	// running, this prevents duplicate workspaces and duplicate planner tabs.
	const snapshot = tryInvokeHerdr(["api", "snapshot"], options);
	const existing = existingWorkspace(snapshot, label, projectRoot);
	let workspace;
	let pane;
	let reused = false;
	if (existing) {
		workspace = existing.workspace;
		pane = existing.pane;
		reused = true;
		const activeAgent = (snapshot.agents ?? []).find((agent) => agent.pane_id === pane.pane_id);
		if (activeAgent && activeAgent.agent_status !== "done") {
			throw new Error(`il workspace Herdr "${label}" ha già un agente attivo nella tab ${pane.pane_id}; non avvio un secondo planner`);
		}
	} else {
		const created = invokeHerdr(["workspace", "create", "--cwd", projectRoot, "--label", label, "--focus"], options);
		workspace = created?.workspace;
		pane = created?.root_pane;
		if (!workspace?.workspace_id || !pane?.pane_id) throw new Error("Herdr ha creato il workspace ma non ha restituito il root pane");
	}

	focusWorkspace(workspace.workspace_id, options);
	const command = buildHerdrInitCommand({ initArgs, plannerInstance, platform });
	invokeHerdr(["pane", "run", pane.pane_id, command.command], options);
	console.log(`yano init --herdr: workspace Herdr "${label}" ${reused ? "riusato" : "creato"} (${workspace.workspace_id}).`);
	console.log(`yano init --herdr: eseguito nella tab ${pane.pane_id}: yano init ... && yano start --instance ${plannerInstance} --role planner`);
	const clientOpened = launchClient ? openHerdrClient(projectRoot, options) : false;
	return { workspace, pane, label, reused, command, clientOpened };
}
