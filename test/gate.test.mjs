// Action gate + read-only mode, against a page with dangerous and harmless buttons, in a real browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'hallpass.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-gate-'));
process.env.HALLPASS_HOME = HOME;
const { RISKY, RISKY_ATTR, writesState, runBrowser } = await import('../src/act.mjs');

test('classifier: dangerous labels are risky, everyday ones are not', () => {
  for (const l of ['Delete account', 'delete project', 'Publish release', 'Submit application', 'Apply for production', 'Pay now', 'Remove member', 'Invite user',
    'Roll out to production', 'Start rollout', 'Send for review', 'Purchase', 'Buy now', 'Subscribe', 'Upgrade plan', 'Transfer funds', 'Revoke access', 'Terminate instance', 'Go live']) {
    assert.ok(RISKY.test(l), 'should be risky: ' + l);
  }
  for (const l of ['Next', 'Cancel', 'Apply filters', 'Search', 'Save draft', 'Edit', 'Add item', 'Continue', 'Close', 'Back', 'Sort order', 'Show more', 'Download report', 'Refresh']) {
    assert.ok(!RISKY.test(l), 'should NOT be risky: ' + l);
  }
});

test('classifier: developer-chosen names catch icon-only buttons', () => {
  for (const a of ['icon-btn btn-delete-user', 'deleteBtn', 'remove_member', 'publishRelease', 'btn-purchase', 'js-submit-form', 'checkout-cta']) assert.ok(RISKY_ATTR.test(a), a);
  for (const a of ['icon-btn', 'nav-link active', 'search-input', 'btn-primary', 'sidebar-toggle', 'payload-viewer', 'apply-filters']) assert.ok(!RISKY_ATTR.test(a), a);
});

test('writesState: observation vs. changing the page', () => {
  for (const c of [['click', '@e1'], ['fill', '@e1', 'x'], ['type', '@e1', 'x'], ['press', 'Enter'], ['select', '@e1', 'a'], ['check', '@e1'], ['find', 'role', 'button', 'click', '--name', 'Go']]) assert.ok(writesState(c), c.join(' '));
  for (const c of [['snapshot', '-i'], ['get', 'text', '@e1'], ['scroll', 'down'], ['open', 'https://a.com'], ['wait', '--text', 'x'], ['find', 'text', 'Hi', 'get'], ['tab', 'list']]) assert.ok(!writesState(c), c.join(' '));
});

