// Access levels: how many confirmation dialogs the PERSON wants. One setting, changed only by a person in a real terminal.
//
//   ask       (default) every confirmation applies: risky clicks, file uploads, sign-ins with a stored login that asks.
//   trusted   no click/upload dialogs on the sites the person listed; everything else still asks.
//   full      no click/upload dialogs anywhere.
//
// Stored logins that were saved with --require-approval keep asking unless the person also chose --include-credentials:
// that was a decision about one specific login, so a blanket level does not silently undo it.
//
// What no level ever turns off (these are integrity checks, not approvals): secrets cannot be read back and are redacted,
// a login is typed only on its pinned origin, eval/cookies/network/file:// stay unavailable, uploads still refuse keys, config
// folders and unknown file types, add/remove/export/import still need a terminal, a rejected password still locks the login,
// CAPTCHAs still go to the person, expiry and use limits still apply, HALLPASS_READONLY and HALLPASS_UPLOAD=off still restrict.
//
// The setting is stored signed (HMAC under a key derived from the vault master key), so a hand-edited file is ignored, and an
// expired or unreadable one means "ask". Every bypassed approval is written to the audit log.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { home } from './paths.mjs';
import { masterKey } from './keystore.mjs';
import { isAllowed, normalizeAllowed } from './origin.mjs';
import { audit } from './audit.mjs';

export const LEVELS = ['ask', 'trusted', 'full'];
export const DEFAULT_FULL_TTL = '4h'; // `full` always expires unless the person says --forever
export const NEVER_BYPASSED = [
  'secrets are never readable and are redacted from every output',
  'a stored login is typed only on the origins approved when it was added',
  'eval, cookies, storage, network and file:// stay unavailable to the agent',
  'uploads still refuse private keys, config folders, protected locations and unknown file types',
  'adding, removing, exporting and importing logins still need a person at a terminal',
  'a rejected password still locks that login; expiry and use limits still apply',
  'CAPTCHAs and MFA are still handed to the person',
  'HALLPASS_READONLY=1 and HALLPASS_UPLOAD=off still restrict the agent',
];

const file = () => path.join(home(), 'access.json');
const macKey = () => {
  const mk = masterKey({ create: false });
  return mk ? crypto.createHash('sha256').update('hallpass-access-v1').update(mk).digest() : null;
};
const body = (d) => JSON.stringify([d.level, [...d.sites].sort(), d.expiresAt || null, !!d.includeCredentials, d.setAt]);
const sign = (d) => { const k = macKey(); return k ? crypto.createHmac('sha256', k).update(body(d)).digest('hex') : null; };

/** "4h" | "30d" | "2w" -> milliseconds, or null. */
export function parseDuration(s) {
  const m = /^(\d+)([mhdw])$/.exec(String(s ?? '').trim());
  if (!m || Number(m[1]) <= 0) return null;
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]];
}

/** Turn what a person typed ("play.google.com", "https://*.supabase.com") into an approved-origin entry, or null. */
export function normalizeSite(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  return normalizeAllowed(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : (/^(\*\.)?(localhost|127\.|\[::1\])/i.test(t) ? 'http://' : 'https://') + t);
}

const ASK = (why) => ({ level: 'ask', sites: [], expiresAt: null, includeCredentials: false, source: why });

/** The level in force right now. Anything wrong with the stored setting (missing, edited, expired, other user) means "ask". */
export function getAccess({ now = Date.now() } = {}) {
  let d;
  try { d = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return ASK('default'); }
  if (!d || d.v !== 1 || !LEVELS.includes(d.level) || !Array.isArray(d.sites)) return ASK('invalid');
  if (d.level === 'ask') return ASK('default');
  const want = sign(d);
  let ok = false;
  try { ok = !!want && typeof d.mac === 'string' && crypto.timingSafeEqual(Buffer.from(d.mac, 'hex'), Buffer.from(want, 'hex')); } catch { ok = false; }
  if (!ok) return ASK('tampered');
  if (d.expiresAt && now >= Date.parse(d.expiresAt)) return ASK('expired');
  return { level: d.level, sites: d.sites, expiresAt: d.expiresAt || null, includeCredentials: !!d.includeCredentials, setAt: d.setAt, source: 'file' };
}

/**
 * One line for dialogs and agent messages when the person DID set trusted/full but it is not in force (expired, or its signature
 * cannot be checked, e.g. this process cannot reach the vault key). Empty when nothing was set or it is working. Without it the
 * person just sees prompts return and cannot tell why.
 */
export function ignoredAccessNote({ now = Date.now() } = {}) {
  let d;
  try { d = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return ''; }
  if (!d || d.v !== 1 || !['trusted', 'full'].includes(d.level)) return '';
  const g = getAccess({ now });
  if (g.level !== 'ask') return '';
  if (g.source === 'expired') return `Note: your "hallpass access ${d.level}" setting expired, so confirmations are back. Re-run it in your terminal to renew.`;
  if (g.source === 'tampered') return `Note: your "hallpass access ${d.level}" setting is being ignored because its signature cannot be verified here (edited, made by another user, or the vault key is unreachable from this process). Re-run it in your terminal.`;
  return '';
}

