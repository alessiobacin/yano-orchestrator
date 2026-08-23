#!/usr/bin/env node
// Prepara un progetto nuovo o già esistente per yano-orchestrator, in una
// directory a scelta. Nei progetti già esistenti copia soltanto file Yano
// mancanti e preserva package.json, codice, configurazioni e file applicativi.
//
// Revisione 33 — NON copia più extensions/: da quando l'estensione si
// installa globalmente (`pi extension install`, Revisione 31), `pi` la
// carica automaticamente in OGNI sessione, ovunque — copiarne anche un
// secondo esemplare nel progetto scaffoldato e caricarlo esplicitamente con
// `-e extensions/orchestrator.ts` (come faceva `yano start` prima di questa
// revisione) causa un doppio caricamento: stessi tool/flag registrati due
// volte, `pi` si rifiuta con "Tool ... conflicts with ...". Scoperto da un
// test reale dell'operatore su una macchina Windows nuova — vedi Revisione
// 33 in docs/development-notes.md per il traceback completo e l'analisi. Un
// progetto scaffoldato contiene solo CONFIGURAZIONE (agents/roles.yaml,
// mqtt/, .env.example), mai il codice dell'estensione.
//
// Revisione 47 — NON copia più prompts/ nel progetto: da Revisione 37 a
// Revisione 46 questo script copiava prompts/ dentro
// .pi/extensions/yano-orchestrator/prompts/ del progetto scaffoldato —
// ma quella copia restava STATICA per sempre: `yano update` (Revisione 34)
// aggiornava solo le due copie GLOBALI del pacchetto, mai quella
// per-progetto, quindi un progetto scaffoldato tempo fa restava
// silenziosamente indietro rispetto a ogni correzione di prompt successiva
// (bug reale osservato su un progetto vero — vedi Revisione 46). Ora i
// prompt di ruolo si leggono SEMPRE dal pacchetto installato
// (resolveGlobalPromptsDir() in extensions/orchestrator.ts, risolta dalla
// posizione reale del file caricato — mai da un percorso ipotizzato): un
// progetto scaffoldato non ha più bisogno di una copia propria, e `yano
// update` funziona correttamente senza nessun passo aggiuntivo. Chi vuole
// prompt personalizzati per UN progetto specifico usa `yano copy-prompts`
// (crea la copia locale) e lancia quell'istanza con `yano start ...
// --custom-prompts` (vedi README).
//
// PERCHÉ QUESTO SCRIPT ESISTE INVECE DI UN VERO SUBCOMMAND `pi orchestrator
// init` (richiesta dell'operatore, Revisione 28): non esiste, in questo
// codebase, nessuna evidenza che la CLI `pi` supporti sottocomandi shell
// registrati da un pacchetto/estensione — `pi.registerCommand()` registra
// solo uno slash-command DENTRO una sessione pi già avviata (vedi
// `/orchestrator` in extensions/orchestrator.ts), e `pi.registerFlag()`
// registra solo flag CLI sull'invocazione `pi -e ...`, non nuovi
// sottocomandi. Inventare `pi orchestrator init` come comando shell reale
// sarebbe una funzionalità non verificata — esattamente il tipo di cosa che
// questo progetto evita di documentare come se funzionasse (vedi la
// disciplina "verificato / non verificato" in docs/development-notes.md). Questo
// script è l'equivalente reale, verificato, dello stesso bisogno: un
// comando a riga di comando che prepara un progetto nuovo pronto all'uso.
//
// Revisione 31: la logica qui sotto è ora esportata come runCreateProject()
// e chiamata dal binario globale unificato `yano init` (bin/yano.mjs, campo
// "bin" di package.json) invece di essere un binario a sé
// (`pi-orchestrator-init`, rinominato — vedi docs/development-notes.md Revisione
// 31). Restano invariati sia l'uso diretto via `node scripts/create-project.mjs`
// sia tutta la logica di scaffolding.
//
// Uso:
//   node scripts/create-project.mjs --name "URL Shortener" [--target <dir>] [--force]
//   yano init --name "URL Shortener" [--target <dir>] [--force]   (dopo `npm install -g` o `npm link`)
//   yano init --name "Applicazione Esistente"                  (adotta la cwd in-place)
//
// --target di default (Revisione 31): la directory CORRENTE, in place — NON
// più una sottocartella nuova (scelta esplicita dell'operatore: "inizializza
// in place nella cartella corrente"). Passa --target <dir> per il vecchio
// comportamento (scaffold in una sottocartella dedicata).
// --force permette di scrivere in una directory --target già esistente e
// non vuota (di norma lo script si rifiuta, per non rischiare di
// sovrascrivere lavoro esistente) — una directory che contiene SOLO una
// `.git/` (es. dopo `mkdir progetto && cd progetto && git init`) non conta
// come "non vuota" ai fini di questo controllo, per non costringere
// all'uso di --force nel caso comune dello scaffolding in place. Per un
// progetto già esistente inizializzato in-place il controllo è volutamente
// non bloccante: l'infrastruttura viene aggiunta con merge non distruttivo.

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor, ensurePlaywrightPrerequisites, ensureCorePrerequisites, ensureEmbeddingPrerequisites, isSupportedNodeRuntime } from "./doctor.mjs";
import { runHerdrInit } from "./init-herdr.mjs";

