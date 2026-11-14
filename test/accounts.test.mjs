// Several accounts for one website: keys, listing, choosing, and the "never guess" rule. No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'hallpass.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-acct-'));
process.env.HALLPASS_HOME = HOME;
process.env.HALLPASS_NO_BROWSER = '1';
const vault = await import('../src/vault.mjs');
const acc = await import('../src/accounts.mjs');
const { listSessions } = await import('../src/sessions.mjs');
const { startCredentialRequest } = await import('../src/request.mjs');
const keystoreOk = process.platform === 'win32' || process.env.HALLPASS_KEYSTORE === 'file' || !!process.env.HALLPASS_TEST_LIBSECRET;
const skipKs = { skip: !keystoreOk };

const PLAY = 'https://play.google.com/console/u/0/developers';
const meta = (url, extra = {}) => ({ url, allowed: [new URL(url).origin], userHint: 'u***@x.test', hasTotp: false, selectors: {}, successUrl: null, successText: null, lockNavigation: false, createdAt: new Date().toISOString(), ...extra });
const profile = (key) => fs.mkdirSync(path.join(HOME, 'profiles', key), { recursive: true });
const cli = (args, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input: input ?? '', env: { ...process.env, HALLPASS_HOME: HOME } });

test('keys: unlabelled stays site-<host>; a label adds __label; parsing round-trips; hosts never collide with labels', () => {
  assert.equal(acc.siteKey('https://play.google.com/console'), 'site-play.google.com');
  assert.equal(acc.siteKey('https://play.google.com/console', 'default'), 'site-play.google.com');
  assert.equal(acc.siteKey('https://play.google.com/console', 'work'), 'site-play.google.com__work');
  assert.deepEqual(acc.parseSiteKey('site-play.google.com__work'), { hostKey: 'site-play.google.com', label: 'work' });
  assert.deepEqual(acc.parseSiteKey('site-play.google.com'), { hostKey: 'site-play.google.com', label: null });
  assert.equal(acc.parseSiteKey('simple'), null);
  assert.deepEqual(acc.parseSiteKey('site-xn--80ak6aa92e.com__a'), { hostKey: 'site-xn--80ak6aa92e.com', label: 'a' }, 'punycode "--" in a host is not a separator');
  assert.throws(() => acc.siteKey('https://x.test', 'Bad Label'), /label/);
  for (const bad of ['', 'UPPER', 'a b', 'a_b', '-a', 'x'.repeat(33), '../x']) assert.equal(acc.validLabel(bad), false, bad);
  for (const good of ['work', 'a', 'client-2', 'x'.repeat(32)]) assert.equal(acc.validLabel(good), true, good);
  // every key is a legal vault/session name (<= 63) even for very long hosts and labels
  const long = 'https://' + 'a'.repeat(60) + '.example.com/';
  for (const l of [undefined, 'work', 'x'.repeat(32)]) {
    const k = acc.siteKey(long, l);
    assert.ok(k.length <= 63 && vault.validName(k), k);
    assert.equal(acc.parseSiteKey(k).label, l || null);
    assert.equal(acc.keyIsForUrl(k, long), true, k);
  }
  assert.equal(acc.keyIsForUrl('site-play.google.com__work', 'https://play.google.com/x'), true);
  assert.equal(acc.keyIsForUrl('site-play.google.com__work', 'https://accounts.google.com/x'), false);
  assert.equal(acc.keyIsForUrl('site-play.google.com', 'https://play.google.com.evil.example/'), false);
});

test('cleanLabel: one printable line, short', () => {
  assert.equal(acc.cleanLabel('  work\u0000\n  account  '), 'work account');
  assert.equal(acc.cleanLabel('x'.repeat(100)).length, 40);
  assert.equal(acc.cleanLabel(undefined), '');
});

test('no accounts yet: nothing to choose, opens the default saved login', () => {
  const r = acc.resolveAccount(PLAY);
  assert.deepEqual([r.key, r.isNew, r.error], ['site-play.google.com', true, undefined]);
  assert.equal(acc.accountsFor(PLAY).needs_choice, false);
});

