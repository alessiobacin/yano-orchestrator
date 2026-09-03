import fs from "node:fs";
import path from "node:path";

export const MEMORY_LIMITS = Object.freeze({ project: 6_000, role: 12_000, preferences: 8_000, instance: 4_000 });

function safe(value) { return String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim(); }
function slug(value) { return safe(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown"; }
function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : item?.text || item?.content || "").join(" ");
	return content?.text || content?.content || "";
}
function paths(root) {
	const base = path.join(root, ".pi", "extensions", "yano-orchestrator", "memory");
	return { base, project: path.join(base, "project.md"), role: path.join(base, "roles"), instance: path.join(base, "instances") };
}
function read(file, limit) { try { return fs.readFileSync(file, "utf8").slice(-limit); } catch { return ""; } }
function writeBounded(file, content, limit) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const bounded = content.length > limit ? `<!-- memoria compattata: limite ${limit} caratteri -->\n${content.slice(-limit + 80)}` : content;
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, bounded, { mode: 0o600 });
	fs.renameSync(temp, file);
}
function entry(title, body) { return `\n## ${new Date().toISOString()} — ${title}\n${body}\n`; }

export function memoryPaths({ root, role, instance }) {
	const p = paths(root);
	return {
		project: p.project,
		role: path.join(p.role, `${slug(role)}.md`),
		preferences: path.join(p.base, "user-preferences.md"),
		instance: path.join(p.instance, `${slug(instance)}.md`),
	};
}

function branchEvidence(branch = []) {
	const user = branch.filter((item) => item?.role === "user").map((item) => safe(textOf(item.content))).filter(Boolean).slice(-3);
	const assistant = branch.filter((item) => item?.role === "assistant").map((item) => safe(textOf(item.content))).filter(Boolean).at(-1) || "";
	const tools = branch.flatMap((item) => Array.isArray(item?.content) ? item.content.filter((part) => part?.type === "toolCall" || part?.type === "tool_use").map((part) => part.name || part.tool || "tool") : []).slice(-12);
	return { user, assistant: assistant.slice(-1200), tools };
}

function explicitPreferences(userMessages) {
	return userMessages.filter((message) => /\b(preferisco|preferenza|preferenze|d'ora in poi|da ora in poi|sempre|mai|voglio che|non voglio)\b/i.test(message)).map((message) => `- ${message.slice(0, 900)}`);
}

export function updateAgentMemory({ root, project, role, instance, turnIndex = null, branch = [] }) {
	const files = memoryPaths({ root, role, instance });
	const evidence = branchEvidence(branch);
	const now = new Date().toISOString();
	const projectFacts = evidence.user.filter((message) => !/\b(preferisco|preferenza|preferenze|d'ora in poi|da ora in poi|sempre|mai)\b/i.test(message)).map((message) => `- ${message.slice(0, 900)}`);
	const previousProject = read(files.project, MEMORY_LIMITS.project);
	const projectHeader = previousProject || `# Riepilogo progetto — ${safe(project)}\n\nMemoria breve condivisa da tutti gli agenti del progetto. Non duplicare qui dettagli già presenti nelle memorie di ruolo.\n`;
	if (projectFacts.length) {
		const additions = projectFacts.filter((fact) => !projectHeader.toLowerCase().includes(fact.toLowerCase().slice(0, 120)));
		if (additions.length) writeBounded(files.project, projectHeader + entry("Fatto o contesto di progetto", additions.join("\n")), MEMORY_LIMITS.project);
	} else if (!previousProject) writeBounded(files.project, projectHeader, MEMORY_LIMITS.project);
	const roleBody = entry(`Round ${turnIndex ?? "?"}`, [
		`La memoria è condivisa dal ruolo ${safe(role)}; il riepilogo generale è in project.md.`,
		evidence.tools.length ? `Strumenti recenti: ${evidence.tools.join(", ")}` : "Strumenti recenti: nessuno rilevato",
		evidence.assistant ? `Ultimo esito osservabile: ${evidence.assistant}` : "Ultimo esito osservabile: non disponibile",
	].join("\n"));
	const previousRole = read(files.role, MEMORY_LIMITS.role);
	writeBounded(files.role, previousRole || `# Memoria condivisa — ruolo ${role}\n\nQuesta memoria sopravvive al kill delle istanze e viene condivisa dai successivi agenti dello stesso ruolo.\n` + roleBody, MEMORY_LIMITS.role);
	const preferenceLines = explicitPreferences(evidence.user);
	if (preferenceLines.length) {
		const previous = read(files.preferences, MEMORY_LIMITS.preferences);
		writeBounded(files.preferences, previous || `# Preferenze utente\n\nNon salvare segreti o credenziali.\n` + entry("Preferenze rilevate", preferenceLines.join("\n")), MEMORY_LIMITS.preferences);
	}
	const instancePrevious = read(files.instance, MEMORY_LIMITS.instance);
	writeBounded(files.instance, (instancePrevious || `# Memoria diagnostica — ${instance}\n\nQuesta memoria identifica l’istanza e resta disponibile dopo un kill o un restart.\n`) + entry(`Round ${turnIndex ?? "?"}`, `Progetto: ${safe(project)}\nRuolo: ${safe(role)}\nUltimo heartbeat osservato: ${now}`), MEMORY_LIMITS.instance);
	return { files, project_chars: fs.statSync(files.project).size, role_chars: fs.statSync(files.role).size, preferences_updated: preferenceLines.length > 0 };
}

export function loadAgentMemory({ root, role, instance, injectRoleChars = 6_000, injectPreferencesChars = 3_000 }) {
	const files = memoryPaths({ root, role, instance });
	const projectMemory = read(files.project, MEMORY_LIMITS.project);
	const roleMemory = read(files.role, injectRoleChars);
	const preferences = read(files.preferences, injectPreferencesChars);
	if (!projectMemory && !roleMemory && !preferences) return "";
	return `\n\n## Memoria operativa persistente\nUsa queste memorie come evidenza storica, non inventare fatti mancanti. Il riepilogo progetto è condiviso da tutti; non duplicarlo nella memoria specifica del ruolo.\n${projectMemory ? `\n### Riepilogo progetto\n${projectMemory}` : ""}${roleMemory ? `\n### Memoria del ruolo\n${roleMemory}` : ""}${preferences ? `\n### Preferenze utente\n${preferences}` : ""}\n\nPrima di una scelta tecnica, operativa o non banale, verifica se esiste una decisione precedente pertinente e chiedi all’utente se desidera ripeterla oppure adottare un approccio diverso. Non chiedere conferma per comandi puramente meccanici o già esplicitamente autorizzati.\n`;
}
