import { execFileSync } from "node:child_process";

const CACHE_TTL_MS = 30_000;
const cache = new Map();

function clean(value) {
	return String(value || "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function runCm(root, args, timeout = 4_000) {
	try {
		return clean(execFileSync("cm", args, { cwd: root, encoding: "utf8", timeout, maxBuffer: 96_000, stdio: ["ignore", "pipe", "pipe"] }));
	} catch (error) {
		return error?.stdout ? clean(error.stdout) : "";
	}
}

/**
 * Return a bounded orientation pack. This is intentionally read-only and
 * best-effort: an absent/broken Code Mem installation must never block Yano.
 */
export function collectCodeMemContext({ root, query, maxChars = 6_000 } = {}) {
	const normalizedQuery = clean(query).slice(0, 800);
	if (!root || !normalizedQuery || maxChars < 500) return { ok: false, context: "", reason: "missing_query_or_root" };
	const key = `${root}\n${normalizedQuery}`;
	const previous = cache.get(key);
	if (previous && Date.now() - previous.at < CACHE_TTL_MS) return previous.value;
	const recall = runCm(root, ["recall", normalizedQuery, "--level", "1", "--limit", "6", "--mode", "hybrid"]);
	const graph = runCm(root, ["query", normalizedQuery]);
	const sections = [
		recall ? `### cm recall (orientamento semantico)\n${recall}` : "",
		graph ? `### cm query (grafo)\n${graph}` : "",
	].filter(Boolean);
	const context = sections.join("\n\n").slice(0, maxChars);
	const value = { ok: Boolean(context), context, reason: context ? "ok" : "unavailable", query: normalizedQuery };
	cache.set(key, { at: Date.now(), value });
	return value;
}

export function clearCodeMemContextCache() { cache.clear(); }
