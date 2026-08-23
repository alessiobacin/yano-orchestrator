import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPlaybook, PlaybookRegistry, PlaybookValidationError } from "./playbook-loader.mjs";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const source = path.join(root, "playbooks", "default.yaml");
const playbook = loadPlaybook(source);
if (playbook.id !== "default-orchestration") throw new Error("ASSERTION FAILED: default Playbook loaded");
if (!/^[0-9a-f]{64}$/.test(playbook.metadata.checksum)) throw new Error("ASSERTION FAILED: checksum persisted");
if (playbook.metadata.origin !== source) throw new Error("ASSERTION FAILED: origin persisted");
const registry = new PlaybookRegistry();
if (registry.bind("run-1", playbook) !== playbook || registry.bind("run-1", playbook) !== playbook) throw new Error("ASSERTION FAILED: same run binding is idempotent");
let immutable = false;
try { playbook.states.push({ id: "tampered" }); } catch { immutable = true; }
if (!immutable) throw new Error("ASSERTION FAILED: loaded Playbook is immutable");
const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yano-playbook-loader-")), "bad.yaml");
fs.writeFileSync(bad, fs.readFileSync(source, "utf8").replace("to: scoping", "to: unknown-state"));
let failed = false;
try { loadPlaybook(bad); } catch (error) { failed = error instanceof PlaybookValidationError; }
if (!failed) throw new Error("ASSERTION FAILED: unknown transition state fails fast");
const badEffect = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yano-playbook-effect-")), "bad-effect.yaml");
fs.writeFileSync(badEffect, fs.readFileSync(source, "utf8").replace("kind: audit", "kind: arbitrary_external_command"));
let badEffectFailed = false;
try { loadPlaybook(badEffect); } catch (error) { badEffectFailed = error instanceof PlaybookValidationError; }
if (!badEffectFailed) throw new Error("ASSERTION FAILED: unknown effect kind fails fast");
const badPayload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yano-playbook-payload-")), "bad-payload.yaml");
fs.writeFileSync(badPayload, fs.readFileSync(source, "utf8").replace("kind: audit", "kind: human_approval"));
let badPayloadFailed = false;
try { loadPlaybook(badPayload); } catch (error) { badPayloadFailed = error instanceof PlaybookValidationError; }
if (!badPayloadFailed) throw new Error("ASSERTION FAILED: incomplete effect payload fails fast");
const changed = path.join(path.dirname(bad), "changed.yaml");
	fs.writeFileSync(changed, fs.readFileSync(source, "utf8").replace("label: Default Yano orchestration flow", "label: Changed orchestration flow"));
let conflict = false;
try { registry.bind("run-1", loadPlaybook(changed)); } catch (error) { conflict = error instanceof PlaybookValidationError; }
if (!conflict) throw new Error("ASSERTION FAILED: conflicting immutable binding is rejected");
console.log("OK — Playbook load, checksum, origin, validation, immutability and idempotent binding verified");
console.log("PLAYBOOK LOADER SMOKE TEST PASSED");
