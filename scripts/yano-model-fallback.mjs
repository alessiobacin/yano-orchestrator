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
