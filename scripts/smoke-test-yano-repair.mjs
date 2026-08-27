#!/usr/bin/env node

// E2E bounded del comando repair: usa un progetto e un Herdr fake, non tocca
// l'ambiente reale e dimostra il caso osservato con uno scope MQTT obsoleto.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-repair-"));
const projectRoot = path.join(root, "repair-demo");
const fakeBin = path.join(root, "bin");
const dataDir = path.join(root, "temp");
fs.mkdirSync(path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "config"), { recursive: true });
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "repair-demo" }) + "\n");
fs.writeFileSync(path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "config", "project.json"), JSON.stringify({ project: "repair-demo" }) + "\n");
const snapshot = {
	result: {
		snapshot: {
			agents: [
				{ agent: "pi", name: "planner-01", agent_status: "idle", cwd: projectRoot, pane_id: "wH:p2", tab_id: "wH:t2", workspace_id: "wH", terminal_title_stripped: "planner-01" },
				{ agent: "pi", name: "architect-prop-20260825120256-b6eddd56", agent_status: "idle", cwd: projectRoot, pane_id: "wM:p3", tab_id: "wM:t3", workspace_id: "wM", terminal_title_stripped: "architect-prop-20260825120256-b6eddd56" },
				{ agent: "pi", name: "yano-watcher-repair-old", agent_status: "idle", cwd: projectRoot, pane_id: "wN:p5", tab_id: "wN:t5", workspace_id: "wN", terminal_title_stripped: "yano-watcher-repair-old" },
			],
			panes: [
				{ agent: "pi", name: "planner-01", agent_status: "idle", cwd: projectRoot, pane_id: "wH:p2", tab_id: "wH:t2", workspace_id: "wH", terminal_title_stripped: "planner-01" },
				{ agent: "pi", name: "architect-prop-20260825120256-b6eddd56", agent_status: "idle", cwd: projectRoot, pane_id: "wM:p3", tab_id: "wM:t3", workspace_id: "wM", terminal_title_stripped: "architect-prop-20260825120256-b6eddd56" },
				{ agent: "pi", name: "yano-watcher-repair-old", agent_status: "idle", cwd: projectRoot, pane_id: "wN:p5", tab_id: "wN:t5", workspace_id: "wN", terminal_title_stripped: "yano-watcher-repair-old" },
			],
			tabs: [
				{ tab_id: "wM:t3", label: "architect-repair-old" },
				{ tab_id: "wN:t5", label: "watcher-repair-old" },
			],
			workspaces: [{ workspace_id: "wH", label: "repair-demo" }],
		},
	},
};
fs.writeFileSync(path.join(fakeBin, "herdr"), [
	"#!/usr/bin/env node",
	"if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }",
	"if (process.argv[2] === 'api' && process.argv[3] === 'snapshot') { console.log(" + JSON.stringify(JSON.stringify(snapshot)) + "); process.exit(0); }",
	"process.exit(0);",
].join("\n") + "\n", { mode: 0o755 });
fs.chmodSync(path.join(fakeBin, "herdr"), 0o755);
fs.writeFileSync(path.join(fakeBin, "yano"), [
	"#!/usr/bin/env node",
	"if (process.argv.includes('--version')) { console.log('1.4.7-test'); process.exit(0); }",
	"if (process.argv[2] === 'update' && process.argv.includes('--check')) { console.log('yano update: il pacchetto npm sembra già aggiornato.'); process.exit(0); }",
	"process.exit(0);",
].join("\n") + "\n", { mode: 0o755 });
fs.chmodSync(path.join(fakeBin, "yano"), 0o755);

process.env.YANO_DATA_DIR = dataDir;
process.env.PATH = fakeBin + path.delimiter + process.env.PATH;
const { runRepair } = await import("../scripts/yano-repair.mjs");
const plan = await runRepair({ cwd: projectRoot, argv: ["--dry-run"] });

assert.equal(plan.dry_run, true);
assert.equal(plan.project.name, "repair-demo");
assert.deepEqual(plan.aliases, ["repair-demo", "repair-old"]);
assert.deepEqual(plan.herdr.panes.map((pane) => pane.instance), [
	"planner-01",
	"architect-prop-20260825120256-b6eddd56",
	"yano-watcher-repair-old",
]);
assert.equal(plan.database.exists, false);
assert.equal(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"), "{\"name\":\"repair-demo\"}\n");
assert.equal(fs.existsSync(path.join(dataDir, "recovery")), false, "dry-run non deve creare snapshot");
const updatePlan = await runRepair({ cwd: projectRoot, argv: ["--dry-run", "--update"] });
assert.equal(updatePlan.update_check.needed, false, "--update controlla prima se esiste davvero una versione nuova");
console.log("smoke-test-yano-repair: OK (dry-run, alias MQTT stale e preservazione progetto)");