function parseArgs(argv) {
	let name;
	let target;
	let force = false;
	let llmp = false;
	let herdr = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--name") name = argv[++i];
		else if (a === "--target") target = argv[++i];
		else if (a === "--force") force = true;
		else if (a === "--llmp") llmp = true;
		else if (a === "--herdr") herdr = true;
		else if (a === "--help" || a === "-h") {
			printUsage();
			process.exit(0);
		} else {
			console.error(`create-project: argomento non riconosciuto "${a}" (vedi --help).`);
			process.exit(1);
		}
	}
	return { name, target, force, llmp, herdr };
}

function printUsage() {
	console.log(
		[
			'Uso: yano init --name "<Nome Progetto>" [--target <dir>] [--force] [--llmp] [--herdr]',
			'     (in locale, senza npm install -g: node scripts/create-project.mjs --name "<Nome Progetto>" [--target <dir>] [--force] [--llmp] [--herdr])',
			"",
			'  --name    Nome del progetto (obbligatorio) — per un progetto esistente viene scritto solo nella',
			"            configurazione Yano: il package.json applicativo già presente non viene mai sovrascritto.",
			"  --target  Directory da scaffoldare (default: la directory CORRENTE, in place). Se passato,",
			"            scaffolda invece in quella sottocartella/percorso (creandolo se non esiste).",
			"  --force   Permette di usare --target su una directory già esistente e non vuota",
			"            (una directory che contiene solo \".git\" non conta come non vuota); con --llmp,",
			"            permette anche di sovrascrivere .pi/agent/models.json e settings.json già esistenti.",
			"            In-place su un progetto esistente yano init è già non distruttivo e non richiede --force.",
			"  --llmp    Scrive anche .pi/agent/models.json e .pi/agent/settings.json, configurazione locale",
			'            di `pi` per un llmproxy su http://127.0.0.1:7045 (provider "llmproxy", tema dark) —',
			"            utile se usi un proxy LLM locale invece di un provider cloud diretto.",
			"  --herdr   Crea/riusa e porta in primo piano un workspace Herdr con il nome della cartella",
			"            corrente, avvia lì `yano init` seguito dal planner-01 e apre/aggancia il client Herdr",
			"            se il comando parte da un terminale normale. Richiede init in place: non usare --target.",
			"",
			"Progetto esistente: yano init aggiunge solo file Yano mancanti, preserva codice, package.json,",
			"configurazioni e .env.example; se root agents/ è già dell'applicazione, usa .pi/agents/ per il roster Yano.",
		].join("\n"),
	);
}

