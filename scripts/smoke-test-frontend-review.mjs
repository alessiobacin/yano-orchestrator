#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { inferFrontendDev, resolveFrontendRoots } from "./yano-frontend-review.mjs";

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

const monorepo = fs.mkdtempSync(path.join(os.tmpdir(), "yano-frontend-monorepo-"));
fs.writeFileSync(path.join(monorepo, "package.json"), JSON.stringify({ name: "miodoc", scripts: {} }));
fs.mkdirSync(path.join(monorepo, "webapp"), { recursive: true });
fs.writeFileSync(path.join(monorepo, "webapp", "package.json"), JSON.stringify({ name: "webapp", scripts: { start: "ng serve --port 4200" } }));
const nested = inferFrontendDev(monorepo);
assert.equal(nested.project_root, monorepo, "la root applicativa resta quella del monorepo");
assert.equal(nested.frontend_root, path.join(monorepo, "webapp"), "il frontend viene cercato nei sotto-progetti webapp/client/frontend");
assert.equal(inferFrontendDev(path.join(monorepo, "webapp")).project_root, monorepo, "lanciando dal frontend viene mantenuta la root del progetto");
assert.deepEqual(resolveFrontendRoots(monorepo), { projectRoot: monorepo, frontendRoot: path.join(monorepo, "webapp") });
const template = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp.json.example"), "utf8"));
assert.deepEqual(template.mcpServers.agentation, { command: "npx", args: ["-y", "agentation-mcp", "server"] });
const roles = YAML.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents", "roles.yaml"), "utf8")).roles;
assert.deepEqual(roles.planner.mcp, ["github", "agentation"]);
assert.deepEqual(roles["frontend-developer"].mcp, ["chrome-devtools"]);
assert.deepEqual(roles["frontend-reviewer"].mcp, ["chrome-devtools"]);
assert.equal(roles["e2e-simulator"].playbook, "frontend-browser");
const frontendPlaybook = YAML.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "playbooks", "frontend-browser.yaml"), "utf8"));
assert.ok(frontendPlaybook.states.some((state) => state.id === "e2e_verification"));
assert.ok(frontendPlaybook.invariants.includes("ui_affecting_tasks_require_e2e_or_explicit_skip_reason"));
assert.ok(frontendPlaybook.invariants.includes("agentation_review_is_offered_before_frontend_finalize"));
const backendPlaybook = YAML.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "playbooks", "backend-change.yaml"), "utf8"));
assert.ok(backendPlaybook.contract.conditional_gates.some((gate) => gate.id === "frontend_impact"));
assert.ok(backendPlaybook.invariants.includes("frontend_impact_requires_frontend_flow_and_e2e_or_explicit_skip_reason"));
const plannerPrompt = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "planner.md"), "utf8");
assert.match(plannerPrompt, /screenshot o altra immagine/);
assert.match(plannerPrompt, /e2e-simulator/);
assert.match(plannerPrompt, /yano frontend-review start/);
assert.match(plannerPrompt, /Vuoi fare\s+una review visuale dell'app in sviluppo con Agentation/);
console.log("FRONTEND REVIEW SMOKE TEST PASSED");
