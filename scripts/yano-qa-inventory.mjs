#!/usr/bin/env node
// `yano qa-inventory scan` (Ticket #124/#125 — deterministic-scripting pass).
// Automatizza il passo 2, puramente MECCANICO, del protocollo di
// `prompts/qa-inventory-analyst.md`: "Raccogli le fonti dichiarate" (README,
// guide, riferimento comandi, `<comando> --help` reale, e per Yano stesso
// anche `agents/*.yaml`/`playbooks/*.yaml`). Prima di questo script,
// qa-inventory-analyst doveva leggere ogni fonte a mano e ricostruire
// l'elenco grezzo dei comandi ogni singolo audit — un lavoro ripetitivo e
// meccanico che non richiede giudizio.
//
// Cosa NON fa (resta compito esclusivo dell'agente, non scriptabile): stimare
// il risultato atteso (output/exit code/effetto collaterale) per ogni voce,
// identificare gli effetti downstream su stato condiviso/persistente,
// segnalare comportamento ambiguo o non implementato. Questo script produce
// solo la bozza grezza dell'inventario — l'agente la legge, la verifica
// contro il codice reale e ci costruisce sopra la matrice con giudizio.
//
// Uso:
//   yano qa-inventory scan [--project-root <dir>] [--yano-self-audit] [--json]
//   (in locale: node scripts/yano-qa-inventory.mjs scan [stesse opzioni])
//
// Read-only: non crea, sposta o modifica alcun file. `--help` viene eseguito
// con timeout e mai in modo che possa bloccare (best-effort: se un comando
// non risponde entro il timeout o esce con errore, il campo `help_output`
// resta null e lo si segnala, non si finge un output).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HELP_TIMEOUT_MS = 5000;
const FENCE_RE = /```(?:bash|sh|shell|console|powershell|pwsh|cmd|zsh)?\n([\s\S]*?)```/g;
const CMD_LINE_RE = /^\s*\$?\s*([a-zA-Z][\w.-]*(?:\s+[a-zA-Z][\w-]*){0,2})\b/;

function parseArgs(argv) {
	const o = { projectRoot: null, json: false, yanoSelfAudit: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--project-root") o.projectRoot = argv[++i] || null;
		else if (a === "--json") o.json = true;
		else if (a === "--yano-self-audit") o.yanoSelfAudit = true;
		else if (a === "--help" || a === "-h") o.help = true;
	}
	return o;
}

function listMarkdownFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	const stack = [dir];
	while (stack.length) {
		const current = stack.pop();
		let entries;
		try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name.endsWith(".md")) out.push(full);
		}
	}
	return out;
}

// Estrae candidate command-line invocation dai blocchi di codice fenced —
// euristica: prende la prima "parola" di ogni riga non vuota in un blocco
// bash/sh/shell/console e la sua (eventuale) sotto-command di primo livello.
// Falsi positivi sono attesi e accettabili: l'agente verifica contro il
// codice reale, questo script fa solo emergere i candidati, non decide.
function extractCommandCandidates(text, sourceLabel, cliNames) {
	const found = [];
	let match;
	FENCE_RE.lastIndex = 0;
	while ((match = FENCE_RE.exec(text))) {
		const block = match[1];
		for (const rawLine of block.split("\n")) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const m = line.match(CMD_LINE_RE);
			if (!m) continue;
			const words = m[1].trim().split(/\s+/);
			if (!cliNames.includes(words[0])) continue;
			const invocation = words.slice(0, 3).join(" ");
			found.push({ command: invocation, source: sourceLabel });
		}
	}
	return found;
}

function tryHelp(binPath, args) {
	try {
		const r = spawnSync(process.execPath, [binPath, ...args, "--help"], { timeout: HELP_TIMEOUT_MS, encoding: "utf8" });
		if (r.error || r.status === null) return null;
		return (r.stdout || r.stderr || "").trim().slice(0, 4000) || null;
	} catch { return null; }
}

