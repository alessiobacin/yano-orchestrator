#!/usr/bin/env node
// `yano update` — aggiorna TUTTE le copie installate del pacchetto all'ultima
// versione pubblicata sul repo GitHub (branch di default), senza dover
// ricordare a mano la sintassi `npm install -g github:...` né andare a
// cercare a mano la cartella dove `pi extension install` tiene la sua copia.
//
// PERCHÉ QUESTO SCRIPT ESISTE (Revisione 34): richiesto esplicitamente
// dall'operatore — un comando per aggiornare l'estensione già installata
// nel folder globale all'ultima versione della repo, invece di reinstallare
// a mano.
//
// CI SONO DAVVERO DUE COPIE DISTINTE, NON UNA SOLA (scoperta 2026-08-20,
// Revisione 34, da un traceback reale dell'operatore — non più solo un
// limite dichiarato "non verificato" come nelle revisioni precedenti):
//
//   1. Il pacchetto npm GLOBALE (`npm install -g <url>`; `npm link` è solo per
//      sviluppo) — da qui vengono `yano` stesso e skills-vendor/ (le skill
//      mattpocock, mai copiate nei progetti scaffoldati — vedi
//      launch-planner.mjs). Percorso tipico: la cartella dei pacchetti
//      globali di npm (`npm root -g`, es. su Windows
//      "%AppData%\npm\node_modules\yano-orchestrator").
//   2. Il clone git che `pi extension install <url>` mantiene per conto
//      suo, IN PIÙ del pacchetto npm — confermato da un traceback reale
//      dell'operatore su Windows (Revisione 34): `pi` caricava
//      l'estensione da
//      "C:\Users\<utente>\.pi\agent\git\github.com\<owner>\<repo>\extensions\orchestrator.ts",
//      un percorso completamente separato da quello npm globale. È
//      quest'ultima copia — non quella npm — che `pi` carica davvero in
//      automatico in ogni sessione (vedi Revisione 33).
//
// `yano update` aggiorna ENTRAMBE, quando presenti: la prima con
// `npm install -g <repository.url da package.json>`, la seconda con
// `git pull` dentro `~/.pi/agent/git/<host>/<owner>/<repo>` (costruito dallo
// stesso `repository.url`, MAI un percorso hardcoded — un fork/mirror
// dell'operatore continua a funzionare senza modifiche a questo script).
//
// Uso:
//   yano update            aggiorna alla versione più recente su GitHub (entrambe le copie)
//   yano update --check    controlla solo se è disponibile un aggiornamento, non installa
//
// Dopo l'aggiornamento del pacchetto e del clone dell'estensione, il comando
// sincronizza anche le estensioni registrate nell'installazione locale di Pi
// con `pi update --extensions`. Questo evita che una sessione Pi appena aperta
// proponga un aggiornamento separato.
//
// Limite onesto residuo: il percorso `~/.pi/agent/git/<host>/<owner>/<repo>`
// è dedotto dalla struttura osservata in un singolo traceback reale (Windows,
// `pi` v0.84.2) — non è documentato pubblicamente da `pi`, quindi potrebbe
// cambiare in una versione futura di `pi` senza preavviso. Se questo script
// non trova quella cartella ma sai di aver installato con `pi extension
// install`, verifica comunque con `yano --version`/riavviando `pi` dopo
// l'update — se non sembra aggiornato, `pi extension install <url>` di
// nuovo resta il modo più sicuro per farlo aggiornare.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runControlledReload } from "./yano-recovery.mjs";
import { installYanoCliSkill } from "./install-yano-cli.mjs";

function commandExists(cmd) {
	const result = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
	return !result.error || result.error.code !== "ENOENT";
}

function readVersion(pkgJsonPath) {
	try {
		return JSON.parse(readFileSync(pkgJsonPath, "utf-8")).version;
	} catch {
		return null;
	}
}

function canonicalPath(value) {
	if (!value) return null;
	try { return realpathSync(value); }
	catch { return path.resolve(value); }
}

