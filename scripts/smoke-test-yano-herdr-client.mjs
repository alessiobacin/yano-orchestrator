// Real test for ticket #118
// (.scratch/optimize-orchestrator/issues/118-herdr-self-heal-unreachable.md):
// the shared herdrSnapshot() client must retry with backoff instead of
// giving up on the first flaky call, exactly the brittleness the ticket's
// evidence showed (every caller was a single un-retried spawnSync).

import assert from "node:assert/strict";
import { herdrSnapshot } from "./yano-herdr-client.mjs";

console.log("=== a snapshot that succeeds on the first try needs exactly one call ===");
{
	let calls = 0;
	const fakeRun = () => { calls++; return { status: 0, stdout: JSON.stringify({ result: { snapshot: { workspaces: [] } } }) }; };
	const result = herdrSnapshot({ run: fakeRun, attempts: 3, baseDelayMs: 1 });
	assert.deepEqual(result, { workspaces: [] });
	assert.equal(calls, 1, "a healthy first call must not be retried");
}
console.log("   OK");

console.log("\n=== a transient failure recovers within the same call via retry ===");
{
	let calls = 0;
	const fakeRun = () => {
		calls++;
		if (calls < 3) return { status: 1, stdout: "" };
		return { status: 0, stdout: JSON.stringify({ result: { snapshot: { workspaces: ["ok"] } } }) };
	};
	const result = herdrSnapshot({ run: fakeRun, attempts: 3, baseDelayMs: 5 });
	assert.deepEqual(result, { workspaces: ["ok"] });
	assert.equal(calls, 3, "must have retried exactly up to the successful attempt");
}
console.log("   OK — un fallimento transitorio (Herdr ancora in avvio) si risolve senza attendere il prossimo giro del cron");

console.log("\n=== a persistently unreachable Herdr returns null after exhausting attempts, never throws ===");
{
	let calls = 0;
	const fakeRun = () => { calls++; return { status: 1, stdout: "" }; };
	const result = herdrSnapshot({ run: fakeRun, attempts: 3, baseDelayMs: 1 });
	assert.equal(result, null);
	assert.equal(calls, 3, "must attempt exactly `attempts` times, not more, not less");
}
console.log("   OK — dopo tutti i tentativi restituisce null senza lanciare eccezioni (i chiamanti restano responsabili della degradazione)");

console.log("\n=== malformed JSON output is treated as a failed attempt and retried, not a crash ===");
{
	let calls = 0;
	const fakeRun = () => {
		calls++;
		if (calls === 1) return { status: 0, stdout: "not json" };
		return { status: 0, stdout: JSON.stringify({ result: { snapshot: { workspaces: [] } } }) };
	};
	const result = herdrSnapshot({ run: fakeRun, attempts: 3, baseDelayMs: 1 });
	assert.deepEqual(result, { workspaces: [] });
	assert.equal(calls, 2);
}
console.log("   OK — un output malformato viene trattato come un tentativo fallito, non come un crash");

console.log("\n=== attempts=1 behaves exactly like the old un-retried call (no behavior change for a single-shot caller) ===");
{
	let calls = 0;
	const fakeRun = () => { calls++; return { status: 1, stdout: "" }; };
	const result = herdrSnapshot({ run: fakeRun, attempts: 1 });
	assert.equal(result, null);
	assert.equal(calls, 1);
}
console.log("   OK");

console.log("\nsmoke-test-yano-herdr-client: ok");
