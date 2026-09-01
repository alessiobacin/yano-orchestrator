// Bounded, read-only web helpers for the auto-improver.  Search is deliberately
// limited to public package/repository indexes; source contents are fetched only
// from explicit HTTPS URLs supplied by the worker after it has identified a
// candidate.  No credentials, cookies or mutation-capable HTTP methods are used.

const MAX_SOURCE_BYTES = 160_000;
const MAX_RESULTS = 10;
const USER_AGENT = "yano-auto-improver/1.x (read-only project audit)";

function blockedHost(hostname) {
	const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
	if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
	if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return true;
	if (/^172\.(?:1[6-9]|2\d|3[0-1])\./.test(host)) return true;
	if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
	return false;
}

export function validatePublicSourceUrl(rawUrl) {
	let url;
	try { url = new URL(String(rawUrl)); } catch { throw new Error("URL non valida"); }
	if (url.protocol !== "https:") throw new Error("sono consentite soltanto URL HTTPS pubbliche");
	if (url.username || url.password) throw new Error("URL con credenziali non consentita");
	if (blockedHost(url.hostname)) throw new Error("host locale o privato non consentito");
	return url;
}

async function readLimited(response, maxBytes = MAX_SOURCE_BYTES) {
	const declared = Number(response.headers?.get?.("content-length") || 0);
	if (declared > maxBytes) return { text: "", truncated: true };
	if (!response.body?.getReader) {
		const text = String(await response.text()).slice(0, maxBytes);
		return { text, truncated: text.length >= maxBytes };
	}
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	let truncated = false;
	try {
		while (size < maxBytes) {
			const part = await reader.read();
			if (part.done) break;
			const bytes = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
			const remaining = maxBytes - size;
			const chunk = bytes.byteLength > remaining ? bytes.slice(0, remaining) : bytes;
			chunks.push(chunk);
			size += chunk.byteLength;
			if (chunk.byteLength < bytes.byteLength) { truncated = true; break; }
		}
	} finally { try { await reader.cancel(); } catch { /* best effort */ } }
	return { text: new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))), truncated };
}

async function get(url, { fetchFn = fetch, timeoutMs = 8_000 } = {}) {
	const safeUrl = validatePublicSourceUrl(url);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchFn(safeUrl.href, { method: "GET", redirect: "follow", signal: controller.signal, headers: { accept: "application/json,text/html,text/plain;q=0.9,*/*;q=0.1", "user-agent": USER_AGENT } });
	} finally { clearTimeout(timer); }
}

function htmlToText(input) {
	return String(input)
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
		.replace(/\s+/g, " ").trim();
}

export async function fetchPublicSource({ url, fetchFn = fetch } = {}) {
	const response = await get(url, { fetchFn });
	const { text, truncated } = await readLimited(response);
	const contentType = String(response.headers?.get?.("content-type") || "");
	const content = /html/i.test(contentType) || /<html[\s>]/i.test(text) ? htmlToText(text) : text.trim();
	return {
		url: String(url),
		final_url: response.url || String(url),
		status: response.status,
		ok: Boolean(response.ok),
		content_type: contentType,
		content: content.slice(0, MAX_SOURCE_BYTES),
		truncated,
	};
}

function githubResults(payload) {
	return (Array.isArray(payload?.items) ? payload.items : []).slice(0, MAX_RESULTS).map((item) => ({
		source: "github",
		name: item.full_name,
		description: item.description || "",
		url: item.html_url,
		stars: item.stargazers_count ?? null,
		language: item.language || null,
		updated_at: item.updated_at || null,
		license: item.license?.spdx_id || null,
	}));
}

function npmResults(payload) {
	return (Array.isArray(payload?.objects) ? payload.objects : []).slice(0, MAX_RESULTS).map((item) => ({
		source: "npm",
		name: item.package?.name,
		description: item.package?.description || "",
		url: item.package?.links?.npm || `https://www.npmjs.com/package/${encodeURIComponent(item.package?.name || "")}`,
		version: item.package?.version || null,
		updated_at: item.package?.date || null,
	}));
}

export async function searchPublicAlternatives({ query, fetchFn = fetch } = {}) {
	const normalized = String(query || "").trim();
	if (!normalized) throw new Error("query di ricerca vuota");
	const encoded = encodeURIComponent(`${normalized} in:name,description,readme`);
	const npmEncoded = encodeURIComponent(normalized);
	const results = [];
	const failures = [];
	for (const request of [
		{ source: "github", url: `https://api.github.com/search/repositories?q=${encoded}&sort=stars&order=desc&per_page=${MAX_RESULTS}`, parse: githubResults },
		{ source: "npm", url: `https://registry.npmjs.org/-/v1/search?text=${npmEncoded}&size=${MAX_RESULTS}`, parse: npmResults },
	]) {
		try {
			const response = await get(request.url, { fetchFn });
			const body = await response.json();
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			results.push(...request.parse(body));
		} catch (error) {
			failures.push({ source: request.source, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { query: normalized, fetched_at: new Date().toISOString(), results, failures, read_only: true };
}
