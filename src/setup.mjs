// First-run setup: hallpass cannot do anything without agent-browser (the program that drives Chrome) and a Chrome for it to
// drive, so both are installed automatically instead of being a manual prerequisite.
//   1. agent-browser: a dependency of this package (npm i -g hallpass-browser brings it), else installed on demand into
//      ~/.hallpass/runtime (that folder is already off limits to agents: see `hallpass harden`).
//   2. Chrome: `agent-browser install` (Chrome for Testing; idempotent, a few seconds when already present).
// Triggers: npm postinstall (best effort), `hallpass setup`, the first `open`/`login` from a terminal (synchronous, with
// progress on stderr), and MCP server start (background, so a tool call is never blocked past a client's timeout).
// HALLPASS_NO_AUTO_INSTALL=1 turns all of it off.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { home, stateDir } from './paths.mjs';
import { findBinary, TESTED_AGENT_BROWSER, runtimeDir } from './ab.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hallpass.mjs');
const win = process.platform === 'win32';
export const autoInstallOff = () => process.env.HALLPASS_NO_AUTO_INSTALL === '1';
const lockFile = () => path.join(stateDir(), 'setup.lock');
const logFile = () => path.join(stateDir(), 'setup.log');
const say = (log, m) => { try { log?.(m); } catch { /* ignore */ } };

/** { agentBrowser: path|null, browser: bool|null (null = cannot tell) } without installing anything. */
export function inspect() {
  let bin = null;
  try { bin = findBinary(); } catch { /* not installed */ }
  let browser = null;
  if (bin) {
    const r = spawnSync(bin, ['doctor', '--quick', '--offline', '--json'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    try { browser = JSON.parse(r.stdout).checks.find((c) => c.id === 'chrome.installed')?.status === 'pass'; } catch { /* older/newer CLI: unknown */ }
  }
  return { agentBrowser: bin, browser };
}

// A positive answer is remembered for 12 hours (per pinned binary), so ordinary opens do not pay for a `doctor` run each time.
// `hallpass setup` and `hallpass doctor` always look for real.
const okFile = () => path.join(stateDir(), 'runtime-ok.json');
const markOk = (bin) => { try { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(okFile(), JSON.stringify({ bin, at: Date.now() })); } catch { /* ignore */ } };
const markedOk = () => { try { const m = JSON.parse(fs.readFileSync(okFile(), 'utf8')); return Date.now() - m.at < 12 * 3600e3 && fs.existsSync(m.bin) && m.bin; } catch { return false; } };
export const ready = () => {
  if (markedOk()) return true;
  const s = inspect();
  const ok = !!s.agentBrowser && s.browser !== false;
  if (ok) markOk(s.agentBrowser);
  return ok;
};

function run(cmd, args, log) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15 * 60_000, shell: win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  say(log, (r.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | '));
  if (r.error || r.status !== 0) {
    const lines = (r.stderr || r.error?.message || '').split(/\r?\n/).map((l) => l.replace(/^npm (error|ERR!)\s*/, '').trim()).filter((l) => l && !/complete log of this run|debug-0\.log/.test(l));
    throw new Error(`${cmd} ${args[0]} failed: ${(lines.slice(0, 3).join(' / ') || 'exit ' + r.status).slice(0, 300)}`);
  }
}

/** Installs whatever is missing. Throws with a human-readable reason; never prints a secret (there are none here). */
export function setup({ log } = {}) {
  let bin = null;
  try { bin = findBinary(); } catch { /* install below */ }
  const did = [];
  const rt = bin ? inspect() : { browser: false };
  const needChrome = rt.browser !== true; // "cannot tell" runs the (idempotent) installer too
  if ((!bin || rt.browser === false) && autoInstallOff()) throw new Error('something is missing and automatic install is disabled (HALLPASS_NO_AUTO_INSTALL=1). Run: npm i -g agent-browser && agent-browser install');
  if (!bin) {
    say(log, `installing agent-browser ${TESTED_AGENT_BROWSER}.x into ${runtimeDir()} ...`);
    fs.mkdirSync(runtimeDir(), { recursive: true });
    run('npm', ['install', '--prefix', runtimeDir(), '--no-audit', '--no-fund', '--loglevel=error', `agent-browser@~${TESTED_AGENT_BROWSER}.2`], log);
    bin = findBinary({ repin: true });
    did.push('agent-browser');
  }
  if (needChrome) {
    say(log, 'downloading Chrome (one time, about 150 MB) ...');
    // Deliberately NOT --with-deps: that runs apt/dnf as root and changes the system. If Chrome later fails to start with a
    // "shared library" error on a bare Linux box, the person runs `agent-browser install --with-deps` themselves.
    run(bin, ['install'], log);
    did.push('chrome');
  }
  markOk(bin);
  return { status: 'ready', installed: did, agent_browser: bin };
}

const alivePid = (pid) => { try { process.kill(pid, 0); return pid !== process.pid; } catch { return false; } };
export function settingUp() {
  try { return alivePid(Number(fs.readFileSync(lockFile(), 'utf8'))); } catch { return false; }
}

/** Fire and forget: used by the MCP server so the first tool call is not stuck behind a download. */
export function startBackgroundSetup() {
  if (autoInstallOff() || settingUp() || ready()) return false;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const out = fs.openSync(logFile(), 'a');
    const p = spawn(process.execPath, [BIN, 'setup', '--background'], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: process.env });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

/** For the setup command itself: hold the lock so concurrent runs and the MCP gate can see it. */
export function withLock(fn) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(lockFile(), String(process.pid));
  try { return fn(); } finally { try { fs.rmSync(lockFile()); } catch { /* ignore */ } }
}

/**
 * Called at the top of open/login. Returns null when ready, otherwise a failed-result object.
 * Terminal use installs synchronously (progress on stderr); the MCP server answers "setting_up" and retries later.
 */
export function ensureReady() {
  if (ready()) return null;
  if (autoInstallOff()) return { status: 'failed', reason: 'not_installed', detail: 'agent-browser or Chrome is missing and automatic install is disabled. Run: hallpass setup (or npm i -g agent-browser && agent-browser install)' };
  if (process.env.HALLPASS_ACTOR === 'mcp') {
    startBackgroundSetup();
    return { status: 'failed', reason: 'setting_up', detail: 'First-run setup is installing the browser components (agent-browser and Chrome, one time, a minute or two). Tell the user, wait about a minute, then call hallpass_open again.' };
  }
  if (settingUp()) return { status: 'failed', reason: 'setting_up', detail: 'Another hallpass process is installing the browser components. Retry in a minute.' };
  try { withLock(() => setup({ log: (m) => m && process.stderr.write(`hallpass setup: ${m}\n`) })); return null; }
  catch (e) { return { status: 'failed', reason: 'not_installed', detail: `Automatic install failed: ${e.message}. Install by hand: npm i -g agent-browser && agent-browser install` }; }
}
