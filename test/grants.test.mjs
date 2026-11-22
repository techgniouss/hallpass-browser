// Root cause of "asked again for every image replacement": `hallpass do` is a new process per command, and the 1-hour grants
// used to live in an in-memory Map. Grants must survive a process boundary, stay scoped, expire, and resist tampering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

process.env.HALLPASS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-grants-'));
process.env.HALLPASS_KEYSTORE = 'file';
const { masterKey } = await import('../src/keystore.mjs');
const { gateGrantKey } = await import('../src/act.mjs');
const g = await import('../src/grants.mjs');
masterKey(); // a vault key exists, so grants can be signed

test('1-hour site grants persist across processes, are scoped and expire', () => {
  const scope = gateGrantKey('hp-play', 'https://play.google.com/console/x');
  assert.equal(g.siteGrantValid('gate', scope), false);
  g.writeSiteGrant('gate', scope);
  assert.equal(g.siteGrantValid('gate', scope), true);
  assert.equal(g.siteGrantValid('upload', scope), false, 'a click grant is not an upload grant');
  assert.equal(g.siteGrantValid('gate', gateGrantKey('hp-play', 'https://evil.example/x')), false, 'per origin');
  assert.equal(g.siteGrantValid('gate', gateGrantKey('hp-other', 'https://play.google.com/x')), false, 'per session');
  assert.equal(g.siteGrantValid('gate', scope, Date.now() + g.GRANT_MS + 1000), false, 'expires after an hour');
  assert.equal(g.siteGrantValid('gate', null), false, 'no origin, no grant');

  const href = new URL('../src/grants.mjs', import.meta.url).href;
  const probe = `import(${JSON.stringify(href)}).then(m=>process.stdout.write(String(m.siteGrantValid('gate', ${JSON.stringify(scope)}))))`;
  const r = spawnSync(process.execPath, ['-e', probe], { env: process.env, encoding: 'utf8' });
  assert.equal(r.stdout, 'true', 'a separate process (like each `hallpass do`) still sees the grant: ' + r.stderr);
  g.revokeSiteGrant('gate', scope);
});

test('an edited or hand-written grant file is worthless', () => {
  const scope = gateGrantKey('hp-tamper', 'https://play.google.com/x');
  g.writeSiteGrant('gate', scope);
  const dir = path.join(process.env.HALLPASS_HOME, 'state');
  const f = fs.readdirSync(dir).find((n) => n.startsWith('site-gate-'));
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  fs.writeFileSync(path.join(dir, f), JSON.stringify({ ...j, exp: j.exp + 86_400_000 }));
  assert.equal(g.siteGrantValid('gate', scope), false, 'extended expiry detected');
  fs.writeFileSync(path.join(dir, f), JSON.stringify({ name: j.name, exp: Date.now() + 1e9, mac: 'ab'.repeat(32) }));
  assert.equal(g.siteGrantValid('gate', scope), false, 'forged signature detected');
});
