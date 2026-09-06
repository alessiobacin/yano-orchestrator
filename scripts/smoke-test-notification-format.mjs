import assert from "node:assert/strict";
import { formatNotification, inferNotificationStatus } from "./yano-notification-format.mjs";

const message = formatNotification('Task "fix-supplier": commit eseguito; in attesa di feedback utente', {
	sender: "planner-01", role: "planner", project: "newMioDOC", server: "mac-test", previousVersion: "1.5.48", currentVersion: "1.5.49",
});

assert.match(message, /Mittente: planner-01 \(planner\)/);
assert.match(message, /Progetto: newMioDOC/);
assert.match(message, /Server: mac-test/);
assert.match(message, /Task: fix-supplier/);
assert.match(message, /Versione software: precedente 1\.5\.48 → attuale 1\.5\.49/);
assert.match(message, /Stato: in attesa di feedback utente/);
assert.equal(inferNotificationStatus("deploy completato"), "deployed");
console.log("smoke-test-notification-format: passed");
