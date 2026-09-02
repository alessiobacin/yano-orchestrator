#!/usr/bin/env node

// Installs the global one-minute watcher supervisor as part of a global Yano
// npm installation. This is intentionally separate from `yano start`: a
// planner launch must never select or start a watcher for its project.

import { runYanoWatcherRegistry } from "./yano-watcher-registry.mjs";

const quiet = process.argv.includes("--quiet");
const ifGlobal = process.argv.includes("--if-global");

if (ifGlobal && !["true", "1"].includes(String(process.env.npm_config_global || "").toLowerCase())) {
	if (!quiet) console.log("yano watcher: installazione lifecycle saltata (non è un npm install globale).");
	process.exit(0);
}

try {
	const result = await runYanoWatcherRegistry({ argv: ["cron", "install", "--json"] });
	if (!quiet) console.log(`yano watcher: supervisore globale installato (${result.schedule})`);
} catch (error) {
	// A package install must remain usable on systems without a usable
	// scheduler (restricted containers, managed macOS environments, or a
	// Windows account without permission to create scheduled tasks — Windows
	// itself now goes through `schtasks` instead of POSIX crontab, see
	// yano-os-scheduler.mjs, ticket #119). The operator can still run
	// `yano watcher cron install` later.
	if (!quiet) console.warn(`yano watcher: supervisore globale non installato — ${error instanceof Error ? error.message : String(error)}`);
}
