#!/usr/bin/env node

import assert from "node:assert/strict";
import { page } from "./yano-feedback-dashboard.mjs";

const html = page("bug", "project-123", "newMioDOC");
assert.match(html, /timeZone:'Europe\/Rome'/);
assert.match(html, /Messaggio \*/);
assert.match(html, /multiple/);
assert.match(html, /dropzone/);
assert.match(html, /data-file-preview/);
assert.match(html, /position:sticky/);
assert.match(html, /card-main/);
assert.match(html, /function cleanUrl/);
assert.doesNotMatch(html, /test_password/);
assert.doesNotMatch(html, /test_username/);
console.log("FEEDBACK DASHBOARD SMOKE TEST PASSED");
