import assert from "node:assert/strict";
import { autoPauseOrResume } from "./yano-scheduler.mjs";

const store = { supervisor: { connectivity: { state: "online", auto_paused_projects: [], tracked_projects: [] } } };
const inventory = { herdr_reachable: true, projects: [{ name: "demo", root: "/tmp/demo" }, { name: "yano-local-pc", root: "/tmp/local" }] };
const calls = [];
const recovery = async ({ cwd, argv }) => calls.push({ cwd, action: argv[0], project: argv.at(-1) });

const offline = await autoPauseOrResume({
	store, now: new Date("2026-09-03T18:00:00Z"), connectivity: { online: false, checked_at: "2026-09-03T18:00:00Z" },
	inventoryProvider: () => inventory, recovery,
});
assert.equal(offline.current, "offline");
assert.deepEqual(calls, [{ cwd: "/tmp/demo", action: "pause", project: "demo" }]);
assert.equal(store.supervisor.connectivity.auto_paused_projects.length, 1);

const online = await autoPauseOrResume({
	store, now: new Date("2026-09-03T18:01:00Z"), connectivity: { online: true, checked_at: "2026-09-03T18:01:00Z" },
	inventoryProvider: () => inventory, recovery,
});
assert.equal(online.current, "online");
assert.deepEqual(calls, [
		{ cwd: "/tmp/demo", action: "pause", project: "demo" },
		{ cwd: "/tmp/demo", action: "resume", project: "demo" },
]);
assert.equal(store.supervisor.connectivity.auto_paused_projects.length, 0);

console.log("connectivity supervision smoke test: ok");