test('saved browser logins: one is used silently, several force a question (and --as picks, or creates, one)', () => {
  profile('site-play.google.com__work');
  let r = acc.resolveAccount(PLAY);
  assert.deepEqual([r.key, r.label, r.isNew], ['site-play.google.com__work', 'work', false], 'a lone saved login is simply used');

  profile('site-play.google.com__personal');
  r = acc.resolveAccount(PLAY);
  assert.equal(r.error?.reason, 'ambiguous_account', 'two saved logins -> refuses to guess');
  assert.deepEqual(r.error.candidates, ['personal', 'work']);
  assert.match(r.error.detail, /Ask the user/);
  assert.ok(r.error.accounts.every((a) => a.description.startsWith(a.as + ':')));

  profile('site-play.google.com'); // the old unlabelled login joins them
  r = acc.resolveAccount(PLAY);
  assert.deepEqual(r.error.candidates, ['personal', 'work', 'default'], 'labels first, the unlabelled login last');

  assert.equal(acc.resolveAccount(PLAY, 'work').key, 'site-play.google.com__work');
  assert.equal(acc.resolveAccount(PLAY, 'default').key, 'site-play.google.com');
  const typo = acc.resolveAccount(PLAY, 'wrok');
  assert.equal(typo.error?.reason, 'no_such_account', 'a typo must not silently start a new account');
  assert.deepEqual(typo.error.candidates, ['personal', 'work', 'default']);
  assert.match(typo.error.detail, /--new/);
  const fresh = acc.resolveAccount(PLAY, 'client-a', { create: true });
  assert.deepEqual([fresh.key, fresh.isNew], ['site-play.google.com__client-a', true], 'with --new an unknown label starts a new account');
  assert.equal(acc.resolveAccount(PLAY, 'work', { create: true }).isNew, false, '--new on an existing label just uses it');
  assert.equal(acc.resolveAccount('https://brand-new.example.com/', 'default').isNew, true, 'default never needs --new');
  for (const bad of ['Work', 'a b', '../x', 'a'.repeat(40)]) assert.equal(acc.resolveAccount(PLAY, bad, { create: true }).error?.reason, 'no_such_account', bad);
  assert.equal(acc.resolveAccount(PLAY, 42).error?.reason, 'bad_account_name');
  // other sites are unaffected
  assert.equal(acc.resolveAccount('https://github.com/x').error, undefined);
});

test('accounts listing: grouped by site, never contains a secret, marks what the person must choose between', skipKs, () => {
  vault.put('play-main', meta('https://play.google.com/console', { label: 'Main developer account' }), { username: 'main@x.test', password: 'Secret-Passw0rd-MAIN' });
  vault.put('play-alt', meta('https://play.google.com/console'), { username: 'alt@x.test', password: 'Secret-Passw0rd-ALT' });
  vault.put('gh', meta('https://github.com/login'), { username: 'gh@x.test', password: 'Secret-Passw0rd-GH' });

  const r = acc.accountsFor(PLAY);
  const byAs = Object.fromEntries(r.accounts.map((a) => [a.as, a]));
  assert.deepEqual(Object.keys(byAs).sort(), ['default', 'personal', 'play-alt', 'play-main', 'work']);
  assert.equal(byAs['play-main'].kind, 'credential');
  assert.equal(byAs['play-main'].label, 'Main developer account');
  assert.equal(byAs['play-main'].hands_free, true);
  assert.equal(byAs.work.kind, 'profile');
  assert.equal(byAs.work.hands_free, false);
  assert.equal(JSON.stringify(r).includes('Secret-Passw0rd'), false);
  // with stored credentials the unlabelled saved login is no longer a *choice* (it never was), but labelled ones are
  assert.deepEqual(r.choices.map((c) => c.as).sort(), ['personal', 'play-alt', 'play-main', 'work']);
  assert.equal(r.needs_choice, true);
  assert.equal(acc.resolveAccount(PLAY).error.reason, 'ambiguous_account');
  assert.equal(acc.resolveAccount(PLAY, 'play-alt').entry, 'play-alt', 'a vault name wins');
  assert.equal(acc.resolveAccount(PLAY, 'default').key, 'site-play.google.com', 'default is still reachable explicitly');

  const all = acc.allAccounts();
  assert.deepEqual(all.map((s) => s.host), [...all.map((s) => s.host)].sort());
  assert.ok(all.find((s) => s.host === 'github.com').accounts.some((a) => a.as === 'gh'));
  assert.ok(all.find((s) => s.host === 'play.google.com').accounts.length >= 5);
  assert.equal(JSON.stringify(all).includes('Secret-Passw0rd'), false);
});

test('a single stored credential + no labelled logins behaves exactly as before (no question, no default profile noise)', skipKs, () => {
  vault.put('solo', meta('https://solo.example.com/login'), { username: 's@x.test', password: 'Secret-Passw0rd-SOLO' });
  profile('site-solo.example.com'); // an old saved login from before the credential existed
  const r = acc.resolveAccount('https://solo.example.com/app');
  assert.deepEqual([r.entry, r.error], ['solo', undefined]);
});

