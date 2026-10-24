// End-to-end: real CLI, real DPAPI vault, real Chrome via agent-browser, against test/mock-site.mjs.
// Opens a visible Chrome window for the CAPTCHA hand-off case.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from './mock-site.mjs';
import { makeFakeClis } from './fake-clis.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-e2e-'));
const STARTED = Date.now();
process.env.HALLPASS_HOME = HOME; // so this process can write vault entries directly (references can't be added non-interactively)
const vault = await import('../src/vault.mjs');
const { clearState } = await import('../src/login.mjs');
const policy = await import('../src/policy.mjs');
const FAKEBIN = makeFakeClis();
const REF_PW = 'RefPw-' + crypto.randomBytes(8).toString('hex'); // what the fake password manager returns
const USER = 'tester@example.test';
// deliberately hostile: leading dashes, quotes, backslash, shell metacharacters, an @ref lookalike, non-ASCII
const PASSWORD = '--Zx9! "q" \'s \\ $HOME %PATH% @e1 \u00fcn\u00ef `x` ;&| ' + crypto.randomBytes(9).toString('hex');
const HUMAN_PW = 'Human-' + crypto.randomBytes(8).toString('hex'); // typed by the simulated person, not stored anywhere
const TOTP = { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 };
const transcript = []; // every byte hallpass ever printed
let site;

