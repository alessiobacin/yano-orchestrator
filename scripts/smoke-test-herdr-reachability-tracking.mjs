// Regression test for Fase 5 (reboot/crash resilience visibility): before
// this, "Herdr unreachable for the whole one-minute supervise() pass" left
// no persisted signal anywhere — every pass after a machine restart where
// Herdr never came back up would silently do nothing, forever, with no way
// for an operator (or the Fase 9 daily digest) to notice. trackHerdrReachability()
// persists a simple consecutive-failure streak across passes.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-herdr-reachability-"));
process.env.YANO_DATA_DIR = root;
process.env.YANO_CONFIG_FILE = path.join(root, "no-such-config.env");

const { trackHerdrReachability, herdrReachabilityPath } = await import("./yano-watcher-registry.mjs");

console.log("Fase 5: Herdr reachability streak tracking");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

check("a fresh install starts with no streak", () => {
	assert.ok(!fs.existsSync(herdrReachabilityPath()), "no state file exists yet");
});

check("Herdr reachable resets/keeps the streak at zero", () => {
	const state = trackHerdrReachability(true);
	assert.equal(state.unreachable_streak, 0);
	assert.equal(state.unreachable_since, null);
});

check("consecutive unreachable passes increment the streak and remember when it started", () => {
	const first = trackHerdrReachability(false);
	assert.equal(first.unreachable_streak, 1);
	assert.ok(first.unreachable_since, "unreachable_since is stamped on the first failure");
	const since = first.unreachable_since;
	const second = trackHerdrReachability(false);
	assert.equal(second.unreachable_streak, 2);
	assert.equal(second.unreachable_since, since, "unreachable_since does not move while the streak continues");
	const third = trackHerdrReachability(false);
	assert.equal(third.unreachable_streak, 3);
});

check("Herdr becoming reachable again resets the streak to zero", () => {
	const recovered = trackHerdrReachability(true);
	assert.equal(recovered.unreachable_streak, 0);
	assert.equal(recovered.unreachable_since, null, "unreachable_since is cleared on recovery");
});

check("the streak survives a fresh process (persisted to disk, not in-memory only)", () => {
	trackHerdrReachability(false);
	trackHerdrReachability(false);
	const persisted = JSON.parse(fs.readFileSync(herdrReachabilityPath(), "utf8"));
	assert.equal(persisted.unreachable_streak, 2, "a brand new read of the state file reflects the persisted streak");
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nsmoke-test-herdr-reachability-tracking: ${passed} passed`);
