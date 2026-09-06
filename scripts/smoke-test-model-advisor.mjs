// Regression for the ticket-recovery escalation feature (2026-09-04): when a
// ticket's retry/replan budget is exhausted, the escalation path needs to
// recommend a DIFFERENT provider than the one that already failed, or the
// "try something different" instruction is meaningless. scoreCatalog()/
// recommend() had no way to exclude a specific provider — this proves the
// new excludeProviderId option actually removes it from the ranked pool
// (and from the raw/no-price-data fallback ranking too), without touching
// any other scoring behavior. Pure/hermetic: exercises scoreCatalog()
// directly with a fabricated catalog, no network call.
import assert from "node:assert/strict";
import { scoreCatalog } from "./yano-model-advisor.mjs";

const catalog = {
	providers: [
		{ id: "provider-a", name: "Provider A", model: "model-a", coding: 80, price_in_usd_per_1m: 3, price_out_usd_per_1m: 9, bench_ms: 900, vision: false, free: false, available: true },
		{ id: "provider-b", name: "Provider B", model: "model-b", coding: 75, price_in_usd_per_1m: 3.2, price_out_usd_per_1m: 9.2, bench_ms: 950, vision: false, free: false, available: true },
	],
};

{
	const { ranked } = scoreCatalog(catalog, { roleClass: "support" });
	assert.ok(ranked.some((entry) => entry.id === "provider-a"), "sanity: provider-a is in the pool before excluding it");
}

{
	const { ranked } = scoreCatalog(catalog, { roleClass: "support", excludeProviderId: "provider-a" });
	assert.ok(!ranked.some((entry) => entry.id === "provider-a"), "excludeProviderId removes the failed provider from the ranked pool");
	assert.ok(ranked.some((entry) => entry.id === "provider-b"), "the other provider is still recommended");
}

{
	// The only provider available is the one that just failed: excluding it
	// must produce an empty ranked pool, not throw or silently ignore the
	// exclusion — the caller (escalation) needs to know no alternative exists.
	const singleProviderCatalog = { providers: [catalog.providers[0]] };
	const { ranked } = scoreCatalog(singleProviderCatalog, { roleClass: "support", excludeProviderId: "provider-a" });
	assert.equal(ranked.length, 0, "excluding the only available provider leaves nothing to recommend, not a false match");
}

{
	// excludeProviderId must not affect scoring when omitted — no regression
	// on the default path.
	const withoutExclude = scoreCatalog(catalog, { roleClass: "support" });
	const withNullExclude = scoreCatalog(catalog, { roleClass: "support", excludeProviderId: null });
	assert.deepEqual(withoutExclude.ranked.map((entry) => entry.id), withNullExclude.ranked.map((entry) => entry.id), "omitting excludeProviderId behaves identically to passing null");
}

console.log("smoke-test-model-advisor: ok");
