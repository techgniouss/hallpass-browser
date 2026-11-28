// Parallel lanes end to end: real CLI, real vault, real Chrome against test/mock-site.mjs.
// A stored credential keeps working as before, and lanes run beside it with their own session and profile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from './mock-site.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'hallpass.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-lane-e2e-'));
const USER = 'tester@example.test';
const PW = 'Lane-test-pw-1';
const NAME = 'lanecred';
let site;

function run(args, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, HALLPASS_HOME: HOME }, windowsHide: false });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill(), 200_000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.stdin.end(input ?? '');
  });
}
async function hp(args, input) {
  const r = await run(args, input);
  let json = null;
  try { json = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch { /* not json */ }
  return { ...r, json };
}

before(async () => {
  site = await startSite({ user: USER, password: PW, totpCfg: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 }, humanPassword: 'unused-human-pw', alsoAccept: [] });
  const r = await hp(['add', NAME, '--url', `http://localhost:${site.port}/twostep/login`, '--stdin-json'], JSON.stringify({ username: USER, password: PW }));
  assert.equal(r.json?.status, 'saved', r.out + r.err);
});
after(async () => {
  for (const n of [`${NAME}_l_a`, `${NAME}_l_b`, NAME]) await hp(['logout', n, '--wipe']);
  site.close();
});

test('a stored credential still logs in with no lane: same session, same profile folder, no lane fields', { timeout: 240_000 }, async () => {
  const r = await hp(['login', NAME]);
  assert.equal(r.json?.status, 'logged_in', r.out + r.err);
  assert.equal(r.json.session, `hp-${NAME}`);
  assert.equal(r.json.lane, undefined);
  assert.ok(fs.existsSync(path.join(HOME, 'profiles', NAME)));
  assert.ok(!fs.readdirSync(path.join(HOME, 'profiles')).some((d) => /_l_/.test(d)));
});

test('lanes run beside the login: own sessions, signed in, same credential, separate profiles', { timeout: 280_000 }, async () => {
  await hp(['logout', NAME]); // close the login's browser so its cookie file can be copied cleanly
  const a = await hp(['login', NAME, '--lane', 'a']);
  assert.equal(a.json?.status, 'logged_in', a.out + a.err);
  assert.equal(a.json.session, `hp-${NAME}_l_a`);
  assert.equal(a.json.lane, 'a');
  assert.equal(a.json.lane_key, `${NAME}_l_a`);
  assert.equal(a.json.name, NAME); // the credential, not the lane, is the login's name
  assert.equal(a.json.lane_seeded, true);
  assert.notEqual(a.json.via, 'vault'); // signed in from the copy: nothing was typed

  const b = await hp(['login', NAME, '--lane', 'b']); // a second lane while the first is still running
  assert.equal(b.json?.status, 'logged_in', b.out + b.err);
  assert.equal(b.json.session, `hp-${NAME}_l_b`);

  const sa = await hp(['status', `${NAME}_l_a`]), sb = await hp(['status', `${NAME}_l_b`]);
  assert.equal(sa.json.browser_running, true);
  assert.equal(sb.json.browser_running, true);
  assert.notEqual(sa.json.session, sb.json.session);
  assert.ok(fs.existsSync(path.join(HOME, 'profiles', `${NAME}_l_a`)) && fs.existsSync(path.join(HOME, 'profiles', `${NAME}_l_b`)));
});

test('closing a lane removes it and leaves the login and the other lane alone; the login still works', { timeout: 240_000 }, async () => {
  const c = await hp(['logout', `${NAME}_l_a`]);
  assert.equal(c.json.profile_wiped, true);
  assert.ok(!fs.existsSync(path.join(HOME, 'profiles', `${NAME}_l_a`)));
  assert.ok(fs.existsSync(path.join(HOME, 'profiles', NAME)));
  assert.equal((await hp(['status', `${NAME}_l_b`])).json.browser_running, true);
  const again = await hp(['login', NAME]);
  assert.equal(again.json?.status, 'logged_in', again.out + again.err);
  assert.equal(again.json.session, `hp-${NAME}`);
});

test('a bad lane id is refused before anything starts', async () => {
  const r = await hp(['login', NAME, '--lane', 'Bad_Id']);
  assert.equal(r.json?.status, 'failed');
  assert.equal(r.json.reason, 'bad_lane');
});
