#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { browserOnlyWebhook, ensureAngularAgentationIntegration, inferFrontendDev, renderBrowserOnlyWrapper, resolveFrontendRoots, setup, wrapperProjectSlug } from "./yano-frontend-review.mjs";

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

const angular = fs.mkdtempSync(path.join(os.tmpdir(), "yano-frontend-angular-"));
fs.writeFileSync(path.join(angular, "package.json"), JSON.stringify({
	name: "angular-ui", dependencies: { "@angular/core": "^21.0.0" },
	scripts: { start: "ng serve --host 0.0.0.0 --port 4200" },
}, null, 2));
fs.writeFileSync(path.join(angular, "angular.json"), "{}\n");
const angularInferred = inferFrontendDev(angular);
assert.equal(angularInferred.framework, "angular");
assert.equal(angularInferred.agentation_supported, false, "Agentation React non deve essere installato in Angular");
assert.equal(angularInferred.review_mode, "browser-only");
assert.equal(angularInferred.port, 4200);
fs.mkdirSync(path.join(angular, "src"));
fs.writeFileSync(path.join(angular, "src", "main.ts"), "import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';\nimport { AppModule } from './app/app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule)\n  .catch(err => console.error(err));\n");
const angularIntegration = ensureAngularAgentationIntegration(angular);
assert.equal(angularIntegration.dev_only, true);
assert.match(fs.readFileSync(path.join(angular, "src", "main.ts"), "utf8"), /isDevMode\(\)/);
const angularHost = fs.readFileSync(path.join(angular, "src", "yano-agentation-host.ts"), "utf8");
assert.match(angularHost, /Agentation/);
assert.match(angularHost, /createElement<AgentationProps>\(Agentation/);
assert.doesNotMatch(angularHost, /Agentation\(\{ endpoint/);
fs.writeFileSync(path.join(angular, "src", "yano-agentation-host.ts"), angularHost.replace(/createElement<AgentationProps>\(Agentation, \{ endpoint: "http:\/\/localhost:4747" \}\)/, "Agentation({ endpoint: \"http://localhost:4747\" })"));
ensureAngularAgentationIntegration(angular);
assert.match(fs.readFileSync(path.join(angular, "src", "yano-agentation-host.ts"), "utf8"), /createElement<AgentationProps>\(Agentation/);
// Fixture deterministiche non-Node in tmp dir: solo resolve/infer + contratto
// print-only. Nessuna rete, nessuna porta occupata, nessuno start() di processi.
const streamlit = fs.mkdtempSync(path.join(os.tmpdir(), "yano-frontend-streamlit-"));
fs.writeFileSync(path.join(streamlit, "streamlit_app.py"), "import streamlit as st\nst.title('demo')\n");
const streamlitInferred = inferFrontendDev(streamlit);
assert.equal(streamlitInferred.framework, "streamlit");
assert.equal(streamlitInferred.review_mode, "browser-only");
assert.equal(streamlitInferred.agentation_supported, false);
assert.equal(streamlitInferred.port, 8501, "default Streamlit 8501");
assert.equal(streamlitInferred.url, "http://localhost:8501");
assert.match(streamlitInferred.command, /streamlit run streamlit_app\.py/);
assert.deepEqual(resolveFrontendRoots(streamlit), { projectRoot: streamlit, frontendRoot: streamlit });

const streamlitPort = fs.mkdtempSync(path.join(os.tmpdir(), "yano-frontend-streamlit-port-"));
fs.writeFileSync(path.join(streamlitPort, "app.py"), "import streamlit as st\nst.write('x')\n");
fs.mkdirSync(path.join(streamlitPort, ".streamlit"));
fs.writeFileSync(path.join(streamlitPort, ".streamlit", "config.toml"), "[server]\nport = 9999\n");
assert.equal(inferFrontendDev(streamlitPort).port, 9999, "override porta da .streamlit/config.toml");

const python = fs.mkdtempSync(path.join(os.tmpdir(), "yano-frontend-python-"));
fs.writeFileSync(path.join(python, "app.py"), "from flask import Flask\napp = Flask(__name__)\n");
const pythonInferred = inferFrontendDev(python);
assert.equal(pythonInferred.framework, "python");
assert.equal(pythonInferred.review_mode, "browser-only");
assert.equal(pythonInferred.port, 8000);
assert.equal(pythonInferred.url, "http://localhost:8000");

const statix = fs.mkdtempSync(path.join(os.tmpdir(), "yano-frontend-static-"));
fs.writeFileSync(path.join(statix, "index.html"), "<!doctype html><html></html>\n");
const staticInferred = inferFrontendDev(statix);
assert.equal(staticInferred.framework, "static");
assert.equal(staticInferred.review_mode, "browser-only");
assert.equal(staticInferred.port, 8080);

// Contratto print-only: nessun install, nessun processo, sorgente intoccato.
const streamlitContract = await setup(streamlit, { printOnly: true });
assert.equal(streamlitContract.dry_run, true);
assert.equal(streamlitContract.review_mode, "browser-only");
assert.equal(streamlitContract.installed, false);
assert.equal(streamlitContract.package_changed, false);
assert.equal(streamlitContract.source_touched, false);
assert.match(streamlitContract.webhook_url, /^http:\/\/127\.0\.0\.1:11000\/api\/agentation\//);
const before = fs.readFileSync(path.join(streamlit, "streamlit_app.py"), "utf8");
const liveContract = await setup(streamlit);
assert.equal(fs.readFileSync(path.join(streamlit, "streamlit_app.py"), "utf8"), before, "setup browser-only non tocca il sorgente");
assert.equal(liveContract.source_touched, false);
assert.equal(liveContract.package_changed, false);
const reactContract = await setup(root, { printOnly: true });
assert.equal(reactContract.dry_run, true);
assert.equal(reactContract.review_mode, "agentation");
assert.equal(reactContract.installed, false, "print-only non installa");

// Wrapper browser-only: pagina servita da Yano, sorgente target intoccato.
const webhook = browserOnlyWebhook(streamlit);
assert.match(webhook, /^http:\/\/127\.0\.0\.1:11000\/api\/agentation\//);
assert.equal(streamlitContract.webhook_url, webhook);
assert.equal(streamlitContract.wrapper_path, `/${wrapperProjectSlug(streamlit)}/__yano-review`);
assert.match(streamlitContract.wrapper_command, /yano frontend-dash start/);
const page = renderBrowserOnlyWrapper({ projectId: wrapperProjectSlug(streamlit), webhookUrl: webhook, framework: "streamlit", targetUrl: streamlitInferred.url });
assert.match(page, /<iframe[^>]*yano-target/);
assert.match(page, new RegExp(webhook.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(page, /<script src=/);
assert.equal(wrapperProjectSlug("/tmp/Mio Progetto_1"), "mio-progetto-1");
// Il JS inline del wrapper non è visibile a `node --check` del .mjs:
// estrazione + syntax-check esplicito contro regressioni (es. riga 300).
const inlineJs = page.split("<script>")[1].split(`</${"script"}>`)[0];
const inlineCheckFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yano-wrapper-js-")), "wrapper-inline.js");
fs.writeFileSync(inlineCheckFile, inlineJs);
new (await import("node:child_process")).execFileSync(process.execPath, ["--check", inlineCheckFile], { stdio: "pipe" });

// Fixture storica non garantita nel worktree: `.mcp.json.example` è untracked
// nel checkout main (debito baseline, non di questo task). Skip non fatale.
const mcpExamplePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".mcp.json.example");
if (fs.existsSync(mcpExamplePath)) {
	const template = JSON.parse(fs.readFileSync(mcpExamplePath, "utf8"));
	assert.deepEqual(template.mcpServers.agentation, { command: "npx", args: ["-y", "agentation-mcp", "server"] });
} else {
	console.warn("SKIP assert .mcp.json.example: file assente nel worktree (debito baseline, vedi report)");
}
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
