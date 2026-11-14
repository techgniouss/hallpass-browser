// Access levels: ask / trusted / full. The setting is person-only, signed, expiring, and fails closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'hallpass.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-access-'));
process.env.HALLPASS_HOME = HOME;
const A = await import('../src/access.mjs');
const vault = await import('../src/vault.mjs');
const policy = await import('../src/policy.mjs');
const { readLog } = await import('../src/audit.mjs');
const keystoreOk = process.platform === 'win32' || process.env.HALLPASS_KEYSTORE === 'file' || !!process.env.HALLPASS_TEST_LIBSECRET;
const skipKs = { skip: !keystoreOk };
const FILE = path.join(HOME, 'access.json');
const cli = (args, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input: input ?? '', env: { ...process.env, HALLPASS_HOME: HOME } });

test('default: ask, everything confirms, nothing is bypassed', () => {
  assert.equal(A.getAccess().level, 'ask');
  for (const k of ['gate', 'upload', 'signin']) assert.equal(A.bypasses(k, { url: 'https://play.google.com/console' }), false, k);
  const d = A.describeAccess();
  assert.equal(d.level, 'ask');
  assert.match(d.effect.risky_clicks, /confirmed by the person/);
  assert.ok(d.never_bypassed.length >= 6);
});

test('parseDuration / normalizeSite', () => {
  assert.equal(A.parseDuration('90m'), 90 * 60e3);
  assert.equal(A.parseDuration('4h'), 4 * 3600e3);
  assert.equal(A.parseDuration('2w'), 14 * 86400e3);
  for (const bad of ['', '0h', '-1h', '4', 'h4', '4 hours', null]) assert.equal(A.parseDuration(bad), null, String(bad));
  assert.equal(A.normalizeSite('play.google.com'), 'https://play.google.com');
  assert.equal(A.normalizeSite('https://*.supabase.com'), 'https://*.supabase.com');
  assert.equal(A.normalizeSite('*.supabase.com'), 'https://*.supabase.com');
  assert.equal(A.normalizeSite('localhost:3000'), 'http://localhost:3000');
  for (const bad of ['', '*.com', 'http://evil.example.com', 'not a host', 'ftp://x.test']) assert.equal(A.normalizeSite(bad), null, bad);
});

test('trusted: only the listed sites skip dialogs; unknown page = still asks; credentials need --include-credentials', skipKs, () => {
  A.setAccess({ level: 'trusted', sites: ['play.google.com', '*.supabase.com'] });
  const g = (u) => A.bypasses('gate', { url: u });
  assert.equal(g('https://play.google.com/console/u/0/developers'), true);
  assert.equal(g('https://app.supabase.com/dashboard'), true);
  assert.equal(g('https://supabase.com/dashboard'), false, 'wildcard is subdomains only');
  assert.equal(g('https://play.google.com.evil.example/'), false, 'lookalike host');
  assert.equal(g('https://evil.example/?next=play.google.com'), false);
  assert.equal(g('http://play.google.com/'), false, 'wrong scheme');
  assert.equal(g(''), false, 'unreadable page means ask');
  assert.equal(g(undefined), false);
  assert.equal(A.bypasses('upload', { url: 'https://play.google.com/x' }), true);
  assert.equal(A.bypasses('signin', { url: 'https://play.google.com/x' }), false, 'stored-login approvals are not waived by default');
  A.setAccess({ level: 'trusted', sites: ['play.google.com'], includeCredentials: true });
  assert.equal(A.bypasses('signin', { url: 'https://play.google.com/x' }), true);
  assert.equal(A.bypasses('signin', { url: 'https://other.example/x' }), false);
  assert.equal(A.bypasses('signin', { url: undefined }), false);
});

test('full: every site skips click/upload dialogs; stored-login approvals only with --include-credentials; always expires by default', skipKs, () => {
  A.setAccess({ level: 'full', ttlMs: A.parseDuration(A.DEFAULT_FULL_TTL) });
  assert.equal(A.bypasses('gate', { url: 'https://anything.example/' }), true);
  assert.equal(A.bypasses('gate', { url: '' }), true);
  assert.equal(A.bypasses('upload', { url: 'https://anything.example/' }), true);
  assert.equal(A.bypasses('signin', { url: 'https://anything.example/' }), false);
  const a = A.getAccess();
  assert.ok(Date.parse(a.expiresAt) - Date.now() > 3.9 * 3600e3 && Date.parse(a.expiresAt) - Date.now() <= 4 * 3600e3);
  A.setAccess({ level: 'full', includeCredentials: true });
  assert.equal(A.bypasses('signin', { url: 'https://anything.example/' }), true);
  assert.equal(A.getAccess().expiresAt, null, 'no ttl given to the library = never (the CLI is what applies the 4h default)');
  assert.equal(A.describeAccess().expires_in, 'never');
});