function run(cmd, args, { input, env, shell } = {}) {
  // async on purpose: the mock site lives in this process, so blocking the event loop would stall the browser
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: env || process.env, shell, windowsHide: false });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill(), 300_000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.stdin.end(input ?? '');
  });
}
async function hp(args, input, extraEnv = {}) {
  const r = await run(process.execPath, [path.join(ROOT, 'bin', 'hallpass.mjs'), ...args], { input, env: { ...process.env, HALLPASS_HOME: HOME, PATH: FAKEBIN + path.delimiter + process.env.PATH, HP_FAKE_PW: REF_PW, ...extraEnv } });
  transcript.push(r.out, r.err);
  let json = null;
  try { json = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch { /* not json */ }
  return { code: r.code, json, out: r.out, err: r.err };
}
async function ab(session, args) {
  // like hallpass itself, and like `hallpass do`: without --profile agent-browser attaches to a blank tab, not the page the person sees
  const r = await run('agent-browser', ['--session', session, '--profile', path.join(HOME, 'profiles', session.slice(3)), '--json', ...args], { shell: process.platform === 'win32' });
  return { ok: r.code === 0, out: r.out };
}
async function add(name, scenario, { password = PASSWORD, withTotp = false, extra = [] } = {}) {
  const origin = `http://localhost:${site.port}`;
  const r = await hp(['add', name, '--url', `${origin}/${scenario}/login`, '--stdin-json', ...extra], JSON.stringify({ username: USER, password, ...(withTotp ? { totp: TOTP.secret } : {}) }));
  assert.equal(r.json?.status, 'saved', r.out + r.err);
}

before(async () => { site = await startSite({ user: USER, password: PASSWORD, totpCfg: TOTP, humanPassword: HUMAN_PW, alsoAccept: [REF_PW] }); });
after(async () => {
  // close every browser session this run created: the names are exactly the profile folders in OUR temp home,
  // so this can never touch a real user's sessions
  const created = fs.existsSync(path.join(HOME, 'profiles')) ? fs.readdirSync(path.join(HOME, 'profiles')) : [];
  for (const n of new Set([...created, 'simple', 'twostep', 'totp', 'captcha', 'badpw', 'phish', 'site-127.0.0.1'])) await hp(['logout', n, '--wipe']);
  site.close();
});

test('the agent can never get a secret back out', async () => {
  await add('simple', 'simple');
  const listing = await hp(['list']);
  const shown = await hp(['show', 'simple']);
  assert.ok(!(listing.out + shown.out).includes(PASSWORD));
  assert.equal(shown.json.userHint, 't***@example.test');
  assert.equal((await hp(['reveal', 'simple'])).code, 2, 'there is no reveal command');
  assert.equal((await hp(['add', 'zzz', '--url', `http://localhost:${site.port}/x`], '')).json.status, 'usage_error', 'add refuses non-TTY without --stdin-json');
});

test('single-page login, honeypot untouched, session usable afterwards', { timeout: 240_000 }, async () => {
  const r = await hp(['login', 'simple']);
  assert.equal(r.json?.status, 'logged_in', r.out + r.err);
  assert.equal(r.json.mode, 'headless');
  assert.equal(r.code, 0);
  assert.equal((await ab('hp-simple', ['get', 'text', 'h1'])).ok, true);
  assert.match((await ab('hp-simple', ['get', 'text', 'h1'])).out, /Welcome back/);
  assert.deepEqual(site.log.trap, [], 'hidden honeypot password field must never be filled');
  assert.equal(site.log.attempts.simple, 1);
  // second call is idempotent: the persistent profile is already logged in, nothing is submitted again
  const again = await hp(['login', 'simple']);
  assert.equal(again.json?.status, 'logged_in', again.out + again.err);
  assert.equal(site.log.attempts.simple, 1, 'no second credential submission');
});

test('two-step (email, then password) login', { timeout: 240_000 }, async () => {
  await add('twostep', 'twostep');
  const r = await hp(['login', 'twostep']);
  assert.equal(r.json?.status, 'logged_in', r.out + r.err);
});

test('TOTP second factor is generated and typed without being shown', { timeout: 240_000 }, async () => {
  await add('totp', 'totp', { withTotp: true });
  const r = await hp(['login', 'totp']);
  assert.equal(r.json?.status, 'logged_in', r.out + r.err);
  assert.equal((await hp(["show", "totp"])).json.hasTotp, true);
});

test('wrong password: fails after exactly one attempt (no lockout loop)', { timeout: 240_000 }, async () => {
  await add('badpw', 'badpw', { password: 'definitely-not-it-' + crypto.randomBytes(4).toString('hex') });
  const r = await hp(['login', 'badpw']);
  assert.equal(r.json?.status, 'failed');
  assert.equal(r.json.reason, 'bad_credentials');
  assert.equal(r.code, 1);
  assert.equal(site.log.attempts.badpw, 1);

  // a second invocation must not hammer the account either
  const again = await hp(['login', 'badpw']);
  assert.equal(again.json?.reason, 'credential_locked', again.out + again.err);
  const viaOpen = await hp(['open', `http://localhost:${site.port}/badpw/app`, '--as', 'badpw']);
  assert.equal(viaOpen.json?.reason, 'credential_locked');
  assert.equal(site.log.attempts.badpw, 1, 'no further attempts reached the site');
  assert.equal((await hp(['unlock', 'badpw'])).json.status, 'usage_error', 'unlock needs a human terminal');

  // an agent cannot clear the lock by replacing the credential, nor delete it
  const origin = `http://localhost:${site.port}`;
  const replace = await hp(['add', 'badpw', '--url', `${origin}/badpw/login`, '--stdin-json', '--force'], JSON.stringify({ username: USER, password: PASSWORD }));
  assert.equal(replace.json?.status, 'usage_error', replace.out + replace.err);
  assert.match(replace.json.message, /real terminal/);
  assert.equal((await hp(['login', 'badpw'])).json?.reason, 'credential_locked', 'still locked');
  const removal = await hp(['remove', 'badpw']);
  assert.equal(removal.json?.status, 'usage_error');
  assert.equal(vault.exists('badpw'), true, 'not deleted');
  const reserved = await hp(['add', 'site-example.com', '--url', `${origin}/simple/login`, '--stdin-json'], JSON.stringify({ username: USER, password: PASSWORD }));
  assert.equal(reserved.json?.status, 'usage_error');
  assert.match(reserved.json.message, /reserved/);

  // fixing the credential (what a person's `add --force` does) clears the lock
  vault.put('badpw', vault.meta('badpw'), { username: USER, password: PASSWORD });
  clearState('badpw'); policy.resetUses('badpw'); policy.revokeGrant('badpw');
  const fixed = await hp(['login', 'badpw']);
  assert.equal(fixed.json?.status, 'logged_in', fixed.out + fixed.err);
  assert.equal(site.log.attempts.badpw, 2);
});

test('phishing redirect to another origin: nothing is typed', { timeout: 240_000 }, async () => {
  await add('phish', 'phish');
  const r = await hp(['login', 'phish']);
  assert.equal(r.json?.status, 'failed', r.out + r.err);
  assert.equal(r.json.reason, 'origin_not_allowed');
  const evil = site.log.posts.filter((p) => p.host.startsWith('127.0.0.1') && p.path.startsWith('/phish'));
  assert.equal(evil.length, 0, 'the attacker origin must never receive a POST');
});

test('CAPTCHA: hands over to a visible window, then resumes after the human acts', { timeout: 420_000 }, async () => {
  await add('captcha', 'captcha');
  const r = await hp(['login', 'captcha']);
  assert.equal(r.json?.status, 'needs_human', r.out + r.err);
  assert.equal(r.json.reason, 'captcha');
  assert.equal(r.json.mode, 'headed');
  assert.equal(r.code, 10);
  // play the human: click the checkbox in the visible window
  const click = await ab('hp-captcha', ['click', '#human']);
  assert.ok(click.ok, 'human click: ' + click.out);
  const resumed = await hp(['resume', 'captcha', '--timeout', '60']);
  assert.equal(resumed.json?.status, 'logged_in', resumed.out + resumed.err);
});

test('open: a page that needs no login just opens', { timeout: 240_000 }, async () => {
  const r = await hp(['open', `http://127.0.0.1:${site.port}/public/app`]);
  assert.equal(r.json?.status, 'logged_in', r.out + r.err);
  assert.equal(r.json.via, 'session');
  assert.equal(r.json.mode, 'headless');
});

test('open: no credential + login wall -> person logs in, then later opens are headless and need nothing', { timeout: 420_000 }, async () => {
  const target = `http://127.0.0.1:${site.port}/simple/app`;
  const r = await hp(['open', target]);
  assert.equal(r.json?.status, 'needs_human', r.out + r.err);
  assert.equal(r.json.reason, 'login');
  assert.equal(r.json.mode, 'headed');
  assert.equal(r.code, 10);
  const session = r.json.session;
  assert.equal(site.log.posts.filter((p) => p.host.startsWith('127.0.0.1') && p.path === '/simple/login').length, 0, 'hallpass must not submit anything in human mode');
  // the simulated person types into the visible window
  assert.ok((await ab(session, ['fill', 'input[name=email]', USER])).ok);
  assert.ok((await ab(session, ['fill', 'input[name=password]', HUMAN_PW])).ok);
  assert.ok((await ab(session, ['click', 'button[type=submit]'])).ok);
  const resumed = await hp(['resume', r.json.name, '--timeout', '60']);
  assert.equal(resumed.json?.status, 'logged_in', resumed.out + resumed.err);
  assert.equal(resumed.json.via, 'human');
  assert.equal(site.log.posts.filter((p) => p.host.startsWith('127.0.0.1') && p.path === '/simple/login').length, 1, 'only the person submitted the form');

  // close the window; the profile keeps the session, so the next open is headless with zero credentials
  await hp(['logout', r.json.name]);
  const again = await hp(['open', target]);
  assert.equal(again.json?.status, 'logged_in', again.out + again.err);
  assert.equal(again.json.mode, 'headless');
  assert.equal(again.json.via, 'session');
});

test('open: stored credential for the origin is found from the URL (deep link)', { timeout: 240_000 }, async () => {
  const r = await hp(['open', `http://localhost:${site.port}/simple/app`, '--as', 'simple']);
  assert.equal(r.json?.status, 'logged_in', r.out + r.err);
  assert.ok(['vault', 'session'].includes(r.json.via), r.json.via);
  assert.equal(r.json.name, 'simple');
  assert.ok(r.json.url.endsWith('/simple/app'), r.json.url);
});

test('open: several credentials match the origin -> refuses to guess', async () => {
  const r = await hp(['open', `http://localhost:${site.port}/simple/app`]);
  assert.equal(r.json?.status, 'failed', r.out + r.err);
  assert.equal(r.json.reason, 'ambiguous_credential');
  assert.ok(r.json.candidates.includes('simple') && r.json.candidates.includes('badpw'));
});

test('regression: an email box on an already-logged-in page never receives the username', { timeout: 240_000 }, async () => {
  const r = await hp(['open', `http://localhost:${site.port}/invite/app`, '--as', 'simple']);
  assert.equal(r.json?.status, 'logged_in', r.out + r.err);
  const v = await ab(r.json.session, ['get', 'value', 'input[name=invitee]']);
  assert.ok(!v.out.includes(USER), 'username must not be typed into an unrelated field');
  assert.ok(!site.log.posts.some((p) => p.body.invitee), 'nothing was submitted from the invite form');
});

test('open: bounced to a different site (logged-out landing page) is not reported as logged in', { timeout: 240_000 }, async () => {
  const r = await hp(['open', `http://127.0.0.1:${site.port}/bounce/app`, '--headless']);
  assert.equal(r.json?.status, 'needs_human', r.out + r.err);
  assert.equal(r.json.reason, 'redirected');
});

test('--lock-navigation: a hostile redirect is blocked and nothing reaches the attacker origin', { timeout: 300_000 }, async () => {
  await add('lockphish', 'phish', { extra: ['--lock-navigation'] });
  const r = await hp(['login', 'lockphish', '--headless']);
  assert.notEqual(r.json?.status, 'logged_in', r.out + r.err);
  assert.equal(site.log.posts.filter((x) => x.host.startsWith('127.0.0.1') && x.path.startsWith('/phish')).length, 0);
  await hp(['logout', 'lockphish', '--wipe']);
});

test('closing the window mid-login: resume says so instead of spawning a blank browser', { timeout: 300_000 }, async () => {
  const r = await hp(['open', `http://127.0.0.1:${site.port}/twostep/app`]);
  assert.equal(r.json?.status, 'needs_human', r.out + r.err);
  await ab(r.json.session, ['close']);
  // `close` returns before the daemon has exited (it still shows in `session list` for a second or two)
  for (let i = 0; i < 30 && (await run('agent-browser', ['session', 'list'], { shell: process.platform === 'win32' })).out.includes(r.json.session); i++) await new Promise((res) => setTimeout(res, 300));
  const st = await hp(['status', r.json.name]);
  assert.equal(st.json.browser_running, false);
  const list = await run('agent-browser', ['session', 'list'], { shell: process.platform === 'win32' });
  assert.ok(!list.out.includes(r.json.session), 'status must not have launched a new browser');
  const res = await hp(['resume', r.json.name, '--timeout', '20']);
  assert.equal(res.json?.status, 'failed');
  assert.equal(res.json.reason, 'no_session');
});

test('unreachable site: clear error, and no dead session left behind', { timeout: 240_000 }, async () => {
  const r = await hp(['open', 'http://localhost:9/', '--headless', '--timeout', '20']);
  assert.equal(r.json?.status, 'failed', r.out + r.err);
  assert.equal(r.json.reason, 'browser_error');
  assert.ok(r.json.detail.length > 5);
  const list = await run('agent-browser', ['session', 'list'], { shell: process.platform === 'win32' });
  assert.ok(!list.out.includes('hp-site-localhost-9'), list.out);
});

test('open: scheme-less URLs work (local servers default to http)', { timeout: 240_000 }, async () => {
  const r = await hp(['open', `127.0.0.1:${site.port}/public/app`, '--headless']);
  assert.equal(r.json?.status, 'logged_in', r.out + r.err);
});

test('open --headless never opens a window; a login wall is just reported', { timeout: 240_000 }, async () => {
  const r = await hp(['open', `http://127.0.0.1:${site.port}/twostep/app`, '--headless']);
  assert.equal(r.json?.status, 'needs_human', r.out + r.err);
  assert.equal(r.json.mode, 'headless');
  assert.match(r.json.message, /No window is open/);
});

const refMeta = (origin) => ({ url: `${origin}/simple/login`, allowed: [origin], userHint: 't***@example.test', hasTotp: false, selectors: {}, successUrl: null, successText: null, lockNavigation: false, createdAt: new Date().toISOString(), source: 'op' });

test('a rejected password does not stay readable in the page (SPA keeps field values)', { timeout: 300_000 }, async () => {
  const wrong = 'WrongPw-' + crypto.randomBytes(6).toString('hex');
  const origin = `http://localhost:${site.port}`;
  vault.put('spabad', { url: `${origin}/spa/login`, allowed: [origin], userHint: 't***', hasTotp: false, selectors: {}, successUrl: null, successText: null, lockNavigation: false, createdAt: new Date().toISOString() }, { username: USER, password: wrong });
  const r = await hp(['login', 'spabad']);
  assert.equal(r.json?.reason, 'bad_credentials', r.out + r.err);
  const read = await ab('hp-spabad', ['get', 'value', 'input[name=password]']); // what a shell agent would try
  assert.ok(!read.out.includes(wrong), 'the typed password was still sitting in the field');
  const snap = await ab('hp-spabad', ['snapshot']);
  assert.ok(!snap.out.includes(wrong));
});

test('password-manager reference: fetched at login time, never stored or printed', { timeout: 240_000 }, async () => {
  const origin = `http://localhost:${site.port}`;
  vault.put('refd', refMeta(origin), { username: USER, passwordRef: 'op://v/i/password' });
  assert.ok(!fs.readFileSync(path.join(HOME, 'entries', 'refd.json'), 'utf8').includes(REF_PW), 'the vault holds a pointer, not the password');
  const r = await hp(['login', 'refd']);
  assert.equal(r.json?.status, 'logged_in', r.out + r.err);
  assert.equal(r.json.via, 'vault');
  assert.equal(site.log.posts.filter((p) => p.path === '/simple/login' && p.body.password === REF_PW).length, 1, 'the manager-supplied password reached the site');
});

test('password-manager reference: a locked manager fails cleanly and nothing is submitted', { timeout: 240_000 }, async () => {
  const origin = `http://localhost:${site.port}`;
  vault.put('reflocked', refMeta(origin), { username: USER, passwordRef: 'op://v/i/password' });
  const before = site.log.posts.length;
  const r = await hp(['login', 'reflocked'], undefined, { HP_FAKE_FAIL: '1' });
  assert.equal(r.json?.reason, 'secret_unavailable', r.out + r.err);
  assert.match(r.json.detail, /locked/);
  assert.equal(site.log.posts.length, before);
});

test('references can only be registered by a person in a terminal', async () => {
  const r = await hp(['add', 'sneaky', '--url', `http://localhost:${site.port}/simple/login`, '--password-ref', 'op://v/i/password', '--username', USER]);
  assert.equal(r.json?.status, 'usage_error', r.out + r.err);
  assert.match(r.json.message, /real terminal/);
  assert.equal(vault.exists('sneaky'), false);
  const viaJson = await hp(['add', 'sneaky', '--url', `http://localhost:${site.port}/simple/login`, '--password-ref', 'op://v/i/password', '--stdin-json'], JSON.stringify({ username: USER, password: 'x'.repeat(8) }));
  assert.equal(viaJson.json?.status, 'usage_error');
});

test('approval required: with no desktop dialog available the answer is deny and nothing is typed', { timeout: 240_000 }, async () => {
  await add('gated', 'simple', { extra: ['--require-approval'] });
  assert.equal((await hp(['show', 'gated'])).json.requireApproval, true);
  const before = site.log.posts.length;
  const r = await hp(['login', 'gated'], undefined, { HALLPASS_NO_UI: '1' });
  assert.equal(r.json?.reason, 'approval_denied', r.out + r.err);
  assert.equal(site.log.posts.length, before, 'no credential was typed');
  const viaOpen = await hp(['open', `http://localhost:${site.port}/simple/app`, '--as', 'gated', '--headless'], undefined, { HALLPASS_NO_UI: '1' });
  assert.equal(viaOpen.json?.reason, 'approval_denied');
});

test('expired and use-limited credentials stop working', { timeout: 240_000 }, async () => {
  await add('limited', 'simple', { extra: ['--max-uses', '1'] });
  const first = await hp(['login', 'limited']);
  assert.equal(first.json?.status, 'logged_in', first.out + first.err);
  const reuse = await hp(['login', 'limited']);
  assert.equal(reuse.json?.status, 'logged_in', 'a valid saved session does not consume a use: ' + reuse.out + reuse.err);
  assert.equal(reuse.json.via, 'session');
  await hp(['logout', 'limited', '--wipe']);
  const second = await hp(['login', 'limited']);
  assert.equal(second.json?.reason, 'credential_exhausted', second.out + second.err);
  const bad = await hp(['add', 'x', '--url', `http://localhost:${site.port}/simple/login`, '--stdin-json', '--expires', 'someday'], JSON.stringify({ username: USER, password: 'x'.repeat(8) }));
  assert.equal(bad.json?.status, 'usage_error');
});

test('valid saved session: no approval dialog, no password-manager call, no decryption', { timeout: 300_000 }, async () => {
  const origin = `http://localhost:${site.port}`;
  const secrets = { username: USER, passwordRef: 'op://v/i/password' };
  vault.put('lazy', refMeta(origin), secrets);
  const first = await hp(['login', 'lazy']);
  assert.equal(first.json?.status, 'logged_in', first.out + first.err);
  assert.equal(first.json.via, 'vault', 'it typed the credential this time');

  // now demand approval, lock the password manager, and offer no desktop: if hallpass needs any of them, it fails
  vault.put('lazy', { ...refMeta(origin), requireApproval: true }, secrets);
  const again = await hp(['login', 'lazy'], undefined, { HALLPASS_NO_UI: '1', HP_FAKE_FAIL: '1' });
  assert.equal(again.json?.status, 'logged_in', again.out + again.err);
  assert.equal(again.json.via, 'session', 'nothing was typed, so no credential was used');
  const viaOpen = await hp(['open', `${origin}/simple/app`, '--as', 'lazy', '--headless'], undefined, { HALLPASS_NO_UI: '1', HP_FAKE_FAIL: '1' });
  assert.equal(viaOpen.json?.status, 'logged_in', viaOpen.out + viaOpen.err);

  // but the moment a credential must actually be typed, approval IS required (and fails closed here)
  await hp(['logout', 'lazy', '--wipe']);
  const needsIt = await hp(['login', 'lazy'], undefined, { HALLPASS_NO_UI: '1' });
  assert.equal(needsIt.json?.reason, 'approval_denied', needsIt.out + needsIt.err);
});

test('human-mode open of a stored site never decrypts or asks the password manager', { timeout: 300_000 }, async () => {
  const r = await hp(['open', `http://localhost:${site.port}/public/app`, '--as', 'lazy', '--headed'], undefined, { HALLPASS_NO_UI: '1', HP_FAKE_FAIL: '1' });
  assert.equal(r.json?.status, 'logged_in', r.out + r.err);
  assert.equal(r.json.via, 'session');
});

test('audit log: records opens, logins, handoffs and denials; verifies; contains no secret', async () => {
  const r = await hp(['log', '--tail', '500']);
  assert.equal(r.json.chain.ok, true, JSON.stringify(r.json.chain));
  const events = r.json.entries.map((e) => e.event);
  for (const ev of ['add', 'login', 'open', 'resume', 'approval']) assert.ok(events.includes(ev), 'missing ' + ev);
  assert.ok(r.json.entries.some((e) => e.event === 'approval' && e.decision === 'deny'));
  assert.ok(r.json.entries.some((e) => e.status === 'needs_human'));
  const raw = fs.readFileSync(path.join(HOME, 'audit.log'), 'utf8');
  for (const n of [PASSWORD, REF_PW, TOTP.secret]) assert.ok(!raw.includes(n));
  assert.equal((await hp(['log', '--verify'])).json.chain.ok, true);
});

test('no secret appears in anything hallpass printed, on disk, or in agent-browser logs', () => {
  const needles = [PASSWORD, TOTP.secret, REF_PW, Buffer.from(PASSWORD).toString('base64')];
  const hay = transcript.join('\n');
  for (const n of needles) assert.ok(!hay.includes(n), 'leak in hallpass output');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'profiles' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  for (const f of walk(HOME)) {
    const t = fs.readFileSync(f, 'latin1');
    for (const n of needles) assert.ok(!t.includes(n), `leak in ${f}`);
  }
  const abDir = path.join(os.homedir(), '.agent-browser');
  if (fs.existsSync(abDir)) {
    for (const f of walk(abDir)) {
      const st = fs.statSync(f);
      if (!st.isFile() || st.mtimeMs < STARTED || st.size > 8e6) continue; // unix sockets (<session>.sock) cannot be read
      const t = fs.readFileSync(f, 'latin1');
      for (const n of needles) assert.ok(!t.includes(n), `leak in agent-browser file ${f}`);
    }
  }
});
