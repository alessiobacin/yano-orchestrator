import fs from "node:fs";
import path from "node:path";
import { memoryPaths, MEMORY_LIMITS } from "./yano-agent-memory.mjs";

const IGNORED_DIRECTORIES = new Set([".git", ".pi", ".yano", "node_modules", ".worktrees", "dist", "build", "coverage", ".next", "target"]);
const MANIFESTS = ["package.json", "pnpm-workspace.yaml", "yarn.lock", "pnpm-lock.yaml", "package-lock.json", "Cargo.toml", "pyproject.toml", "requirements.txt", "go.mod", "pom.xml", "composer.json", "Gemfile"];
const DOC_CATEGORIES = ["architecture", "guides", "quick-guides", "adr", "notes", "postman", "cheat-sheet", "diagram"];
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".php", ".rb", ".vue", ".svelte", ".html", ".css", ".scss"]);

function safe(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function exists(file) { try { return fs.existsSync(file); } catch { return false; } }
function stat(file) { try { return fs.statSync(file); } catch { return null; } }
function relative(root, file) { return path.relative(root, file) || "."; }

function walk(root, max = 3000) {
	const files = [];
	const stack = [root];
	while (stack.length && files.length < max) {
		const current = stack.pop();
		let entries;
		try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(full);
			} else files.push(full);
		}
	}
	return files;
}

function packageFacts(root) {
	const file = path.join(root, "package.json");
	if (!exists(file)) return null;
	try {
		const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
		const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
		return {
			name: safe(pkg.name),
			description: safe(pkg.description),
			private: pkg.private === true,
			scripts: Object.keys(pkg.scripts || {}).slice(0, 12),
			dependencies: Object.keys(deps).slice(0, 20),
		};
	} catch { return { invalid: true }; }
}

function docsState(root, files) {
	const docsRoot = path.join(root, "docs");
	const sourceTimes = files.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file))).map((file) => stat(file)?.mtimeMs || 0);
	const newestSource = Math.max(0, ...sourceTimes);
	const categories = DOC_CATEGORIES.map((category) => {
		const dir = path.join(docsRoot, category);
		const categoryFiles = files.filter((file) => file.startsWith(`${dir}${path.sep}`) && [".md", ".mmd", ".json"].includes(path.extname(file)));
		const newestDoc = Math.max(0, ...categoryFiles.map((file) => stat(file)?.mtimeMs || 0));
		return {
			category,
			files: categoryFiles.map((file) => relative(root, file)).sort().slice(0, 8),
			status: categoryFiles.length === 0 ? "missing" : newestSource > newestDoc && newestSource - newestDoc > 86_400_000 ? "possibly-stale" : "present",
		};
	});
	const relevant = categories.filter((item) => item.status !== "present");
	return { categories, relevant, newestSource: newestSource ? new Date(newestSource).toISOString() : null };
}

export function scanProject({ root }) {
	const projectRoot = path.resolve(root);
	const files = walk(projectRoot);
	const dirs = new Set(files.map((file) => relative(projectRoot, path.dirname(file)).split(path.sep)[0]).filter((name) => name && name !== "."));
	const manifests = MANIFESTS.filter((name) => exists(path.join(projectRoot, name)));
	const entrypoints = files.filter((file) => /(^|\/)(main|index|app|server|cli|manage)\.(js|jsx|ts|tsx|mjs|py|go|rs|java)$/.test(relative(projectRoot, file).replaceAll(path.sep, "/"))).map((file) => relative(projectRoot, file)).sort().slice(0, 12);
	const pkg = packageFacts(projectRoot);
	const docs = docsState(projectRoot, files);
	const projectMemory = memoryPaths({ root: projectRoot, role: "planner", instance: "planner-01" }).project;
	const existing = exists(projectMemory);
	const initialized = [
		path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "config", "project.json"),
		path.join(projectRoot, "agents", "roles.yaml"),
		path.join(projectRoot, ".pi", "agents", "roles.yaml"),
		path.join(projectRoot, "extensions", "orchestrator.ts"),
	].some(exists);
	const nonEmpty = files.length > 0;
	return {
		project_root: projectRoot,
		project_name: pkg?.name || path.basename(projectRoot),
		non_empty: nonEmpty,
		file_count: files.length,
		manifests,
		package: pkg,
		top_level_directories: [...dirs].sort().slice(0, 20),
		entrypoints,
		docs,
		project_memory: { path: relative(projectRoot, projectMemory), exists: existing },
		initialized,
		needs_documentation_gate: initialized && nonEmpty && (!existing || docs.relevant.length > 0),
	};
}