function slugify(s) {
	return (
		s
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "") // strip combining diacritics (é -> e, etc.)
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "progetto"
	);
}

function nowIso() {
	return new Date().toISOString();
}

function copyDirMissing(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const source = path.join(src, entry.name);
		const destination = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			if (fs.existsSync(destination) && !fs.statSync(destination).isDirectory()) continue;
			copyDirMissing(source, destination);
		} else if (!fs.existsSync(destination)) {
			fs.copyFileSync(source, destination);
		}
	}
}

function copyFileMissing(source, destination) {
	if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(source, destination);
	return true;
}

function resolveAgentsDestination(targetDir) {
	const rootAgents = path.join(targetDir, "agents");
	const rootRoster = path.join(rootAgents, "roles.yaml");
	const existingLegacyAgents = path.join(targetDir, ".pi", "agents");
	const existingLegacyRoster = path.join(existingLegacyAgents, "roles.yaml");
	if (!fs.existsSync(rootAgents) && fs.existsSync(existingLegacyRoster)) return existingLegacyAgents;
	if (fs.existsSync(rootAgents) && !fs.existsSync(rootRoster) && fs.readdirSync(rootAgents).length > 0) {
		// An application may already own a root `agents/` directory. Keep it
		// untouched and place Yano's roster in the supported project-local
		// compatibility location instead of polluting the application folder.
		return existingLegacyAgents;
	}
	return rootAgents;
}

function ensureGitignore(targetDir) {
	const file = path.join(targetDir, ".gitignore");
	const required = ["node_modules/", ".worktrees/", ".env", ".pi/", "*.db", "*.db-journal"];
	if (!fs.existsSync(file)) {
		fs.writeFileSync(file, `${required.join("\n")}\n`);
		return;
	}
	const current = fs.readFileSync(file, "utf8");
	const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
	const missing = required.filter((entry) => !lines.has(entry));
	if (missing.length) fs.appendFileSync(file, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${missing.join("\n")}\n`);
}

async function ensureMcpCredentials(targetDir) {
	const candidates = [path.join(targetDir, ".mcp.json"), path.join(targetDir, ".pi", "mcp.json")];
	const activePath = candidates.find((candidate) => fs.existsSync(candidate));
	if (!activePath) return true;
	let config;
	try {
		config = JSON.parse(fs.readFileSync(activePath, "utf8"));
	} catch (error) {
		console.error(`yano init: configurazione MCP non leggibile (${activePath}): ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
	const pending = [];
	for (const [serverName, server] of Object.entries(config.mcpServers ?? {})) {
		const headers = server && typeof server === "object" ? server.headers : null;
		if (!headers || typeof headers !== "object") continue;
		for (const [header, value] of Object.entries(headers)) {
			if (/api[-_]?key/i.test(header) && (!value || String(value).includes("<YOUR_"))) pending.push({ serverName, header });
		}
	}
	if (!pending.length) return true;
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error(`yano init: manca la chiave MCP per ${pending.map((item) => `${item.serverName}.${item.header}`).join(", ")}. Esegui l'init in un terminale interattivo oppure valorizza manualmente ${activePath} e ripeti.`);
		return false;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		for (const item of pending) {
			const answer = (await rl.question(`Inserisci la chiave MCP ${item.serverName} (${item.header}): `)).trim();
			if (!answer) {
				console.error(`yano init: chiave MCP ${item.serverName}.${item.header} vuota — nessun file è stato modificato.`);
				return false;
			}
			config.mcpServers[item.serverName].headers[item.header] = answer;
		}
	} finally {
		rl.close();
	}
	const temporaryPath = `${activePath}.yano-init-tmp-${process.pid}`;
	fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporaryPath, activePath);
	return true;
}

