#!/usr/bin/env node
// `yano doctor` — verifica che l'ambiente abbia tutto il necessario per far
// girare yano-orchestrator, e per ciò che manca stampa un'istruzione di
// installazione specifica per il sistema operativo rilevato
// (`process.platform`) invece di un'unica lista generica.
//
// PERCHÉ QUESTO SCRIPT ESISTE (Revisione 33): richiesto dall'operatore dopo
// un test reale su una macchina Windows nuova — l'unico modo per scoprire
// che mancava un prerequisito era un errore criptico più a valle (spesso
// dentro `pi` stesso, non dentro questo pacchetto). Questo script sposta
// quella scoperta all'inizio, prima che qualunque cosa venga lanciata.
//
// Verifica: Node.js (già garantito se questo script gira, ma la versione è
// comunque riportata), git (richiesto per l'isolamento in worktree), `pi`
// (richiesto per lanciare qualunque istanza — questo pacchetto non gestisce
// la sua installazione, vedi nota onesta sotto), e un modo per far girare un
// broker MQTT: Docker con il daemon attivo (per `docker compose`), OPPURE
// Mosquitto nativo sul PATH, OPPURE un broker già raggiungibile su
// 127.0.0.1:1883 (qualcuno potrebbe già averne uno acceso altrove).
//
// Uso:
//   node scripts/doctor.mjs   (anche: yano doctor — e automaticamente in coda a `yano init`)
//
// Nota onesta: questo script NON verifica che `pi`, una volta trovato sul
// PATH, sia della versione giusta o configurato correttamente — controlla
// solo che il comando risolva. Non installa nulla da solo: stampa solo cosa
// manca e come installarlo, la decisione e l'esecuzione restano
// all'operatore (evita di richiedere permessi di sistema/sudo a sua
// insaputa).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const PLAYWRIGHT_CLI_PACKAGE = "@playwright/cli@latest";
const PLAYWRIGHT_CLI_SKILL_REPO = "https://github.com/microsoft/playwright-cli";
const MATT_SKILLS_REPO = "https://github.com/mattpocock/skills";
const CHROME_SKILLS_REPO = "https://github.com/github/awesome-copilot";
const ESSENTIAL_SKILLS = [
	{ name: "wayfinder", repo: MATT_SKILLS_REPO, vendored: true },
	{ name: "to-spec", repo: MATT_SKILLS_REPO, vendored: true },
	{ name: "grilling", repo: MATT_SKILLS_REPO, vendored: true },
	{ name: "domain-modeling", repo: MATT_SKILLS_REPO, vendored: true },
	{ name: "setup-matt-pocock-skills", repo: MATT_SKILLS_REPO, vendored: true },
	{ name: "code-review", repo: MATT_SKILLS_REPO },
	{ name: "chrome-devtools", repo: CHROME_SKILLS_REPO },
	{ name: "playwright-cli", repo: PLAYWRIGHT_CLI_SKILL_REPO },
];
const ESSENTIAL_MCP_SERVERS = ["chrome-devtools", "github"];
const LAZY_SKILL_SOURCES = {
	"playwright-cli": PLAYWRIGHT_CLI_SKILL_REPO,
	"chrome-devtools": CHROME_SKILLS_REPO,
	"code-review": MATT_SKILLS_REPO,
	wayfinder: MATT_SKILLS_REPO,
	"to-spec": MATT_SKILLS_REPO,
	grilling: MATT_SKILLS_REPO,
	"domain-modeling": MATT_SKILLS_REPO,
	"setup-matt-pocock-skills": MATT_SKILLS_REPO,
};
const LAZY_CLI_INSTALLERS = {
	"playwright-cli": ["npm", ["install", "-g", PLAYWRIGHT_CLI_PACKAGE]],
	postman: ["npm", ["install", "-g", "postman-cli"]],
};

function playwrightSkillPaths() {
	const roots = [
		process.env.HOME ? path.join(process.env.HOME, ".agents", "skills") : null,
		process.env.HOME ? path.join(process.env.HOME, ".codex", "skills") : null,
	].filter(Boolean);
	return roots.map((root) => path.join(root, "playwright-cli", "SKILL.md"));
}

function hasPlaywrightSkill() {
	return playwrightSkillPaths().some((file) => {
		try { return fs.readFileSync(file, "utf8").trim().length >= 20; } catch { return false; }
	});
}