function renderSummary(scan) {
	const pkg = scan.package;
	const lines = [
		`# Riepilogo progetto — ${scan.project_name}`,
		"",
		"Memoria breve condivisa dagli agenti. Contiene solo orientamento e riferimenti: i dettagli operativi restano nei documenti del progetto.",
		"",
		"## Identità e stack rilevati",
		`- Root: \`${scan.project_root}\``,
		`- Manifest: ${scan.manifests.length ? scan.manifests.map((item) => `\`${item}\``).join(", ") : "nessuno rilevato"}`,
		`- Descrizione: ${pkg?.description || "da confermare dal planner"}`,
		`- Dipendenze principali: ${pkg?.dependencies?.length ? pkg.dependencies.join(", ") : "non rilevate"}`,
		`- Script disponibili: ${pkg?.scripts?.length ? pkg.scripts.map((item) => `\`${item}\``).join(", ") : "non rilevati"}`,
		"",
		"## Struttura ed entrypoint",
		`- Directory principali: ${scan.top_level_directories.length ? scan.top_level_directories.map((item) => `\`${item}/\``).join(", ") : "non rilevate"}`,
		`- Entry point candidati: ${scan.entrypoints.length ? scan.entrypoints.map((item) => `\`${item}\``).join(", ") : "da confermare"}`,
		"",
		"## Documentazione da consultare",
		...scan.docs.categories.map((item) => `- \`docs/${item.category}/\`: ${item.status}${item.files.length ? ` — ${item.files.join(", ")}` : ""}`),
		"",
		"## Stato bootstrap",
		"- documentation_setup: pending — il planner deve chiedere conferma prima di creare o aggiornare documenti.",
		`- Ultima scansione automatica: ${new Date().toISOString()}`,
		"- Regola: dopo il lavoro di docs-sync, il planner verifica l’esito e aggiorna questo riepilogo senza duplicare i documenti dettagliati.",
	];
	return lines.join("\n");
}

export function ensureProjectSummary(scan) {
	const file = path.resolve(scan.project_root, scan.project_memory.path);
	if (exists(file)) return { created: false, file };
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const content = renderSummary(scan);
	const bounded = content.length > MEMORY_LIMITS.project ? content.slice(0, MEMORY_LIMITS.project) : content;
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, bounded, { mode: 0o600 });
	fs.renameSync(temp, file);
	return { created: true, file };
}

export function projectBootstrapPrompt(scan) {
	if (!scan.needs_documentation_gate) return "";
	const relevant = scan.docs.relevant.map((item) => `- docs/${item.category}/: ${item.status}`).join("\n");
	return `\n\n## Bootstrap documentale obbligatorio del progetto\nÈ stata eseguita una scansione leggera del progetto prima di leggere il codice in profondità. Il riepilogo breve è in \`${scan.project_memory.path}\`; leggilo per primo.\n\nStato rilevato:\n- memoria progetto presente: ${scan.project_memory.exists ? "sì" : "no, è stata appena inizializzata"}\n- manifest: ${scan.manifests.join(", ") || "nessuno"}\n- entrypoint candidati: ${scan.entrypoints.join(", ") || "da confermare"}\n- directory principali: ${scan.top_level_directories.join(", ") || "nessuna"}\n${relevant || "- documentazione da verificare"}\n\nPrima di iniziare il lavoro sostanziale, mostra all’utente questa scansione in forma sintetica e chiedi esplicitamente se vuole che docs-sync crei i documenti mancanti e aggiorni quelli esistenti potenzialmente obsoleti. Non modificare i documenti senza conferma. Se l’utente conferma, delega un task a docs-sync; docs-sync deve confrontare i documenti con codice, configurazione e test reali, aggiornare quelli obsoleti e riportare i file modificati. Al termine verifica il risultato e aggiorna tu \`${scan.project_memory.path}\` con i riferimenti e lo stato finale. Se l’utente rifiuta, registra la decisione come \`documentation_setup: declined\` nella memoria preferenze/progetto e continua senza inventare documentazione.`;
}
