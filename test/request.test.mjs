// Just-in-time credential form: the happy path and the attacks it must survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-req-'));
process.env.HALLPASS_HOME = HOME;
process.env.HALLPASS_NO_BROWSER = '1';
const { startCredentialRequest, describeRequest } = await import('../src/request.mjs');
const vault = await import('../src/vault.mjs');
const skip = process.platform === 'linux' && !process.env.HALLPASS_TEST_LIBSECRET;

// raw HTTP so we can lie about Host / Origin
const call = (u, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const url = new URL(u);
  const req = http.request({ host: '127.0.0.1', port: url.port, path: url.pathname, method, headers }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  req.on('error', reject);
  req.end(body);
});
const form = (o) => new URLSearchParams(o).toString();
const FORM_HEADERS = (port, extra = {}) => ({ 'content-type': 'application/x-www-form-urlencoded', ...extra });
const csrfOf = (html) => /name="csrf" value="([0-9a-f]+)"/.exec(html)[1];

test('form: security headers, shows the pinned origin, never echoes secrets', { skip }, async () => {
  const r = await startCredentialRequest({ url: 'https://app.example.com/login', name: 'req-a', launch: false });
  const g = await call(r.formUrl);
  assert.equal(g.status, 200);
  assert.match(g.headers['content-security-policy'], /default-src 'none'/);
  assert.match(g.headers['cache-control'], /no-store/);
  assert.equal(g.headers['x-frame-options'], 'DENY');
  assert.ok(g.body.includes('https://app.example.com'), 'the pinned origin is displayed');
  assert.ok(!/<script/i.test(g.body), 'no scripts at all');
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)[^"' ]+\.(js|css|png)/.test(g.body), 'no external resources');
  r.cancel();
});

