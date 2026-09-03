import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allocateTestEnvironment, releaseTestEnvironment } from "./yano-test-environment.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-e2e-env-"));
const blocker = net.createServer();
await new Promise((resolve) => blocker.listen({ port: 14200, host: "127.0.0.1" }, resolve));
try {
	const env = await allocateTestEnvironment({ worktreePath: root });
	assert.notEqual(env.frontend_port, 14200, "una porta frontend occupata non viene riusata");
	assert.ok(env.frontend_port >= 14200 && env.frontend_port <= 14999);
	assert.ok(env.backend_port >= 13200 && env.backend_port <= 13999);
	assert.equal(JSON.parse(fs.readFileSync(env.path, "utf8")).worktree_path, root);
	assert.equal(releaseTestEnvironment(root).removed, true);
	console.log("smoke-test-yano-test-environment: ok");
} finally {
	blocker.close();
	fs.rmSync(root, { recursive: true, force: true });
}
