import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = fs.mkdtempSync(path.join(os.tmpdir(), "yano-mcp-preflight-"));
const mcpPath = path.join(target, ".mcp.json");
const original = { mcpServers: { stitch: { headers: { "X-Goog-Api-Key": "<YOUR_API_KEY>" } } } };
fs.writeFileSync(mcpPath, `${JSON.stringify(original, null, 2)}\n`);

const result = spawnSync(process.execPath, [path.join(root, "bin", "yano.mjs"), "init", "--name", "mcp-preflight", "--target", target, "--force"], {
	encoding: "utf8",
	input: "",
});
const output = `${result.stdout}\n${result.stderr}`;
if (result.status !== 1) throw new Error(`ASSERTION FAILED: missing MCP key must fail (status ${result.status})\n${output}`);
if (!/chiave MCP/.test(output) || !/nessun file di scaffold/.test(output)) throw new Error(`ASSERTION FAILED: actionable MCP credential diagnostic missing\n${output}`);
if (fs.existsSync(path.join(target, "package.json"))) throw new Error("ASSERTION FAILED: scaffold was written after MCP preflight failure");
if (JSON.parse(fs.readFileSync(mcpPath, "utf8")).mcpServers.stitch.headers["X-Goog-Api-Key"] !== "<YOUR_API_KEY>") throw new Error("ASSERTION FAILED: placeholder was modified in non-interactive mode");
console.log("OK — missing active MCP key blocks init without writing scaffold or mutating the placeholder");
console.log("MCP CREDENTIAL PREFLIGHT SMOKE TEST PASSED");
