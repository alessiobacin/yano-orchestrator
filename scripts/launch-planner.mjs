#!/usr/bin/env node
// Lancia una istanza `pi` per QUALUNQUE ruolo (Revisione 44 — prima solo
// planner, vedi sotto), includendo automaticamente i flag --skill per le
// skill vendorizzate di mattpocock/skills (skills-vendor/mattpocock/, vedi
// VERSION.md lì dentro) — wayfinder, to-spec, to-tickets, grilling, domain-modeling,
// setup-matt-pocock-skills — MA SOLO quando il ruolo risolto è "planner"
// (default se --role non è passato affatto, per compatibilità con l'uso
// storico di questo script/`yano start`).
//
// Revisione 49 — stessa identica logica, seconda skill vendorizzata: la
// skill `chrome-devtools` (skills-vendor/awesome-copilot/, vedi VERSION.md
// lì dentro) viene attaccata con --skill SOLO quando il ruolo risolto è
// "reviewer" o "frontend-developer" — richiesta esplicita dell'operatore
// per permettere a questi due ruoli di verificare DAVVERO nel browser che
// il frontend funzioni (via i tool del server MCP chrome-devtools), non
// solo leggendo il codice. Vedi VERSION.md per il limite onesto: la SKILL
// è scopabile per ruolo esattamente come le skill mattpocock, ma il server
// MCP che quella skill presuppone NON lo è (limite di pi-mcp-adapter/Pi,
// non di questo script) — va dichiarato project-wide in .mcp.json.
//
// PERCHÉ QUESTO SCRIPT ESISTE (Revisione 22, vedi docs/notes/development-notes.md):
// extensions/orchestrator.ts non compone MAI il comando che lancia un nuovo
// processo `pi` — l'unico uso di execFile() nell'estensione è per le
// chiamate di self-report/rename verso herdr e per `git` (vedi
// herdrReportAgent()/herdrRenamePane()/gitExec... più sotto nel file). Le
// istanze del team vengono lanciate dal planner stesso via shell, seguendo
// il testo di prompts/planner.md (Herdr) — mai per un altro
// planner, visto che l'architettura attuale non ne spawna mai un secondo.
// planner-01 stesso viene avviato a mano dall'utente (vedi README
// Quickstart). Questo script è quindi il vero "punto" in cui gli argomenti
// del processo pi vengono composti — non un ramo dentro orchestrator.ts,
// che non esiste.
//
// Uso:
//   node scripts/launch-planner.mjs --instance planner-01 [--name "Planner"] [altri flag pi...]
//   node scripts/launch-planner.mjs --instance coder-01 --role coder   # Revisione 44: qualunque ruolo, non solo planner
//   node scripts/launch-planner.mjs --instance planner-01 --print-only   # stampa il comando composto, non lo esegue (verifica manuale)
//   yano start --instance planner-01   # dopo `npm install -g`/`npm link` (Revisione 31, vedi bin/yano.mjs)
//
// Revisione 44 — generalizzato a QUALUNQUE ruolo, non solo planner (incidente
// reale, vedi docs/notes/development-notes.md): prima di questa revisione, questo
// script si rifiutava con un --role diverso da "planner" e rimandava a "usa
// `pi -e extensions/orchestrator.ts --role <ruolo>` direttamente" — un
// consiglio diventato STALE dalla Revisione 33 (un progetto scaffoldato non
// ha più quel file, l'estensione si carica da sola). Il planner, componendo
// quel comando a mano dal proprio prompt (mai passando da questo script),
// lanciava esattamente quel comando stale per lanciare coder/reviewer/
// specialisti via Herdr — il processo `pi` falliva subito
// (`extensions/orchestrator.ts` non esiste nel progetto), il pannello/sessione
// moriva immediatamente, e il planner doveva ridiagnosticare il problema da
// capo ogni volta (osservato realmente: ~58k token di ragionamento sprecati
// per riscoprire ciò che questo script già sapeva fare correttamente per
// planner). Fix: questo script (quindi `yano start`) ora gestisce QUALUNQUE
// ruolo con la stessa identica logica di rilevamento `-e` già corretta per
// planner dalla Revisione 33/38 — i flag --skill mattpocock restano
// attaccati SOLO quando il ruolo risolto è "planner" (default se --role è
// omesso), mai per altri ruoli.
//
// Revisione 31 — packageRoot vs cwd (importante per l'installazione globale):
// prima di questa revisione lo script usava SEMPRE la propria directory
// (repoRoot, cioè la cartella del pacchetto) sia per risolvere le skill
// vendorizzate sia come cwd del processo `pi` che spawna — corretto solo
// quando lo script viene eseguito dalla root del pacchetto stesso (l'unico
// caso d'uso, prima d'ora). Con `yano start` installato globalmente, invece,
// il pacchetto vive in tutt'altra directory rispetto al PROGETTO
// dell'operatore (dove sta extensions/orchestrator.ts scaffoldato da `yano
// init`): le skill vendorizzate vanno ancora cercate nel pacchetto
// (packageRoot — non vengono copiate nei progetti scaffoldati, vedi
// create-project.mjs), ma `pi` va spawnato con cwd = directory
// dell'operatore (cwd), altrimenti caricherebbe l'orchestrator.ts sbagliato
// (quello del pacchetto, non quello del progetto).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ensureRolePrerequisites, isSupportedNodeRuntime } from "./doctor.mjs";
import { globalDataPath } from "./yano-config.mjs";
import { TRACE_MODES, canonicalProjectScope, getTraceConfig, resolveTraceProject, setTraceMode, slugify, traceRoot } from "./yano-trace-storage.mjs";
import { assertAgentIdentityAvailable } from "./yano-agent-identity.mjs";
import { agentMcpConfigPath, materializeAgentMcp } from "./yano-agent-mcp.mjs";

