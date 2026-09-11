// Runtime fallback for pinned llmProxy models. Keep this narrow: application
// and tool errors must remain visible and must not trigger a model switch.
const fallbackState = new WeakMap();
const PROVIDER_FAILURE = /(?:\b(?:401|402|403|408|409|429|5\d\d)\b|credit|credito|quota|rate.?limit|insufficient|exhausted|overload|unavailable|temporarily|provider|gateway|upstream|timeout)/i;

export function isProviderFailure(message) {
	return Boolean(String(message || "").trim()) && PROVIDER_FAILURE.test(String(message));
}

export function isAutoModel(model) {
	return Boolean(model && model.provider === "llmproxy" && (model.id === "llmproxy" || model.model === "llmproxy"));
}

export function getModelFallbackState(ctx) {
	return ctx && typeof ctx === "object" ? fallbackState.get(ctx) || null : null;
}

// Pi resolves a persisted session model before emitting session_start. When
// that model disappeared (or lost provider auth), Pi silently selects the
// configured default and only shows a UI warning. Keep Yano's control plane
// aware of that transition and make the auto route explicit when Pi selected
// something other than it.
export async function recoverUnavailableRestoredModel({ persistedModel, activeModel, restoredModelAvailable, autoModel, setModel, log }) {
	if (!persistedModel || restoredModelAvailable || !autoModel) {
		return { handled: false, switched: false, reason: "restored_model_available_or_no_auto" };
	}
	const from = `${persistedModel.provider || "?"}/${persistedModel.modelId || persistedModel.id || "?"}`;
	const activeIsAuto = isAutoModel(activeModel);
	if (activeIsAuto) {
		log?.("model_restore_fallback", { from, to: "llmproxy/llmproxy", reason: "persisted_model_unavailable", switched: false });
		return { handled: true, switched: false, reason: "already_auto" };
	}
	try {
		const switched = await setModel(autoModel);
		if (!switched) {
			log?.("model_restore_fallback_failed", { from, requested: "llmproxy/llmproxy", reason: "set_model_rejected" });
			return { handled: true, switched: false, reason: "set_model_rejected" };
		}
		log?.("model_restore_fallback", { from, to: "llmproxy/llmproxy", reason: "persisted_model_unavailable", switched: true });
		return { handled: true, switched: true, reason: "persisted_model_unavailable" };
	} catch (error) {
		log?.("model_restore_fallback_failed", { from, requested: "llmproxy/llmproxy", reason: "set_model_error", error: error instanceof Error ? error.message : String(error) });
		return { handled: true, switched: false, reason: "set_model_error" };
	}
}

export async function switchPinnedModelToAuto({ message, ctx, autoModel, setModel, resume, log }) {
	const errorMessage = message?.errorMessage;
	if (message?.role !== "assistant" || !isProviderFailure(errorMessage) || !ctx || !autoModel || isAutoModel(ctx.model)) {
		return { handled: false, switched: false, reason: "not_provider_failure_or_already_auto" };
	}
	const previous = fallbackState.get(ctx);
	if (previous?.retry_started) return { handled: true, switched: false, resumed: false, reason: "already_retried" };
	const state = { original: { ...ctx.model }, retry_started: false };
	fallbackState.set(ctx, state);
	try {
		const switched = await setModel(autoModel);
		if (!switched) {
			fallbackState.delete(ctx);
			log?.("model_runtime_fallback_failed", { reason: "set_model_rejected", requested: "llmproxy/llmproxy", error_preview: String(errorMessage).slice(0, 240) });
			return { handled: true, switched: false, reason: "set_model_rejected" };
		}
		state.retry_started = true;
		log?.("model_runtime_fallback", { from: `${state.original.provider || "?"}/${state.original.id || state.original.model || "?"}`, to: "llmproxy/llmproxy", reason: "provider_credit_or_runtime_failure", error_preview: String(errorMessage).slice(0, 240) });
		await resume?.();
		return { handled: true, switched: true, resumed: true, reason: "provider_failure" };
	} catch (error) {
		fallbackState.delete(ctx);
		log?.("model_runtime_fallback_failed", { reason: "runtime_error", requested: "llmproxy/llmproxy", error: error instanceof Error ? error.message : String(error) });
		return { handled: true, switched: false, reason: "runtime_error" };
	}
}
