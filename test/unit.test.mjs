import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALLPASS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-unit-'));

const { totp, base32Decode, parseTotpInput } = await import('../src/totp.mjs');
const { parseOrigin, normalizeAllowed, isAllowed, safeUrl, globToRegExp, sameSite, siteOf } = await import('../src/origin.mjs');
const { Redactor } = await import('../src/redact.mjs');
const vault = await import('../src/vault.mjs');

test('TOTP matches RFC 6238 vectors (SHA1, 8 digits)', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  const cfg = { secret, algorithm: 'SHA1', digits: 8, period: 30 };
  assert.equal(totp(cfg, 59_000), '94287082');
  assert.equal(totp(cfg, 1111111109_000), '07081804');
  assert.equal(totp(cfg, 2000000000_000), '69279037');
});

test('TOTP accepts otpauth URIs and spaced secrets', () => {
  const c = parseTotpInput('otpauth://totp/x:y?secret=gezd gndv&digits=6&period=30');
  assert.equal(c.secret, 'GEZDGNDV');
  assert.equal(parseTotpInput('abcd efgh').secret, 'ABCDEFGH');
  assert.throws(() => base32Decode('not*base32'));
});

test('origins: https only, localhost exempt, wildcards are subdomain-only', () => {
  assert.equal(parseOrigin('http://evil.com'), null);
  assert.equal(parseOrigin('http://localhost:3000/x'), 'http://localhost:3000');
  assert.equal(normalizeAllowed('https://*.com'), null);
  assert.equal(normalizeAllowed('http://*.example.com'), null);
  const allowed = [normalizeAllowed('https://*.supabase.com'), normalizeAllowed('https://accounts.google.com')];
  assert.ok(isAllowed('https://app.supabase.com/x', allowed));
  assert.ok(!isAllowed('https://supabase.com', allowed), 'wildcard must not match the apex');
  assert.ok(!isAllowed('https://evilsupabase.com', allowed));
  assert.ok(!isAllowed('https://supabase.com.evil.io', allowed));
  assert.ok(!isAllowed('https://accounts.google.com.evil.io', allowed));
  assert.ok(!isAllowed('http://accounts.google.com', allowed), 'scheme downgrade');
  assert.ok(!isAllowed('https://accounts.google.com:8443', allowed), 'port must match');
});

test('safeUrl strips query and fragment', () => {
  assert.equal(safeUrl('https://a.com/p?token=abc#frag'), 'https://a.com/p');
  assert.ok(globToRegExp('https://a.com/**').test('https://a.com/x/y'));
  assert.ok(!globToRegExp('https://a.com/*').test('https://a.com/x/y'));
});

test('redactor scrubs raw, JSON, URL-encoded and base64 forms', () => {
  const pw = 'p@ss"w/rd&1+x';
  const r = new Redactor();
  r.add(pw);
  for (const form of [pw, JSON.stringify(pw), encodeURIComponent(pw), Buffer.from(pw).toString('base64')]) {
    assert.ok(!r.scrub(`before ${form} after`).includes(form), form);
  }
  assert.deepEqual(r.scrubDeep({ a: [`x${pw}`], b: { c: pw } }), { a: ['x[REDACTED]'], b: { c: '[REDACTED]' } });
  r.add('ab'); // too short to be a safe needle - ignored rather than mangling output
  assert.equal(r.scrub('about'), 'about');
});

test('vault: seals, opens, lists metadata only, and detects tampering', { skip: process.platform === 'linux' && !process.env.HALLPASS_TEST_LIBSECRET }, () => {
  const meta = { url: 'https://x.test/login', allowed: ['https://x.test'] };
  vault.put('demo', meta, { password: 'correct-horse-battery' });
  assert.deepEqual(vault.unseal('demo'), { password: 'correct-horse-battery' });

  const listing = JSON.stringify(vault.list());
  assert.ok(!listing.includes('correct-horse'));
  const raw = fs.readFileSync(path.join(process.env.HALLPASS_HOME, 'entries', 'demo.json'), 'utf8');
  assert.ok(!raw.includes('correct-horse'), 'ciphertext only on disk');
  for (const f of fs.readdirSync(process.env.HALLPASS_HOME)) {
    if (fs.statSync(path.join(process.env.HALLPASS_HOME, f)).isFile())
      assert.ok(!fs.readFileSync(path.join(process.env.HALLPASS_HOME, f), 'utf8').includes('correct-horse'));
  }

  // widening the trusted origins on disk must brick the entry, not silently work
  const p = path.join(process.env.HALLPASS_HOME, 'entries', 'demo.json');
  const d = JSON.parse(raw);
  d.meta.allowed.push('https://evil.test');
  fs.writeFileSync(p, JSON.stringify(d));
  assert.throws(() => vault.unseal('demo'), /integrity/);
});

test('vault: "site-" names are reserved for saved-session profiles', () => {
  assert.throws(() => vault.put('site-github.com', {}, {}), /reserved/);
});

test('vault rejects path-traversal names', () => {
  assert.throws(() => vault.put('../x', {}, {}), /invalid name/);
  assert.throws(() => vault.meta('A B'), /invalid name/);
});