test('locked credentials are flagged so the person is told, not surprised', skipKs, () => {
  vault.put('lockme', meta('https://lock.example.com/login'), { username: 'l@x.test', password: 'Secret-Passw0rd-LOCK' });
  fs.mkdirSync(path.join(HOME, 'state'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'state', 'lockme.json'), JSON.stringify({ phase: 'failed', reason: 'bad_credentials' }));
  const a = acc.accountsFor('https://lock.example.com/').accounts[0];
  assert.equal(a.locked, true);
  assert.match(acc.describeAccount(a), /LOCKED/);
  vault.put('expd', meta('https://lock.example.com/login', { expiresAt: new Date(Date.now() - 1000).toISOString() }), { username: 'e@x.test', password: 'Secret-Passw0rd-EXP' });
  const e = acc.accountsFor('https://lock.example.com/').accounts.find((x) => x.as === 'expd');
  assert.equal(e.expired, true);
  assert.match(acc.describeAccount(e), /EXPIRED/);
});

test('names: "default" and "site-*" cannot be stored credentials (they would shadow saved logins)', () => {
  assert.throws(() => vault.put('default', meta('https://x.test/l'), { username: 'a', password: 'b' }), /reserved/);
  assert.throws(() => vault.put('site-x.test', meta('https://x.test/l'), { username: 'a', password: 'b' }), /reserved/);
  const r = cli(['add', 'default', '--url', 'https://x.test/login', '--stdin-json'], JSON.stringify({ username: 'a@x.test', password: 'password-123' }));
  assert.equal(JSON.parse(r.stdout).status, 'usage_error');
});

test('sessions list shows which site and account each saved login belongs to', () => {
  const by = Object.fromEntries(listSessions().map((s) => [s.name, s]));
  assert.deepEqual([by['site-play.google.com__work'].host, by['site-play.google.com__work'].account], ['play.google.com', 'work']);
  assert.equal(by['site-play.google.com'].account, 'default');
  assert.equal(by['site-play.google.com__work'].kind, 'saved-login-site');
});

test('CLI: `accounts <url>` and `accounts` (all sites) are secret-free JSON; a bad URL is a usage error', skipKs, () => {
  const one = cli(['accounts', 'play.google.com/console']);
  const j = JSON.parse(one.stdout);
  assert.equal(j.origin, 'https://play.google.com');
  assert.equal(j.needs_choice, true);
  assert.match(j.choose, /--as/);
  assert.equal(one.stdout.includes('Secret-Passw0rd'), false);
  const all = JSON.parse(cli(['accounts']).stdout);
  assert.ok(all.sites.some((s) => s.host === 'github.com'));
  assert.equal(JSON.parse(cli(['accounts', 'http://example.com']).stdout).status, 'usage_error');
  const shown = JSON.parse(cli(['show', 'play-main']).stdout);
  assert.equal(shown.label, 'Main developer account');
});

test('CLI: `add --label` stores a nickname shown by list/accounts', skipKs, () => {
  const r = cli(['add', 'labelled', '--url', 'https://lab.example.com/login', '--label', ' Client\u0007 A  ', '--stdin-json'], JSON.stringify({ username: 'a@x.test', password: 'password-123' }));
  assert.equal(JSON.parse(r.stdout).status, 'saved', r.stdout + r.stderr);
  assert.equal(JSON.parse(cli(['show', 'labelled']).stdout).label, 'Client A');
});

test('request: a second account for the same site gets a free name, the nickname is prefilled, and an explicit clash is refused', skipKs, async () => {
  const a = await startCredentialRequest({ url: 'https://req.example.com/login', launch: false });
  assert.equal(a.name, 'req-example-com');
  a.cancel();
  vault.put('req-example-com', meta('https://req.example.com/login'), { username: 'a', password: 'Secret-Passw0rd-1' });
  const b = await startCredentialRequest({ url: 'https://req.example.com/login', label: 'work', launch: false });
  assert.equal(b.name, 'req-example-com-2', 'no name given -> next free one');
  const html = await (await fetch(b.formUrl)).text();
  assert.match(html, /name="label"[^>]*value="work"/);
  b.cancel();
  await assert.rejects(startCredentialRequest({ url: 'https://req.example.com/login', name: 'req-example-com', launch: false }), /already exists/);
  await assert.rejects(startCredentialRequest({ url: 'https://req.example.com/login', name: 'default', launch: false }), /reserved/);
});

