// Runs the real page probe in a real browser over the fixture corpus and checks what it reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES } from './fixtures.mjs';
import { Browser } from '../src/ab.mjs';
import { Redactor } from '../src/redact.mjs';
import { probeScript } from '../src/probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let server, port, browser;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-detect-'));

before(async () => {
  const routes = {};
  for (const f of FIXTURES) routes[f.path + (f.dupe || '')] = f.html; // paths are unique per fixture below
  // several fixtures share /login: serve each at a unique prefix but keep its real path as the tail
  const map = {};
  for (const f of FIXTURES) map[`/${f.name}${f.path}`] = f.html;
  fs.writeFileSync(path.join(tmp, 'routes.json'), JSON.stringify(map));
  server = spawn(process.execPath, [path.join(HERE, 'fixture-server.mjs'), path.join(tmp, 'routes.json')], { stdio: ['pipe', 'pipe', 'inherit'] });
  port = await new Promise((r) => server.stdout.once('data', (d) => r(Number(String(d).trim()))));
  browser = new Browser({ session: 'hp-detect', profile: path.join(tmp, 'profile'), redactor: new Redactor() });
});
after(() => { try { browser?.close(); } catch { /* ignore */ } server?.stdin.end(); });

// what the engine derives from the probe (kept in sync with drive() in login.mjs)
const derive = (p) => {
  const userStep = p.user && (p.loginish || p.pass);
  return { ...p, wall: !!(userStep || p.pass || p.otp || p.mfa || p.captcha || p.loginish) };
};

for (const f of FIXTURES) {
  test(`detect: ${f.name}${f.note ? ' (' + f.note.slice(0, 50) + '...)' : ''}`, { timeout: 60_000 }, () => {
    const opened = browser.open(`http://localhost:${port}/${f.name}${f.path}`);
    assert.ok(opened.ok, 'page opened: ' + opened.stderr);
    const p = browser.evalJson(probeScript({ nonce: 'abcdef12' }));
    assert.ok(p, 'probe returned data');
    const d = derive(p);
    for (const [k, v] of Object.entries(f.expect)) assert.equal(d[k], v, `${f.name}: ${k} expected ${v}, got ${d[k]} (probe: ${JSON.stringify({ user: p.user, pass: p.pass, otp: p.otp, captcha: p.captcha, mfa: p.mfa, error: p.error, loginish: p.loginish, submit: p.submit })})`);
  });
}