test('form: wrong token, wrong Host (DNS rebinding), cross-site Origin, bad CSRF are all refused', { skip }, async () => {
  const r = await startCredentialRequest({ url: 'https://app.example.com/login', name: 'req-b', launch: false });
  const u = new URL(r.formUrl);
  const good = await call(r.formUrl);
  const csrf = csrfOf(good.body);
  assert.equal((await call(`http://127.0.0.1:${u.port}/r/${'0'.repeat(64)}`)).status, 404);
  assert.equal((await call(r.formUrl, { headers: { host: 'evil.example.com' } })).status, 403, 'rebinding host');
  const body = form({ csrf, username: 'me@example.com', password: 'hunter2hunter2', confirm: '1' });
  assert.equal((await call(r.formUrl, { method: 'POST', headers: FORM_HEADERS(u.port, { origin: 'https://evil.example.com' }), body })).status, 403, 'cross-site post');
  assert.equal((await call(r.formUrl, { method: 'POST', headers: FORM_HEADERS(u.port), body: form({ csrf: 'f'.repeat(32), username: 'me@example.com', password: 'hunter2hunter2', confirm: '1' }) })).status, 403, 'bad csrf');
  assert.equal((await call(r.formUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 415);
  assert.equal(vault.exists('req-b'), false, 'nothing was saved by any refused request');
  r.cancel();
});

test('form: validation errors re-show the form without saving', { skip }, async () => {
  const r = await startCredentialRequest({ url: 'https://app.example.com/login', name: 'req-c', launch: false });
  const u = new URL(r.formUrl);
  const csrf = csrfOf((await call(r.formUrl)).body);
  const post = (o) => call(r.formUrl, { method: 'POST', headers: FORM_HEADERS(u.port), body: form({ csrf, ...o }) });
  assert.equal((await post({ username: 'a@b.c', password: 'longenough1' })).status, 400, 'missing trust confirmation');
  assert.equal((await post({ username: 'a@b.c', password: 'short', confirm: '1' })).status, 400, 'short password');
  assert.equal((await post({ username: 'a@b.c', password: 'longenough1', totp: 'not*base32', confirm: '1' })).status, 400, 'bad totp');
  assert.equal(vault.exists('req-c'), false);
  r.cancel();
});

test('form: a valid submission seals the login, is single-use, and the agent-visible result has no secret', { skip }, async () => {
  const r = await startCredentialRequest({ url: 'https://app.example.com/login', name: 'req-d', launch: false });
  const u = new URL(r.formUrl);
  const csrf = csrfOf((await call(r.formUrl)).body);
  const secret = 'S3cret-' + Math.random().toString(16).slice(2);
  const ok = await call(r.formUrl, { method: 'POST', headers: FORM_HEADERS(u.port), body: form({ csrf, username: 'me@example.com', password: secret, totp: 'JBSWY3DPEHPK3PXP', approval: '1', confirm: '1' }) });
  assert.equal(ok.status, 200);
  const result = await r.wait();
  assert.equal(result.status, 'saved');
  assert.ok(!JSON.stringify(result).includes(secret));
  const meta = vault.meta('req-d');
  assert.deepEqual(meta.allowed, ['https://app.example.com']);
  assert.equal(meta.hasTotp, true);
  assert.equal(meta.requireApproval, true);
  assert.equal(vault.unseal('req-d').password, secret);
  // single use
  await new Promise((res) => setTimeout(res, 400));
  await assert.rejects(call(r.formUrl), /ECONNREFUSED|ECONNRESET/, 'server is gone after one use');
  assert.ok(!fs.readFileSync(path.join(HOME, 'audit.log'), 'utf8').includes(secret), 'audit log has no secret');
});

test('form: refuses unsafe requests up front, never overwrites, and expires', { skip }, async () => {
  await assert.rejects(startCredentialRequest({ url: 'http://evil.example.com/login', launch: false }), /https/);
  await assert.rejects(startCredentialRequest({ url: 'https://app.example.com/login', name: '../x', launch: false }), /invalid name/);
  await assert.rejects(startCredentialRequest({ url: 'https://app.example.com/login', name: 'req-d', launch: false }), /already exists/);
  const r = await startCredentialRequest({ url: 'https://app.example.com/login', name: 'req-e', ttlSec: 1, launch: false });
  assert.equal((await r.wait()).status, 'expired');
});

test('describeRequest: the one-time URL is withheld from the agent whenever a window could be opened for the person', () => {
  const base = { name: 'n', origin: 'https://a.test', expiresInSec: 600, formUrl: 'http://127.0.0.1:1/r/secrettoken' };
  const opened = describeRequest({ ...base, opened: true });
  assert.equal(opened.form_url, undefined);
  assert.ok(!JSON.stringify(opened).includes('secrettoken'));
  const manual = describeRequest({ ...base, opened: false });
  assert.equal(manual.form_url, base.formUrl, 'only when it could not be opened, so the person can');
});

test('requests: one pending form per origin, and a global rate limit', { skip }, async () => {
  const a = await startCredentialRequest({ url: 'https://dedupe.example.com/login', name: 'dd-1', launch: false });
  await assert.rejects(startCredentialRequest({ url: 'https://dedupe.example.com/other', name: 'dd-2', launch: false }), /already waiting/);
  a.cancel();
  await a.wait();
  const b = await startCredentialRequest({ url: 'https://dedupe.example.com/login', name: 'dd-3', launch: false });
  b.cancel();
});

test('form: oversized body is rejected', { skip }, async () => {
  const r = await startCredentialRequest({ url: 'https://app.example.com/login', name: 'req-f', launch: false });
  const u = new URL(r.formUrl);
  const res = await call(r.formUrl, { method: 'POST', headers: FORM_HEADERS(u.port), body: 'x'.repeat(20000) }).catch((e) => ({ status: e.code }));
  assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(res.status), String(res.status));
  r.cancel();
});

test('CLI: hallpass request prints the form URL first, then the result once a person submits', { skip, timeout: 60_000 }, async () => {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hallpass.mjs');
  const p = spawn(process.execPath, [bin, 'request', 'https://cli.example.com/login', '--name', 'req-cli'], { env: { ...process.env, HALLPASS_HOME: HOME, HALLPASS_NO_BROWSER: '1' } });
  let out = ''; p.stdout.on('data', (d) => (out += d));
  const first = await new Promise((resolve) => { const t = setInterval(() => { const l = out.split('\n')[0]; if (l && out.includes('\n')) { clearInterval(t); resolve(JSON.parse(l)); } }, 50); });
  assert.equal(first.status, 'awaiting_user');
  assert.equal(first.origin, 'https://cli.example.com');
  const u = new URL(first.form_url);
  const csrf = csrfOf((await call(first.form_url)).body);
  await call(first.form_url, { method: 'POST', headers: FORM_HEADERS(u.port), body: form({ csrf, username: 'cli@example.com', password: 'cli-password-1', confirm: '1' }) });
  const code = await new Promise((res) => p.on('close', res));
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.trim().split('\n').pop()).status, 'saved');
  assert.equal(vault.exists('req-cli'), true);
});

// keep last: it deliberately exhausts the in-process rate limit
test('requests: global rate limit', { skip }, async () => {
  let failed = null;
  for (let i = 0; i < 20 && !failed; i++) {
    try { (await startCredentialRequest({ url: `https://rate${i}.example.com/login`, name: `rl-${i}`, launch: false })).cancel(); }
    catch (e) { failed = e.message; }
  }
  assert.match(failed || '', /too many credential forms/);
});