// ---------- data saved by earlier releases ----------
const OLD = 'https://legacy.example.com/app';
test('upgrade: an unlabelled saved login from before accounts is kept, flagged as unnamed, and only asks once a second account exists', () => {
  profile('site-legacy.example.com');
  fs.writeFileSync(path.join(HOME, 'profiles', 'site-legacy.example.com', 'Cookies'), 'old-session-marker');
  assert.equal(acc.resolveAccount(OLD).key, 'site-legacy.example.com', 'alone, it behaves exactly as before');
  assert.equal(acc.accountsFor(OLD).accounts[0].unnamed, true);

  profile('site-legacy.example.com__second');
  const r = acc.resolveAccount(OLD);
  assert.equal(r.error.reason, 'ambiguous_account');
  const d = r.error.accounts.find((a) => a.as === 'default');
  assert.match(d.description, /no name yet/);
  assert.match(r.error.detail, /name-login/, 'the agent is told to offer naming it');
});

test('name-login: gives the old login a name, keeps its cookies and state, and refuses unsafe requests', async () => {
  const { nameLogin } = await import('../src/login.mjs');
  fs.mkdirSync(path.join(HOME, 'state'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'state', 'site-legacy.example.com.json'), JSON.stringify({ phase: 'logged_in', url: OLD }));
  assert.equal(nameLogin(OLD, 'Bad Name').reason, 'bad_account_name');
  assert.equal(nameLogin(OLD, 'default').reason, 'bad_account_name');
  assert.equal(nameLogin(OLD, 'second').reason, 'name_taken', 'an existing label is never overwritten');
  assert.equal(nameLogin('https://nothing.example.org/', 'x').reason, 'nothing_to_name');
  assert.equal(nameLogin('http://insecure.example.com/', 'x').reason, 'bad_url');

  const r = nameLogin(OLD, 'personal');
  assert.deepEqual([r.status, r.as, r.name], ['renamed', 'personal', 'site-legacy.example.com__personal']);
  assert.equal(fs.readFileSync(path.join(HOME, 'profiles', 'site-legacy.example.com__personal', 'Cookies'), 'utf8'), 'old-session-marker', 'the saved session came along');
  assert.ok(!fs.existsSync(path.join(HOME, 'profiles', 'site-legacy.example.com')));
  assert.ok(fs.existsSync(path.join(HOME, 'state', 'site-legacy.example.com__personal.json')));
  assert.deepEqual(acc.resolveAccount(OLD).error.candidates, ['personal', 'second']);
  assert.equal(acc.resolveAccount(OLD, 'personal').isNew, false);
  assert.equal(nameLogin(OLD, 'again').reason, 'nothing_to_name', 'nothing left to name');
});

test('name-login: a stored credential name cannot be taken as a label', skipKs, async () => {
  const { nameLogin } = await import('../src/login.mjs');
  profile('site-clash.example.com');
  vault.put('clash-name', meta('https://elsewhere.example.com/login'), { username: 'a', password: 'Secret-Passw0rd-X' });
  assert.equal(nameLogin('https://clash.example.com/', 'clash-name').reason, 'name_taken');
  const cli1 = JSON.parse(cli(['name-login', 'https://clash.example.com/', 'mine']).stdout);
  assert.equal(cli1.status, 'renamed');
  assert.equal(JSON.parse(cli(['name-login', 'only-one-arg']).stdout).status, 'usage_error');
});

test('upgrade: a credential saved by an older release (no nickname) still lists, and import skips a reserved name instead of aborting', skipKs, async () => {
  vault.put('oldstyle', meta('https://old.example.com/login'), { username: 'o@x.test', password: 'Secret-Passw0rd-OLD' }); // no "label" field, like every pre-1.6 entry
  const a = acc.accountsFor('https://old.example.com/').accounts[0];
  assert.deepEqual([a.as, a.label, a.user], ['oldstyle', null, 'u***@x.test']);
  const { exportVault, importVault } = await import('../src/portable.mjs');
  const bundle = exportVault('correct horse battery staple');
  // hand-build a bundle that contains a legacy entry named "default" next to a good one
  const crypto = await import('node:crypto');
  const plain = JSON.stringify({ exportedAt: new Date().toISOString(), entries: [{ name: 'default', meta: meta('https://d.example.com/l'), secrets: { username: 'd', password: 'Secret-Passw0rd-D' } }, { name: 'after-default', meta: meta('https://d.example.com/l'), secrets: { username: 'd', password: 'Secret-Passw0rd-D2' } }] });
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync('correct horse battery staple'.normalize('NFKC'), salt, 32, { N: bundle.N, r: bundle.r, p: bundle.p, maxmem: 128 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from('hallpass-export-v1'));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const res = importVault({ ...bundle, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') }, 'correct horse battery staple');
  assert.deepEqual(res.imported, ['after-default'], 'the good entry is imported');
  assert.equal(res.skipped[0].name, 'default');
});
