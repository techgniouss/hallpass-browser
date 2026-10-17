import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALLPASS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-audit-'));
const { audit, verifyLog, readLog } = await import('../src/audit.mjs');

test('audit log: hash chain detects edits, deletions and reordering; control characters are stripped', () => {
  const f = path.join(process.env.HALLPASS_HOME, 'audit.log');
  audit('open', { name: 'a', status: 'logged_in', url: 'https://x.test/p' });
  audit('login', { name: 'a', status: 'failed', reason: 'bad_credentials', note: 'multi\nline\u0000text' });
  audit('open', { name: 'b', status: 'needs_human' });
  assert.deepEqual(verifyLog(), { ok: true, entries: 3 });
  assert.equal(readLog({ tail: 2 }).length, 2);

  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, 'one physical line per entry even with newlines in a field');
  assert.ok(!lines[1].includes('\u0000'));

  const write = (arr) => fs.writeFileSync(f, arr.join('\n') + '\n');
  write([lines[0], lines[1].replace('bad_credentials', 'ok'), lines[2]]);
  assert.equal(verifyLog().ok, false, 'edited entry');
  write([lines[0], lines[2]]);
  assert.equal(verifyLog().ok, false, 'deleted entry');
  write([lines[1], lines[0], lines[2]]);
  assert.equal(verifyLog().ok, false, 'reordered entries');
  write(lines);
  assert.equal(verifyLog().ok, true, 'restored original verifies again');
});

test('audit log: never throws, even when the log location is unusable', () => {
  const prev = process.env.HALLPASS_HOME;
  process.env.HALLPASS_HOME = path.join(prev, 'audit.log', 'not-a-dir'); // a file in the path: mkdir/append must fail
  try { assert.doesNotThrow(() => audit('open', { name: 'x' })); } finally { process.env.HALLPASS_HOME = prev; }
});