// `npm link` is deliberately a symlink in npm's global node_modules. Calling
// `npm install -g` on it makes npm rename the link as though it were a normal
// directory; npm then fails with ENOTDIR. Detect this before mutating anything.
export function inspectGlobalLinkedInstall({ packageRoot, packageName = "yano-orchestrator", npmRoot } = {}) {
	const resolvedNpmRoot = npmRoot ?? (() => {
		const result = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", shell: process.platform === "win32" });
		return result.status === 0 ? result.stdout.trim() : null;
	})();
	if (!resolvedNpmRoot) return { found: false, linked: false, matches_running_package: false, path: null };
	const installedPath = path.join(resolvedNpmRoot, packageName);
	if (!existsSync(installedPath)) return { found: false, linked: false, matches_running_package: false, path: installedPath };
	let linked = false;
	try { linked = lstatSync(installedPath).isSymbolicLink(); } catch { /* absent/unreadable is not a link */ }
	return {
		found: true,
		linked,
		matches_running_package: linked && Boolean(packageRoot) && canonicalPath(installedPath) === canonicalPath(packageRoot),
		path: installedPath,
		target: linked ? canonicalPath(installedPath) : null,
	};
}

function installPermanentGlobalPackage(repoUrl) {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "yano-update-"));
	try {
		// Do not ask npm to prepare a git dependency: npm 11 applies the user's
		// allow-scripts policy in that temporary project and can fail with
		// EALLOWSCRIPTS. Clone with git, pack the local checkout, then install the
		// tarball; this also prevents npm's git-clone cache from becoming a link.
		const checkout = path.join(tempDir, "checkout");
		execFileSync("git", ["clone", "--depth", "1", repoUrl, checkout], { stdio: "inherit", shell: process.platform === "win32" });
		execFileSync("npm", ["pack", checkout, "--pack-destination", tempDir], { stdio: "inherit", shell: process.platform === "win32" });
		const tarball = readdirSync(tempDir).find((entry) => entry.endsWith(".tgz"));
		if (!tarball) throw new Error("npm pack non ha prodotto un tarball");
		execFileSync("npm", ["install", "-g", path.join(tempDir, tarball), "--ignore-scripts"], { stdio: "inherit", shell: process.platform === "win32" });
	} finally {
		try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* cleanup best effort */ }
	}
}

// npm cannot replace a linked package on every npm/node combination (notably
// macOS npm 26 reports ENOTDIR while trying to rename the symlink). Remove
// only the exact global symlink, then install a real package copy. A regular
// global installation is never touched by this path.
export function removeLinkedGlobalInstall({ linkedInstall, packageName = "yano-orchestrator" } = {}) {
	if (!linkedInstall?.linked || !linkedInstall.path) return { removed: false, reason: "not-linked" };
	try {
		unlinkSync(linkedInstall.path);
		return { removed: true, path: linkedInstall.path, package_name: packageName };
	} catch (error) {
		return { removed: false, path: linkedInstall.path, reason: error instanceof Error ? error.message : String(error) };
	}
}

