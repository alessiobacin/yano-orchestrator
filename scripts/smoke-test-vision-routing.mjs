import assert from "node:assert/strict";
import { hasImageInput, llmProxyAutoModel, switchImageTurnToAuto } from "./yano-vision-routing.mjs";

assert.equal(hasImageInput({ images: [{ type: "image", data: "..." }] }), true, "Pi image attachments are detected");
assert.equal(hasImageInput({ images: [] }), false, "text-only turns are not rerouted");
assert.equal(hasImageInput({ message: { content: [{ type: "input_image" }] } }), true, "serialized input_image blocks are detected");
assert.equal(hasImageInput({ message: { content: [{ type: "text", text: "screenshot.png" }] } }), false, "image-looking text is not treated as an attachment");

const autoModel = { provider: "llmproxy", id: "llmproxy" };
assert.equal(
	llmProxyAutoModel({ modelRegistry: { find: (provider, model) => provider === "llmproxy" && model === "llmproxy" ? autoModel : null } }),
	autoModel,
	"vision routing resolves llmProxy auto rather than a pinned provider/model",
);
assert.equal(llmProxyAutoModel({ modelRegistry: { find: () => null } }), null, "routing reports unavailable auto model");

let selected = null;
const events = [];
const switched = await switchImageTurnToAuto({
	event: { images: [{ type: "image" }] },
	ctx: { modelRegistry: { find: () => autoModel }, model: { provider: "llmproxy", id: "text-only-pin" } },
	setModel: async (model) => { selected = model; return true; },
	log: (type, data) => events.push({ type, data }),
});
assert.equal(switched.switched, true, "an image turn switches the live Pi session");
assert.equal(selected, autoModel, "the live session receives llmproxy auto");
assert.equal(events[0].type, "vision_model_switched", "the switch is logged");

console.log("Vision routing smoke test passed.");
