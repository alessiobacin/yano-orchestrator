// A globally linked development checkout must never be handed to
// `npm install -g`: npm tries to rename the symlink and fails with ENOTDIR.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPermanentGlobalInstall, inspectGlobalLinkedInstall, removeLinkedGlobalInstall } from "./update.mjs";

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
	fs.writeFileSync(path.join(normal, "package.json"), JSON.stringify({ name: "normal-package", version: "1.0.0" }));
	const regular = inspectGlobalLinkedInstall({ packageRoot: checkout, packageName: "normal-package", npmRoot });
	assert.equal(regular.linked, false, "normal global installations continue using npm install");
	assert.equal(assertPermanentGlobalInstall({ packageName: "normal-package", npmRoot }).path, normal, "la verifica accetta solo una copia globale reale");
	const transient = inspectGlobalLinkedInstall({ packageName: "normal-package", npmRoot });
	assert.equal(transient.matches_running_package, false, "il controllo post-install è sicuro anche senza packageRoot");

	const badLink = path.join(npmRoot, "linked-again");
	fs.symlinkSync(checkout, badLink);
	assert.throws(
		() => assertPermanentGlobalInstall({ packageName: "linked-again", npmRoot }),
		/ancora collegata tramite symlink/,
		"la verifica deve rifiutare un link rimasto dopo l'update",
	);
	console.log("smoke-test-yano-update-linked: ok");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
