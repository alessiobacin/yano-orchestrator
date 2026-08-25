import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

const TOP_LEVEL_KEYS = new Set(["schema_version", "id", "label", "description", "enforcement", "catalog", "team", "states", "transitions", "failure_routes", "invariants", "non_code_tasks"]);
const EFFECT_KINDS = new Set(["audit", "human_approval", "mqtt_event", "notification"]);

export class PlaybookValidationError extends Error {
	constructor(message, details = {}) {
		super(`Playbook validation failed: ${message}`);
		this.name = "PlaybookValidationError";
		this.details = details;
	}
}

function assert(condition, message, details) {
	if (!condition) throw new PlaybookValidationError(message, details);
}

function deepFreeze(value, seen = new Set()) {
	if (!value || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	return Object.freeze(value);
}

function uniqueIds(items, kind) {
	const seen = new Set();
	for (const item of items) {
		assert(item && typeof item.id === "string" && item.id.trim(), `${kind} requires a non-empty id`);
		assert(!seen.has(item.id), `${kind} id is duplicated: ${item.id}`);
		seen.add(item.id);
	}
}

function validateCatalog(catalog, source) {
	if (catalog === undefined) return;
	assert(catalog && typeof catalog === "object" && !Array.isArray(catalog), "catalog must be a mapping", { source });
	if (catalog.scope !== undefined) assert(catalog.scope === "global", "catalog.scope must be global", { source });
	if (catalog.reusable !== undefined) assert(typeof catalog.reusable === "boolean", "catalog.reusable must be boolean", { source });
	for (const field of ["intents", "exclusions", "parameters"]) {
		if (catalog[field] !== undefined) assert(Array.isArray(catalog[field]) && catalog[field].every((value) => typeof value === "string" && value.trim()), `catalog.${field} must be an array of strings`, { source });
	}
}

function validateTeam(team, source) {
	if (team === undefined) return;
	assert(team && typeof team === "object" && !Array.isArray(team), "team must be a mapping", { source });
	assert(typeof team.strategy === "string" && team.strategy.trim(), "team.strategy must be a non-empty string", { source });
	assert(Array.isArray(team.roles) && team.roles.length > 0, "team.roles must be a non-empty array", { source });
	uniqueIds(team.roles, "team role");
	const roleIds = new Set(team.roles.map((role) => role.id));
	for (const role of team.roles) {
		assert(typeof role.purpose === "string" && role.purpose.trim(), `team role ${role.id} requires purpose`, { source });
		for (const field of ["outputs", "write_scope", "capabilities"]) {
			if (role[field] !== undefined) assert(Array.isArray(role[field]) && role[field].every((value) => typeof value === "string"), `team role ${role.id}.${field} must be an array of strings`, { source });
		}
	}
	if (team.default_variant !== undefined) assert(typeof team.default_variant === "string" && team.default_variant.trim(), "team.default_variant must be a string", { source });
	if (team.variants !== undefined) {
		assert(Array.isArray(team.variants) && team.variants.length > 0, "team.variants must be a non-empty array", { source });
		uniqueIds(team.variants, "team variant");
		for (const variant of team.variants) {
			assert(Array.isArray(variant.roles) && variant.roles.length > 0, `team variant ${variant.id} requires roles`, { source });
			assert(variant.roles.every((role) => roleIds.has(role)), `team variant ${variant.id} references an unknown team role`, { source });
			if (variant.parallel_groups !== undefined) {
				assert(Array.isArray(variant.parallel_groups), `team variant ${variant.id}.parallel_groups must be an array`, { source });
				for (const group of variant.parallel_groups) assert(Array.isArray(group) && group.every((role) => roleIds.has(role)), `team variant ${variant.id} has an invalid parallel group`, { source });
			}
		}
		if (team.default_variant !== undefined) assert(team.variants.some((variant) => variant.id === team.default_variant), "team.default_variant does not reference a declared variant", { source });
	}
}

export function validatePlaybook(document, source = "<memory>") {
	assert(document && typeof document === "object" && !Array.isArray(document), "root must be a mapping", { source });
	for (const key of Object.keys(document)) assert(TOP_LEVEL_KEYS.has(key), `unknown root key: ${key}`, { source, key });
	assert(Number.isInteger(document.schema_version) && document.schema_version >= 1, "schema_version must be a positive integer", { source });
	for (const field of ["id", "label", "description"]) assert(typeof document[field] === "string" && document[field].trim(), `${field} must be a non-empty string`, { source, field });
	assert(Array.isArray(document.states) && document.states.length > 0, "states must be a non-empty array", { source });
	assert(Array.isArray(document.transitions), "transitions must be an array", { source });
	assert(Array.isArray(document.failure_routes), "failure_routes must be an array", { source });
	assert(Array.isArray(document.invariants), "invariants must be an array", { source });
	validateCatalog(document.catalog, source);
	validateTeam(document.team, source);
	uniqueIds(document.states, "state");
	uniqueIds(document.transitions, "transition");
	const stateIds = new Set(document.states.map((state) => state.id));
	for (const state of document.states) {
		assert(typeof state.owner === "string" && state.owner.trim(), `state ${state.id} requires owner`, { source });
		assert(typeof state.terminal === "boolean", `state ${state.id} requires boolean terminal`, { source });
	}
	for (const transition of document.transitions) {
		const from = Array.isArray(transition.from) ? transition.from : [transition.from];
		assert(from.length > 0 && from.every((id) => typeof id === "string" && stateIds.has(id)), `transition ${transition.id} references unknown from state`, { source });
		assert(typeof transition.to === "string" && stateIds.has(transition.to), `transition ${transition.id} references unknown to state`, { source });
		assert(typeof transition.actor === "string" && transition.actor.trim(), `transition ${transition.id} requires actor`, { source });
		assert(transition.requires === undefined || Array.isArray(transition.requires), `transition ${transition.id} requires must be an array`, { source });
		if (transition.effects !== undefined) {
			assert(Array.isArray(transition.effects), `transition ${transition.id} effects must be an array`, { source });
			for (const effect of transition.effects) {
				assert(effect && typeof effect.id === "string" && effect.id.trim(), `transition ${transition.id} effect requires id`, { source });
				assert(typeof effect.kind === "string" && effect.kind.trim(), `transition ${transition.id} effect ${effect.id} requires kind`, { source });
				assert(EFFECT_KINDS.has(effect.kind), `transition ${transition.id} effect ${effect.id} has unknown kind: ${effect.kind}`, { source });
				assert(effect.payload === undefined || (effect.payload && typeof effect.payload === "object" && !Array.isArray(effect.payload)), `transition ${transition.id} effect ${effect.id} payload must be a mapping`, { source });
				if (effect.kind === "human_approval") assert(typeof effect.payload?.question === "string" && effect.payload.question.trim(), `transition ${transition.id} human_approval effect ${effect.id} requires payload.question`, { source });
				if (effect.kind === "mqtt_event") assert(typeof effect.payload?.topic === "string" && effect.payload.topic.trim(), `transition ${transition.id} mqtt_event effect ${effect.id} requires payload.topic`, { source });
				if (effect.kind === "notification") assert(typeof effect.payload?.message === "string" && effect.payload.message.trim(), `transition ${transition.id} notification effect ${effect.id} requires payload.message`, { source });
			}
		}
	}
	for (const route of document.failure_routes) {
		assert(route && typeof route.condition === "string" && route.condition.trim(), "failure route requires condition", { source });
		assert(typeof route.action === "string" && route.action.trim(), `failure route ${route.condition} requires action`, { source });
		assert(typeof route.terminal === "boolean", `failure route ${route.condition} requires boolean terminal`, { source });
	}
	return document;
}

export function loadPlaybook(filePath, { expectedChecksum } = {}) {
	const origin = path.resolve(filePath);
	let raw;
	try { raw = fs.readFileSync(origin, "utf8"); } catch (error) { throw new PlaybookValidationError(`cannot read ${origin}: ${error.message}`, { origin }); }
	const checksum = createHash("sha256").update(raw).digest("hex");
	if (expectedChecksum && expectedChecksum !== checksum) throw new PlaybookValidationError(`checksum mismatch for ${origin}`, { origin, expectedChecksum, checksum });
	let document;
	try { document = parseYaml(raw); } catch (error) { throw new PlaybookValidationError(`invalid YAML in ${origin}: ${error.message}`, { origin }); }
	validatePlaybook(document, origin);
	return deepFreeze({ ...document, metadata: Object.freeze({ origin, checksum }) });
}

export class PlaybookRegistry {
	#runs = new Map();

	bind(runId, playbook) {
		assert(typeof runId === "string" && runId.trim(), "runId must be a non-empty string");
		const existing = this.#runs.get(runId);
		if (existing) {
			if (existing.metadata.checksum !== playbook.metadata.checksum) throw new PlaybookValidationError(`run ${runId} is already bound to an immutable Playbook`, { runId, existing: existing.metadata, received: playbook.metadata });
			return existing;
		}
		this.#runs.set(runId, playbook);
		return playbook;
	}

	get(runId) { return this.#runs.get(runId); }
	size() { return this.#runs.size; }
}
