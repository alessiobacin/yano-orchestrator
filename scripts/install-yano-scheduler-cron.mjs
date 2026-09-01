#!/usr/bin/env node
import { runYanoScheduler } from "./yano-scheduler.mjs";

const quiet = process.argv.includes("--quiet");
if (process.argv.includes("--if-global") && !["true", "1"].includes(String(process.env.npm_config_global || "").toLowerCase())) process.exit(0);
try { await runYanoScheduler({ argv: ["cron", "install", "--json"] }); }
catch (error) { if (!quiet) console.warn(`yano schedule: cron non installato — ${error.message}`); }
