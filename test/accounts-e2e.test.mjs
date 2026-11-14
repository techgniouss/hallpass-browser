// Several accounts on one site, end to end: real CLI + MCP server + real Chrome against test/mock-site.mjs.
// Two saved browser logins ("work", "personal") on the same host must keep separate sessions, never be guessed between,
// and be choosable by the person through an MCP client that supports elicitation.
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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-acct-e2e-'));
const USER = 'tester@example.test';
const HUMAN_PW = 'Human-pw-for-work-account';
let site;

function run(cmd, args, { input, env, shell } = {}) {
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
async function hp(args) {
  const r = await run(process.execPath, [BIN, ...args], { env: { ...process.env, HALLPASS_HOME: HOME } });
  let json = null;
  try { json = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch { /* not json */ }
  return { code: r.code, json, out: r.out, err: r.err };
}
before(async () => { site = await startSite({ user: USER, password: 'unused-password-1', humanPassword: HUMAN_PW, totpCfg: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 } }); });
after(async () => {
  for (const n of ['site-127.0.0.1__work', 'site-127.0.0.1__personal', 'site-127.0.0.1']) await hp(['logout', n, '--wipe']);
  site.close();
});

const url = (p) => `http://127.0.0.1:${site?.port}${p}`;

test('two saved logins on one host: separate sessions, new label starts a new account, no label asks', { timeout: 420_000 }, async () => {
  const w = await hp(['open', url('/public/app'), '--as', 'work', '--headless']);
  assert.equal(w.json?.reason, 'no_such_account', 'an unknown label without --new is an error, not a new account');
  assert.ok(!fs.existsSync(path.join(HOME, 'profiles', 'site-127.0.0.1__work')));
  assert.equal(w.code, 1);
  const w2 = await hp(['open', url('/public/app'), '--as', 'work', '--new', '--headless']);
  assert.equal(w2.json?.status, 'logged_in', w2.out + w2.err);
  Object.assign(w, { json: w2.json });
  assert.equal(w.json.name, 'site-127.0.0.1__work');
  assert.equal(w.json.account, 'work');
  assert.equal(w.json.session, 'hp-site-127.0.0.1__work');
  assert.equal(w.json.new_account, true, 'first use of a label is reported as a new account');

  const p = await hp(['open', url('/public/app'), '--as', 'personal', '--new', '--headless']);
  assert.equal(p.json?.status, 'logged_in', p.out + p.err);
  assert.notEqual(p.json.session, w.json.session);
  assert.ok(fs.existsSync(path.join(HOME, 'profiles', 'site-127.0.0.1__work')) && fs.existsSync(path.join(HOME, 'profiles', 'site-127.0.0.1__personal')));

  const again = await hp(['open', url('/public/app'), '--as', 'work', '--headless']);
  assert.equal(again.json?.status, 'logged_in', again.out + again.err);
  assert.equal(again.json.new_account, undefined, 'the label already exists');

  const ask = await hp(['open', url('/public/app'), '--headless']);
  assert.equal(ask.json?.status, 'failed', ask.out + ask.err);
  assert.equal(ask.json.reason, 'ambiguous_account');
  assert.deepEqual(ask.json.candidates, ['personal', 'work']);
  assert.equal(ask.code, 1);

  const list = await hp(['accounts', url('/public/app')]);
  assert.deepEqual(list.json.accounts.map((a) => a.as), ['personal', 'work']);
  assert.equal(list.json.needs_choice, true);
  const sessions = (await hp(['sessions'])).json.sessions.filter((s) => s.host === '127.0.0.1');
  assert.deepEqual(sessions.map((s) => s.account).sort(), ['personal', 'work']);
});

test('a login made in one account does not leak into the other', { timeout: 420_000 }, async () => {
  const target = url('/simple/app');
  // headless: nobody sees a window, so "the person" signs in through hallpass's own guarded command (same profile, same cookies)
  const w = await hp(['open', target, '--as', 'work', '--headless']); // exists from the previous test
  assert.equal(w.json?.status, 'needs_human', w.out + w.err);
  assert.equal(w.json.reason, 'login');
  assert.equal(w.json.account, 'work');
  for (const cmd of [['fill', 'input[name=email]', USER], ['fill', 'input[name=password]', HUMAN_PW], ['click', 'button[type=submit]']]) {
    const r = await hp(['do', w.json.session, ...cmd]);
    assert.equal(r.code, 0, cmd[0] + ': ' + r.out + r.err);
  }
  assert.equal((await hp(['do', w.json.session, 'wait', '--text', 'Welcome back'])).code, 0, 'the sign-in took effect in the work profile');
  await hp(['logout', w.json.name]);

  const workAgain = await hp(['open', target, '--as', 'work', '--headless']);
  assert.equal(workAgain.json?.status, 'logged_in', workAgain.out + workAgain.err);
  assert.equal(workAgain.json.via, 'session', 'the work account stayed signed in');

  const personal = await hp(['open', target, '--as', 'personal', '--headless']);
  assert.equal(personal.json?.status, 'needs_human', 'the personal account never signed in: ' + personal.out + personal.err);
  assert.equal(personal.json.account, 'personal');
});

// ---------- MCP: the person picks ----------
function mcp(capabilities) {
  const srv = spawn(process.execPath, [BIN, 'mcp'], { env: { ...process.env, HALLPASS_HOME: HOME }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = new Map();
  let buf = '', nextId = 1;
  const serverRequests = [];
  let onServerRequest = null;
  srv.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method) { serverRequests.push(m); onServerRequest?.(m, (result) => srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n')); continue; }
      waiters.get(m.id)?.(m); waiters.delete(m.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; waiters.set(id, resolve); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return {
    serverRequests, rpc, close: () => srv.stdin.end(),
    answer: (fn) => { onServerRequest = fn; },
    init: () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'test', version: '0' } }),
    call: async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text),
  };
}

test('MCP: hallpass_accounts lists the choices; without elicitation hallpass_open returns the question for the agent to relay', { timeout: 240_000 }, async () => {
  const c = mcp({});
  try {
    await c.init();
    const l = await c.call('hallpass_accounts', { url: url('/public/app') });
    assert.deepEqual(l.accounts.map((a) => a.as), ['personal', 'work']);
    assert.equal(l.needs_choice, true);
    assert.match(l.next, /ask the user/i);
    const all = await c.call('hallpass_accounts', {});
    assert.ok(all.sites.some((s) => s.host === '127.0.0.1'));
    const r = await c.call('hallpass_open', { url: url('/public/app'), mode: 'headless' });
    assert.equal(r.reason, 'ambiguous_account');
    assert.equal(c.serverRequests.length, 0, 'a client that cannot ask is never sent a question');
  } finally { c.close(); }
});

test('MCP: a client that supports elicitation shows the person a picker; only a real candidate is accepted', { timeout: 420_000 }, async () => {
  const c = mcp({ elicitation: {} });
  try {
    await c.init();
    // 1. the person picks "work"
    c.answer((m, reply) => reply({ action: 'accept', content: { account: 'work' } }));
    const ok = await c.call('hallpass_open', { url: url('/public/app'), mode: 'headless' });
    assert.equal(ok.status, 'logged_in', JSON.stringify(ok));
    assert.equal(ok.account, 'work');
    assert.equal(ok.account_chosen_by, 'user');
    const q = c.serverRequests[0];
    assert.equal(q.method, 'elicitation/create');
    assert.deepEqual(q.params.requestedSchema.properties.account.enum, ['personal', 'work']);
    assert.equal(q.params.requestedSchema.properties.account.enumNames.length, 2);
    assert.ok(!JSON.stringify(q).match(/password|secret/i));

    // 2. the person declines: the agent gets the question back and must ask in chat
    c.answer((m, reply) => reply({ action: 'decline' }));
    const no = await c.call('hallpass_open', { url: url('/public/app'), mode: 'headless' });
    assert.equal(no.reason, 'ambiguous_account');

    // 3. a client answering with something that was not offered is ignored
    c.answer((m, reply) => reply({ action: 'accept', content: { account: 'admin-of-everything' } }));
    const bad = await c.call('hallpass_open', { url: url('/public/app'), mode: 'headless' });
    assert.equal(bad.reason, 'ambiguous_account');

    // 4. an explicit "as" never asks
    const before = c.serverRequests.length;
    c.answer(() => assert.fail('must not be asked'));
    const direct = await c.call('hallpass_open', { url: url('/public/app'), mode: 'headless', as: 'personal' });
    assert.equal(direct.status, 'logged_in', JSON.stringify(direct));
    assert.equal(direct.account_chosen_by, undefined);
    assert.equal(c.serverRequests.length, before);
  } finally { c.close(); }
});

// ---------- window mode ----------
test('window mode: headless, visible and headed are honoured per call and can be switched on a running account', { timeout: 420_000 }, async () => {
  const modeOf = async (...args) => (await hp(['open', url('/public/app'), '--as', 'personal', ...args])).json;
  assert.equal((await modeOf('--headless')).mode, 'headless');
  const v = await modeOf('--visible');
  assert.equal(v.status, 'logged_in', JSON.stringify(v));
  assert.equal(v.mode, 'headed', 'visible really opens a window');
  assert.equal((await modeOf('--headed')).mode, 'headed');
  assert.equal((await modeOf('--headless')).mode, 'headless', 'and back');
  assert.equal((await hp(['open', url('/public/app'), '--headed', '--visible'])).json?.status, 'usage_error');
  assert.equal((await hp(['open', url('/public/app'), '--new'])).json?.status, 'usage_error', '--new needs --as');
});

test('window mode: the person can fix it for everything with HALLPASS_WINDOW', { timeout: 420_000 }, async () => {
  const run2 = async (win, ...args) => {
    const r = await run(process.execPath, [BIN, 'open', url('/public/app'), '--as', 'personal', ...args], { env: { ...process.env, HALLPASS_HOME: HOME, HALLPASS_WINDOW: win } });
    return JSON.parse(r.out.trim().split(/\r?\n/).pop());
  };
  assert.equal((await run2('visible', '--headless')).mode, 'headed', 'an agent asking for headless cannot override a person who wants to watch');
  assert.equal((await run2('headless', '--headed')).mode, 'headless', 'and the reverse: a person who never wants a window');
  assert.equal((await run2('headless')).status, 'logged_in');
});