function skillFile(name, packageRoot) {
	const readable = (file) => {
		try { return fs.readFileSync(file, "utf8").trim().length >= 20; } catch { return false; }
	};
	const globalFile = [
		process.env.HOME ? path.join(process.env.HOME, ".agents", "skills", name, "SKILL.md") : null,
		process.env.HOME ? path.join(process.env.HOME, ".codex", "skills", name, "SKILL.md") : null,
	].find((file) => file && readable(file));
	if (globalFile) return globalFile;
	if (packageRoot) {
		const vendorRoots = [path.join(packageRoot, "skills-vendor", "mattpocock", name), path.join(packageRoot, "skills-vendor", "awesome-copilot", name)];
		const vendorFile = vendorRoots.map((root) => path.join(root, "SKILL.md")).find(readable);
		if (vendorFile) return vendorFile;
	}
	return null;
}

function checkEssentialSkills(packageRoot) {
	return ESSENTIAL_SKILLS.map((spec) => ({ ...spec, path: skillFile(spec.name, packageRoot), ok: Boolean(skillFile(spec.name, packageRoot)) }));
}

function checkPiMcpAdapter() {
	try {
		const result = spawnSync("pi", ["list"], { encoding: "utf8", timeout: 10_000 });
		return result.status === 0 && /pi-mcp-adapter/.test(`${result.stdout}\n${result.stderr}`);
	} catch { return false; }
}

function checkMcpServerPackage() {
	try {
		const result = spawnSync("npx", ["-y", "chrome-devtools-mcp@latest", "--help"], { stdio: "ignore", timeout: 30_000 });
		return result.status === 0;
	} catch { return false; }
}

function checkHttpEndpoint(url) {
	try {
		const result = spawnSync("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", url], { encoding: "utf8", timeout: 15_000 });
		const status = Number.parseInt(result.stdout, 10);
		return result.status === 0 && Number.isFinite(status) && status >= 200 && status < 500;
	} catch { return false; }
}

function readMcpConfig(cwd) {
	const candidates = [path.join(cwd, ".mcp.json"), path.join(cwd, ".pi", "mcp.json")];
	const file = candidates.find((candidate) => fs.existsSync(candidate));
	if (!file) return { file: null, servers: {} };
	try { return { file, servers: JSON.parse(fs.readFileSync(file, "utf8")).mcpServers ?? {} }; } catch { return { file, servers: {}, invalid: true }; }
}

function ensureDeclaredMcp(cwd, packageRoot, server) {
	const current = readMcpConfig(cwd);
	if (Object.hasOwn(current.servers, server)) return true;
	if (!packageRoot || !["github", "chrome-devtools"].includes(server)) return false;
	const example = path.join(packageRoot, "mcp.json.example");
	try {
		const template = JSON.parse(fs.readFileSync(example, "utf8"));
		const target = current.file ?? path.join(cwd, ".mcp.json");
		const merged = { ...(current.file ? JSON.parse(fs.readFileSync(target, "utf8")) : {}), mcpServers: { ...(current.servers ?? {}), ...(template.mcpServers ?? {}) } };
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
		return Object.hasOwn(merged.mcpServers, server);
	} catch {
		return false;
	}
}

export function ensureCorePrerequisites({ packageRoot, cwd, install = false } = {}) {
	const skills = checkEssentialSkills(packageRoot);
	const missingSkills = skills.filter((skill) => !skill.ok);
	if (install && missingSkills.length) {
		for (const skill of missingSkills) {
			const installed = runInstall("npx", ["-y", "skills", "add", skill.repo, "--skill", skill.name, "--global", "--yes"]);
			if (!installed) console.error(`yano init: installazione skill fallita: ${skill.name}`);
		}
	}
	const afterSkills = checkEssentialSkills(packageRoot);
	let adapter = checkPiMcpAdapter();
	if (install && !adapter) {
		console.log("yano init: installo pi-mcp-adapter...");
		adapter = runInstall("pi", ["install", "npm:pi-mcp-adapter"]) && checkPiMcpAdapter();
	}
	const chromePackage = checkMcpServerPackage();
	const githubEndpoint = checkHttpEndpoint("https://api.githubcopilot.com/mcp/");
	const mcp = readMcpConfig(cwd ?? process.cwd());
	const declared = ESSENTIAL_MCP_SERVERS.filter((name) => Object.hasOwn(mcp.servers, name));
	return {
		ok: afterSkills.every((skill) => skill.ok) && adapter && chromePackage && githubEndpoint && (!mcp.file || declared.length === ESSENTIAL_MCP_SERVERS.length || install),
		skills: afterSkills,
		mcp: { adapter, chromePackage, githubEndpoint, config: mcp.file, declared, missing: ESSENTIAL_MCP_SERVERS.filter((name) => !declared.includes(name)) },
	};
}