function mergeEssentialMcpServers(targetDir, packageRoot) {
	const activePath = [path.join(targetDir, ".mcp.json"), path.join(targetDir, ".pi", "mcp.json")].find((candidate) => fs.existsSync(candidate));
	if (!activePath) return true;
	const examplePath = path.join(packageRoot, "mcp.json.example");
	try {
		const current = JSON.parse(fs.readFileSync(activePath, "utf8"));
		const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
		current.mcpServers ??= {};
		let changed = false;
		for (const [name, definition] of Object.entries(example.mcpServers ?? {})) {
			if (!current.mcpServers[name]) {
				current.mcpServers[name] = definition;
				changed = true;
			}
		}
		if (!changed) return true;
		const temporaryPath = `${activePath}.yano-init-mcp-${process.pid}`;
		fs.writeFileSync(temporaryPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporaryPath, activePath);
		return true;
	} catch (error) {
		console.error(`yano init: impossibile aggiungere i MCP essenziali (${activePath}): ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

// runCreateProject({ packageRoot, cwd, argv }) — packageRoot è la directory
// del pacchetto yano-orchestrator installato (da cui copiare
// extensions/agents/prompts/mqtt/.env.example/check-syntax.mjs); cwd è la
// directory dell'operatore (default per --target, Revisione 31: in place,
// non più una sottocartella — vedi commento in testa al file); argv sono gli
// argomenti (senza node/nome-script).
export async function runCreateProject({ packageRoot, cwd, argv, preflightTools = {} }) {
	const {
		ensurePlaywright = ensurePlaywrightPrerequisites,
		ensureCore = ensureCorePrerequisites,
		ensureEmbeddings = ensureEmbeddingPrerequisites,
		doctor = runDoctor,
	} = preflightTools;
	const { name, target, force, llmp, herdr } = parseArgs(argv);
	if (!name) {
		console.error("create-project: --name è obbligatorio (vedi --help).");
		process.exit(1);
	}
	if (herdr) {
		if (target) {
			console.error("yano init --herdr: --target non è supportato; esegui il comando dalla directory che deve diventare il workspace Herdr.");
			process.exitCode = 1;
			return;
		}
		const innerArgs = argv.filter((arg) => arg !== "--herdr");
		runHerdrInit({ cwd, initArgs: innerArgs });
		return;
	}
	const slug = slugify(name);
	const inPlace = !target;
	const targetDir = path.resolve(target ? path.resolve(cwd, target) : cwd);

	if (fs.existsSync(targetDir)) {
		// Una directory che contiene solo ".git" (es. dopo `mkdir progetto &&
		// cd progetto && git init`, il flusso più comune prima di `yano init` in
		// place) non conta come "non vuota" — altrimenti --force servirebbe
		// quasi sempre nel caso d'uso di default (Revisione 31).
		const existing = fs.readdirSync(targetDir).filter((e) => e !== ".git");
		if (existing.length > 0 && target && !force) {
			console.error(`create-project: "${targetDir}" esiste già e non è vuota — usa --force per scrivere comunque, o scegli un --target diverso.`);
			process.exit(1);
		}
	}

	// Deterministic preflight MUST precede every write. A failed dependency
	// check must not leave a half-scaffolded project behind; the operator gets
	// the exact doctor diagnostics and can fix the machine before retrying the
	// same command. Installation of system-level tools remains explicit and
	// version-controlled by the operator (doctor prints the platform command).
	if (!isSupportedNodeRuntime()) {
		console.error(`yano init: Node.js ${process.version} non supportato — serve Node 22.5.0 o superiore. Nessun file di scaffold è stato scritto.`);
		process.exitCode = 1;
		return;
	}
	const playwright = ensurePlaywright({ install: true });
	if (!playwright.ok) {
		console.error("yano init: prerequisiti Playwright non installabili — nessun file di scaffold è stato scritto.");
		console.error(`  CLI: ${playwright.cli.hint}`);
		console.error(`  skill: ${playwright.skill.hint}`);
		process.exitCode = 1;
		return;
	}
	const core = ensureCore({ packageRoot, cwd: targetDir, install: true });
	if (!core.ok) {
		console.error("yano init: skill/MCP prerequisiti non installabili — nessun file di scaffold è stato scritto.");
		for (const skill of core.skills.filter((item) => !item.ok)) console.error(`  skill ${skill.name}: installa da ${skill.repo}`);
		if (!core.mcp.adapter) console.error("  MCP adapter: pi install npm:pi-mcp-adapter");
		if (!core.mcp.chromePackage) console.error("  MCP chrome-devtools: npx -y chrome-devtools-mcp@latest --help");
		if (!core.mcp.githubEndpoint) console.error("  MCP GitHub: endpoint non raggiungibile; verifica connessione e accesso OAuth");
		process.exitCode = 1;
		return;
	}
	const embeddings = await ensureEmbeddings({ install: true });
	if (!embeddings.ok) {
		console.error("yano init: prerequisiti embeddings non disponibili — nessun file di scaffold è stato scritto.");
		console.error(`  Ollama: ${embeddings.cli.detail}`);
		console.error(`  server: ${embeddings.server.detail}`);
		console.error(`  modello: ${embeddings.modelCheck.detail}`);
		console.error(`  probe: ${embeddings.probe.detail}`);
		process.exitCode = 1;
		return;
	}
	if (!(await ensureMcpCredentials(targetDir))) {
		console.error("yano init: preflight credenziali fallito — nessun file di scaffold è stato scritto.");
		process.exitCode = 1;
		return;
	}
	if (!mergeEssentialMcpServers(targetDir, packageRoot)) {
		console.error("yano init: preflight MCP fallito — nessun file di scaffold è stato scritto.");
		process.exitCode = 1;
		return;
	}
	const doctorResult = await doctor({ cwd: targetDir, autoStartBroker: true, packageRoot });
	if (!doctorResult.ok) {
		console.error("yano init: preflight fallito — nessun file è stato scritto. Risolvi i prerequisiti indicati sopra e ripeti lo stesso comando.");
		process.exitCode = 1;
		return;
	}
	fs.mkdirSync(targetDir, { recursive: true });

	const adoptingExistingProject = inPlace && fs.readdirSync(targetDir).some((entry) => entry !== ".git");
	console.log(`create-project: ${adoptingExistingProject ? "inizializzo il progetto esistente" : "creo il progetto"} "${name}" in ${targetDir}${inPlace ? " (in place)" : ""}`);

	// 1. Copia SOLO configurazione (agents/mqtt qui, prompts/ poco più sotto
	//    con una destinazione diversa — vedi quel commento) dal pacchetto —
	//    MAI extensions/ (Revisione 33, vedi commento in testa al file: il
	//    codice dell'estensione vive nel pacchetto installato globalmente,
	//    `pi` lo carica da lì in automatico) e MAI il package.json del
	//    pacchetto stesso (motivo per cui questo script esiste: evitare che
	//    un progetto nuovo erediti l'identità/il nome del pacchetto invece
	//    del proprio, il problema reale osservato in yano-test-project — vedi
	//    docs/development-notes.md, Revisione 28).
	const agentsDestination = resolveAgentsDestination(targetDir);
	for (const dir of ["mqtt"]) {
		const src = path.join(packageRoot, dir);
		if (fs.existsSync(src)) copyDirMissing(src, path.join(targetDir, dir));
	}
	const packagedAgents = path.join(packageRoot, "agents");
	if (fs.existsSync(packagedAgents)) copyDirMissing(packagedAgents, agentsDestination);
	const envExample = path.join(packageRoot, ".env.example");
	copyFileMissing(envExample, path.join(targetDir, ".env.example"));

	// Revisione 49 — il template MCP diventa attivo automaticamente: i server
	// essenziali sono parte del preflight e devono essere disponibili a ogni
	// progetto. `.mcp.json` (o `.pi/mcp.json`) è letto da pi-mcp-adapter.
	// Questo script copia anche una versione `.example` per riferimento. Il
	// server resta tecnicamente disponibile a qualunque ruolo: Pi non offre
	// scope MCP per ruolo.
	const mcpExample = path.join(packageRoot, "mcp.json.example");
	if (fs.existsSync(mcpExample)) {
		copyFileMissing(mcpExample, path.join(targetDir, "mcp.json.example"));
		copyFileMissing(mcpExample, path.join(targetDir, ".mcp.json.example"));
		const activeMcp = path.join(targetDir, ".mcp.json");
		if (!fs.existsSync(activeMcp)) {
			fs.copyFileSync(mcpExample, activeMcp);
			fs.chmodSync(activeMcp, 0o600);
		}
	}

	// Playbook package assets are copied into the project's runtime workspace
	// as an explicit, inspectable local baseline. Never source them from an
	// ignored package path at runtime: yano init owns this deterministic copy.
	const packagedPlaybooks = path.join(packageRoot, "playbooks");
	const projectPlaybooks = path.join(targetDir, ".pi", "extensions", "yano-orchestrator", "playbooks");
	if (fs.existsSync(packagedPlaybooks) && !fs.existsSync(projectPlaybooks)) {
		copyDirMissing(packagedPlaybooks, projectPlaybooks);
	}

	// Revisione 47: prompts/ NON viene più copiato qui — vedi il commento in
	// testa al file. Un progetto scaffoldato non ha una propria cartella
	// prompts/ finché non si esegue `yano copy-prompts` (facoltativo, solo per
	// chi vuole personalizzare i prompt di UN progetto specifico).

	// 2. package.json minimo, specifico del progetto. Per un progetto già
	//    esistente è intoccabile: package manager, framework e identità
	//    applicativa appartengono al progetto, non all'infrastruttura Yano.
	//    identità/metadata (Revisione 33: nessuna dipendenza da installare
	//    per far girare l'estensione, dato che il codice e le sue
	//    dipendenze npm vivono nell'installazione globale del pacchetto, non
	//    qui — `npm install` non è più un passo necessario in un progetto
	//    scaffoldato di default).
	const projectPkg = {
		name: slug,
		version: "0.1.0",
		private: true,
		type: "module",
		description: `Progetto "${name}", orchestrato con yano-orchestrator.`,
	};
	const packageJsonPath = path.join(targetDir, "package.json");
	if (!fs.existsSync(packageJsonPath)) fs.writeFileSync(packageJsonPath, `${JSON.stringify(projectPkg, null, 2)}\n`);

	// 3. Pre-scrivi config/project.json con il nome scelto — così il primo
	//    orchestrator_init lo trova già impostato e il planner non deve
	//    chiederlo all'utente (vedi prompts/planner.md, "Layer ticket/DAG
	//    persistente", Revisione 28). Schema minimo, coerente con
	//    YanoProjectConfig in extensions/orchestrator.ts, ma senza importare
	//    quel file (troppo pesante per uno script di scaffolding — si
	//    connetterebbe a MQTT): se lo schema di project.json cambia in una
	//    revisione futura, orchestrator_init lo aggiorna comunque da solo al
	//    primo utilizzo (creazione idempotente, mai distruttiva).
	const yanoConfigDir = path.join(targetDir, ".pi", "extensions", "yano-orchestrator", "config");
	fs.mkdirSync(yanoConfigDir, { recursive: true });
	const projectJsonPath = path.join(yanoConfigDir, "project.json");
	if (!fs.existsSync(projectJsonPath)) {
		fs.writeFileSync(
			projectJsonPath,
			`${JSON.stringify({ schema_version: 1, extension_version: "pre-init", project: name, created_at: nowIso(), updated_at: nowIso() }, null, 2)}\n`,
		);
	}

	// 3bis. --llmp (Revisione 36, richiesto dall'operatore): scrive la
	//    configurazione LOCALE di `pi` per un llmproxy in
	//    <targetDir>/.pi/agent/{models,settings}.json — `pi` legge un `.pi/`
	//    project-local in aggiunta a quello globale in home (già osservato in
	//    Revisione 31: un `.pi/` dentro un checkout dell'operatore conteneva
	//    proprio impostazioni locali di `pi`, incluse le credenziali del suo
	//    proxy LLM), quindi questo è lo stesso meccanismo, non un'invenzione.
	//    Contenuto FISSO, fornito esplicitamente dall'operatore — non generato:
	//    provider "llmproxy" su http://127.0.0.1:7045 con una apiKey segnaposto
	//    ("proxy-local", non un vero segreto — un proxy locale in loopback non
	//    ne ha bisogno, il valore serve solo perché `pi` si aspetta il campo).
	//    Idempotente come il resto dello scaffold: non sovrascrive file già
	//    esistenti a meno di --force (evita di disfare una configurazione che
	//    l'operatore ha già personalizzato a mano).
	if (llmp) {
		const agentDir = path.join(targetDir, ".pi", "agent");
		fs.mkdirSync(agentDir, { recursive: true });

		const modelsPath = path.join(agentDir, "models.json");
		const settingsPath = path.join(agentDir, "settings.json");
		const modelsContent = {
			providers: {
				llmproxy: {
					api: "anthropic-messages",
					baseUrl: "http://127.0.0.1:7045",
					apiKey: "proxy-local",
					models: [{ id: "llmproxy", name: "llmProxy", contextWindow: 1000000 }],
				},
			},
		};
		const settingsContent = {
			theme: "dark",
			defaultProvider: "llmproxy",
			defaultModel: "llmproxy",
		};

		const skipped = [];
		if (force || !fs.existsSync(modelsPath)) {
			fs.writeFileSync(modelsPath, `${JSON.stringify(modelsContent, null, 2)}\n`);
		} else {
			skipped.push(modelsPath);
		}
		if (force || !fs.existsSync(settingsPath)) {
			fs.writeFileSync(settingsPath, `${JSON.stringify(settingsContent, null, 2)}\n`);
		} else {
			skipped.push(settingsPath);
		}

		console.log(`create-project: --llmp — configurazione pi/llmproxy scritta in ${agentDir}`);
		if (skipped.length > 0) {
			console.log(`create-project: (già presenti, non sovrascritti: ${skipped.join(", ")} — usa --force per sovrascriverli)`);
		}
	}

	// 4. .gitignore minimo (worktree/node_modules), git init se non è già un
	//    repo — richiesto per l'isolamento in worktree (docs/development-notes.md,
	//    Revisioni 13/14).
	// .pi/ qui è la workspace runtime dell'estensione nel progetto scaffoldato
	// (SQLite, config, specs, report e trace locali), non codice applicativo.
	// In un progetto esistente le regole mancanti vengono aggiunte in coda,
	// senza sostituire il .gitignore del progetto.
	ensureGitignore(targetDir);
	if (!fs.existsSync(path.join(targetDir, ".git"))) {
		try {
			execFileSync("git", ["init"], { cwd: targetDir, stdio: "ignore" });
			console.log("create-project: repo git inizializzato.");
		} catch (err) {
			console.warn(`create-project: \`git init\` non riuscito (${err instanceof Error ? err.message : String(err)}) — inizializzalo tu a mano, serve per l'isolamento in worktree.`);
		}
	}

	// Auto-discovery del sistema operativo (Revisione 32, richiesto
	// dall'operatore): il comando di copia e le opzioni broker suggerite
	// cambiano tra Windows e macOS/Linux — invece di scrivere un'unica riga
	// che funziona ovunque (impossibile: `cp` non esiste su cmd.exe, `copy`
	// non esiste su bash), lo script rileva `process.platform` e stampa il
	// comando giusto per CHI lo sta eseguendo, senza che l'operatore debba
	// tradurlo a mano — vedi anche README, sezione "Installazione su
	// Windows", per l'equivalente completo in PowerShell.
	const isWindows = process.platform === "win32";
	const copyEnvCmd = isWindows ? "copy .env.example .env" : "cp .env.example .env";

	console.log("");
	console.log(`Fatto. Prossimi passi${inPlace ? "" : ` (cd ${targetDir})`}:`);
	console.log(`  ${copyEnvCmd}   # facoltativo, per la notifica WhatsApp di fine task`);
	console.log(
		"  .mcp.json è già attivo: chrome-devtools e GitHub MCP sono stati dichiarati automaticamente; autentica GitHub alla prima connessione",
	);
	console.log("  docker compose -f mqtt/compose.yaml up -d   # broker MQTT locale (Docker Desktop su Windows), oppure punta --broker a uno esistente");
	if (isWindows) {
		console.log("  # senza Docker Desktop: installa Mosquitto nativo (https://mosquitto.org/download/ o `winget install EclipseFoundation.Mosquitto`)");
		console.log("  #   poi: mosquitto -c mqtt\\mosquitto.native.conf   (in una finestra PowerShell separata)");
	}
	console.log("  yano start --instance planner-01   # planner SEMPRE così, mai `pi` a mano — vedi sotto");
	console.log("");
	console.log("IMPORTANTE — planner va lanciato SOLO con `yano start`, mai con `pi --instance planner-01 --role planner` a mano:");
	console.log("`yano start` è l'unico modo in cui le skill vendorizzate di mattpocock (Wayfinder/To-Spec, più grilling/domain-modeling");
	console.log("che invocano) vengono cablate nella sessione, dall'installazione globale del pacchetto (non dal progetto scaffoldato —");
	console.log("questo scaffold non le include). Lanciato a mano, il planner parte comunque ma senza quelle skill: usa in automatico un");
	console.log("metodo di scoping equivalente ma più semplice, integrato nel suo prompt (vedi Revisione 38 in docs/development-notes.md).");
	console.log("coder/specialisti non hanno bisogno di questo — per loro basta `yano start --instance <nome> --role <ruolo>` (Revisione 44");
	console.log("— nessun `-e` a mano, funziona per qualunque ruolo esattamente come per planner, senza le skill mattpocock). reviewer e");
	console.log("Frontend Developer e frontend-reviewer invece SI: `yano start` cabla la skill chrome-devtools e la CLI Playwright —");
	console.log("lanciati a mano restano funzionanti ma senza quella skill (e senza sapere come usare il server MCP omonimo, se configurato");
	console.log("in .mcp.json — vedi sopra). oppure `pi --instance <nome> --role <ruolo>` direttamente, MAI `pi -e extensions/orchestrator.ts");
	console.log("...`: questo scaffold non include più quel file (Revisione 33), l'estensione si carica da sola dall'installazione globale.");
	console.log("Il planner userà gli 8 tool del layer ticket/DAG di default fin dal primo task.");
	console.log("");
	console.log("I prompt di ruolo (planner/coder/reviewer/specialisti) si leggono SEMPRE dal pacchetto installato (Revisione 47) — un");
	console.log("`yano update` li aggiorna per questo progetto senza nessun passo in più. Per personalizzarli SOLO per questo progetto:");
	console.log("`yano copy-prompts` (copia i prompt correnti in .pi/extensions/yano-orchestrator/prompts/, poi modificali), quindi");
	console.log("lancia quell'istanza con `yano start --instance <nome> --role <ruolo> --custom-prompts` per usarli davvero.");
}

// Uso diretto: `node scripts/create-project.mjs ...` (dev, dal repo del pacchetto).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	runCreateProject({ packageRoot: path.resolve(__dirname, ".."), cwd: process.cwd(), argv: process.argv.slice(2) });
}
