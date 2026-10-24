// Thin, hardened wrapper around the agent-browser CLI.
//  - secrets only ever travel over stdin (JSON `batch`), never argv, so they are not visible in process listings
//  - every byte coming back is passed through the Redactor before anything can print or log it
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRequire } from 'node:module';
import { home } from './paths.mjs';

export const runtimeDir = () => path.join(home(), 'runtime');

// The agent-browser binary receives every typed secret on stdin, so WHICH binary it is must not be steerable from the
// agent's shell. There is no env override, and once resolved the absolute path is pinned in config.json: a later
// `PATH=/tmp/fake:$PATH hallpass login x` cannot redirect it. Re-pinning (after moving/reinstalling) is a human action:
// `hallpass doctor --repin`.
const cfgFile = () => path.join(home(), 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } };
const pinned = () => { const p = readCfg().agentBrowser; return typeof p === 'string' && fs.existsSync(p) ? p : null; };
const pin = (p, { human = false } = {}) => { try { fs.writeFileSync(cfgFile(), JSON.stringify({ ...readCfg(), agentBrowser: p, agentBrowserPinnedBy: human ? 'person' : 'auto' }), { mode: 0o600 }); } catch { /* best effort */ } };
export const pinnedByHuman = () => readCfg().agentBrowserPinnedBy === 'person';

// The agent-browser release line this version of hallpass was developed and tested against. Newer lines may change CLI output.
export const TESTED_AGENT_BROWSER = '0.39';

let binCache;
export function findBinary({ repin = false, human = false } = {}) {
  if (!repin) {
    if (binCache) return binCache;
    const p = pinned();
    // Our own copy (this package's dependency, or ~/.hallpass/runtime) is the one hallpass was tested with and is not steerable
    // from a shell, so it replaces an older pin to some other install (typically a global agent-browser from before hallpass
    // shipped its own). A pin to anything else stays: choosing a different agent-browser is a human decision (`doctor --repin`).
    const own = ownBinary();
    if (p && (!own || p === own)) return (binCache = p);
    if (own && p && !pinnedByHuman()) { pin(own); return (binCache = own); }
    if (p) return (binCache = p);
  }
  const found = resolveFromPath();
  pin(found, { human });
  return (binCache = found);
}

// The native binary inside an agent-browser package folder, or null. Linux has glibc and musl builds; take whichever exists.
function nativeIn(pkgDir) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const names = { win32: ['agent-browser-win32-x64.exe'], darwin: [`agent-browser-darwin-${arch}`], linux: [`agent-browser-linux-${arch}`, `agent-browser-linux-musl-${arch}`] }[process.platform] || [];
  for (const n of names) {
    const p = path.join(pkgDir, 'bin', n);
    if (!fs.existsSync(p)) continue;
    // npm run with --ignore-scripts leaves the binary without its execute bit: fix it rather than fail later with "permission denied"
    if (process.platform !== 'win32') { try { fs.accessSync(p, fs.constants.X_OK); } catch { try { fs.chmodSync(p, 0o755); } catch { continue; } } }
    return p;
  }
  return null;
}

/** Hallpass's own agent-browser: the package dependency, else the copy installed under ~/.hallpass/runtime. Never PATH. */
export function ownBinary() {
  try { const own = nativeIn(path.dirname(createRequire(import.meta.url).resolve('agent-browser/package.json'))); if (own) return own; } catch { /* not a dependency here */ }
  return nativeIn(path.join(runtimeDir(), 'node_modules', 'agent-browser'));
}

/** "0.39.2" for a binary, or null. */
export function versionOf(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return /(\d+\.\d+\.\d+)/.exec(r.stdout || '')?.[1] || null;
}
/** true when a version is on an older minor line than the one hallpass is tested with. */
export const olderThanTested = (v) => { const a = String(v || '').split('.').map(Number), b = TESTED_AGENT_BROWSER.split('.').map(Number); return a.length >= 2 && !a.some(Number.isNaN) && (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])); };

// Where agent-browser may come from, in trust order. Our own dependency and our own runtime folder come BEFORE anything an
// environment variable or PATH could steer; the result is then pinned (see above).
function resolveFromPath() {
  const own = ownBinary();
  if (own) return (binCache = own);
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of ['agent-browser.cmd', 'agent-browser.exe', 'agent-browser']) {
      const p = path.join(d, n);
      if (!fs.existsSync(p)) continue;
      // npm global layout: <prefix>/agent-browser(.cmd) beside <prefix>/node_modules/agent-browser/bin/<native>
      const native = nativeIn(path.join(d, 'node_modules', 'agent-browser'));
      if (native) return (binCache = native);
      if (!p.endsWith('.cmd')) return (binCache = p);
    }
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
    const native = nativeIn(path.join(root, 'agent-browser'));
    if (native) return (binCache = native);
  } catch { /* fall through */ }
  throw new Error('agent-browser not found. Run: hallpass setup   (or: npm i -g agent-browser && agent-browser install)');
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

  // `close` returns before the daemon has finished exiting, and for a second or two `session list` still shows the session. A
  // relaunch (headless to headed) or a quick logout-then-open in that window would talk to the dying daemon, so wait it out.
  close() {
    const r = this.run(['close'], { timeout: 30_000 });
    for (let i = 0; i < 24 && this.alive(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    return r;
  }
  // Is there a live session by this name? Must NOT use a page command: on a missing session those silently
  // launch a new blank browser, which would make "closed" look like "open".
  alive() {
    // bare: no --session flag, because with one the listing marks the current session as "-> name"
    const r = this.run(['session', 'list'], { timeout: 15_000, bare: true });
    return r.ok && Array.isArray(r.json?.data?.sessions) && r.json.data.sessions.includes(this.session);
  }
}
