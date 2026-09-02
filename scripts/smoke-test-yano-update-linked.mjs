// A globally linked development checkout must never be handed to
// `npm install -g`: npm tries to rename the symlink and fails with ENOTDIR.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectGlobalLinkedInstall, removeLinkedGlobalInstall } from "./update.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-update-link-"));
const npmRoot = path.join(root, "node_modules");
const checkout = path.join(root, "checkout");
fs.mkdirSync(npmRoot, { recursive: true });
fs.mkdirSync(checkout, { recursive: true });
fs.symlinkSync(checkout, path.join(npmRoot, "yano-orchestrator"));

try {
	const linked = inspectGlobalLinkedInstall({ packageRoot: checkout, npmRoot });
	assert.equal(linked.linked, true, "npm link is detected as a symlink");
	assert.equal(linked.matches_running_package, true, "the symlink target is the running package checkout");
	assert.deepEqual(removeLinkedGlobalInstall({ linkedInstall: linked }), { removed: true, path: path.join(npmRoot, "yano-orchestrator"), package_name: "yano-orchestrator" }, "solo il symlink globale esatto viene rimosso");
	assert.equal(fs.existsSync(path.join(npmRoot, "yano-orchestrator")), false, "il link è stato rimosso prima della reinstallazione permanente");

	const normal = path.join(npmRoot, "normal-package");
	fs.mkdirSync(normal);
	const regular = inspectGlobalLinkedInstall({ packageRoot: checkout, packageName: "normal-package", npmRoot });
	assert.equal(regular.linked, false, "normal global installations continue using npm install");
	const transient = inspectGlobalLinkedInstall({ packageName: "normal-package", npmRoot });
	assert.equal(transient.matches_running_package, false, "il controllo post-install è sicuro anche senza packageRoot");
	console.log("smoke-test-yano-update-linked: ok");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
