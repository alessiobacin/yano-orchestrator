import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRetention } from './yano-data.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yano-retention-'));
const previous = process.env.YANO_DATA_BACKUP_DIR;
try {
  const source = path.join(root, 'logs', 'old.log');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'preserve me');
  fs.utimesSync(source, new Date(0), new Date(0));
  const unavailable = path.join(root, 'not-a-directory');
  fs.writeFileSync(unavailable, 'block');
  process.env.YANO_DATA_BACKUP_DIR = path.join(unavailable, 'backup');
  const deferred = applyRetention({ root, yes: true });
  assert.equal(deferred.applied, false);
  assert.equal(deferred.reason, 'backup_unavailable');
  assert.equal(fs.readFileSync(source, 'utf8'), 'preserve me');
  process.env.YANO_DATA_BACKUP_DIR = path.join(root, 'backup');
  assert.equal(applyRetention({ root, yes: true }).applied, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(root, 'backup/retired/logs/old.log'), 'utf8'), 'preserve me');
  console.log('retention backup unavailable/recovery: passed');
} finally {
  if (previous === undefined) delete process.env.YANO_DATA_BACKUP_DIR;
  else process.env.YANO_DATA_BACKUP_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
}
