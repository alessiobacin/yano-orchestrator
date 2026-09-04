// Verifies that yano init performs its preflight before writing any scaffold
// files when a required executable is missing.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const target = fs.mkdtempSync(path.join(os.tmpdir(), "yano-init-preflight-"));
const result = spawnSync(node, [path.join(root, "bin", "yano.mjs"), "init", "--name", "preflight-failure", "--target", target], {
	encoding: "utf8",
	env: { ...process.env, PATH: "/usr/bin:/bin" },
});
const output = `${result.stdout}\n${result.stderr}`;
const checks = [
	[result.status === 1, "a missing required CLI makes yano init fail with exit code 1"],
	[/(preflight fallito|prerequisiti .*non installabili|Code Mem è un prerequisito obbligatorio)/.test(output), "failure explains that preflight blocked initialization"],
	[/nessun file (?:è stato scritto|di scaffold è stato scritto)/i.test(output), "failure explains that no files were written"],
	[fs.readdirSync(target).length === 0, "target remains empty after preflight failure"],
];
for (const [ok, message] of checks) {
	if (!ok) throw new Error(`ASSERTION FAILED: ${message}\n${output}`);
	console.log(`OK — ${message}`);
}
console.log("INIT PREFLIGHT SMOKE TEST PASSED");
