// Fase 2 / M1 — terminal/pane/tab display integration, extracted
// mechanically (zero logic change) from extensions/orchestrator.ts per the
// original audit's recommendation ("Spacchetta orchestrator.ts in storage/,
// watchdog/, notifications/, terminal-integration/, tools/{worktree,plan,
// ticket}"). setTerminalTitle/herdrReportAgent/herdrRenamePane/
// herdrRenameTab are pure (process.env + execFile only, no orchestrator
// state). paseoDetectAndLog is the one exception — it called the closure
// function `logEvent()` in the original file, so it takes `{ logEvent }`
// as an explicit parameter here instead.
//
// Loaded as a plain .ts file under Node's --experimental-strip-types, same
// as scripts/yano-orchestrator-storage.ts (Fase 2 / M0) — verified working
// both for extensions/orchestrator.ts importing this file and for Vitest
// importing it directly in unit tests.

import { execFile } from "node:child_process";

// Sets the terminal window/tab title via the standard OSC 0/2 escape
// sequence (ESC ] 0 ; <title> BEL) — the convention Herdr/iTerm2/Terminal.app
// read to name a pane. Harmless secondary fallback for whatever multiplexer
// happens to be hosting `pi` (including a plain terminal tab). NOT relied on
// for herdr itself — see herdrReportAgent() below for herdr's actual naming
// mechanism, confirmed from https://herdr.dev/docs/integrations/ and
// https://herdr.dev/docs/cli-reference/.
export function setTerminalTitle(title: string): void {
	try {
		if (process.stdout && process.stdout.isTTY) {
			process.stdout.write(`\x1b]0;${title}\x07`);
		}
	} catch {
		// non-fatal: not a TTY, or stdout not writable in this context
	}
}

// herdr injects HERDR_ENV=1, HERDR_PANE_ID, HERDR_BIN_PATH (and
// HERDR_SOCKET_PATH) into every process it manages. herdr's documented way
// for a managed process to report/override its own display name+state is
// `"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" --source <id> --agent
// <label> --state <idle|working|blocked|unknown>` — this is what actually
// controls the name shown in herdr's sidebar/"new agent" list (the OSC
// terminal-title trick above does NOT do this: herdr has its own explicit
// agent-state protocol, separate from the terminal title). --source is our
// own instance id (so herdr can tell repeated reports apart); --agent is the
// human-facing label (--name if given, otherwise --instance, so panes are
// named like the agent by default, per the original request). Complete no-op
// outside herdr (HERDR_ENV unset) so this is always safe to call.
//
// Honest limit: I verified this against herdr's own published docs (CLI +
// integrations reference), not against a live herdr binary — this sandbox
// has no herdr installed and no device bridge to your Mac in this session.
// If it doesn't take effect, the manual fallback confirmed in the same docs
// is `herdr agent rename <target> <name>` run from any terminal (target =
// pane id or live agent name), or the rename_pane keybinding inside herdr.
export function herdrReportAgent(label: string, state: "idle" | "working" | "blocked" | "unknown", source: string): void {
	const bin = process.env.HERDR_BIN_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !bin || !paneId) return; // not running under herdr — no-op
	try {
		execFile(bin, ["pane", "report-agent", paneId, "--source", source, "--agent", label, "--state", state], () => {
			// best-effort: a failure here (older herdr version, binary moved,
			// etc.) must never break the extension or the agent's turn.
		});
	} catch {
		// ignore — see above
	}
}

// Directly renames the pane label in herdr's sidebar/"new agent" list — the
// explicit, user-confirmed fallback (from herdr's own CLI help on their
// machine) for when herdrReportAgent()'s state-reporting protocol above
// doesn't change what's shown there (e.g. because that list is a saved
// launch-profile name, not live per-turn state — see docs/notes/development-notes.md
// Revisione 7/10). herdr exposes this as `herdr agent rename <pane_id>
// <name>` in some versions and `herdr pane rename <pane_id> <name>` in
// others; since I can't confirm which one exists on any given install from
// this sandbox, both are tried in order and the second only runs if the
// first fails (wrong-subcommand exit, not a real error) — so this stays a
// harmless no-op if herdr's actual CLI shape differs from both guesses.
// Same HERDR_ENV/HERDR_BIN_PATH/HERDR_PANE_ID no-op guard as
// herdrReportAgent(): does nothing outside herdr.
export function herdrRenamePane(name: string): void {
	const bin = process.env.HERDR_BIN_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !bin || !paneId) return; // not running under herdr — no-op
	try {
		execFile(bin, ["agent", "rename", paneId, name], (err) => {
			if (!err) return; // succeeded, no need to try the alternate subcommand
			try {
				execFile(bin, ["pane", "rename", paneId, name], () => {
					// best-effort — if this also fails, there's nothing more we can
					// safely guess at from here; the manual fallback (running either
					// command yourself, or the rename_pane keybinding) still works.
				});
			} catch {
				// ignore
			}
		});
	} catch {
		// ignore
	}
}

