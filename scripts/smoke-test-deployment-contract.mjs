import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const roles = parse(read("agents/roles.yaml")).roles;
const playbook = parse(read("playbooks/deployment-delivery.yaml"));
const skill = read("skills-vendor/yano/yano-deployment/SKILL.md");
const prompt = read("prompts/deployment-agent.md");

const role = roles["deployment-agent"];
assert.ok(role, "deployment-agent deve essere registrato");
assert.equal(role.playbook, "deployment-delivery");
assert.deepEqual(role.mcp, [], "il deploy Docker locale non deve richiedere MCP remoto");
for (const cli of ["git", "npm", "npx", "docker", "docker-compose", "curl"]) assert.ok(role.cli.includes(cli), `deployment-agent deve dichiarare ${cli}`);
assert.ok(role.skills.includes("yano-deployment"));
assert.ok(role.skills.includes("yano-planner-trace-analysis"));

assert.equal(playbook.id, "deployment-delivery");
assert.ok(playbook.invariants.includes("development_uses_source_at_canonical_projects_path"));
assert.ok(playbook.invariants.includes("staging_and_production_are_dockerized"));
assert.ok(playbook.invariants.includes("paired_backend_and_frontend_port_ranges_are_preserved"));
assert.ok(playbook.invariants.includes("no_production_deploy_without_explicit_approval"));
assert.ok(playbook.invariants.includes("previous_release_and_rollback_checkpoint_are_retained"));
assert.match(skill, /B\+1000/);
assert.match(skill, /B\+3000/);
assert.match(skill, /Docker\/Compose/);
assert.match(skill, /immutable image/);
assert.match(prompt, /deployment-delivery/);
assert.match(prompt, /awaiting_validation/);
assert.match(prompt, /rollback/);

console.log("smoke-test-deployment-contract: ok");