test('input validation', skipKs, () => {
  assert.throws(() => A.setAccess({ level: 'bogus' }), /level must be/);
  assert.throws(() => A.setAccess({ level: 'trusted', sites: [] }), /at least one site/);
  assert.throws(() => A.setAccess({ level: 'trusted', sites: ['not a host'] }), /every site/);
  assert.throws(() => A.setAccess({ level: 'full', sites: ['play.google.com'] }), /every site/);
});

test('expiry: an expired setting is ignored, not honoured', skipKs, () => {
  A.setAccess({ level: 'full', ttlMs: 60_000, now: Date.now() - 2 * 3600e3 }); // set two hours ago for one minute
  assert.equal(A.getAccess().level, 'ask');
  assert.equal(A.getAccess().source, 'expired');
  assert.match(A.describeAccess(A.getAccess()).note, /expired/);
  assert.equal(A.bypasses('gate', { url: 'https://x.example/' }), false);
});

test('tampering: editing the file, copying it from another vault, or forging one does nothing', skipKs, () => {
  A.setAccess({ level: 'trusted', sites: ['play.google.com'] });
  const good = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const write = (d) => fs.writeFileSync(FILE, JSON.stringify(d));
  // widen the level by hand
  write({ ...good, level: 'full', sites: [] });
  assert.equal(A.getAccess().level, 'ask'); assert.equal(A.getAccess().source, 'tampered');
  assert.match(A.describeAccess(A.getAccess()).note, /signature/);
  // add a site
  write({ ...good, sites: [...good.sites, 'https://evil.example'] });
  assert.equal(A.getAccess().level, 'ask');
  // stretch the expiry / flip credentials
  write({ ...good, expiresAt: '2999-01-01T00:00:00.000Z' }); assert.equal(A.getAccess().level, 'ask');
  write({ ...good, includeCredentials: true }); assert.equal(A.getAccess().level, 'ask');
  // forge from scratch with no / a wrong signature
  write({ v: 1, level: 'full', sites: [], expiresAt: null, includeCredentials: true, setAt: new Date().toISOString() }); assert.equal(A.getAccess().level, 'ask');
  write({ v: 1, level: 'full', sites: [], expiresAt: null, includeCredentials: true, setAt: new Date().toISOString(), mac: 'ab'.repeat(32) }); assert.equal(A.getAccess().level, 'ask');
  // garbage
  fs.writeFileSync(FILE, '{not json'); assert.equal(A.getAccess().level, 'ask');
  fs.writeFileSync(FILE, ''); assert.equal(A.getAccess().level, 'ask');
  // the genuine file still works
  write(good); assert.equal(A.getAccess().level, 'trusted');
  // trusted-site matching survives reordering that does not change meaning, but a changed site list does not
  A.clearAccess(); assert.equal(fs.existsSync(FILE), false);
});

test('CLI: loosening needs a real terminal; reading and tightening do not', skipKs, () => {
  for (const args of [['access', 'full'], ['access', 'trusted', 'play.google.com'], ['access', 'full', '--forever']]) {
    const r = cli(args, 'yes\n');
    assert.equal(JSON.parse(r.stdout).status, 'usage_error', args.join(' '));
    assert.match(JSON.parse(r.stdout).message, /real terminal/);
  }
  assert.equal(A.getAccess().level, 'ask', 'nothing changed');
  assert.equal(JSON.parse(cli(['access']).stdout).level, 'ask');
  assert.equal(JSON.parse(cli(['access', 'status']).stdout).level, 'ask');
  A.setAccess({ level: 'full', ttlMs: 3600e3 });
  assert.equal(JSON.parse(cli(['access']).stdout).level, 'full');
  assert.equal(JSON.parse(cli(['access', 'ask']).stdout).level, 'ask', 'an agent may always turn dialogs back on');
  assert.equal(A.getAccess().level, 'ask');
  assert.equal(JSON.parse(cli(['access', 'sudo']).stdout).status, 'usage_error');
});

