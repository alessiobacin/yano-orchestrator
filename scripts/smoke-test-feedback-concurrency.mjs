import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yano-feedback-lock-'));
process.env.YANO_DATA_DIR = root;
process.env.YANO_FEEDBACK_SKIP_NOTIFY = '1';
const { openDatabase, createFeedback } = await import('./yano-feedback.mjs');
const db = openDatabase();
let child;
try {
  const item = await createFeedback(db, { type: 'bug', project_id: 'concurrency', message: 'original', notify: false });
  child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { openDatabase } from ${JSON.stringify(new URL('./yano-feedback.mjs', import.meta.url).href)};
    const db = openDatabase();
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 400);
  `], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('writer exited before locking'); })]);
  db.prepare('UPDATE feedback SET message=? WHERE id=?').run('updated', item.id);
  assert.equal(db.prepare('SELECT message FROM feedback WHERE id=?').get(item.id).message, 'updated');
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  console.log('feedback concurrent writer waits and succeeds: passed');
} finally {
  if (child && child.exitCode === null) await once(child, 'exit');
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
