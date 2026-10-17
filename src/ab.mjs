// Thin, hardened wrapper around the agent-browser CLI.
//  - secrets only ever travel over stdin (JSON `batch`), never argv, so they are not visible in process listings
//  - every byte coming back is passed through the Redactor before anything can print or log it
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { home } from './paths.mjs';

// The agent-browser binary receives every typed secret on stdin, so WHICH binary it is must not be steerable from the
// agent's shell. There is no env override, and once resolved the absolute path is pinned in config.json: a later
// `PATH=/tmp/fake:$PATH hallpass login x` cannot redirect it. Re-pinning (after moving/reinstalling) is a human action:
// `hallpass doctor --repin`.
const cfgFile = () => path.join(home(), 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } };
const pinned = () => { const p = readCfg().agentBrowser; return typeof p === 'string' && fs.existsSync(p) ? p : null; };
const pin = (p) => { try { fs.writeFileSync(cfgFile(), JSON.stringify({ ...readCfg(), agentBrowser: p }), { mode: 0o600 }); } catch { /* best effort */ } };

// The agent-browser release line this version of hallpass was developed and tested against. Newer lines may change CLI output.
export const TESTED_AGENT_BROWSER = '0.27';

let binCache;
export function findBinary({ repin = false } = {}) {
  if (!repin) {
    if (binCache) return binCache;
    const p = pinned();
    if (p) return (binCache = p);
  }
  const found = resolveFromPath();
  pin(found);
  return (binCache = found);
}

function resolveFromPath() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const exe = { win32: 'agent-browser-win32-x64.exe', darwin: `agent-browser-darwin-${arch}`, linux: `agent-browser-linux-${arch}` }[process.platform];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of ['agent-browser.cmd', 'agent-browser.exe', 'agent-browser']) {
      const p = path.join(d, n);
      if (!fs.existsSync(p)) continue;
      // npm global layout: <prefix>/agent-browser(.cmd) beside <prefix>/node_modules/agent-browser/bin/<native>
      const native = path.join(d, 'node_modules', 'agent-browser', 'bin', exe);
      if (fs.existsSync(native)) return (binCache = native);
      if (!p.endsWith('.cmd')) return (binCache = p);
    }
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
    const native = path.join(root, 'agent-browser', 'bin', exe);
    if (fs.existsSync(native)) return (binCache = native);
  } catch { /* fall through */ }
  throw new Error('agent-browser not found. Install it: npm i -g agent-browser && agent-browser install');
}

export class Browser {
  constructor({ session, profile, headed = false, redactor, allowedDomains = null }) {
    Object.assign(this, { session, profile, headed, redactor, allowedDomains });
  }

  _flags(json = true) {
    const f = ['--session', this.session, '--profile', this.profile];
    if (json) f.push('--json');
    if (this.headed) f.push('--headed');
    if (this.allowedDomains?.length) f.push('--allowed-domains', this.allowedDomains.join(','));
    return f;
  }

  run(args, { input, timeout = 60_000, json: wantJson = true, env: extraEnv = {}, bare = false } = {}) {
    // Output goes to temp files, not pipes: the first command of a session spawns a long-lived daemon that
    // inherits our stdio, and a pipe would never reach EOF (spawnSync would hang until its timeout).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
    const fo = fs.openSync(path.join(dir, 'out'), 'w');
    const fe = fs.openSync(path.join(dir, 'err'), 'w');
    let r;
    try {
      r = spawnSync(findBinary(), [...(bare ? ['--json'] : this._flags(wantJson)), ...args], {
        input, timeout, windowsHide: false, stdio: [input === undefined ? 'ignore' : 'pipe', fo, fe],
        env: { AGENT_BROWSER_IDLE_TIMEOUT_MS: '7200000', ...process.env, AGENT_BROWSER_HEADED: this.headed ? 'true' : 'false', ...extraEnv },
      });
    } finally { fs.closeSync(fo); fs.closeSync(fe); }
    const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
    const stdout = read('out'), stderr = read('err');
    fs.rmSync(dir, { recursive: true, force: true });
    const scrub = (s) => this.redactor.scrub(s || '');
    let json = null;
    try { json = JSON.parse(stdout); } catch { /* non-json output */ }
    return {
      ok: r.status === 0 && json?.success !== false,
      json, stdout: scrub(stdout), stderr: scrub(stderr),
      error: r.error ? scrub(String(r.error.message)) : null,
    };
  }

  // Plain-text pass-through for an agent's own commands (used by the MCP server).
  // Page output is wrapped in boundary markers so injected page text is clearly delimited from tool output.
  text(args, { timeout = 60_000, boundaries = true } = {}) {
    const r = this.run(args, { timeout, json: false, env: boundaries ? { AGENT_BROWSER_CONTENT_BOUNDARIES: 'true' } : {} });
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, error: r.error };
  }

  open(url) { return this.run(['open', url], { timeout: 120_000 }); }

  // commands: array of string arrays. May contain secrets; they go over stdin only.
  batch(commands) {
    const r = this.run(['batch', '--bail'], { input: JSON.stringify(commands) });
    const results = Array.isArray(r.json) ? r.json : [];
    return {
      ok: r.ok && results.length === commands.length && results.every((x) => x.success),
      results: this.redactor.scrubDeep(results),
      error: r.error || r.stderr,
    };
  }

  // Runs a script in the page and parses its JSON result.
  evalJson(script) {
    const r = this.run(['eval', '--stdin'], { input: script });
    if (!r.ok) return null;
    const raw = r.json?.data?.result;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  }

  close() { return this.run(['close'], { timeout: 30_000 }); }
  // Is there a live session by this name? Must NOT use a page command: on a missing session those silently
  // launch a new blank browser, which would make "closed" look like "open".
  alive() {
    // bare: no --session flag, because with one the listing marks the current session as "-> name"
    const r = this.run(['session', 'list'], { timeout: 15_000, bare: true });
    return r.ok && Array.isArray(r.json?.data?.sessions) && r.json.data.sessions.includes(this.session);
  }
}