/** Person-only (the CLI enforces a terminal). Throws on bad input. */
export function setAccess({ level, sites = [], ttlMs = null, includeCredentials = false, now = Date.now() }) {
  if (!LEVELS.includes(level)) throw new Error(`level must be one of: ${LEVELS.join(', ')}`);
  if (level === 'ask') return clearAccess();
  if (level === 'trusted' && !sites.length) throw new Error('trusted needs at least one site, e.g. hallpass access trusted play.google.com');
  if (level === 'full' && sites.length) throw new Error('full applies to every site; use "trusted" to limit it to some');
  const norm = [...new Set(sites.map((s) => normalizeSite(s)))];
  if (norm.some((s) => !s)) throw new Error('every site must be a hostname or https origin, e.g. play.google.com or https://*.supabase.com');
  const d = { v: 1, level, sites: norm, expiresAt: ttlMs ? new Date(now + ttlMs).toISOString() : null, includeCredentials: !!includeCredentials, setAt: new Date(now).toISOString() };
  masterKey(); // make sure a key exists so the setting can be signed
  d.mac = sign(d);
  if (!d.mac) throw new Error('the vault master key is unavailable, so the setting cannot be signed');
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
  audit('access', { level, sites: norm.join(' '), expires: d.expiresAt || 'never', credentials: d.includeCredentials ? 'included' : 'still ask' });
  return getAccess({ now });
}

export function clearAccess() {
  const had = getAccess().level !== 'ask';
  try { fs.rmSync(file()); } catch { /* none */ }
  if (had) audit('access', { level: 'ask' });
  return getAccess();
}

/**
 * Does the current level waive this confirmation?
 *   kind  'gate' (risky click) | 'upload'   (stored-login approvals have their own check: bypassesSignin)
 *   url   the page the action happens on; unknown means "not trusted"
 *   access  injectable for tests
 */
export function bypasses(kind, { url, access = getAccess() } = {}) {
  if (access.level === 'ask') return false;
  if (kind !== 'gate' && kind !== 'upload') return false;
  if (access.level === 'full') return true;
  return !!url && siteMatches(url, access.sites); // trusted: only on the listed sites
}

/**
 * May this stored login's own approval dialog be skipped? Needs --include-credentials. Under "trusted", EVERY origin the login is
 * allowed to be typed on (its login page and each approved origin, SSO hops included) must be a listed site: the URL an agent asked
 * to open proves nothing, since a trusted site can redirect to anywhere.
 */
export function bypassesSignin(meta, { access = getAccess() } = {}) {
  if (access.level === 'ask' || !access.includeCredentials) return false;
  if (access.level === 'full') return true;
  const origins = [...new Set([meta?.url, ...(Array.isArray(meta?.allowed) ? meta.allowed : [])].filter(Boolean))];
  if (!origins.length) return false;
  return origins.every((o) => (o.includes('*.') ? access.sites.includes(o) : siteMatches(o, access.sites)));
}

// A site entry is an origin ("https://play.google.com"), a wildcard ("https://*.supabase.com"), or a local dev host given without a port
// ("http://localhost"), which then covers every port: dev servers move around.
function siteMatches(url, sites) {
  if (isAllowed(url, sites)) return true;
  let u;
  try { u = new URL(url); } catch { return false; }
  const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname.endsWith('.localhost'));
  return local && sites.some((s) => { try { const t = new URL(s); return t.protocol === 'http:' && t.hostname === u.hostname && t.port === ''; } catch { return false; } });
}

/** Record that a dialog was waived, so the audit log shows exactly what ran without asking. */
export function auditBypass(kind, fields = {}) {
  audit(kind === 'gate' ? 'gate' : kind === 'upload' ? 'upload' : 'approval', { ...fields, decision: 'allowed-by-access', level: getAccess().level });
}

/** Plain-language summary for `hallpass access`, doctor and agents. Never contains a secret. */
export function describeAccess(a = getAccess()) {
  const left = a.expiresAt ? Math.max(0, Date.parse(a.expiresAt) - Date.now()) : null;
  const fmt = (ms) => (ms >= 86400e3 ? `${Math.round(ms / 86400e3)}d` : ms >= 3600e3 ? `${Math.round(ms / 3600e3)}h` : `${Math.max(1, Math.round(ms / 60e3))}m`);
  const on = a.level !== 'ask';
  const scope = a.level === 'full' ? 'every site' : a.sites.join(', ');
  return {
    level: a.level,
    ...(on ? { sites: a.level === 'full' ? 'all' : a.sites, expires_at: a.expiresAt, expires_in: left === null ? 'never' : fmt(left), include_credentials: a.includeCredentials } : {}),
    effect: {
      risky_clicks: on ? `no confirmation dialog on ${scope}` : 'confirmed by the person in a dialog',
      file_uploads: on ? `no confirmation dialog on ${scope} (files are still vetted)` : 'confirmed by the person in a dialog',
      stored_login_approval: on && a.includeCredentials ? `skipped on ${scope}` : 'logins saved with --require-approval still ask',
    },
    never_bypassed: NEVER_BYPASSED,
    ...(a.source === 'tampered' ? { note: 'An access setting was found but its signature does not match (edited, or made by another user). It is ignored.' } : {}),
    ...(a.source === 'expired' ? { note: 'The access level you set has expired; back to asking.' } : {}),
  };
}
