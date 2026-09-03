import assert from "node:assert/strict";
import { getModelFallbackState, isProviderFailure, switchPinnedModelToAuto } from "./yano-model-fallback.mjs";

assert.equal(isProviderFailure("402 insufficient credit"), true);
assert.equal(isProviderFailure("429 rate limit exceeded"), true);
assert.equal(isProviderFailure("validation failed: field is required"), false);

const auto = { provider: "llmproxy", id: "llmproxy" };
const ctx = { model: { provider: "llmproxy", id: "deepseek-v4@opencode-bacin" } };
const events = [];
let selected = ctx.model;
let resumes = 0;
const args = {
	message: { role: "assistant", errorMessage: "402 insufficient credit" }, ctx, autoModel: auto,
	setModel: async (model) => { selected = model; ctx.model = model; return true; },
	resume: async () => { resumes += 1; }, log: (type, data) => events.push({ type, data }),
};
const switched = await switchPinnedModelToAuto(args);
assert.equal(switched.switched, true);
assert.equal(switched.resumed, true);
assert.equal(selected, auto);
assert.equal(resumes, 1);
assert.equal(events[0].type, "model_runtime_fallback");
assert.equal(getModelFallbackState(ctx).retry_started, true);

const second = await switchPinnedModelToAuto(args);
assert.equal(second.reason, "not_provider_failure_or_already_auto", "auto routing never retries itself through this fallback");
assert.equal(resumes, 1);
console.log("Model fallback smoke test passed.");
