import assert from "node:assert/strict";
import { runNeedsPlanner } from "./yano-watcher-registry.mjs";

assert.equal(runNeedsPlanner({ status: "active", finalization_status: "not_started" }), true);
assert.equal(runNeedsPlanner({ status: "completed", finalization_status: "pending_finalize" }), false);
assert.equal(runNeedsPlanner({ status: "completed", finalization_status: "finalized" }), false);

console.log("smoke-test-completed-run-supervision: ok");