// Le 6 skill vendorizzate destinate al ruolo planner — vedi
// skills-vendor/mattpocock/VERSION.md per la motivazione di ciascuna
// (wayfinder/to-spec/to-tickets richieste dal flusso di planning;
// grilling/domain-modeling
// dipendenze dirette e incondizionate di wayfinder; setup-matt-pocock-skills
// perché entrambe la richiedono per configurare il tracker del repo).
const MATT_POCOCK_SKILLS = ["wayfinder", "to-spec", "to-tickets", "grilling", "domain-modeling", "setup-matt-pocock-skills"];

// Skill Yano condivisa: contiene il contratto della CLI trace e il protocollo
// per riportare evidenze tra coder, reviewer, specialisti e planner. Il planner
// mantiene comunque la responsabilità delle overview cross-project e delle
// decisioni di modifica sistemica.
const YANO_PLANNER_SKILL = "yano-planner-trace-analysis";

// Skill Yano condivisa: insegna a ogni agente a interpretare richieste
// semantiche sulla CLI completa (`yano watcher projects`, `yano init`, trace,
// recovery, playbook, ecc.) e a scegliere il comando meno rischioso. Tutte le
// skill proprie di Yano vivono sotto skills-vendor/yano/; l'installer globale
// la espone poi come ~/.<harness>/skills/yano-cli.
const YANO_CLI_SKILL = "yano-cli";
// Memory protocol shared by every Yano role. The project-local `cm init pi`
// integration captures context; this skill tells agents how to retrieve and
// record it safely and consistently.
const YANO_CODE_MEM_SKILL = "yano-code-mem";
// Preview read-only condivisa: ogni ruolo deve poter proporre una simulazione
// sicura di auto-improver, feedback o Architect senza creare lavoro reale.
const YANO_OBSERVER_DRY_RUN_SKILL = "yano-observer-dry-run";

// Adapter Yano della skill /code-review di Matt Pocock: il reviewer riceve il
// metodo Spec/Standards, ma non il workflow originale con fixed point chiesto
// all'utente e sub-agent paralleli. Vedi skills-vendor/yano/yano-code-review/.
const YANO_REVIEW_SKILL = "yano-code-review";
const YANO_REVIEW_SKILL_ROLES = ["reviewer", "frontend-reviewer"];
// Deployment workers receive a Yano-specific contract in addition to the
// shared trace skill. It is scoped to deployment-agent so normal coders and
// reviewers cannot accidentally treat a coding task as a release operation.
const YANO_DEPLOYMENT_SKILL = "yano-deployment";
const YANO_DEPLOYMENT_SKILL_ROLES = ["deployment-agent"];
const YANO_OBSERVER_SKILL = "yano-observer";
const YANO_OBSERVER_SKILL_ROLES = ["watcher", "auto-improver"];
const YANO_AUTO_IMPROVEMENT_SKILL = "yano-auto-improvement";
const YANO_AUTO_IMPROVEMENT_SKILL_ROLES = ["auto-improver"];
const YANO_ARCHITECT_SKILL = "yano-architect";
const YANO_ARCHITECT_SKILL_ROLES = ["architect"];
const YANO_AI_OPTIMIZATION_SKILL = "yano-ai-optimization";
const YANO_AI_OPTIMIZATION_SKILL_ROLES = ["ai-optimizer"];

// Skill vendorizzata destinata ai ruoli che devono verificare davvero il
// browser: reviewer frontend e simulatore E2E.
const CHROME_DEVTOOLS_SKILL = "chrome-devtools";
const CHROME_DEVTOOLS_SKILL_ROLES = ["frontend-reviewer", "frontend-developer", "e2e-simulator", "full-stack-developer", "full-stack-reviewer"];

function resolveVendoredSkillPaths(packageRoot, vendorDir, names) {
	const base = path.join(packageRoot, "skills-vendor", vendorDir);
	const missing = [];
	const paths = names.map((name) => {
		const p = path.join(base, name);
		if (!existsSync(path.join(p, "SKILL.md"))) missing.push(p);
		return p;
	});
	if (missing.length > 0) {
		console.error("launch-planner: skill vendorizzate mancanti o incomplete (manca SKILL.md):");
		for (const m of missing) console.error(`  - ${m}`);
		console.error(`Verifica skills-vendor/${vendorDir}/ (vedi VERSION.md lì dentro).`);
		process.exit(1);
	}
	return paths;
}

function resolveSkillPaths(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "mattpocock", MATT_POCOCK_SKILLS);
}

function resolveChromeDevToolsSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "awesome-copilot", [CHROME_DEVTOOLS_SKILL])[0];
}

function resolveYanoPlannerSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "yano", [YANO_PLANNER_SKILL])[0];
}

function resolveYanoCliSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "yano", [YANO_CLI_SKILL])[0];
}

function resolveYanoCodeMemSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "yano", [YANO_CODE_MEM_SKILL])[0];
}

function resolveYanoObserverDryRunSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "yano", [YANO_OBSERVER_DRY_RUN_SKILL])[0];
}

function resolveYanoReviewSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "yano", [YANO_REVIEW_SKILL])[0];
}

function resolveYanoDeploymentSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "yano", [YANO_DEPLOYMENT_SKILL])[0];
}

function resolveYanoObserverSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "yano", [YANO_OBSERVER_SKILL])[0];
}

function resolveYanoAutoImprovementSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "yano", [YANO_AUTO_IMPROVEMENT_SKILL])[0];
}


function resolveYanoArchitectSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "yano", [YANO_ARCHITECT_SKILL])[0];
}

function resolveYanoAiOptimizationSkillPath(packageRoot) {
	return resolveVendoredSkillPaths(packageRoot, "yano", [YANO_AI_OPTIMIZATION_SKILL])[0];
}

// Pi carica automaticamente le skill in ~/.pi/agent/skills e nelle directory
// dichiarate in ~/.pi/agent/settings.json. Passare di nuovo una skill con lo
// stesso `name:` tramite --skill produce il messaggio "Skill conflicts" e Pi
// scarta una delle due copie. Il catalogo globale e quello vendorizzato sono
// entrambi utili: il primo è la copia aggiornata dell'operatore, il secondo è
// il fallback portabile di Yano. Perciò non copiamo né cancelliamo nulla:
// omettiamo soltanto dal comando esplicito i nomi che Pi scoprirà già da sé.
function skillNameAt(skillPath) {
	try {
		const source = readFileSync(path.join(skillPath, "SKILL.md"), "utf8");
		const match = source.match(/^name:\s*([^\s#]+)\s*$/m);
		return match?.[1] || path.basename(skillPath);
	} catch {
		return path.basename(skillPath);
	}
}

function expandHome(value, home) {
	if (typeof value !== "string" || value.length === 0) return null;
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return path.resolve(value);
}

export function piAutomaticSkillNames({ env = process.env, home = env.HOME || process.env.HOME } = {}) {
	if (!home) return new Set();
	const piHome = expandHome(env.PI_CODING_AGENT_DIR || "~/.pi/agent", home);
	if (!piHome) return new Set();
	const roots = [path.join(piHome, "skills")];
	try {
		const settings = JSON.parse(readFileSync(path.join(piHome, "settings.json"), "utf8"));
		for (const configuredRoot of settings.skills || []) {
			const resolved = expandHome(configuredRoot, home);
			if (resolved) roots.push(resolved);
		}
	} catch {
		// No settings is a normal first-run state; the default Pi skills root is
		// still checked above.
	}
	const names = new Set();
	for (const root of new Set(roots)) {
		try {
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				const skillPath = path.join(root, entry.name);
				// User skill catalogues commonly contain symlinks (for example
				// ~/.claude/skills/wayfinder -> ~/.agents/skills/wayfinder).
				// Dirent.isDirectory() is false for those links, while Pi follows
				// them and therefore sees the skill. Presence of SKILL.md is the
				// authoritative test for both normal directories and symlinks.
				if (existsSync(path.join(skillPath, "SKILL.md"))) names.add(skillNameAt(skillPath));
			}
		} catch {
			// A configured optional root can legitimately be absent.
		}
	}
	return names;
}

export function explicitSkillPathsWithoutPiConflicts(skillPaths, automaticNames = piAutomaticSkillNames()) {
	return [...new Set(skillPaths)].filter((skillPath) => !automaticNames.has(skillNameAt(skillPath)));
}

function generatedRoleManifest(role) {
	const root = path.join(traceRoot(), "catalog", "agents", role);
	if (!existsSync(root)) return null;
	const versions = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.reverse();
	for (const version of versions) {
		const file = path.join(root, version, "role.yaml");
		if (!existsSync(file)) continue;
		try {
			const document = YAML.parse(readFileSync(file, "utf8"));
			if (document?.id === role) return { document, file };
		} catch { /* an invalid catalog entry is ignored; yano agent resolution remains unchanged */ }
	}
	return null;
}

function isWithin(parent, child) {
	const canonical = (value) => {
		try { return realpathSync(value); } catch { return path.resolve(value); }
	};
	const parentPath = canonical(parent);
	const childPath = canonical(child);
	return childPath === parentPath || childPath.startsWith(`${parentPath}${path.sep}`);
}

// An Architect proposal is intentionally ephemeral: it must be usable by the
// Planner before promotion, but it must never be copied into the application
// repository. The old launcher only resolved roles from the persistent global
// catalog, so `business-docs-author` could be reported READY and still be
// impossible to launch. `--proposal-id` is the explicit, auditable handoff.
function ephemeralRoleManifest({ proposalId, role, cwd }) {
	if (!proposalId) return null;
	const proposalDir = path.join(traceRoot(), "architect", "proposals", proposalId);
	const manifestPath = path.join(proposalDir, "manifest.json");
	const playbookPath = path.join(proposalDir, "playbook.yaml");
	const readinessPath = path.join(proposalDir, "readiness.json");
	if (!existsSync(manifestPath)) throw new Error(`launch-planner: proposta Architect non trovata: ${proposalId}`);
	let manifest;
	try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
	catch (error) { throw new Error(`launch-planner: manifest Architect non leggibile (${proposalId}): ${error.message}`); }
	const projectRoot = manifest?.project?.root;
	if (!projectRoot || !isWithin(projectRoot, cwd)) {
		throw new Error(`launch-planner: la proposta ${proposalId} appartiene a un altro progetto; cwd=${cwd}`);
	}
	const declaredRoles = Array.isArray(manifest.roles) ? manifest.roles : [manifest.role_id];
	if (!declaredRoles.includes(role)) {
		throw new Error(`launch-planner: il ruolo "${role}" non è dichiarato dalla proposta ${proposalId}`);
	}
	if (!existsSync(playbookPath)) throw new Error(`launch-planner: playbook ephemeral mancante: ${playbookPath}`);
	if (!existsSync(readinessPath)) throw new Error(`launch-planner: readiness Architect mancante per ${proposalId}; esegui yano architect verify --proposal-id ${proposalId}`);
	let readiness;
	try { readiness = JSON.parse(readFileSync(readinessPath, "utf8")); }
	catch (error) { throw new Error(`launch-planner: readiness Architect non leggibile (${proposalId}): ${error.message}`); }
	if (readiness.ready !== true || readiness.operational !== true || (readiness.checks || []).some((check) => check.status !== "ready")) {
		throw new Error(`launch-planner: proposta ${proposalId} non operativa; capability readiness incompleta. Esegui yano architect verify --proposal-id ${proposalId}`);
	}
	const capabilities = manifest.capabilities || { skills: [], cli: [], mcp: [] };
	return {
		document: {
			id: role,
			label: `Generated ${role}`,
			brief: `Agente ephemeral creato da Yano Architect per la proposta ${proposalId}. Segui il playbook ${manifest.playbook_id} e consegna evidenze al planner.`,
			activation: "lazy",
			playbook: manifest.playbook_id,
			playbook_path: playbookPath,
			model: { provider: "llmproxy", model: "llmproxy" },
			skills: capabilities.skills || [],
			cli: capabilities.cli || [],
			mcp: capabilities.mcp || [],
			teams: ["generated"],
			source_proposal: proposalId,
			read_only: false,
		},
		file: manifestPath,
		playbookPath,
		proposalId,
		ephemeral: true,
	};
}

function generatedSkillPath(packageRoot, name) {
	const candidates = [
		path.join(packageRoot, name),
		path.join(packageRoot, "skills-vendor", "yano", name),
		path.join(packageRoot, "skills-vendor", "mattpocock", name),
		path.join(packageRoot, "skills-vendor", "awesome-copilot", name),
		path.join(traceRoot(), "catalog", "skills", name),
		path.join(process.env.HOME || process.env.USERPROFILE || "", ".agents", "skills", name),
		path.join(process.env.HOME || process.env.USERPROFILE || "", ".codex", "skills", name),
	];
	return candidates.find((candidate) => existsSync(path.join(candidate, "SKILL.md"))) || null;
}

function generatedRoleConfigDir({ cwd, role, roleManifest, sourceDir: preferredSourceDir = null }) {
	if (!roleManifest) return null;
	const sourceDirs = [path.join(cwd, "agents"), path.join(cwd, ".pi", "agents")];
	const sourceDir = preferredSourceDir || sourceDirs.find((candidate) => existsSync(path.join(candidate, "roles.yaml"))) || sourceDirs[0];
	let config = { roles: {} };
	const sourceFile = path.join(sourceDir, "roles.yaml");
	if (existsSync(sourceFile)) {
		try { config = YAML.parse(readFileSync(sourceFile, "utf8")) || { roles: {} }; } catch { config = { roles: {} }; }
	}
	config.roles ||= {};
	config.roles[role] = roleManifest.document;
	const configDir = path.join(traceRoot(), "architect", "runtime-config", slugify(resolveTraceProject(cwd)), role);
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(configDir, "roles.yaml"), YAML.stringify(config), { mode: 0o600 });
	if (roleManifest.playbookPath && existsSync(roleManifest.playbookPath)) {
		const playbooksDir = path.join(configDir, "playbooks");
		mkdirSync(playbooksDir, { recursive: true, mode: 0o700 });
		const playbookId = roleManifest.document.playbook || "ephemeral-playbook";
		writeFileSync(path.join(playbooksDir, `${slugify(playbookId)}.yaml`), readFileSync(roleManifest.playbookPath), { mode: 0o600 });
	}
	return configDir;
}

function parseArgs(argv) {
	const passthrough = [];
	let printOnly = false;
	let json = false;
	let role; // undefined finché non trovato — risolto a "planner" più sotto se mai passato
	let traceMode;
	let proposalId;
	let llmproxyPin;
	let herdr;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--print-only") {
			printOnly = true;
			continue;
		}
		if (a === "--json") {
			json = true;
			continue;
		}
		if (a === "--herdr") {
			herdr = true;
			continue;
		}
		if (a === "--role") {
			role = argv[i + 1];
			if (!role) {
				console.error("launch-planner: --role richiede un valore (es. --role coder).");
				process.exit(1);
			}
			i++; // consuma anche il valore, verrà comunque riaggiunto sotto in modo esplicito
			continue;
		}
		if (a === "--proposal-id" || a === "--playbook-proposal") {
			proposalId = argv[i + 1];
			if (!proposalId) {
				console.error(`launch-planner: ${a} richiede un proposal ID Architect.`);
				process.exit(1);
			}
			i++;
			continue;
		}
		if (a === "--trace-mode") {
			traceMode = argv[++i];
			if (!traceMode || !TRACE_MODES.includes(traceMode)) {
				console.error(`launch-planner: --trace-mode richiede uno tra ${TRACE_MODES.join(", ")}.`);
				process.exit(1);
			}
			continue;
		}
		if (a === "--llmproxy-pin") {
			llmproxyPin = argv[++i];
			if (!llmproxyPin) {
				console.error("launch-planner: --llmproxy-pin richiede un pinned_id llmProxy model@provider-id.");
				process.exit(1);
			}
			continue;
		}
		passthrough.push(a);
	}
	return { passthrough, printOnly, json, role: role ?? "planner", traceMode, proposalId, llmproxyPin, herdr };
}