test('doctor reports the level; results carry it when it is not "ask"', skipKs, () => {
  const check = () => JSON.parse(cli(['doctor']).stdout).checks.find((c) => c.name === 'access level');
  assert.match(check().detail, /^ask/);
  A.setAccess({ level: 'trusted', sites: ['play.google.com'], ttlMs: 3600e3 });
  assert.match(check().detail, /NOTE: trusted.*play\.google\.com.*hallpass access ask/);
  A.clearAccess();
});

test('stored-login approval: waived only when the person said so; limits and expiry still apply; audited', skipKs, () => {
  const meta = { url: 'https://login.example.com/', allowed: ['https://login.example.com'], userHint: 'u***', hasTotp: false, selectors: {}, successUrl: null, successText: null, lockNavigation: false, createdAt: new Date().toISOString(), requireApproval: true, maxUses: 2 };
  vault.put('needs-ok', meta, { username: 'u@x.test', password: 'Secret-Passw0rd-Z' });
  const noDialog = () => { throw new Error('the approval dialog must not be shown'); };
  const target = 'https://login.example.com/app';

  A.setAccess({ level: 'full' });
  let asked = 0;
  assert.equal(policy.authorizeUse('needs-ok', { target, approver: () => { asked++; return 'deny'; } })?.reason, 'approval_denied', 'full without --include-credentials still asks');
  assert.equal(asked, 1);

  A.setAccess({ level: 'full', includeCredentials: true });
  assert.equal(policy.authorizeUse('needs-ok', { target, approver: noDialog }), null, 'waived');
  assert.equal(policy.authorizeUse('needs-ok', { target, approver: noDialog }), null);
  assert.equal(policy.authorizeUse('needs-ok', { target, approver: noDialog })?.reason, 'credential_exhausted', 'use limit is not an approval: it still applies');

  A.setAccess({ level: 'trusted', sites: ['other.example.com'], includeCredentials: true });
  policy.resetUses('needs-ok');
  assert.equal(policy.authorizeUse('needs-ok', { target, approver: () => 'deny' })?.reason, 'approval_denied', 'trusted for a different site still asks');
  A.clearAccess();

  const log = readLog({ tail: 50 }).filter((e) => e.event === 'approval' && e.decision === 'allowed-by-access');
  assert.ok(log.length >= 2 && log.every((e) => e.level === 'full'), JSON.stringify(log));
  assert.ok(readLog({ tail: 80 }).some((e) => e.event === 'access' && e.level === 'full'), 'turning it on is itself logged');
});

test('trusted: a local dev host given without a port covers every port; with a port only that port', skipKs, () => {
  A.setAccess({ level: 'trusted', sites: ['localhost', '127.0.0.1:8080'] });
  const g = (u) => A.bypasses('gate', { url: u });
  assert.equal(g('http://localhost:3000/app'), true);
  assert.equal(g('http://localhost/app'), true);
  assert.equal(g('http://127.0.0.1:8080/x'), true);
  assert.equal(g('http://127.0.0.1:9090/x'), false);
  assert.equal(g('https://localhost.evil.example/'), false);
  assert.equal(g('http://notlocalhost:3000/'), false);
  A.clearAccess();
});

test('every result says when dialogs are being skipped (so the agent and the person can see it)', skipKs, () => {
  A.setAccess({ level: 'full', ttlMs: 3600e3 });
  const open = () => JSON.parse(spawnSync(process.execPath, [BIN, 'open', 'http://insecure.example.com/'], { encoding: 'utf8', env: { ...process.env, HALLPASS_HOME: HOME, HALLPASS_NO_AUTO_INSTALL: '1' } }).stdout);
  assert.equal(open().access, 'full'); // whatever the outcome (here: refused URL, or browser not installed), the level is shown
  A.clearAccess();
  assert.equal(open().access, undefined, 'nothing extra when the level is ask');
  const deny = JSON.parse(cli(['harden']).stdout).permissions.deny.join(' ');
  assert.match(deny, /hallpass access full/);
  assert.match(deny, /access\.json/);
});