test('findByUrl: matches own origin and approved wildcards, never a bare IdP origin', () => {
  vault.put('sb', { url: 'https://supabase.com/dashboard/sign-in', allowed: ['https://supabase.com', 'https://*.supabase.com', 'https://github.com'] }, { password: 'x'.repeat(8) });
  vault.put('gp', { url: 'https://play.google.com/console', allowed: ['https://play.google.com', 'https://accounts.google.com'] }, { password: 'y'.repeat(8) });
  assert.deepEqual(vault.findByUrl('https://supabase.com/dashboard/project/x'), ['sb']);
  assert.deepEqual(vault.findByUrl('https://app.supabase.com/x'), ['sb']);
  assert.deepEqual(vault.findByUrl('https://play.google.com/console/u/0/developers'), ['gp']);
  assert.deepEqual(vault.findByUrl('https://github.com/settings'), [], 'github.com is only an IdP hop for sb, not its home');
  assert.deepEqual(vault.findByUrl('https://accounts.google.com/'), [], 'a Google entry must not claim all Google-SSO sites');
  assert.deepEqual(vault.findByUrl('http://supabase.com/'), [], 'no http');
  assert.deepEqual(vault.findByUrl('not a url'), []);
});

test('sameSite: benign redirects do not count as "sent somewhere else"; real ones do', () => {
  assert.ok(sameSite('https://www.example.com/a', 'https://example.com/b'), 'www <-> apex');
  assert.ok(sameSite('https://app.example.com/', 'https://example.com/'), 'subdomain <-> apex');
  assert.ok(sameSite('http://example.com/', 'https://example.com/'), 'http -> https');
  assert.ok(sameSite('https://docs.example.co.uk/', 'https://www.example.co.uk/'), 'two-level suffix');
  assert.ok(!sameSite('https://google.play/business/', 'https://play.google.com/console'), 'Play Console marketing bounce');
  assert.ok(!sameSite('https://a.co.uk/', 'https://b.co.uk/'), 'different registrants under a shared suffix');
  assert.ok(!sameSite('http://127.0.0.1:1/', 'http://localhost:1/'), 'ip vs name');
  assert.equal(siteOf('console.cloud.google.com'), 'google.com');
  assert.equal(sameSite('not a url', 'https://a.com'), false);
});

const policy = await import('../src/policy.mjs');
const ui = await import('../src/ui.mjs');

const skipNoKeystore = { skip: process.platform === 'linux' && !process.env.HALLPASS_TEST_LIBSECRET };

test('policy: approval decisions, 1-hour grants, grant forgery, expiry, max uses', skipNoKeystore, () => {
  const meta = (extra) => ({ url: 'https://p.test/login', allowed: ['https://p.test'], ...extra });
  vault.put('needs-ok', meta({ requireApproval: true }), { password: 'abcdefgh' });
  let calls = 0;
  const ans = (id) => () => { calls++; return id; };

  assert.equal(policy.checkPolicy('needs-ok', { approver: ans('deny') }).reason, 'approval_denied');
  assert.equal(policy.checkPolicy('needs-ok', { approver: ans(null) }).reason, 'approval_denied', 'timeout / no GUI = deny');
  assert.equal(policy.checkPolicy('needs-ok', { approver: ans('once') }), null);
  assert.equal(calls, 3);
  assert.equal(policy.checkPolicy('needs-ok', { approver: ans('deny') }).reason, 'approval_denied', 'allow-once leaves no grant behind');

  assert.equal(policy.checkPolicy('needs-ok', { approver: ans('hour') }), null);
  const before = calls;
  assert.equal(policy.checkPolicy('needs-ok', { approver: ans('deny') }), null, 'grant is honoured without asking');
  assert.equal(calls, before);

  // a hand-forged or edited grant is worthless
  const gf = path.join(process.env.HALLPASS_HOME, 'state', 'needs-ok.grant');
  const g = JSON.parse(fs.readFileSync(gf, 'utf8'));
  fs.writeFileSync(gf, JSON.stringify({ ...g, exp: g.exp + 86_400_000 }));
  assert.equal(policy.checkPolicy('needs-ok', { approver: ans('deny') }).reason, 'approval_denied', 'extended expiry detected');
  fs.writeFileSync(gf, JSON.stringify({ name: 'needs-ok', exp: Date.now() + 1e9, mac: 'ab'.repeat(32) }));
  assert.equal(policy.checkPolicy('needs-ok', { approver: ans('deny') }).reason, 'approval_denied', 'forged mac detected');

  vault.put('old', meta({ expiresAt: new Date(Date.now() - 1000).toISOString() }), { password: 'abcdefgh' });
  assert.equal(policy.checkPolicy('old').reason, 'credential_expired');

  vault.put('twice', meta({ maxUses: 2 }), { password: 'abcdefgh' });
  assert.equal(policy.checkPolicy('twice'), null);
  assert.equal(policy.checkPolicy('twice'), null);
  assert.equal(policy.checkPolicy('twice').reason, 'credential_exhausted');
  policy.resetUses('twice');
  assert.equal(policy.checkPolicy('twice'), null, 'a human re-add resets the counter');

  vault.put('plain', meta({}), { password: 'abcdefgh' });
  assert.equal(policy.checkPolicy('plain', { approver: () => { throw new Error('must not ask'); } }), null, 'no approval requested unless the entry demands it');
});

test('ui: with no GUI available every dialog answers deny', () => {
  process.env.HALLPASS_NO_UI = '1';
  try { assert.equal(ui.ask({ title: 't', message: 'm', buttons: [{ id: 'deny', label: 'Deny' }, { id: 'once', label: 'Allow' }] }), null); }
  finally { delete process.env.HALLPASS_NO_UI; }
});

test('policy: expiry parsing', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(policy.parseExpiry('12h', now), '2026-01-01T12:00:00.000Z');
  assert.equal(policy.parseExpiry('2w', now), '2026-01-15T00:00:00.000Z');
  assert.equal(policy.parseExpiry('2027-03-04', now), '2027-03-04T00:00:00.000Z');
  assert.equal(policy.parseExpiry('soon', now), null);
});
