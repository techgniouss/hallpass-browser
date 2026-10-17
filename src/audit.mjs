// Append-only, hash-chained audit log of everything an agent did with your logins. Never contains secrets:
// callers pass only names, origin+path, verbs and outcomes. Best-effort: logging can never break a login.
// Tamper-EVIDENT, not tamper-proof: a same-user process can still delete the file, but cannot edit history unnoticed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { home } from './paths.mjs';

const file = () => path.join(home(), 'audit.log');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const GENESIS = '0'.repeat(64);
const trim = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200) : v);

function lastHash(f) {
  try {
    const fd = fs.openSync(f, 'r');
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').trimEnd().split('\n');
    return JSON.parse(lines[lines.length - 1]).hash || GENESIS;
  } catch { return GENESIS; }
}

export function audit(event, fields = {}) {
  try {
    const f = file();
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, trim(v)]));
    const rec = { ts: new Date().toISOString(), actor: process.env.HALLPASS_ACTOR || 'cli', event, ...clean, prev: lastHash(f) };
    fs.appendFileSync(f, JSON.stringify({ ...rec, hash: sha(JSON.stringify(rec)) }) + '\n', { mode: 0o600 });
  } catch { /* never break the caller */ }
}

export function readLog({ tail = 50 } = {}) {
  const f = file();
  if (!fs.existsSync(f)) return [];
  const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { event: 'corrupt-line' }; } });
  return rows.slice(-tail);
}

export function verifyLog() {
  const f = file();
  if (!fs.existsSync(f)) return { ok: true, entries: 0 };
  let prev = GENESIS, n = 0;
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    n++;
    let r;
    try { r = JSON.parse(line); } catch { return { ok: false, entries: n, broken_at: n, reason: 'unparseable line' }; }
    const { hash, ...rec } = r;
    if (rec.prev !== prev) return { ok: false, entries: n, broken_at: n, reason: 'chain broken (entry removed or reordered)' };
    if (sha(JSON.stringify(rec)) !== hash) return { ok: false, entries: n, broken_at: n, reason: 'entry modified' };
    prev = hash;
  }
  return { ok: true, entries: n };
}
