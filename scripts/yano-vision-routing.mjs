/**
 * Deterministic image-input routing shared by the Yano Pi extension and tests.
 * An image-bearing turn must use llmProxy's automatic model so the gateway can
 * select a vision-capable provider, even when the session started pinned to a
 * non-vision model.
 */

export function hasImageInput(event) {
	if (Array.isArray(event?.images) && event.images.length > 0) return true;
	const content = event?.message?.content ?? event?.prompt?.content;
	if (!Array.isArray(content)) return false;
	return content.some((part) => part && (part.type === "image" || part.type === "input_image"));
}

export function llmProxyAutoModel(ctx) {
	return ctx?.modelRegistry?.find?.("llmproxy", "llmproxy") ?? null;
}

export async function switchImageTurnToAuto({ event, ctx, setModel, log }) {
	if (!hasImageInput(event)) return { handled: false, switched: false };
	const autoModel = llmProxyAutoModel(ctx);
	if (!autoModel) {
		log("vision_model_switch_failed", { reason: "llmproxy_auto_model_unavailable", requested: "llmproxy/llmproxy" });
		return { handled: true, switched: false, reason: "llmproxy_auto_model_unavailable" };
	}
	try {
		const switched = await setModel(autoModel);
		log(switched ? "vision_model_switched" : "vision_model_switch_failed", {
			from: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			to: "llmproxy/llmproxy",
			reason: switched ? "image_input" : "model_auth_unavailable",
		});
		return { handled: true, switched, reason: switched ? "image_input" : "model_auth_unavailable" };
	} catch (error) {
		log("vision_model_switch_failed", { reason: "set_model_error", requested: "llmproxy/llmproxy", error: error instanceof Error ? error.message : String(error) });
		return { handled: true, switched: false, reason: "set_model_error" };
	}
}
