#!/usr/bin/env node

// Verifica dell'inizializzazione esplicita del DB orchestrator usato da Gantt.
// Il test dimostra che si crea solo il layer Yano e che una seconda riparazione
// è idempotente e non riscrive il file applicativo.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ensureProjectDatabase } from "../scripts/yano-project-db.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-project-db-"));
const projectRoot = path.join(root, "existing-app");
fs.mkdirSync(projectRoot, { recursive: true });
const packageFile = path.join(projectRoot, "package.json");
fs.writeFileSync(packageFile, JSON.stringify({ name: "existing-app", scripts: { test: "node test.js" } }) + "\n");
const before = fs.readFileSync(packageFile, "utf8");
const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const first = ensureProjectDatabase({ projectRoot, project: "existing-app", packageRoot });
assert.equal(first.created, true);
assert.equal(first.schema_version, 11);
assert.ok(fs.existsSync(first.path));

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const db = new DatabaseSync(first.path, { readOnly: true });
for (const table of ["schema_meta", "runs", "specs", "tickets", "events", "playbook_bindings"]) {
	assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `tabella ${table} presente`);
}
assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, "11");
db.close();

const second = ensureProjectDatabase({ projectRoot, project: "existing-app", packageRoot });
assert.equal(second.created, false);
assert.equal(second.path, first.path);
assert.equal(fs.readFileSync(packageFile, "utf8"), before);
console.log("smoke-test-yano-project-db: OK (schema orchestrator completo, idempotenza, progetto preservato)");
