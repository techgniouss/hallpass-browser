// MCP server + multi-tool installers. The MCP part drives a real browser over stdio, exactly as an IDE would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from './mock-site.mjs';
import { guardBrowser } from '../src/mcp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'hallpass.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-mcp-'));

test('guard: only safe browser commands, hallpass sessions, and http(s) URLs get through', () => {
  const ok = (command, session = 'hp-site-x.com') => assert.equal(guardBrowser({ session, command }), null, JSON.stringify(command));
  const no = (command, session = 'hp-site-x.com') => assert.notEqual(guardBrowser({ session, command }), null, JSON.stringify(command));
  ok(['snapshot', '-i']); ok(['click', '@e3']); ok(['fill', '@e2', 'hello -world']); ok(['open', 'https://a.com/x?y=1']);
  ok(['scroll', 'down', '500']); ok(['wait', '--text', 'Saved']); ok(['find', 'role', 'button', 'click', '--name', 'Go']);
  no(['eval', 'document.cookie']); no(['cookies', 'get']); no(['state', 'save', 'x.json']); no(['storage', 'local']);
  no(['upload', '@e1', 'C:/secret.txt']); no(['download', '@e1', 'x']); no(['network', 'route', 'x']); no(['auth', 'show', 'x']);
  no(['open', 'file:///C:/Windows/win.ini']); no(['open', 'javascript:alert(1)']); no(['tab', 'new', 'data:text/html,hi']);
  no(['snapshot', '--cdp', '9222']); no(['open', 'https://a.com', '--proxy', 'http://evil']); no(['snapshot', '-p']); no(['wait', '--fn', 'document.cookie']);
  no(['snapshot'], 'default'); no(['snapshot'], 'hp-../../x'); no(['snapshot'], 'someone-elses-session');
  no([]); no('snapshot'); no(['snapshot', 'x'.repeat(5000)]);
});

test('installers write marked blocks, are idempotent, and never clobber existing content', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-cwd-'));
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# My project rules\n\nUse tabs.\n');
  const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8', cwd, env: { ...process.env, HALLPASS_HOME: HOME, HALLPASS_TARGET_HOME: home } });
  for (let i = 0; i < 2; i++) { // twice: must not duplicate
    const r = run('install', '--for', 'all');
    assert.equal(JSON.parse(r.stdout).status, 'installed', r.stdout + r.stderr);
  }
  const agents = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Use tabs\./, 'existing content preserved');
  assert.equal(agents.split('hallpass:begin').length - 1, 1, 'exactly one managed block');
  for (const f of [
    path.join(home, '.claude', 'skills', 'hallpass', 'SKILL.md'), path.join(home, '.codex', 'AGENTS.md'), path.join(home, '.gemini', 'GEMINI.md'),
    path.join(cwd, '.cursor', 'rules', 'hallpass.mdc'), path.join(cwd, '.windsurf', 'rules', 'hallpass.md'), path.join(cwd, '.github', 'copilot-instructions.md'),
  ]) {
    const t = fs.readFileSync(f, 'utf8');
    assert.match(t, /Never ask the user to paste a password/, f);
    assert.match(t, /hallpass open/, f);
  }
  assert.match(fs.readFileSync(path.join(cwd, '.cursor', 'rules', 'hallpass.mdc'), 'utf8'), /^---\ndescription:/);
  assert.equal(run('install', '--for', 'nonsense').status, 1);
});

test('lost master key: adding another entry is refused instead of silently orphaning the old ones', { skip: process.platform !== 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-lostkey-'));
  const add = (n) => spawnSync(process.execPath, [BIN, 'add', n, '--url', 'https://example.com/login', '--stdin-json'], { encoding: 'utf8', input: JSON.stringify({ username: 'u@example.com', password: 'password-123' }), env: { ...process.env, HALLPASS_HOME: home } });
  assert.equal(JSON.parse(add('one').stdout).status, 'saved');
  fs.rmSync(path.join(home, 'master.key.dpapi')); // simulate a new Windows profile / wiped keystore
  const r = add('two');
  assert.equal(r.status, 1, r.stdout);
  assert.match(JSON.parse(r.stdout).detail, /master key .* missing/);
  assert.ok(!fs.existsSync(path.join(home, 'master.key.dpapi')), 'must not mint a replacement key');
});