function dedupe(items, keyFn) {
	const seen = new Set();
	return items.filter((item) => {
		const key = keyFn(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export async function runYanoQaInventory({ cwd, argv }) {
	const args = argv || [];
	const sub = args[0] === "scan" ? args.slice(1) : args;
	const opts = parseArgs(sub);
	if (opts.help || args[0] === "--help" || args[0] === "-h") {
		console.log("yano qa-inventory scan [--project-root <dir>] [--yano-self-audit] [--json]");
		console.log("  Raccoglie meccanicamente le fonti (README, docs/guides, --help reale, e per Yano stesso roles/playbooks) in una bozza di inventario grezzo.");
		return { help: true };
	}
	const projectRoot = opts.projectRoot ? path.resolve(opts.projectRoot) : cwd;

	let cliNames = [];
	const pkgPath = path.join(projectRoot, "package.json");
	let bin = {};
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
			if (typeof pkg.bin === "string") bin = { [pkg.name]: pkg.bin };
			else if (pkg.bin && typeof pkg.bin === "object") bin = pkg.bin;
			cliNames = Object.keys(bin);
		} catch { /* package.json non valido: prosegui senza CLI dichiarate */ }
	}

	const sources = [
		{ file: path.join(projectRoot, "README.md"), label: "README.md" },
		...listMarkdownFiles(path.join(projectRoot, "docs", "guides")).map((f) => ({ file: f, label: path.relative(projectRoot, f) })),
	];

	let candidates = [];
	for (const source of sources) {
		if (!existsSync(source.file)) continue;
		const text = readFileSync(source.file, "utf8");
		candidates.push(...extractCommandCandidates(text, source.label, cliNames));
	}
	candidates = dedupe(candidates, (c) => c.command).sort((a, b) => a.command.localeCompare(b.command));

	const helpOutputs = [];
	for (const [name, binRelPath] of Object.entries(bin)) {
		const binPath = path.join(projectRoot, binRelPath);
		if (!existsSync(binPath)) continue;
		helpOutputs.push({ cli: name, entry_point: path.relative(projectRoot, binPath), help_output: tryHelp(binPath, []) });
	}

	let yanoRoles = [];
	let yanoPlaybooks = [];
	if (opts.yanoSelfAudit) {
		const rolesPath = path.join(projectRoot, "agents", "roles.yaml");
		if (existsSync(rolesPath)) {
			try {
				const doc = parseYaml(readFileSync(rolesPath, "utf8"));
				yanoRoles = Object.entries(doc?.roles || {}).map(([role, cfg]) => ({ role, label: cfg?.label || role, playbook: cfg?.playbook || "default", activation: cfg?.activation || "always" }));
			} catch { /* roles.yaml non valido: segnalato via yano_roles: [] */ }
		}
		const playbooksDir = path.join(projectRoot, "playbooks");
		if (existsSync(playbooksDir)) {
			for (const entry of readdirSync(playbooksDir)) {
				if (!entry.endsWith(".yaml")) continue;
				try {
					const doc = parseYaml(readFileSync(path.join(playbooksDir, entry), "utf8"));
					yanoPlaybooks.push({ id: doc?.id || entry.replace(/\.yaml$/, ""), file: `playbooks/${entry}` });
				} catch { /* playbook non valido: segnalato via file presente ma senza id */ }
			}
		}
	}

	const report = {
		ok: true, // read-only discovery: non fallisce mai, produce solo una bozza (eventualmente vuota)
		project_root: projectRoot,
		cli_declared: cliNames,
		command_candidates: candidates,
		help_outputs: helpOutputs,
		yano_self_audit: opts.yanoSelfAudit,
		yano_roles: yanoRoles,
		yano_playbooks: yanoPlaybooks,
		sources_scanned: sources.filter((s) => existsSync(s.file)).map((s) => s.label),
		scanned_at: new Date().toISOString(),
	};

	if (opts.json) {
		console.log(JSON.stringify(report));
	} else {
		console.log(`yano qa-inventory scan: ${candidates.length} candidati comando da ${report.sources_scanned.length} fonti, ${helpOutputs.filter((h) => h.help_output).length}/${helpOutputs.length} --help catturati.`);
		for (const c of candidates) console.log(`   • ${c.command}  (${c.source})`);
		for (const h of helpOutputs) console.log(`   --help ${h.cli}: ${h.help_output ? "catturato" : "non disponibile (timeout/errore — verificare a mano)"}`);
		if (opts.yanoSelfAudit) {
			console.log(`\nRuoli Yano (agents/roles.yaml): ${yanoRoles.length}`);
			console.log(`Playbook Yano (playbooks/*.yaml): ${yanoPlaybooks.length}`);
		}
		console.log(`\nQuesta è solo la bozza grezza: verifica ogni voce contro il codice reale, stima tu il risultato atteso e gli effetti downstream — non è compito di questo script.`);
	}
	return report;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	runYanoQaInventory({ cwd: process.cwd(), argv: process.argv.slice(2) }).then((r) => process.exit(r.help ? 0 : r.ok ? 0 : 1));
}