// La tab e il pane sono due entità distinte in Herdr. Il report-agent aggiorna
// lo stato dell'agente e il rename del pane aggiorna il titolo del terminale,
// ma la sidebar può mostrare ancora il label della tab. Recuperiamo quindi la
// tab proprietaria del pane corrente e la rinominiamo esplicitamente.
export function herdrRenameTab(name: string): void {
	const bin = process.env.HERDR_BIN_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	const explicitTabId = process.env.HERDR_TAB_ID;
	if (process.env.HERDR_ENV !== "1" || !bin || (!paneId && !explicitTabId)) return;
	const rename = (tabId: string) => {
		try {
			execFile(bin, ["tab", "rename", tabId, name], () => {
				// best-effort: the agent must continue even on older Herdr builds
				// where tab rename is not available.
			});
		} catch {
			// ignore
		}
	};
	if (explicitTabId) {
		rename(explicitTabId);
		return;
	}
	try {
		execFile(bin, ["pane", "get", paneId!], { encoding: "utf8" }, (err, stdout) => {
			if (err) return;
			try {
				const parsed = JSON.parse(stdout);
				const tabId = parsed?.result?.pane?.tab_id || parsed?.pane?.tab_id;
				if (typeof tabId === "string" && tabId) rename(tabId);
			} catch {
				// ignore malformed/legacy CLI output
			}
		});
	} catch {
		// ignore
	}
}

// paseo (https://paseo.sh) — client-daemon tool for managing agent
// sessions. NOTE (Revisione 23, see docs/notes/development-notes.md): confirmed in a
// real user test that `paseo run --provider <x> -- <text>` treats
// everything after `--provider` as a natural-language PROMPT for the
// agent, not literal argv to exec — there's no documented exec/shell
// subcommand. That means `paseo run` cannot be used to spawn a `pi -e
// extensions/orchestrator.ts --instance ... --role ...` process the way
// herdr can; prompts/planner.md no longer offers paseo as a launch option
// Herdr is the only supported launch supervisor — see "Selezione dinamica
// del team", punto 8. This detection stub is kept only for the
// case where a user runs an already-launched instance (started some other
// way) inside a paseo-managed pty by hand — PASEO_AGENT_ID (confirmed from
// paseo.sh/docs/cli + CHANGELOG.md, added v0.1.34) still gets set in that
// case, and it's harmless to log it if so.
//
// Honest limit, deliberately NOT worked around by guessing: unlike herdr,
// I found NO documented paseo command for a running process to report its
// own state or rename itself from the inside (herdrReportAgent()/
// herdrRenamePane()'s equivalent) — only higher-level commands run from
// OUTSIDE the process (`paseo workspace rename <id>`, `paseo project
// rename <id>`) that need an id this process has no confirmed way to
// obtain from its own env. Inventing a call here would repeat the exact
// mistake this project's own herdr integration was careful to avoid
// (fabricating a CLI surface never verified against a real binary) — so
// this stays a detection-only stub: it logs that we're running under
// paseo (useful for scripts/review-log.mjs) and is a safe no-op otherwise.
export function paseoDetectAndLog({ logEvent }: { logEvent: (event: string, data?: unknown) => void }): void {
	const agentId = process.env.PASEO_AGENT_ID;
	if (!agentId) return; // not running under paseo — no-op
	try {
		logEvent("paseo_detected", { paseo_agent_id: agentId });
	} catch {
		// ignore — logging must never break the extension
	}
}
