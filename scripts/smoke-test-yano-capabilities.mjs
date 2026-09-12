import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCapabilities, readCapabilities, writeCapabilities } from "./yano-capabilities.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-capabilities-"));
fs.mkdirSync(path.join(root, "src", "app"), { recursive: true });
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "next dev" } }));

const detected = detectCapabilities(root);
assert.equal(detected.components.frontend.present, true);
assert.equal(detected.components.backend.present, false);
assert.equal(detected.components.frontend.source, "detector");

const manifest = writeCapabilities(root, {
	...detected,
	components: {
		frontend: { ...detected.components.frontend, url: "http://localhost:3014", source: "planner", confidence: "confirmed" },
		backend: { present: false, source: "planner", confidence: "confirmed" },
	},
});
assert.equal(fs.existsSync(manifest.path), true);
assert.deepEqual(readCapabilities(root).components, manifest.data.components);
assert.equal(fs.readdirSync(path.dirname(manifest.path)).some((name) => name.includes(".tmp")), false);
console.log("smoke-test-yano-capabilities: OK (manifest canonico, rilevamento e scrittura atomica)");
