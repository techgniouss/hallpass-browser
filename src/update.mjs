// "A new version is available": a quiet, privacy-minded update notice.
//
// The only network request Hallpass makes by itself: at most once a day, an anonymous GET of the latest published version number
// from the npm registry (https://registry.npmjs.org/hallpass-browser/latest). It sends no identifier, no version, no data from your
// machine. It never blocks a command (a detached background process does it), fails silently, and is off with
// HALLPASS_NO_UPDATE_CHECK=1 (and automatically in CI and under `node --test`).
//
// What is shown: a `update_available` field on the first result of the day (so the agent tells you), a line in `hallpass doctor`,
// and `hallpass update`. Updating is only ever done by you, in a terminal, after typing yes. The command shown comes from this
// file, never from the registry response; the response contributes one version number that must look like 1.2.3.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stateDir } from './paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE = 'hallpass-browser';
export const REGISTRY_URL = () => process.env.HALLPASS_UPDATE_URL || `https://registry.npmjs.org/${PACKAGE}/latest`;
const DAY = 24 * 3600e3;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export const currentVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const cacheFile = () => path.join(stateDir(), 'update-check.json');
const readCache = () => { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {}; } catch { return {}; } };
const writeCache = (o) => { try { fs.writeFileSync(cacheFile(), JSON.stringify(o), { mode: 0o600 }); } catch { /* best effort */ } };

/** Is `a` a newer x.y.z than `b`? Anything that is not plain x.y.z is never "newer". */
export function newer(a, b) {
  if (!VERSION_RE.test(a) || !VERSION_RE.test(b)) return false;
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Off in CI, under the node test runner, and when the person said so. HALLPASS_UPDATE_URL (tests) turns it back on. */
export function enabled(env = process.env) {
  if (env.HALLPASS_NO_UPDATE_CHECK === '1') return false;
  if (env.HALLPASS_UPDATE_URL) return true;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return false;
  if (env.NODE_TEST_CONTEXT) return false;
  return true;
}

/** How this copy of hallpass was installed, and therefore the command that updates it. Never from user or network input. */
export function detectInstall(root = ROOT) {
  const p = root.replace(/\\/g, '/');
  const has = (s) => p.toLowerCase().includes(s);
  if (has('/.claude/plugins/') || has('/.claude/plugin')) return { method: 'claude-plugin', command: '/plugin update hallpass-browser   (inside Claude Code), then restart it', automatic: false };
  if (has('/.gemini/extensions/')) return { method: 'gemini-extension', command: 'gemini extensions update hallpass-browser', automatic: false };
  if (has('/.codex/') && has('plugin')) return { method: 'codex-plugin', command: 'update the hallpass-browser plugin from the Codex plugin marketplace, then restart Codex', automatic: false };
  if (has('/_npx/')) return { method: 'npx', command: `npx -y ${PACKAGE}@latest mcp   (restart your AI tool so it starts the new one)`, automatic: false };
  if (fs.existsSync(path.join(root, '.git'))) return { method: 'git-clone', command: 'git pull && npm install   (in the hallpass-browser folder)', automatic: false };
  if (has('/node_modules/')) {
    const local = fs.existsSync(path.join(root, '..', '..', 'package.json')) && !/\/(lib\/node_modules|npm\/node_modules|node_global)\//i.test(p);
    return local
      ? { method: 'npm-local', command: `npm install ${PACKAGE}@latest   (in the project that depends on it)`, automatic: false }
      : { method: 'npm-global', command: `npm install -g ${PACKAGE}@latest`, automatic: true };
  }
  return { method: 'unknown', command: `npm install -g ${PACKAGE}@latest`, automatic: false };
}

/** What the cache says right now. No network. */
export function status() {
  const c = readCache();
  const current = currentVersion();
  const latest = VERSION_RE.test(c.latest || '') ? c.latest : null;
  return { current, latest, update_available: !!latest && newer(latest, current), checked_at: c.checkedAt ? new Date(c.checkedAt).toISOString() : null, install: detectInstall(), check_enabled: enabled() };
}

// One GET with node:http(s) rather than fetch: a plain socket we close ourselves, so the process can exit cleanly right afterwards
// (fetch's connection pool left handles closing at process.exit, which aborts Node on Windows with a libuv assertion).
function getJson(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('bad url')); }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) return reject(new Error('bad url'));
    const req = lib.request(u, { method: 'GET', agent: false, timeout: timeoutMs, headers: { accept: 'application/json', 'user-agent': 'hallpass-update-check', connection: 'close' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); res.on('close', () => reject(Object.assign(new Error('status'), { status: res.statusCode }))); return; } // no redirects followed
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 100_000) req.destroy(new Error('too large')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('not json')); } });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end();
  });
}

/** Ask the registry now (await it). Records the answer. Returns { ok, latest } or { ok:false, reason }. */
export async function checkNow({ timeoutMs = 5000, now = Date.now() } = {}) {
  writeCache({ ...readCache(), checkedAt: now }); // failures are not retried on every command
  try {
    const v = (await getJson(REGISTRY_URL(), timeoutMs))?.version;
    if (typeof v !== 'string' || !VERSION_RE.test(v)) return { ok: false, reason: 'unexpected answer from the registry' };
    writeCache({ ...readCache(), checkedAt: now, latest: v });
    return { ok: true, latest: v };
  } catch (e) {
    return { ok: false, reason: e?.status ? `registry answered ${e.status}` : e?.name === 'TimeoutError' ? 'timed out' : 'could not reach the registry' };
  } finally {
    await new Promise((r) => setTimeout(r, 100)); // let the socket finish closing before a caller may process.exit()
  }
}

/** Fire and forget: refresh the cache in a detached process when it is more than a day old. Never blocks, never throws. */
export function refreshIfStale({ now = Date.now(), bin = path.join(ROOT, 'bin', 'hallpass.mjs') } = {}) {
  try {
    if (!enabled()) return false;
    const c = readCache();
    if (c.checkedAt && now - c.checkedAt < DAY) return false;
    writeCache({ ...c, checkedAt: now }); // claim the slot first so concurrent commands do not all fetch
    const p = spawn(process.execPath, [bin, '_update-check'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

/** The notice an agent should relay: returned once per new version per day, then null. */
export function noticeOnce({ now = Date.now() } = {}) {
  if (!enabled()) return null;
  const s = status();
  if (!s.update_available) return null;
  const c = readCache();
  if (c.notifiedFor === s.latest && c.notifiedAt && now - c.notifiedAt < DAY) return null;
  writeCache({ ...c, notifiedFor: s.latest, notifiedAt: now });
  return {
    current: s.current, latest: s.latest,
    how: s.install.command,
    message: `Hallpass ${s.latest} is available (this is ${s.current}). Tell the user once, and ask whether they want to update. Only they can: in their own terminal run "hallpass update" (or: ${s.install.command}). Do not run it yourself.`,
  };
}

/** Person-only. Runs the install command for a global npm install after the CLI has asked. Returns { ok, code }. */
export function runUpdate() {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', ['install', '-g', `${PACKAGE}@latest`], { stdio: 'inherit', shell: win });
  return { ok: r.status === 0, code: r.status };
}
