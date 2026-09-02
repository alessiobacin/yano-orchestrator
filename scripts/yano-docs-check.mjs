#!/usr/bin/env node
// `yano docs-check` (Ticket #124/#125 — deterministic-scripting pass). Verifica
// in modo scriptato, non tramite giudizio dell'agente, la parte MECCANICA del
// contratto documentale che `prompts/docs-sync.md` impone a ogni round: le
// otto categorie canoniche sotto `docs/` esistono davvero e contengono almeno
// un file non vuoto, i percorsi legacy (`docs/quick_guides/`, `docs/diagramma/`)
// non hanno contenuto residuo da migrare, e nessun file "vagante" resta
// direttamente sotto `docs/` (ammesso solo `docs/README.md`).
//
// Cosa NON verifica (resta giudizio dell'agente, non scriptabile): se il
// CONTENUTO dei file è aggiornato/corretto, se `postman` è davvero applicabile
// (il probe dà solo un'euristica, mai una decisione vincolante), se il
// diagramma riflette lo stato REALE dell'architettura.
//
// Uso:
//   yano docs-check [--project-root <dir>] [--json]
//   (in locale: node scripts/yano-docs-check.mjs [stesse opzioni])
//
// Read-only: non crea, sposta o modifica alcun file.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Stesse otto categorie canoniche di prompts/docs-sync.md e
// scripts/smoke-test-clean-repo-documentation-contract.mjs — non duplicare
// altrove questa lista, tenerla in sync a mano con quei due file.
const CANONICAL_CATEGORIES = ["architecture", "guides", "quick-guides", "adr", "notes", "postman", "cheat-sheet", "diagram"];
const LEGACY_PATHS = { "quick_guides": "quick-guides", "diagramma": "diagram" };

function parseArgs(argv) {
	const o = { projectRoot: null, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--project-root") o.projectRoot = argv[++i] || null;
		else if (a === "--json") o.json = true;
		else if (a === "--help" || a === "-h") o.help = true;
	}
	return o;
}

function listFilesRecursive(dir) {
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
			else out.push(full);
		}
	}
	return out;
}

function nonEmptyFileCount(files) {
	return files.filter((f) => { try { return statSync(f).size > 0; } catch { return false; } }).length;
}

// Euristica soltanto — mai una decisione vincolante: un progetto può avere un
// backend reale senza nessuno di questi segnali (framework non elencato, o
// server scritto senza dipendenze da package.json), o averne uno solo di
// supporto (es. un piccolo webhook) senza che sia il fulcro del progetto.
// docs-sync deve sempre leggere il progetto reale prima di fidarsi di questo
// valore — il campo si chiama apposta `backend_likely`, non `has_backend`.
function detectBackendHeuristic(projectRoot) {
	const reasons = [];
	const pkgPath = path.join(projectRoot, "package.json");
	const webFrameworks = ["express", "fastify", "koa", "hapi", "@nestjs/core", "restify", "hono"];
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
			const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
			const found = webFrameworks.filter((f) => f in deps);
			if (found.length) reasons.push(`package.json dichiara: ${found.join(", ")}`);
		} catch { /* package.json non valido: ignora, non è compito di questo probe */ }
	}
	const backendDirHints = ["src/server", "src/api", "server", "api", "routes"];
	for (const hint of backendDirHints) {
		if (existsSync(path.join(projectRoot, hint))) reasons.push(`directory presente: ${hint}/`);
	}
	return { backend_likely: reasons.length > 0, reasons };
}

