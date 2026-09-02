// Real test for ticket #120
// (.scratch/optimize-orchestrator/issues/120-docker-bundle-mqtt-yano-evaluation.md):
// deterministic Docker daemon restart, the concrete ask the user made
// regardless of the containerization question the same ticket also answers.
//
// Deterministic-logic assertions here use an injected `run` (fast, exact
// control over every branch); the module was ALSO verified against the real
// Docker CLI in this sandbox (see the ticket's "## Answer" for the session
// log: a genuinely-down daemon correctly detected and a restart genuinely
// attempted and honestly reported as failed with no systemd init available,
// then a real `dockerd` started by hand correctly detected as healthy with
// zero restart attempt).

import assert from "node:assert/strict";
import { isDockerDaemonRunning, dockerDaemonRestartCommand, ensureDockerDaemonRunning } from "./yano-docker-daemon.mjs";

console.log("=== dockerDaemonRestartCommand: one deterministic command per major OS ===");
assert.equal(dockerDaemonRestartCommand("darwin"), "open -a Docker");
assert.match(dockerDaemonRestartCommand("linux"), /systemctl start docker/);
assert.match(dockerDaemonRestartCommand("win32"), /Start-Service|Docker Desktop/);
assert.equal(dockerDaemonRestartCommand("some-unknown-platform"), dockerDaemonRestartCommand("linux"), "an unrecognized platform falls back to the Linux command rather than throwing");
console.log("   OK");

console.log("\n=== isDockerDaemonRunning reflects `docker info`'s real exit code ===");
{
	const okRun = () => ({ status: 0 });
	const failRun = () => ({ status: 1 });
	assert.equal(isDockerDaemonRunning({ run: okRun }), true);
	assert.equal(isDockerDaemonRunning({ run: failRun }), false);
}
console.log("   OK");

console.log("\n=== ensureDockerDaemonRunning: already healthy needs no restart attempt ===");
{
	let calls = 0;
	const run = () => { calls++; return { status: 0 }; };
	const result = ensureDockerDaemonRunning({ run, waitMs: 5000 });
	assert.equal(result.running, true);
	assert.equal(result.attempted_restart, false);
	assert.equal(calls, 1, "only the single health check, never a restart command, when already healthy");
}
console.log("   OK — un daemon già sano non viene mai toccato");

console.log("\n=== ensureDockerDaemonRunning: down, restart launches, daemon comes up within the poll window ===");
{
	let checks = 0;
	let restartLaunched = false;
	const run = (command, args) => {
		if (command === "docker") {
			checks++;
			// Healthy starting from the 3rd health check (2 polls after the
			// initial failing check + the restart attempt itself).
			return { status: checks >= 3 ? 0 : 1 };
		}
		restartLaunched = true;
		return { status: 0 };
	};
	const result = ensureDockerDaemonRunning({ run, waitMs: 5000, pollIntervalMs: 1 });
	assert.equal(result.running, true);
	assert.equal(result.attempted_restart, true);
	assert.ok(restartLaunched, "the platform restart command must actually be invoked");
	assert.ok(result.restart_command, "the exact command used must be reported back");
}
console.log("   OK — un daemon giù viene riavviato e il ritorno a sano entro la finestra di polling viene rilevato");

console.log("\n=== ensureDockerDaemonRunning: restart command itself fails to launch, honestly reported ===");
{
	const run = (command) => (command === "docker" ? { status: 1 } : { status: 127 });
	const result = ensureDockerDaemonRunning({ run, waitMs: 20, pollIntervalMs: 5 });
	assert.equal(result.running, false);
	assert.equal(result.attempted_restart, true);
	assert.equal(result.restart_launch_ok, false, "a restart command that itself fails to launch (e.g. no systemd init, ENOENT) must be reported honestly, not swallowed");
}
console.log("   OK — un comando di restart che fallisce a sua volta viene riportato onestamente, mai nascosto");

console.log("\n=== ensureDockerDaemonRunning: restart launches fine but the daemon never comes up -> bounded timeout, not an infinite wait ===");
{
	let checks = 0;
	const run = (command) => {
		if (command === "docker") { checks++; return { status: 1 }; }
		return { status: 0 };
	};
	const t0 = Date.now();
	const result = ensureDockerDaemonRunning({ run, waitMs: 60, pollIntervalMs: 15 });
	const elapsed = Date.now() - t0;
	assert.equal(result.running, false);
	assert.equal(result.attempted_restart, true);
	assert.equal(result.restart_launch_ok, true, "the restart command itself launched fine — it is the daemon that never became healthy");
	assert.ok(elapsed >= 60 && elapsed < 500, `must wait roughly the requested waitMs (60ms) and then give up, not hang — measured ${elapsed}ms`);
	assert.ok(checks >= 2, "must have polled more than once within the window");
}
console.log("   OK — se il comando di restart parte ma il daemon non torna mai sano, si arrende entro il timeout configurato invece di attendere all'infinito");

console.log("\nsmoke-test-yano-docker-daemon: ok");
