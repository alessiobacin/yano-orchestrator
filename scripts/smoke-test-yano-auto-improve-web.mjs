import assert from "node:assert/strict";
import { fetchPublicSource, searchPublicAlternatives, validatePublicSourceUrl } from "./yano-auto-improve-web.mjs";

const calls = [];
const headers = (contentType = "application/json") => ({ get(name) { return name.toLowerCase() === "content-type" ? contentType : null; } });
const fetchFn = async (url) => {
	calls.push(url);
	if (url.startsWith("https://api.github.com/")) return { ok: true, status: 200, url, headers: headers(), json: async () => ({ items: [{ full_name: "acme/memory", html_url: "https://github.com/acme/memory", description: "memory for agents", stargazers_count: 42, language: "TypeScript", license: { spdx_id: "MIT" } }] }) };
	if (url.startsWith("https://registry.npmjs.org/")) return { ok: true, status: 200, url, headers: headers(), json: async () => ({ objects: [{ package: { name: "agent-memory", description: "memory package", version: "1.2.3", links: { npm: "https://www.npmjs.com/package/agent-memory" } } }] }) };
	return { ok: true, status: 200, url, headers: headers("text/html"), text: async () => "<html><script>secret()</script><h1>Official docs</h1><p>Hybrid search and MCP.</p></html>" };
};

const search = await searchPublicAlternatives({ query: "coding agent memory", fetchFn });
assert.equal(search.read_only, true);
assert.equal(search.failures.length, 0);
assert.equal(search.results.length, 2);
assert.ok(search.results.some((item) => item.source === "github"));
assert.ok(search.results.some((item) => item.source === "npm"));
assert.ok(calls.some((url) => url.startsWith("https://api.github.com/search/repositories")));
assert.ok(calls.some((url) => url.startsWith("https://registry.npmjs.org/-/v1/search")));

const source = await fetchPublicSource({ url: "https://docs.example.com/memory", fetchFn });
assert.equal(source.ok, true);
assert.match(source.content, /Official docs/);
assert.doesNotMatch(source.content, /secret/);

assert.equal(validatePublicSourceUrl("https://github.com/acme/memory").hostname, "github.com");
assert.throws(() => validatePublicSourceUrl("http://github.com/acme/memory"), /HTTPS/);
assert.throws(() => validatePublicSourceUrl("https://localhost/private"), /locale|privato/);
assert.throws(() => validatePublicSourceUrl("https://user:pass@example.com/private"), /credenziali/);

console.log("smoke-test-yano-auto-improve-web: ok");