test('mcp-config prints valid config for every client', () => {
  for (const t of ['claude', 'cursor', 'gemini', 'antigravity', 'windsurf', 'vscode', 'codex']) {
    const r = spawnSync(process.execPath, [BIN, 'mcp-config', '--for', t], { encoding: 'utf8' });
    const j = JSON.parse(r.stdout);
    assert.equal(j.target, t);
    const blob = JSON.stringify(j);
    assert.match(blob, /hallpass\.mjs/);
    assert.match(blob, /mcp/);
  }
});

// ---------- real MCP session ----------
let site, srv, buf = '', waiters = new Map(), nextId = 1;
before(async () => {
  site = await startSite({ user: 'u@example.test', password: 'unused-password-1', totpCfg: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 } });
  srv = spawn(process.execPath, [BIN, 'mcp'], { env: { ...process.env, HALLPASS_HOME: HOME }, stdio: ['pipe', 'pipe', 'inherit'] });
  srv.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = JSON.parse(line); // every stdout line must be valid JSON-RPC: any stray print would break clients
      waiters.get(m.id)?.(m); waiters.delete(m.id);
    }
  });
});
after(() => { srv?.stdin.end(); site?.close(); spawnSync(process.execPath, [BIN, 'logout', 'site-127.0.0.1', '--wipe'], { env: { ...process.env, HALLPASS_HOME: HOME } }); });

const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiters.set(id, resolve);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
const json = (r) => JSON.parse(r.content[0].text);

test('MCP: initialize advertises tools + instructions; no tool can read or write a credential', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'hallpass');
  assert.match(init.result.instructions, /Never ask the user to paste/);
  const { tools } = (await rpc('tools/list')).result;
  const names = tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['browser', 'browser_screenshot', 'hallpass_list', 'hallpass_logout', 'hallpass_open', 'hallpass_request_credential', 'hallpass_resume', 'hallpass_status'].sort());
  const schemaText = JSON.stringify(tools);
  assert.ok(!/password|secret|totp|reveal|export/i.test(names.join(' ')), 'no secret-handling tool names');
  assert.ok(!/"(password|secret|username|token)"\s*:/.test(schemaText), 'no secret-bearing parameters');
});

test('MCP: open a page, drive it, screenshot it, close it (real browser)', { timeout: 240_000 }, async () => {
  const opened = json(await call('hallpass_open', { url: `http://127.0.0.1:${site.port}/public/app` }));
  assert.equal(opened.status, 'logged_in', JSON.stringify(opened));
  const session = opened.session;
  assert.match(session, /^hp-/);

  const snap = await call('browser', { session, command: ['snapshot'] });
  assert.ok(!snap.isError, snap.content[0].text);
  assert.match(snap.content[0].text, /Public docs/);
  assert.match(snap.content[0].text, /AGENT_BROWSER_PAGE_CONTENT nonce=/, 'page text is wrapped in content-boundary markers');

  const shot = await call('browser_screenshot', { session });
  assert.equal(shot.content[0].type, 'image');
  assert.equal(shot.content[0].mimeType, 'image/png');
  assert.ok(Buffer.from(shot.content[0].data, 'base64').subarray(1, 4).toString() === 'PNG', 'valid PNG bytes');

  const st = json(await call('hallpass_status', { name: opened.name }));
  assert.equal(st.browser_running, true);
  assert.ok(!st.url.includes('?'));

  for (const command of [['eval', '1+1'], ['cookies', 'get'], ['open', 'file:///C:/Windows/win.ini'], ['snapshot', '--cdp', '9222']]) {
    const r = await call('browser', { session, command });
    assert.equal(r.isError, true, JSON.stringify(command));
  }
  assert.equal((await call('browser', { session: 'default', command: ['snapshot'] })).isError, true);

  const closed = json(await call('hallpass_logout', { name: opened.name }));
  assert.equal(closed.closed, true);
});

test('MCP: errors are reported in-band, stdout stays clean JSON-RPC', async () => {
  const r = await call('hallpass_resume', { name: 'does-not-exist' });
  assert.equal(r.isError, true);
  assert.equal((await call('hallpass_open', { url: 'http://evil.example.com' })).isError, true);
  const bad = await rpc('no/such/method');
  assert.equal(bad.error.code, -32601);
  assert.deepEqual(json(await call('hallpass_list', {})), { entries: [] });
});
