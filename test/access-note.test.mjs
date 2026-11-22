// When trusted/full was set but is not in force (expired / unverifiable), the person and the agent are told why,
// instead of prompts silently coming back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-anote-'));
process.env.HALLPASS_HOME = HOME;
process.env.HALLPASS_KEYSTORE = 'file';
const A = await import('../src/access.mjs');
const ui = await import('../src/ui.mjs');
const FILE = path.join(HOME, 'access.json');

test('nothing set: no note', () => {
  assert.equal(A.ignoredAccessNote(), '');
});

test('working setting: no note', () => {
  A.setAccess({ level: 'trusted', sites: ['play.google.com'] });
  assert.equal(A.getAccess().level, 'trusted');
  assert.equal(A.ignoredAccessNote(), '');
});

test('expired setting: note says it expired, and the agent message carries it', () => {
  A.setAccess({ level: 'full', ttlMs: 60_000, now: Date.now() - 2 * 3600e3 });
  assert.match(A.ignoredAccessNote(), /expired/);
  process.env.HALLPASS_NO_UI = '1';
  try { ui.ask({ title: 't', message: 'm', buttons: [{ id: 'deny', label: 'Deny' }, { id: 'once', label: 'Allow' }] }); } finally { delete process.env.HALLPASS_NO_UI; }
  assert.match(ui.explainNoApproval('action', 'play.google.com'), /setting expired/);
});

test('unverifiable setting: note says the signature cannot be verified', () => {
  A.setAccess({ level: 'trusted', sites: ['play.google.com'] });
  const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  fs.writeFileSync(FILE, JSON.stringify({ ...d, sites: [...d.sites, 'https://other.example'] }));
  assert.match(A.ignoredAccessNote(), /signature cannot be verified/);
  A.clearAccess();
  assert.equal(A.ignoredAccessNote(), '');
});