let site, port;
before(async () => {
  site = spawn(process.execPath, [path.join(HERE, 'site-proc.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  port = await new Promise((resolve) => site.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
});
after(() => { site?.stdin.end(); });

function mcp(env = {}) {
  const p = spawn(process.execPath, [BIN, 'mcp'], { env: { ...process.env, HALLPASS_HOME: HOME, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 1; const waiters = new Map();
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); waiters.delete(m.id); } });
  const rpc = (method, params) => new Promise((res) => { const n = id++; waiters.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { call, close: () => p.stdin.end() };
}
const title = async (c, session) => (await c.call('browser', { session, command: ['get', 'title'] })).content[0].text;

test('gate (no desktop dialog = deny): dangerous clicks are blocked, harmless ones work', { timeout: 300_000 }, async () => {
  const c = mcp({ HALLPASS_NO_UI: '1' });
  try {
    const opened = JSON.parse((await c.call('hallpass_open', { url: `http://127.0.0.1:${port}/danger/app` })).content[0].text);
    assert.equal(opened.status, 'logged_in', JSON.stringify(opened));
    const s = opened.session;
    for (const command of [['click', '#del'], ['click', '#icon'], ['click', '#sub'], ['find', 'text', 'Delete account', 'click']]) {
      const r = await c.call('browser', { session: s, command });
      assert.equal(r.isError, true, command.join(' '));
      assert.match(r.content[0].text, /Blocked: the user did not approve/, command.join(' '));
    }
    const t = await title(c, s);
    assert.ok(!/DELETED|PUBLISHED|SUBMITTED/.test(t), 'no dangerous handler ran: ' + t);
    const ok = await c.call('browser', { session: s, command: ['click', '#next'] });
    assert.equal(ok.isError, false, ok.content[0].text);
    assert.match(await title(c, s), /NEXT/);
    await c.call('hallpass_logout', { name: opened.name });
  } finally { c.close(); }
});

test('the browser tool will not read back password fields', { timeout: 300_000 }, async () => {
  const c = mcp({ HALLPASS_NO_UI: '1', HALLPASS_GATE: 'off' });
  try {
    // a page with a password field reads as a login wall (needs_human), but the headless session is open and drivable
    const opened = JSON.parse((await c.call('hallpass_open', { url: `http://127.0.0.1:${port}/danger/password`, mode: 'headless' })).content[0].text);
    const s = opened.session;
    const r = await c.call('browser', { session: s, command: ['get', 'value', '#pw'] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /password/i);
    assert.ok(!r.content[0].text.includes('demo-typed-secret'));
    const note = await c.call('browser', { session: s, command: ['get', 'value', '#note'] });
    assert.equal(note.isError, false, 'ordinary fields are still readable even on a /password URL: ' + note.content[0].text);
    const snap = await c.call('browser', { session: s, command: ['snapshot'] });
    assert.ok(!snap.content[0].text.includes('demo-typed-secret'), 'snapshots mask password fields');
    await c.call('hallpass_logout', { name: opened.name });
  } finally { c.close(); }
});

test('gate holes: icon-only buttons, find last/nth, and press/dialog in "all" mode', { timeout: 300_000 }, async () => {
  const c = mcp({ HALLPASS_NO_UI: '1' });
  try {
    const opened = JSON.parse((await c.call('hallpass_open', { url: `http://127.0.0.1:${port}/danger/app` })).content[0].text);
    const s = opened.session;
    // a trash can with no text at all: only its class says what it does
    const trash = await c.call('browser', { session: s, command: ['click', '#trash'] });
    assert.equal(trash.isError, true, 'icon-only delete button must be gated');
    assert.match(trash.content[0].text, /Blocked/);
    assert.ok(!/TRASHED/.test(await title(c, s)));
    // we cannot tell which element "last" is, so we ask rather than guess
    assert.equal((await c.call('browser', { session: s, command: ['find', 'last', 'button', 'click'] })).isError, true);
    assert.equal((await c.call('browser', { session: s, command: ['find', 'nth', '2', 'button', 'click'] })).isError, true);
    // plain "find first" resolves a label and a harmless target still works
    const ok = await c.call('browser', { session: s, command: ['find', 'first', '#next', 'click'] });
    assert.equal(ok.isError, false, ok.content[0].text);
    assert.match(await title(c, s), /NEXT/);
    await c.call('hallpass_logout', { name: opened.name });
  } finally { c.close(); }

  const strict = mcp({ HALLPASS_NO_UI: '1', HALLPASS_GATE: 'all' });
  try {
    const opened = JSON.parse((await strict.call('hallpass_open', { url: `http://127.0.0.1:${port}/danger/app` })).content[0].text);
    const s = opened.session;
    for (const command of [['press', 'Enter'], ['click', '#next'], ['dialog', 'accept']]) {
      const r = await strict.call('browser', { session: s, command });
      assert.equal(r.isError, true, 'all mode gates ' + command.join(' '));
    }
    assert.equal((await strict.call('browser', { session: s, command: ['snapshot'] })).isError, false, 'reading is never gated');
    await strict.call('hallpass_logout', { name: opened.name });
  } finally { strict.close(); }
});

test('gate: when the person approves, the action runs; when they deny, it does not', { timeout: 300_000 }, async () => {
  const c = mcp({ HALLPASS_NO_UI: '1', HALLPASS_GATE: 'off' }); // open the page; gate off just for setup
  try {
    const opened = JSON.parse((await c.call('hallpass_open', { url: `http://127.0.0.1:${port}/danger/app` })).content[0].text);
    const s = opened.session;
    const denied = runBrowser({ session: s, command: ['click', '#del'] }, { approver: () => 'deny' });
    assert.equal(denied.isError, true);
    assert.ok(!/DELETED/.test(await title(c, s)));
    const allowed = runBrowser({ session: s, command: ['click', '#del'] }, { approver: ({ message }) => { assert.match(message, /Delete account/i); assert.match(message, /127\.0\.0\.1/); return 'once'; } });
    assert.equal(allowed.isError, false, allowed.text);
    assert.match(await title(c, s), /DELETED/);
    await c.call('hallpass_logout', { name: opened.name });
  } finally { c.close(); }
});

test('read-only server: observation works, every state change is refused', { timeout: 300_000 }, async () => {
  const c = mcp({ HALLPASS_READONLY: '1', HALLPASS_GATE: 'off', HALLPASS_NO_UI: '1' });
  try {
    const opened = JSON.parse((await c.call('hallpass_open', { url: `http://127.0.0.1:${port}/danger/app` })).content[0].text);
    const s = opened.session;
    assert.equal((await c.call('browser', { session: s, command: ['snapshot'] })).isError, false);
    assert.equal((await c.call('browser', { session: s, command: ['get', 'title'] })).isError, false);
    for (const command of [['click', '#next'], ['fill', '#note', 'hello'], ['press', 'Enter'], ['find', 'role', 'button', 'click', '--name', 'Next']]) {
      const r = await c.call('browser', { session: s, command });
      assert.equal(r.isError, true, command.join(' '));
      assert.match(r.content[0].text, /read-only/, command.join(' '));
    }
    assert.ok(!/NEXT/.test(await title(c, s)), 'nothing was clicked');
    await c.call('hallpass_logout', { name: opened.name });
  } finally { c.close(); }
});