function runInstall(command, args) {
	return spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", timeout: 120_000 }).status === 0;
}

// Installs the two frontend prerequisites idempotently. This is deliberately
// separate from runDoctor: doctor remains read-only, while every `yano init`
// calls this function before scaffolding so a partial project is never created.
export function ensurePlaywrightPrerequisites({ install = false } = {}) {
	let cliOk = commandExists("playwright-cli", ["--help"]);
	let skillOk = hasPlaywrightSkill();
	if (install && !cliOk) {
		console.log(`yano init: installo ${PLAYWRIGHT_CLI_PACKAGE} globalmente...`);
		cliOk = runInstall("npm", ["install", "-g", PLAYWRIGHT_CLI_PACKAGE]) && commandExists("playwright-cli", ["--help"]);
	}
	if (install && !skillOk) {
		console.log(`yano init: installo la skill playwright-cli da ${PLAYWRIGHT_CLI_SKILL_REPO}...`);
		skillOk = runInstall("npx", ["-y", "skills", "add", PLAYWRIGHT_CLI_SKILL_REPO, "--skill", "playwright-cli", "--global", "--yes"]) && hasPlaywrightSkill();
	}
	return {
		ok: cliOk && skillOk,
		cli: { name: "playwright-cli", ok: cliOk, hint: `npm install -g ${PLAYWRIGHT_CLI_PACKAGE}` },
		skill: { name: "playwright-cli", ok: skillOk, hint: `npx -y skills add ${PLAYWRIGHT_CLI_SKILL_REPO} --skill playwright-cli --global --yes` },
	};
}

function readRoleConfig(packageRoot, cwd, role) {
	const candidates = [path.join(cwd ?? process.cwd(), "agents", "roles.yaml"), path.join(packageRoot ?? "", "agents", "roles.yaml")];
	const file = candidates.find((candidate) => fs.existsSync(candidate));
	if (!file) return null;
	try { return parseYaml(fs.readFileSync(file, "utf8"))?.roles?.[role] ?? null; } catch { return null; }
}

// Lazy, role-scoped gate. `yano init` calls only ensureCorePrerequisites;
// this function is called by `yano start --role <specialist>`, so optional
// capabilities are installed exactly when the planner asks for that role.
// Unknown OS-level tools are never guessed or installed through sudo: the
// launch is stopped with a deterministic manual command instead.
export function ensureRolePrerequisites({ packageRoot, cwd, role, install = true } = {}) {
	const cfg = readRoleConfig(packageRoot, cwd, role);
	if (!cfg || cfg.activation !== "lazy") return { ok: true, role, skipped: true, missing: [] };
	const missing = [];
	for (const skill of cfg.skills ?? []) {
		if (skillFile(skill, packageRoot)) continue;
		const source = LAZY_SKILL_SOURCES[skill];
		if (!source) {
			missing.push({ kind: "skill", name: skill, hint: `installa/verifica la skill '${skill}' nel tuo catalogo Codex` });
			continue;
		}
		if (!skillFile(skill, packageRoot) && install) {
			runInstall("npx", ["-y", "skills", "add", source, "--skill", skill, "--global", "--yes"]);
		}
		if (!skillFile(skill, packageRoot)) missing.push({ kind: "skill", name: skill, hint: `npx -y skills add ${source} --skill ${skill} --global --yes` });
	}
	for (const cli of cfg.cli ?? []) {
		if (cli === "git" || cli === "npm" || cli === "npx") continue;
		let ok = commandExists(cli, ["--version"]);
		const installer = LAZY_CLI_INSTALLERS[cli];
		if (!ok && installer && install) {
			runInstall(installer[0], installer[1]);
			ok = commandExists(cli, ["--version"]);
		}
		if (!ok) missing.push({ kind: "cli", name: cli, hint: installer ? `${installer[0]} ${installer[1].join(" ")}` : `installa '${cli}' con il package manager ufficiale del tuo sistema` });
	}
	const mcp = readMcpConfig(cwd ?? process.cwd());
	for (const server of cfg.mcp ?? []) {
		let present = Object.hasOwn(mcp.servers, server);
		if (!present && install) present = ensureDeclaredMcp(cwd ?? process.cwd(), packageRoot, server);
		if (!present) missing.push({ kind: "mcp", name: server, hint: `aggiungi il server '${server}' a ${mcp.file ?? ".mcp.json"} seguendo la documentazione ufficiale` });
	}
	if (missing.length) {
		console.error(`yano start: prerequisiti mancanti per il ruolo lazy '${role}'; avvio annullato (nessun worktree modificato).`);
		for (const item of missing) console.error(`  - ${item.kind} ${item.name}: ${item.hint}`);
	}
	return { ok: missing.length === 0, role, skipped: false, missing };
}

