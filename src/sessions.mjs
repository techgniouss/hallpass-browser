// Visibility and cleanup for saved browser sessions (profiles). Credentials are never touched here.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Browser } from './ab.mjs';
import { Redactor } from './redact.mjs';
import { profilesDir, stateDir } from './paths.mjs';
import { audit } from './audit.mjs';

function dirSize(d, cap = 5e9) {
  let total = 0;
  const stack = [d];
  while (stack.length && total < cap) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* vanished */ } }
    }
  }
  return total;
}

function lastUsed(name) {
  const times = [];
  for (const p of [path.join(stateDir(), name + '.json'), path.join(profilesDir(), name)]) { try { times.push(fs.statSync(p).mtimeMs); } catch { /* none */ } }
  return times.length ? Math.max(...times) : 0;
}

function runningSessions() {
  const b = new Browser({ session: 'hp-probe', profile: path.join(os.tmpdir(), 'hp-probe'), redactor: new Redactor() });
  const r = b.run(['session', 'list'], { timeout: 15_000, bare: true });
  return new Set(Array.isArray(r.json?.data?.sessions) ? r.json.data.sessions : []);
}

export function listSessions() {
  const running = runningSessions();
  return fs.readdirSync(profilesDir(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const t = lastUsed(e.name);
    return {
      name: e.name, kind: e.name.startsWith('site-') ? 'saved-login-site' : 'credential-profile', running: running.has('hp-' + e.name),
      last_used: t ? new Date(t).toISOString() : null, age_days: t ? Math.floor((Date.now() - t) / 86400e3) : null,
      size_mb: Math.round(dirSize(path.join(profilesDir(), e.name)) / 1e5) / 10,
    };
  }).sort((a, b) => (b.last_used || '').localeCompare(a.last_used || ''));
}

/** Delete saved browser sessions not used for `olderThan` (e.g. "30d"). Forces a fresh login next time; never touches credentials. */
export function pruneSessions({ olderThan = '30d', dryRun = false } = {}) {
  const m = /^(\d+)([hdw])$/.exec(String(olderThan).trim());
  if (!m || Number(m[1]) <= 0) throw new Error('--older-than must look like 12h, 30d or 2w');
  const ms = Number(m[1]) * { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]];
  const removed = [], kept = [];
  for (const s of listSessions()) {
    const idle = s.last_used ? Date.now() - Date.parse(s.last_used) : Infinity;
    if (idle > ms && !s.running) {
      removed.push(s.name);
      if (!dryRun) { fs.rmSync(path.join(profilesDir(), s.name), { recursive: true, force: true }); try { fs.rmSync(path.join(stateDir(), s.name + '.json')); } catch { /* none */ } }
    } else kept.push(s.name);
  }
  if (!dryRun) audit('prune', { removed: removed.length });
  return { dry_run: dryRun, removed, kept };
}
