import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-feedback-"));
process.env.YANO_DATA_DIR = dataDir;
process.env.YANO_FEEDBACK_SKIP_NOTIFY = "1";
const { openDatabase, createFeedback, claimFeedback, listFeedback } = await import("./yano-feedback.mjs");
const db = openDatabase();
const suggestion = await createFeedback(db, { type: "suggestion", project_id: "workspace-smoke", message: "Aumentare il contrasto" });
	assert.equal(suggestion.resolution, "user_confirmation");
	assert.equal(suggestion.status, "pending_planner");
	assert.equal(db.prepare("SELECT count(*) AS n FROM feedback WHERE id=?").get(suggestion.id).n, 1);
	const screenshot = path.join(dataDir, "bug.png");
	fs.writeFileSync(screenshot, Buffer.from("not-a-real-png"));
	const bug = await createFeedback(db, {
		type: "bug",
		project_id: "workspace-smoke",
		message: "Toast rosso",
		resolution: "automatic",
		test_username: "smoke-user",
		test_password: "smoke-password",
		screenshots: [{ path: screenshot }, { url: "https://example.test/bug.png" }],
	});
	assert.equal(bug.screenshots.length, 2);
	assert.equal(bug.screenshots[0].kind, "file");
	assert.equal(fs.existsSync(bug.screenshots[0].path), true);
	assert.equal(bug.screenshots[1].url, "https://example.test/bug.png");
assert.equal(JSON.parse(db.prepare("SELECT screenshots FROM feedback WHERE id=?").get(bug.id).screenshots).length, 2);
const first = await createFeedback(db, { type: "bug", project_id: "workspace-queue", message: "primo", resolution: "automatic", notify: false, test_username: "smoke-user", test_password: "smoke-password" });
const second = await createFeedback(db, { type: "bug", project_id: "workspace-queue", message: "secondo", resolution: "automatic", notify: false, test_username: "smoke-user", test_password: "smoke-password" });
assert.equal(listFeedback(db, { project_id: "workspace-queue", type: "bug", statuses: ["pending_planner"] })[0].id, first.id);
assert.equal(claimFeedback(db, first.id).status, "processing");
assert.equal(listFeedback(db, { project_id: "workspace-queue", type: "bug", statuses: ["pending_planner"] })[0].id, second.id);
db.prepare("UPDATE feedback SET status='processed' WHERE id=?").run(suggestion.id);
assert.equal(db.prepare("SELECT status FROM feedback WHERE id=?").get(suggestion.id).status, "processed");
db.prepare("DELETE FROM feedback WHERE id=?").run(suggestion.id);
assert.equal(db.prepare("SELECT count(*) AS n FROM feedback WHERE id=?").get(suggestion.id).n, 0);
db.close();
console.log("YANO FEEDBACK SMOKE TEST PASSED");