export async function runYanoDocsCheck({ cwd, argv }) {
	const opts = parseArgs(argv || []);
	if (opts.help) {
		console.log("yano docs-check [--project-root <dir>] [--json]");
		console.log("  Verifica scriptata delle otto categorie canoniche sotto docs/ (vedi prompts/docs-sync.md).");
		return { help: true };
	}
	const projectRoot = opts.projectRoot ? path.resolve(opts.projectRoot) : cwd;
	const docsRoot = path.join(projectRoot, "docs");

	const { backend_likely, reasons: backendReasons } = detectBackendHeuristic(projectRoot);

	const categories = CANONICAL_CATEGORIES.map((name) => {
		const dir = path.join(docsRoot, name);
		const exists = existsSync(dir) && statSync(dir).isDirectory();
		const files = exists ? listFilesRecursive(dir) : [];
		const nonEmpty = nonEmptyFileCount(files);
		const required = name === "postman" ? backend_likely : true;
		return {
			name,
			path: path.relative(projectRoot, dir),
			exists,
			file_count: files.length,
			non_empty_file_count: nonEmpty,
			satisfied: nonEmpty > 0,
			required,
		};
	});

	const legacyPathsNeedingMigration = Object.entries(LEGACY_PATHS)
		.map(([legacy, canonical]) => {
			const dir = path.join(docsRoot, legacy);
			const files = listFilesRecursive(dir);
			const nonEmpty = nonEmptyFileCount(files);
			return { legacy_path: path.relative(projectRoot, dir), canonical_replacement: canonical, has_content: nonEmpty > 0, file_count: files.length };
		})
		.filter((entry) => entry.has_content);

	let strayFilesUnderDocs = [];
	if (existsSync(docsRoot)) {
		strayFilesUnderDocs = readdirSync(docsRoot, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name !== "README.md")
			.map((entry) => path.relative(projectRoot, path.join(docsRoot, entry.name)));
	}

	const architectureDiagramSharedState = {
		path: path.relative(projectRoot, path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "diagrams", "architecture.mmd")),
		exists: existsSync(path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "diagrams", "architecture.mmd")),
	};

	const unsatisfiedRequired = categories.filter((c) => c.required && !c.satisfied);
	const ok = unsatisfiedRequired.length === 0 && legacyPathsNeedingMigration.length === 0 && strayFilesUnderDocs.length === 0;

	const report = {
		ok,
		project_root: projectRoot,
		categories,
		unsatisfied_required_categories: unsatisfiedRequired.map((c) => c.name),
		legacy_paths_needing_migration: legacyPathsNeedingMigration,
		stray_files_under_docs: strayFilesUnderDocs,
		postman_backend_heuristic: { backend_likely, reasons: backendReasons },
		architecture_diagram_shared_state: architectureDiagramSharedState,
		checked_at: new Date().toISOString(),
	};

	if (opts.json) {
		console.log(JSON.stringify(report));
	} else {
		console.log(`yano docs-check: ${ok ? "OK" : "GAP TROVATI"} (${categories.filter((c) => c.satisfied).length}/${categories.length} categorie soddisfatte, ${categories.filter((c) => c.required).length} richieste in questo progetto).`);
		for (const c of categories) {
			const mark = c.satisfied ? "✓" : (c.required ? "✗" : "–");
			console.log(`   ${mark} ${c.name.padEnd(14)} ${c.path} (${c.file_count} file, ${c.non_empty_file_count} non vuoti)${!c.required ? " [non richiesta: nessun backend rilevato]" : ""}`);
		}
		if (legacyPathsNeedingMigration.length) {
			console.log(`\nPercorsi legacy con contenuto da migrare:`);
			for (const l of legacyPathsNeedingMigration) console.log(`   ⚠ ${l.legacy_path} → ${l.canonical_replacement}/ (${l.file_count} file)`);
		}
		if (strayFilesUnderDocs.length) {
			console.log(`\nFile direttamente sotto docs/ (vanno spostati nella categoria corretta):`);
			for (const f of strayFilesUnderDocs) console.log(`   ⚠ ${f}`);
		}
		console.log(`\nEuristica backend (solo un segnale, non una decisione): ${backend_likely ? "probabile" : "nessun segnale trovato"}${backendReasons.length ? ` — ${backendReasons.join("; ")}` : ""}.`);
		console.log(`Diagramma condiviso (${architectureDiagramSharedState.path}): ${architectureDiagramSharedState.exists ? "presente" : "assente"}.`);
	}
	return report;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	runYanoDocsCheck({ cwd: process.cwd(), argv: process.argv.slice(2) }).then((r) => process.exit(r.help ? 0 : r.ok ? 0 : 1));
}
