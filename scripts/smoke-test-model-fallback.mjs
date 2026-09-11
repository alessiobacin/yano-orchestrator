import assert from "node:assert/strict";
import { getModelFallbackState, isProviderFailure, recoverUnavailableRestoredModel, switchPinnedModelToAuto } from "./yano-model-fallback.mjs";

const restoreEvents = [];
const restoreAuto = { provider: "llmproxy", id: "llmproxy" };
const restoreResult = await recoverUnavailableRestoredModel({
	persistedModel: { provider: "llmproxy", modelId: "z-ai/glm-5.3-flash@openrouter-glm" },
	activeModel: { provider: "llmproxy", id: "llmproxy" },
	restoredModelAvailable: false,
	autoModel: restoreAuto,
	setModel: async () => { throw new Error("must not replace an already-auto model"); },
	log: (type, data) => restoreEvents.push({ type, data }),
});
assert.deepEqual(restoreResult, { handled: true, switched: false, reason: "already_auto" });
assert.equal(restoreEvents[0].type, "model_restore_fallback");
assert.equal(restoreEvents[0].data.from, "llmproxy/z-ai/glm-5.3-flash@openrouter-glm");

let restoredSelection;
const forcedRestore = await recoverUnavailableRestoredModel({
	persistedModel: { provider: "llmproxy", modelId: "z-ai/glm-5.3-flash@openrouter-glm" },
	activeModel: { provider: "llmproxy", id: "some-default" },
	restoredModelAvailable: false,
	autoModel: restoreAuto,
	setModel: async (model) => { restoredSelection = model; return true; },
	log: (type, data) => restoreEvents.push({ type, data }),
});
assert.equal(forcedRestore.switched, true);
assert.equal(restoredSelection, restoreAuto);
assert.equal(restoreEvents.at(-1).type, "model_restore_fallback");

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
