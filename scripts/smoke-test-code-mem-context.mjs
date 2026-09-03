import assert from "node:assert/strict";
import path from "node:path";
import { collectCodeMemContext } from "./yano-code-mem-context.mjs";

const root = path.resolve(import.meta.dirname, "..");
const result = collectCodeMemContext({ root, query: "planner project memory graph" });
assert.ok(result && typeof result.context === "string", "Code Mem context must always return a bounded result object");
assert.ok(result.context.length <= 6000, "orientation pack must stay within the token-saving bound");
assert.equal(result.query, "planner project memory graph");
const unavailable = collectCodeMemContext({ root: path.join(root, ".missing-code-mem-project"), query: "anything" });
assert.ok(unavailable && typeof unavailable.context === "string", "missing Code Mem must never block agent startup");
console.log(`smoke-test-code-mem-context: ok (${result.ok ? "available" : "graceful fallback"})`);