function commandExists(cmd, args = ["--version"]) {
	try {
		const result = spawnSync(cmd, args, { stdio: "ignore", shell: process.platform === "win32" });
		// ENOENT (or a thrown error) means the executable itself wasn't found.
		// A non-zero exit code still means the executable IS there (it just
		// didn't like these args) — that still counts as "found".
		return !result.error || result.error.code !== "ENOENT";
	} catch {
		return false;
	}
}

function dockerDaemonRunning() {
	if (!commandExists("docker")) return false;
	const result = spawnSync("docker", ["info"], { stdio: "ignore", shell: process.platform === "win32", timeout: 5000 });
	return result.status === 0;
}

function tcpReachable(host, port, timeoutMs = 400) {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const done = (ok) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

const MIN_NODE = { major: 22, minor: 5, patch: 0 };

export function isSupportedNodeRuntime(version = process.versions.node) {
	const [major, minor, patch] = String(version).split(".").map((part) => Number.parseInt(part, 10));
	if (![major, minor, patch].every(Number.isFinite)) return false;
	if (major !== MIN_NODE.major) return major > MIN_NODE.major;
	if (minor !== MIN_NODE.minor) return minor > MIN_NODE.minor;
	return patch >= MIN_NODE.patch;
}

function osInstallHint(tool) {
	const platform = process.platform;
	const hints = {
		git: {
			darwin: "brew install git   (oppure installa Xcode Command Line Tools: xcode-select --install)",
			win32: "winget install Git.Git   (oppure https://git-scm.com/download/win)",
			linux: "sudo apt-get install -y git   (Debian/Ubuntu — su altre distro usa il tuo package manager: dnf, pacman, ecc.)",
		},
		docker: {
			darwin: "brew install --cask docker   (oppure scarica Docker Desktop da https://www.docker.com/products/docker-desktop — poi APRILO, il daemon deve essere in esecuzione)",
			win32: "winget install Docker.DockerDesktop   (poi APRI Docker Desktop — il daemon deve essere in esecuzione)",
			linux: "segui https://docs.docker.com/engine/install/ per la tua distribuzione, poi: sudo systemctl start docker",
		},
		mosquitto: {
			darwin: "brew install mosquitto   (poi: mosquitto -c mqtt/mosquitto.native.conf)",
			win32: "winget install EclipseFoundation.Mosquitto   (poi, in una finestra separata: mosquitto -c mqtt\\mosquitto.native.conf)",
			linux: "sudo apt-get install -y mosquitto   (Debian/Ubuntu — poi: mosquitto -c mqtt/mosquitto.native.conf)",
		},
	};
	return hints[tool]?.[platform] ?? hints[tool]?.linux ?? "vedi la documentazione ufficiale del progetto.";
}

// runDoctor({ cwd }) — cwd è usato solo per decidere se menzionare
// `docker compose -f mqtt/compose.yaml up -d` (ha senso solo se quel file
// esiste, cioè dentro un progetto scaffoldato o dentro questo pacchetto
// stesso). Ritorna { ok: boolean } — ok è false se manca `pi` o se non c'è
// NESSUN modo disponibile per far girare un broker MQTT; git mancante è
// segnalato ma non fa fallire il check da solo (serve solo per i worktree,
// alcuni usi read-only/di prova non lo richiedono subito).
export async function runDoctor({ cwd = process.cwd(), json = false, autoStartBroker = false, packageRoot = null } = {}) {
	packageRoot ??= path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	if (!json) console.log("yano doctor — verifica ambiente\n");

	const rows = [];
	let ok = true;

	const nodeOk = isSupportedNodeRuntime();
	rows.push(["Node.js", nodeOk, nodeOk ? `${process.version} (minimo 22.5.0)` : `${process.version} — richiesto almeno Node 22.5.0`]);
	if (!nodeOk) ok = false;

	const hasGit = commandExists("git");
	rows.push(["git", hasGit, hasGit ? "trovato" : `non trovato — ${osInstallHint("git")}`]);
	const hasNpm = commandExists("npm", ["--version"]);
	const hasNpx = commandExists("npx", ["--version"]);
	rows.push(["npm", hasNpm, hasNpm ? "trovato" : "non trovato — installa Node.js LTS"]);
	rows.push(["npx", hasNpx, hasNpx ? "trovato" : "non trovato — installa Node.js LTS"]);
	if (!hasNpm || !hasNpx) ok = false;

	const hasPi = commandExists("pi", ["--version"]);
	rows.push([
		"pi",
		hasPi,
		hasPi
			? "trovato"
			: "non trovato sul PATH — questo pacchetto non gestisce l'installazione di `pi` stesso: installalo secondo la documentazione della tua distribuzione di pi.",
	]);
	if (!hasPi) ok = false;

	const playwright = ensurePlaywrightPrerequisites({ install: false });
	rows.push(["playwright-cli", playwright.cli.ok, playwright.cli.ok ? "trovato" : `non trovato — ${playwright.cli.hint}`]);
	rows.push(["skill playwright-cli", playwright.skill.ok, playwright.skill.ok ? "installata globalmente" : `non trovata — ${playwright.skill.hint}`]);
	if (!playwright.ok) ok = false;

	const core = ensureCorePrerequisites({ packageRoot, cwd, install: false });
	for (const skill of core.skills) {
		rows.push([`skill ${skill.name}`, skill.ok, skill.ok ? "presente" : `mancante — installa da ${skill.repo}`]);
		if (!skill.ok) ok = false;
	}
	rows.push(["pi-mcp-adapter", core.mcp.adapter, core.mcp.adapter ? "installato" : "mancante — pi install npm:pi-mcp-adapter"]);
	rows.push(["MCP chrome-devtools", core.mcp.chromePackage, core.mcp.chromePackage ? "pacchetto risolvibile" : "mancante — npx -y chrome-devtools-mcp@latest --help"]);
	rows.push(["MCP GitHub endpoint", core.mcp.githubEndpoint, core.mcp.githubEndpoint ? "raggiungibile; OAuth al primo uso" : "non raggiungibile — verifica rete/GitHub OAuth"]);
	if (!core.mcp.adapter || !core.mcp.chromePackage || !core.mcp.githubEndpoint) ok = false;
	if (core.mcp.config) {
		for (const server of ESSENTIAL_MCP_SERVERS) {
			const present = core.mcp.declared.includes(server);
			rows.push([`MCP ${server}`, present, present ? `dichiarato in ${core.mcp.config}` : `mancante in ${core.mcp.config}`]);
			if (!present) ok = false;
		}
	}

	const dockerOk = dockerDaemonRunning();
	const hasMosquitto = commandExists("mosquitto", ["-h"]);
	let brokerUp = await tcpReachable("127.0.0.1", 1883);
	let brokerAutoStarted = false;
	if (!brokerUp && autoStartBroker && dockerOk && packageRoot) {
		const composeFile = path.join(packageRoot, "mqtt", "compose.yaml");
		const started = spawnSync("docker", ["compose", "-f", composeFile, "up", "-d"], { cwd, stdio: "ignore", timeout: 30_000 });
		if (started.status === 0) {
			brokerAutoStarted = true;
			brokerUp = await tcpReachable("127.0.0.1", 1883, 2_000);
		}
	}

	if (brokerUp) {
		rows.push(["Broker MQTT", true, brokerAutoStarted ? "avviato automaticamente con il compose ufficiale" : "già raggiungibile su 127.0.0.1:1883"]);
	} else if (dockerOk) {
		rows.push(["Docker", true, "installato e in esecuzione — usa: docker compose -f mqtt/compose.yaml up -d"]);
	} else if (hasMosquitto) {
		rows.push(["Mosquitto (nativo)", true, "trovato sul PATH — usa: mosquitto -c mqtt/mosquitto.native.conf"]);
	} else {
		const dockerInstalled = commandExists("docker");
		rows.push([
			"Broker MQTT",
			false,
			dockerInstalled
				? `Docker è installato ma il daemon non sembra in esecuzione — aprilo, oppure installa Mosquitto nativo: ${osInstallHint("mosquitto")}`
				: `nessun broker disponibile — installa Docker Desktop (${osInstallHint("docker")}) oppure Mosquitto nativo (${osInstallHint("mosquitto")})`,
		]);
		ok = false;
	}

	const checks = rows.map(([name, good, detail]) => ({ name, ok: good, detail }));
	if (json) {
		console.log(JSON.stringify({ ok, checks }, null, 2));
	} else {
		for (const [name, good, detail] of rows) console.log(`  ${good ? "✓" : "✗"} ${name.padEnd(19)} ${detail}`);
		console.log("");
		console.log(ok ? "Ambiente pronto." : "Manca almeno un prerequisito — vedi sopra prima di continuare.");
	}
	return { ok, checks, broker_auto_started: brokerAutoStarted };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const json = process.argv.includes("--json");
	runDoctor({ cwd: process.cwd(), json }).then(({ ok }) => process.exit(ok ? 0 : 1));
}