// runLaunchPlanner({ packageRoot, cwd, argv }) — packageRoot risolve le
// skill vendorizzate (vivono SOLO nel pacchetto, mai copiate in un progetto
// scaffoldato — vedi create-project.mjs); cwd è la directory del progetto
// dell'operatore, usata sia come cwd del processo `pi` spawnato sia per
// verificare che sia davvero un progetto inizializzato.
//
// Revisione 33 — niente più `-e extensions/orchestrator.ts` di default:
// da quando l'estensione si installa globalmente (`pi extension install`),
// `pi` la carica in automatico in OGNI sessione, ovunque (verificato da un
// test reale dell'operatore su Windows: `pi --instance planner-01`, senza
// alcun `-e`, si connette correttamente). Un progetto scaffoldato da `yano
// init` non contiene più una copia locale di extensions/orchestrator.ts
// (vedi create-project.mjs) — comporre comunque il comando con
// `-e extensions/orchestrator.ts` in quel caso caricava lo stesso codice
// due volte (quello globale auto-caricato + quello esplicito locale), e
// `pi` rifiutava ogni tool/flag duplicato ("Tool ... conflicts with ...",
// "Flag ... conflicts with ...") — esattamente il traceback riportato
// dall'operatore. Fix: passa `-e extensions/orchestrator.ts` SOLO se quel
// file esiste davvero in cwd (dev mode dentro questo stesso repo, o un
// progetto legacy pre-Revisione-33 con ancora una copia locale); altrimenti
// confida nell'auto-load globale e non passa `-e` affatto. La verifica "è
// un progetto inizializzato" non può quindi più dipendere dall'esistenza di
// extensions/orchestrator.ts (Revisione 31) — usa invece i marker che
// `yano init` scrive sempre: agents/roles.yaml oppure
// .pi/extensions/yano-orchestrator/config/project.json.
export function runLaunchPlanner({ packageRoot, cwd, argv }) {
	const { passthrough, printOnly, json, role, traceMode, proposalId, llmproxyPin, herdr } = parseArgs(argv);
	const ephemeralRole = ephemeralRoleManifest({ proposalId, role, cwd });
	if (!isSupportedNodeRuntime()) {
		console.error(`launch-planner: Node.js ${process.version} non supportato — serve Node 22.5.0 o superiore.`);
		return;
	}
	const prerequisites = ensureRolePrerequisites({ packageRoot, cwd, role, install: !printOnly });
	if (!prerequisites.ok && !printOnly) return;
	if (!prerequisites.ok && printOnly) console.warn("launch-planner: print-only — prerequisiti lazy non installati/verificati; comando mostrato soltanto.");

	const orchestratorPath = path.join(cwd, "extensions", "orchestrator.ts");
	const hasLocalExtension = existsSync(orchestratorPath);
	const projectMarkers = [
		path.join(cwd, ".pi", "extensions", "yano-orchestrator", "config", "project.json"),
		path.join(cwd, "agents", "roles.yaml"),
		// Projects created by earlier Yano scaffolds kept the roster under
		// `.pi/agents`. Keep them launchable while deriving the project scope
		// from the current root and passing it explicitly below.
		path.join(cwd, ".pi", "agents", "roles.yaml"),
	];
	// Recovery launches a worker from its preserved Git worktree while passing
	// the main checkout's roster with --config-dir. A worktree need not carry
	// the ignored .pi/agents directory itself; the explicit config is enough to
	// prove that this is an intentional Yano launch.
	const configDirIndex = passthrough.indexOf("--config-dir");
	const explicitConfigDir = configDirIndex >= 0 ? passthrough[configDirIndex + 1] : null;
	if (explicitConfigDir) {
		const resolvedConfigDir = path.resolve(cwd, explicitConfigDir);
		if (existsSync(path.join(resolvedConfigDir, "roles.yaml"))) projectMarkers.push(path.join(resolvedConfigDir, "roles.yaml"));
	}
	const looksInitialized = hasLocalExtension || projectMarkers.some((p) => existsSync(p));
	if (!looksInitialized) {
		console.error(
			`launch-planner: questa directory non sembra un progetto yano-orchestrator inizializzato ` +
				`(nessun agents/roles.yaml, nessun .pi/extensions/yano-orchestrator/config/project.json, ` +
				`nessun extensions/orchestrator.ts locale).\n` +
				`Esegui prima \`yano init --name "<nome progetto>"\` (o \`node scripts/create-project.mjs ...\` in locale), poi rilancia da lì.`,
		);
		process.exit(1);
	}
	// Common gate for every Yano-created role. It runs before a process or a
	// Herdr tab is created, and therefore rejects concurrent duplicate starts.
	if (!printOnly) {
		const instanceIndex = passthrough.indexOf("--instance");
		const instance = instanceIndex >= 0 ? passthrough[instanceIndex + 1] : null;
		if (!instance) {
			console.error("launch-planner: --instance è obbligatorio per un agente Yano.");
			process.exit(1);
		}
		let snapshot = null;
		try {
			const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer: 4_000_000 });
			if (result.status === 0) {
				const parsed = JSON.parse(result.stdout || "");
				snapshot = parsed?.result?.snapshot || parsed?.result || parsed;
			}
		} catch { /* A plain terminal launch can work without Herdr. */ }
		if (snapshot) assertAgentIdentityAvailable({ snapshot, root: cwd, instance, role });
	}

	// A launcher-created session must have a complete forensic trail unless the
	// operator explicitly opts down. Previously the CLI and the Pi extension
	// could silently use different modes/stores, making a post-mortem blind.
	const projectFlagIndex = passthrough.indexOf("--project");
	const explicitProject = projectFlagIndex >= 0 ? passthrough[projectFlagIndex + 1] : null;
	// Always pass a derived scope explicitly to the child. Pi can auto-load a
	// different Yano package from its own extension registry than the npm
	// package that launched this script; relying on the child extension to
	// repeat project discovery made a stale install able to fall back to a
	// shared/default MQTT namespace and mix projects. An operator-supplied
	// --project remains verbatim for deliberate shared scopes.
	const derivedProject = canonicalProjectScope(cwd);
	const traceProject = canonicalProjectScope(cwd, explicitProject);
	const requestedTraceMode = traceMode || process.env.YANO_TRACE_MODE || "full";
	if (!TRACE_MODES.includes(requestedTraceMode)) {
		console.error(`launch-planner: modalità trace non valida "${requestedTraceMode}".`);
		process.exit(1);
	}
	if (!printOnly) setTraceMode({ cwd, project: traceProject, mode: requestedTraceMode });
	const traceConfig = getTraceConfig({ cwd, project: traceProject });
	const packageVersion = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
	// Promoted roles live in the global catalog, not in a project roster. Build
	// a short-lived merged roles.yaml so `yano start --role <generated-role>`
	// remains immediately usable without copying catalog state into the app.
	const generatedRole = ephemeralRole || generatedRoleManifest(role);
	const generatedConfigDir = generatedRole ? generatedRoleConfigDir({ cwd, role, roleManifest: generatedRole }) : null;

	// Revisione 34 — caso reale osservato dall'operatore: un progetto
	// scaffoldato da una versione di `yano init` PRECEDENTE alla Revisione 33
	// ha ancora una copia locale di extensions/orchestrator.ts sul disco
	// (creata prima che create-project.mjs smettesse di copiarla). Quella
	// copia stale continua a triggerare `hasLocalExtension` qui sopra.
	// Euristica per distinguere questo caso dal legittimo "dentro il repo del
	// pacchetto stesso, in sviluppo": il package.json del pacchetto ha
	// sempre name === "yano-orchestrator"; un progetto scaffoldato da `yano
	// init` ha sempre uno slug diverso (viene da --name, vedi
	// create-project.mjs).
	let cwdPkgName;
	try {
		cwdPkgName = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8")).name;
	} catch {
		cwdPkgName = undefined;
	}
	const looksLikePackageRepo = cwdPkgName === "yano-orchestrator";

	// Revisione 38 — bug reale trovato in produzione (docs/notes/development-notes.md,
	// Revisione 38): fino a qui questo script si limitava ad AVVISARE del
	// rischio di conflitto ("Tool ... conflicts with ...") ma continuava
	// comunque a comporre `-e extensions/orchestrator.ts` anche nel caso
	// stale — l'avviso descriveva correttamente il crash imminente invece di
	// evitarlo. Un operatore che ha visto esattamente quell'avviso ha
	// comunque avuto il crash subito dopo, sia con `yano start` che con `pi -e
	// extensions/orchestrator.ts --role planner` a mano. Fix: quando la
	// copia locale NON è dentro il repo del pacchetto stesso, ignorala del
	// tutto — non passare mai `-e` per lei, confida SEMPRE sull'auto-load
	// globale in quel caso (esattamente come per un progetto senza copia
	// locale affatto). L'unico caso in cui `-e` viene ancora composto è lo
	// sviluppo del pacchetto stesso (packageRoot === cwd, verificato via
	// package.json name).
	if (hasLocalExtension && !looksLikePackageRepo) {
		console.warn(
			`launch-planner: trovato "${orchestratorPath}" residuo, ma IGNORATO (non aggiunto a -e) — è quasi certamente\n` +
				`un residuo di uno scaffold creato da una versione di \`yano init\` precedente alla Revisione 33 (che non copia\n` +
				`più extensions/ — vedi docs/notes/development-notes.md). L'estensione installata globalmente (pi extension install /\n` +
				`npm install -g) viene usata al suo posto, come per qualunque altro progetto scaffoldato di recente — questa\n` +
				`cartella residua è ormai inerte e sicura da cancellare quando vuoi:\n` +
				`  ${process.platform === "win32" ? "Remove-Item -Recurse -Force" : "rm -rf"} "${path.join(cwd, "extensions")}"\n`,
		);
	}

	// Revisione 44: le skill mattpocock restano riservate al planner — un
	// --role diverso (coder/reviewer/specialista) non le riceve mai, stessa
	// garanzia di isolamento verificata da scripts/check-skill-isolation.mjs.
	const mattPocockSkillFlags = role === "planner" ? resolveSkillPaths(packageRoot).flatMap((p) => ["--skill", p]) : [];
	// Revisione 49: la skill chrome-devtools resta riservata a reviewer e
	// frontend-developer — nessun altro ruolo la riceve mai, stessa garanzia
	// verificata da scripts/check-skill-isolation.mjs.
	const chromeDevToolsSkillFlags = CHROME_DEVTOOLS_SKILL_ROLES.includes(role)
		? ["--skill", resolveChromeDevToolsSkillPath(packageRoot)]
		: [];
	const yanoReviewSkillFlags = YANO_REVIEW_SKILL_ROLES.includes(role)
		? ["--skill", resolveYanoReviewSkillPath(packageRoot)]
		: [];
	const yanoDeploymentSkillFlags = YANO_DEPLOYMENT_SKILL_ROLES.includes(role)
		? ["--skill", resolveYanoDeploymentSkillPath(packageRoot)]
		: [];
	const yanoObserverSkillFlags = YANO_OBSERVER_SKILL_ROLES.includes(role)
		? ["--skill", resolveYanoObserverSkillPath(packageRoot)]
		: [];
	const yanoAutoImprovementSkillFlags = YANO_AUTO_IMPROVEMENT_SKILL_ROLES.includes(role)
		? ["--skill", resolveYanoAutoImprovementSkillPath(packageRoot)]
		: [];
	const yanoArchitectSkillFlags = YANO_ARCHITECT_SKILL_ROLES.includes(role)
		? ["--skill", resolveYanoArchitectSkillPath(packageRoot)]
		: [];
	const yanoAiOptimizationSkillFlags = YANO_AI_OPTIMIZATION_SKILL_ROLES.includes(role)
		? ["--skill", resolveYanoAiOptimizationSkillPath(packageRoot)]
		: [];
	const generatedSkillFlags = generatedRole
		? (generatedRole.document.skills || []).flatMap((name) => {
			const skillPath = generatedSkillPath(packageRoot, name);
			return skillPath ? ["--skill", skillPath] : [];
		})
		: [];
	const yanoTraceSkillFlags = ["--skill", resolveYanoPlannerSkillPath(packageRoot)];
	const yanoCliSkillFlags = ["--skill", resolveYanoCliSkillPath(packageRoot)];
	const yanoCodeMemSkillFlags = ["--skill", resolveYanoCodeMemSkillPath(packageRoot)];
	const yanoObserverDryRunSkillFlags = ["--skill", resolveYanoObserverDryRunSkillPath(packageRoot)];
	const allSkillFlags = [...mattPocockSkillFlags, ...yanoTraceSkillFlags, ...yanoCliSkillFlags, ...yanoCodeMemSkillFlags, ...yanoObserverDryRunSkillFlags, ...chromeDevToolsSkillFlags, ...yanoReviewSkillFlags, ...yanoDeploymentSkillFlags, ...yanoObserverSkillFlags, ...yanoAutoImprovementSkillFlags, ...yanoArchitectSkillFlags, ...yanoAiOptimizationSkillFlags, ...generatedSkillFlags];
	const requestedSkillPaths = allSkillFlags.filter((_, index) => index % 2 === 1);
	const skillFlags = explicitSkillPathsWithoutPiConflicts(requestedSkillPaths).flatMap((skillPath) => ["--skill", skillPath]);
	// -e esplicito SOLO in sviluppo del pacchetto stesso (looksLikePackageRepo)
	// — mai per una copia locale residua in un progetto scaffoldato, anche se
	// esiste sul disco (vedi Revisione 38 sopra): l'estensione installata
	// globalmente basta sempre da sola in quel caso. Questa logica di
	// rilevamento vale per QUALUNQUE ruolo (Revisione 44), non solo planner —
	// è esattamente ciò che mancava quando il planner componeva a mano
	// `pi -e extensions/orchestrator.ts` per lanciare altri ruoli.
	const extensionFlags = hasLocalExtension && looksLikePackageRepo ? ["-e", "extensions/orchestrator.ts"] : [];
	const normalizedPassthrough = [...passthrough];
	if (projectFlagIndex >= 0 && normalizedPassthrough[projectFlagIndex + 1] !== undefined) normalizedPassthrough[projectFlagIndex + 1] = traceProject;
	const projectScopeFlags = explicitProject ? [] : ["--project", derivedProject];
	const hasExplicitConfigDir = passthrough.includes("--config-dir");
	const legacyConfigDirFlags = !hasExplicitConfigDir && !existsSync(path.join(cwd, "agents", "roles.yaml")) && existsSync(path.join(cwd, ".pi", "agents", "roles.yaml"))
		? ["--config-dir", path.join(".pi", "agents")]
		: [];
	const generatedConfigFlags = generatedConfigDir && !hasExplicitConfigDir ? ["--config-dir", generatedConfigDir] : [];
	// `yano model-advisor` returns an llmProxy catalog pin such as
	// `z-ai/glm-5.3-flash@openrouter-glm`. Keep the translation to Pi in this
	// launcher so planners never have to mistake the catalog id for a Pi
	// provider (`--provider openrouter-glm` is invalid). The explicit flag is
	// consumed here and becomes the only Pi provider/model pair.
	const llmproxyFlags = llmproxyPin ? ["--provider", "llmproxy", "--model", llmproxyPin] : [];
	const instanceForMcp = passthrough[passthrough.indexOf("--instance") + 1] || null;
	const agentMcpPath = instanceForMcp ? materializeAgentMcp(instanceForMcp) : null;
	const agentMcpFlags = agentMcpPath && !passthrough.includes("--mcp-config") ? ["--mcp-config", agentMcpConfigPath(instanceForMcp)] : [];
	const piArgs = [...extensionFlags, ...normalizedPassthrough, ...projectScopeFlags, ...legacyConfigDirFlags, ...generatedConfigFlags, ...agentMcpFlags, ...llmproxyFlags, "--role", role, ...skillFlags];

	const printable = ["pi", ...piArgs].map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
	if (json) console.log(JSON.stringify({ command: herdr ? "herdr agent start" : "pi", args: piArgs, cwd, trace_mode: traceConfig.mode, project: traceProject, proposal_id: proposalId || null, llmproxy_pin: llmproxyPin || null, playbook_path: generatedRole?.playbookPath || null, role_source: ephemeralRole ? "architect-ephemeral" : (generatedRole ? "architect-catalog" : "project") }));
	else console.log(`launch-planner: comando composto (cwd ${cwd}, trace ${traceConfig.mode}, progetto ${traceProject}):\n  ${printable}\n`);

	if (printOnly) {
		process.exit(0);
	}

	if (herdr) {
		const instance = normalizedPassthrough[normalizedPassthrough.indexOf("--instance") + 1];
		if (!instance) {
			console.error("launch-planner: --herdr richiede --instance <nome>.");
			process.exit(1);
		}
		const snapshotResult = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer: 4_000_000 });
		let snapshot;
		try { snapshot = JSON.parse(snapshotResult.stdout || "")?.result?.snapshot; } catch { /* handled below */ }
		let declaredProjectName = null;
		try { declaredProjectName = JSON.parse(readFileSync(path.join(cwd, ".pi", "extensions", "yano-orchestrator", "config", "project.json"), "utf8")).project || null; } catch { /* legacy/new scaffold fallback below */ }
		const expectedLabels = new Set([traceProject, path.basename(cwd), declaredProjectName].filter(Boolean));
		const workspace = snapshot?.workspaces?.find((item) => expectedLabels.has(item.label) && snapshot.panes?.some((pane) => pane.workspace_id === item.workspace_id && path.resolve(pane.cwd || "") === path.resolve(cwd)));
		if (!workspace?.workspace_id) {
			console.error(`launch-planner: nessun workspace Herdr verificato per ${cwd}; rifiuto di creare ${instance} nel workspace UI corrente.`);
			process.exit(1);
		}
		// Herdr creates an initial tab (often labelled `1`) with a new
		// workspace. Reuse and rename that empty tab instead of creating a
		// useless second tab. A tab containing a live agent is never reused.
		const initialTab = snapshot?.tabs?.find((tab) => tab.workspace_id === workspace.workspace_id && /^(1|\d+)$/.test(tab.label || ""));
		const initialPane = initialTab && snapshot?.panes?.find((pane) => pane.tab_id === initialTab.tab_id);
		const initialAgent = initialPane && snapshot?.agents?.find((agent) => agent.pane_id === initialPane.pane_id);
		let tabResult = null;
		let paneId = null;
		if (initialTab && initialPane && (!initialAgent || ["done", "offline", "unknown"].includes(String(initialAgent.agent_status || "").toLowerCase()))) {
			const renamed = spawnSync("herdr", ["tab", "rename", initialTab.tab_id, instance], { encoding: "utf8", maxBuffer: 1_000_000 });
			if (renamed.status === 0) paneId = initialPane.pane_id;
		}
		if (!paneId) {
			tabResult = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", cwd, "--label", instance, "--no-focus"], { encoding: "utf8", maxBuffer: 1_000_000 });
			try { paneId = JSON.parse(tabResult.stdout || "")?.result?.root_pane?.pane_id; } catch { /* handled below */ }
		}
		if (tabResult.status !== 0 || !paneId) {
			console.error(`launch-planner: Herdr non ha creato una tab isolata per ${instance}: ${(tabResult.stderr || "risposta senza pane").trim()}`);
			process.exit(1);
		}
		const agentName = `${slugify(instance)}-${slugify(traceProject)}`.slice(0, 32);
		const started = spawnSync("herdr", ["agent", "start", agentName, "--kind", "pi", "--pane", paneId, "--", ...piArgs], { cwd, encoding: "utf8", maxBuffer: 4_000_000 });
		if (started.status !== 0) {
			console.error(`launch-planner: Herdr non ha avviato ${instance}: ${(started.stderr || "errore sconosciuto").trim()}`);
			process.exit(1);
		}
		console.log(`launch-planner: ${instance} avviato nel workspace verificato ${workspace.workspace_id}, pane ${paneId}.`);
		return;
	}

	// stdio: "inherit" — planner è una sessione interattiva, deve ereditare
	// il terminale corrente esattamente come un `pi ...` lanciato a mano.
	// cwd: la directory del PROGETTO (non del pacchetto) — vedi commento
	// Revisione 31 in testa al file.
	//
	// shell su Windows (Revisione 32): un `pi` installato via npm su Windows è
	// quasi certamente uno shim `pi.cmd`/`pi.ps1`, non un eseguibile nativo —
	// `child_process.spawn()` NON risolve l'estensione da solo (a differenza
	// della shell dell'utente) e fallirebbe con ENOENT anche se `pi` funziona
	// perfettamente da un prompt aperto a mano. Passare per la shell di
	// sistema (cmd.exe) risolve lo shim correttamente. Limite noto e onesto:
	// Node cita rare stranezze di quoting con `shell: true` su Windows quando
	// un argomento contiene spazi (es. un percorso come "C:\Users\Mario
	// Rossi\..."); non verificato in questa sessione (nessun ambiente
	// Windows disponibile per testarlo) — se capita, la libreria `cross-spawn`
	// è il fix noto (gestisce il quoting di cmd.exe correttamente), non
	// ancora aggiunta come dipendenza per non appesantire il pacchetto senza
	// una verifica reale del problema.
	const child = spawn("pi", piArgs, {
		cwd,
		stdio: "inherit",
		shell: process.platform === "win32",
		// Keep the CLI and every agent launched by the planner on one trace
		// store, even when Pi loads Yano from its own git clone.
		env: {
			...process.env,
			YANO_DATA_DIR: process.env.YANO_DATA_DIR || globalDataPath({ env: process.env }),
			YANO_EXPECTED_TRACE_MODE: requestedTraceMode,
			YANO_EXPECTED_YANO_VERSION: packageVersion,
		},
	});
	child.on("error", (err) => {
		console.error(`launch-planner: impossibile lanciare "pi" (${err.message}) — è nel PATH?`);
		process.exit(1);
	});
	child.on("exit", (code, signal) => {
		process.exit(signal ? 1 : (code ?? 0));
	});
}

// Uso diretto: `node scripts/launch-planner.mjs ...` (dev, dal repo del
// pacchetto — packageRoot e cwd coincidono in questo caso, comportamento
// invariato rispetto a prima della Revisione 31 per questo flusso).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageRoot = path.resolve(__dirname, "..");
	runLaunchPlanner({ packageRoot, cwd: process.cwd(), argv: process.argv.slice(2) });
}