function updateLinkedCheckout(packageRoot) {
	if (!existsSync(path.join(packageRoot, ".git"))) {
		return { ok: true, skipped: true, reason: "linked-non-git" };
	}
	const dirty = spawnSync("git", ["-C", packageRoot, "status", "--porcelain"], { encoding: "utf-8" });
	if (dirty.status !== 0) return { ok: false, skipped: true, reason: "git-status-failed" };
	if (dirty.stdout.trim()) return { ok: true, skipped: true, reason: "dirty" };
	try {
		execFileSync("git", ["-C", packageRoot, "pull", "--ff-only"], { stdio: "inherit" });
		return { ok: true, skipped: false, reason: "pulled" };
	} catch (error) {
		return { ok: false, skipped: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

// Estrae { host, owner, repo } da un URL git di GitHub, sia in forma HTTPS
// (https://github.com/<owner>/<repo>.git) sia SSH (git@github.com:<owner>/<repo>.git).
// Ritorna null se il formato non è riconosciuto (nessuna assunzione azzardata).
function parseGitUrl(url) {
	const https = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
	if (https) return { host: https[1], owner: https[2], repo: https[3] };
	const ssh = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
	if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };
	return null;
}

// Percorso della copia gestita da `pi extension install` — vedi il
// commento in testa al file per come è stato scoperto (traceback reale,
// Revisione 34). null se repoUrl non è nel formato GitHub atteso.
function piExtensionGitDir(repoUrl) {
	const parsed = parseGitUrl(repoUrl);
	if (!parsed) return null;
	return path.join(os.homedir(), ".pi", "agent", "git", parsed.host, parsed.owner, parsed.repo);
}

function currentGitCommit(dir) {
	const result = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf-8" });
	return result.status === 0 ? result.stdout.trim() : null;
}

export function updatePiExtensions() {
	if (!commandExists("pi")) {
		console.warn("yano update: pi non trovato sul PATH — sincronizzazione delle estensioni saltata.");
		return { ok: false, skipped: true };
	}
	try {
		execFileSync("pi", ["update", "--extensions"], { stdio: "inherit", shell: process.platform === "win32" });
		console.log("yano update: estensioni Pi sincronizzate.");
		return { ok: true, skipped: false };
	} catch (err) {
		console.warn(`yano update: "pi update --extensions" non riuscito (${err instanceof Error ? err.message : String(err)}).`);
		console.warn("Le copie Yano sono state aggiornate; ripeti manualmente `pi update --extensions` quando Pi sarà disponibile.");
		return { ok: false, skipped: false };
	}
}

// runUpdate({ packageRoot, argv }) — packageRoot è la directory del
// pacchetto npm installato globalmente da cui `yano` sta girando in questo
// momento (usata sia per leggere la versione corrente sia per il campo
// "repository.url" da cui reinstallare/aggiornare entrambe le copie).
async function performUpdate({ packageRoot, argv }) {
	const checkOnly = argv.includes("--check");

	const pkgJsonPath = path.join(packageRoot, "package.json");
	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
	const currentVersion = pkg.version;

	const repoUrl = pkg.repository?.url;
	if (!repoUrl) {
		console.error(`yano update: "${pkgJsonPath}" non ha un campo repository.url — non so da dove reinstallare.`);
		process.exit(1);
	}

	if (!commandExists("npm")) {
		console.error("yano update: npm non trovato sul PATH — necessario per reinstallare il pacchetto globale.");
		process.exit(1);
	}
	if (!commandExists("git")) {
		console.error("yano update: git non trovato sul PATH — necessario sia a npm che al clone di `pi extension install`.");
		process.exit(1);
	}

	const gitDir = piExtensionGitDir(repoUrl);
	const hasGitClone = gitDir ? existsSync(gitDir) : false;
	const packageName = pkg.name || "yano-orchestrator";
	const linkedInstall = inspectGlobalLinkedInstall({ packageRoot, packageName });

	console.log(`yano update: versione installata attualmente (pacchetto npm): ${currentVersion}`);
	console.log(`yano update: repo sorgente: ${repoUrl}`);
	console.log(`yano update: modalità installazione: ${linkedInstall.matches_running_package ? "checkout dev collegato (npm link)" : "copia globale permanente"}`);
	if (hasGitClone) console.log(`yano update: trovata anche la copia di \`pi extension install\` in ${gitDir}`);

	if (checkOnly) {
		// Confronto best-effort via `npm view` (legge il package.json remoto
		// senza reinstallare nulla) invece di clonare tutto solo per sapere
		// se serve un aggiornamento.
		const result = spawnSync("npm", ["view", repoUrl, "version"], {
			encoding: "utf-8",
			shell: process.platform === "win32",
		});
		if (result.status !== 0 || !result.stdout) {
			console.error(`yano update: impossibile controllare la versione remota (${result.stderr?.trim() || "errore sconosciuto"}).`);
			process.exit(1);
		}
		const remoteVersion = result.stdout.trim();
		console.log(`yano update: ultima versione su GitHub: ${remoteVersion}`);
		if (remoteVersion === currentVersion) {
			console.log("yano update: il pacchetto npm sembra già aggiornato.");
		} else {
			console.log(`yano update: disponibile un aggiornamento (${currentVersion} → ${remoteVersion}). Esegui \`yano update\` (senza --check) per installarlo.`);
		}
		if (hasGitClone) {
			const fetchResult = spawnSync("git", ["-C", gitDir, "fetch", "--quiet"], { stdio: "ignore" });
			if (fetchResult.status === 0) {
				const local = currentGitCommit(gitDir);
				const remote = spawnSync("git", ["-C", gitDir, "rev-parse", "--short", "@{u}"], { encoding: "utf-8" });
				const remoteCommit = remote.status === 0 ? remote.stdout.trim() : null;
				if (local && remoteCommit) {
					console.log(
						local === remoteCommit
							? `yano update: la copia di \`pi extension install\` (${local}) è già aggiornata.`
							: `yano update: la copia di \`pi extension install\` è indietro (${local} → ${remoteCommit} disponibile).`,
					);
				}
			}
		}
		return { checkOnly: true, currentVersion, remoteVersion };
	}

	let activePackageRoot = packageRoot;
	if (linkedInstall.matches_running_package) {
		console.log(`\nyano update: 1/2 — converto l’installazione linkata in una copia globale permanente (${linkedInstall.path} → ${linkedInstall.target}).`);
		const removed = removeLinkedGlobalInstall({ linkedInstall, packageName });
		if (!removed.removed) {
			console.error(`yano update: impossibile rimuovere il link globale (${removed.reason}).`);
			process.exit(1);
		}
	}
	if (!linkedInstall.matches_running_package) console.log("\nyano update: 1/2 — reinstallo il pacchetto npm globale da GitHub (npm install -g ...)...\n");
	else console.log("yano update: installo ora la copia permanente da GitHub (npm install -g ...)...\n");
	try {
		// npm may remove/rename the global package while its lifecycle is still
		// running. That leaves postinstall with a deleted cwd (uv_cwd) and can
		// make npm report false TAR_ENTRY_ERROR files. Install the package first,
		// then run Yano's lifecycle scripts from the stable installed directory.
		installPermanentGlobalPackage(repoUrl);
	} catch (err) {
		console.error(`\nyano update: "npm install -g ${repoUrl}" fallito (${err instanceof Error ? err.message : String(err)}).`);
		console.error(
			"Su alcuni sistemi npm install -g richiede permessi elevati (sudo su macOS/Linux, un terminale da Amministratore su Windows) — riprova con quelli se l'errore riguarda i permessi.",
		);
		process.exit(1);
	}
	const installedAfter = inspectGlobalLinkedInstall({ packageName });
	if (installedAfter.found && !installedAfter.linked) activePackageRoot = installedAfter.path;
	const requiredPlaybook = path.join(activePackageRoot, "playbooks", "suggestion-proposal.yaml");
	if (!existsSync(requiredPlaybook)) {
		console.error(`yano update: pacchetto globale incompleto; manca ${requiredPlaybook}. Installazione annullata.`);
		process.exit(1);
	}
	for (const script of ["install-yano-cli.mjs", "install-yano-watcher-cron.mjs", "install-yano-scheduler-cron.mjs"]) {
		try {
			execFileSync(process.execPath, [path.join(activePackageRoot, "scripts", script), "--if-global", "--quiet"], {
				cwd: activePackageRoot,
				stdio: "inherit",
				env: { ...process.env, npm_config_global: "true" },
			});
		} catch (error) {
			console.error(`yano update: lifecycle ${script} fallito (${error instanceof Error ? error.message : String(error)}).`);
			process.exit(1);
		}
	}
	const newVersion = readVersion(path.join(activePackageRoot, "package.json"));
	console.log("");
	if (linkedInstall.matches_running_package) {
		console.log(`yano update: installazione permanente attiva (versione: ${newVersion || currentVersion}); npm link disattivato.`);
	} else if (newVersion && newVersion !== currentVersion) {
		console.log(`yano update: pacchetto npm aggiornato ${currentVersion} → ${newVersion}.`);
	} else if (newVersion === currentVersion) {
		console.log(`yano update: pacchetto npm reinstallato (versione invariata: ${currentVersion} — probabilmente eri già aggiornato).`);
	} else {
		console.log("yano update: reinstallazione npm completata, ma non sono riuscito a rileggere la nuova versione — verifica con `yano --version`.");
	}

	if (hasGitClone) {
		console.log(`\nyano update: 2/2 — aggiorno la copia di \`pi extension install\` in ${gitDir} (git pull)...\n`);
		const before = currentGitCommit(gitDir);
		try {
			execFileSync("git", ["-C", gitDir, "pull", "--ff-only"], { stdio: "inherit" });
		} catch (err) {
			console.error(`\nyano update: "git -C ${gitDir} pull" fallito (${err instanceof Error ? err.message : String(err)}).`);
			console.error(
				"Se il pull fallisce per modifiche locali o divergenza (--ff-only si rifiuta apposta di riscrivere la history), " +
					"la via più sicura resta reinstallare da capo con `pi extension install <url>`.",
			);
			process.exit(1);
		}
		const after = currentGitCommit(gitDir);
		console.log("");
		if (before && after && before !== after) {
			console.log(`yano update: copia di \`pi extension install\` aggiornata (${before} → ${after}).`);
		} else if (before && after && before === after) {
			console.log(`yano update: copia di \`pi extension install\` invariata (${before} — era già aggiornata).`);
		} else {
			console.log("yano update: `git pull` completato in quella cartella, ma non sono riuscito a confermare il commit — controlla l'output sopra.");
		}
	} else {
		console.log(
			"\nyano update: nessuna copia di `pi extension install` trovata in " +
				`${gitDir ?? "(percorso non deducibile dal repository.url)"} — se l'hai installato SOLO con \`pi extension install\`, ` +
				"controlla comunque con `yano --version`/riavviando `pi`; se non risulta aggiornato, il modo più sicuro resta rilanciare " +
				"`pi extension install <url>`.",
		);
	}

	console.log("\nyano update: 3/3 — sincronizzo le estensioni registrate in Pi (pi update --extensions)...\n");
	updatePiExtensions();

	const harnessSkill = installYanoCliSkill({ packageRoot: activePackageRoot });
	if (harnessSkill.ok) console.log("yano update: skill globale yano-cli sincronizzata negli harness disponibili.");
	else console.warn("yano update: skill globale yano-cli non sincronizzata completamente — esegui `yano skills status` per i dettagli.");

	console.log(
		"\nyano update: i prompt di ruolo di OGNI progetto (anche già scaffoldato prima di questo update) si leggono " +
			"sempre dal pacchetto installato (Revisione 47) — nessun passo aggiuntivo necessario, a meno che tu " +
			"non abbia attivato `--custom-prompts` per un progetto specifico (vedi `yano copy-prompts`), nel qual " +
			"caso solo i file che hai personalizzato lì restano tuoi: qualunque altro ruolo/file continua comunque " +
			"a leggere questa versione appena aggiornata.",
	);
	return {
		checkOnly: false,
		currentVersion,
		newVersion: readVersion(pkgJsonPath) || currentVersion,
		extensionGitDir: gitDir,
		extensionCommit: hasGitClone ? currentGitCommit(gitDir) : null,
	};
}

export async function runUpdate({ packageRoot, cwd = process.cwd(), argv }) {
	if (argv.includes("--reload")) {
		if (argv.includes("--check")) throw new Error("yano update: --check e --reload non sono combinabili.");
		return runControlledReload({
			cwd,
			packageRoot,
			argv,
			update: () => performUpdate({
				packageRoot,
				argv: argv.filter((arg) => !["--reload", "--dry-run", "--force", "--timeout"].includes(arg)),
			}),
		});
	}
	return performUpdate({ packageRoot, argv });
}

// Uso diretto: `node scripts/update.mjs ...` (dev, dal repo del pacchetto).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	await runUpdate({ packageRoot: path.resolve(__dirname, ".."), cwd: process.cwd(), argv: process.argv.slice(2) });
}
