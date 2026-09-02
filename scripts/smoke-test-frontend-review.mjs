#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { inferFrontendDev } from "./yano-frontend-review.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-agentation-"));
fs.mkdirSync(path.join(root, "src"));
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
	name: "demo-ui", dependencies: { react: "^18.0.0" }, scripts: { dev: "vite --host 0.0.0.0" },
}, null, 2));
const inferred = inferFrontendDev(root);
assert.equal(inferred.script, "dev");
assert.equal(inferred.port, 5173);
assert.equal(inferred.framework, "react");
assert.equal(inferred.agentation_supported, true);
assert.equal(inferred.url, "http://localhost:5173");
const template = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp.json.example"), "utf8"));
assert.deepEqual(template.mcpServers.agentation, { command: "npx", args: ["-y", "agentation-mcp", "server"] });
const roles = YAML.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents", "roles.yaml"), "utf8")).roles;
assert.deepEqual(roles.planner.mcp, ["github", "agentation"]);
assert.deepEqual(roles["frontend-developer"].mcp, ["chrome-devtools"]);
assert.deepEqual(roles["frontend-reviewer"].mcp, ["chrome-devtools"]);
console.log("FRONTEND REVIEW SMOKE TEST PASSED");
