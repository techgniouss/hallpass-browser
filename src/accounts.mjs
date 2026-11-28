// Several logins for one website: Play Console with two Google accounts, GitHub personal + work, ...
//
// An "account" is one of:
//   credential  a stored vault entry (hands-free login). Selected by its vault name.
//   profile     a saved browser login the PERSON made in a visible window (no secret stored). Selected by a short label.
//                 site-<host>            the unlabelled one ("default")
//                 site-<host>__<label>   a labelled one ("work", "personal", ...)
// Everything here is metadata only: nothing in this module can read a secret.
import fs from 'node:fs';
import path from 'node:path';
import * as vault from './vault.mjs';
import { parseOrigin } from './origin.mjs';
import { profilesDir, stateDir } from './paths.mjs';

export const DEFAULT_ACCOUNT = 'default';
export const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A label is what the person calls a saved login on one site ("work"). `default` is the unlabelled login. */
export const validLabel = (l) => typeof l === 'string' && LABEL_RE.test(l);

const MAX_KEY = 63;

// A LANE is an extra, parallel browser for the same login: same credential or saved login, its own session and its own profile
// folder, so two tasks can drive the same account at once without fighting over one Chrome profile.
//   <key>_l_<id>   e.g. play-console_l_app2, site-play.google.com__work_l_2
// "_" cannot occur in a host or a label, and a lane id has no "_", so the last "_l_" always splits base from id.
export const LANE_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
export const validLane = (l) => typeof l === 'string' && LANE_RE.test(l);
export const laneKey = (key, lane) => {
  if (!validLane(lane)) throw new Error('lane must be lowercase letters, digits and - (max 16)');
  const k = `${key}_l_${lane}`;
  if (k.length > MAX_KEY) throw new Error(`lane name too long: "${k}" would be over ${MAX_KEY} characters; use a shorter lane id`);
  return k;
};
/** "play-console_l_app2" -> { base: "play-console", lane: "app2" }; not a lane key -> null. */
export function splitLane(key) {
  const m = typeof key === 'string' ? /^(.+)_l_([a-z0-9][a-z0-9-]{0,15})$/.exec(key) : null;
  return m ? { base: m[1], lane: m[2] } : null;
}
const hostPart = (url) => ('site-' + new URL(url).hostname).replace(/[^a-z0-9.-]/gi, '-').toLowerCase();

/** Profile/session key for a site with no vault entry. `label` (or none / "default") picks which saved login on that site. */
export function siteKey(url, label) {
  const h = hostPart(url);
  if (!label || label === DEFAULT_ACCOUNT) return h.slice(0, MAX_KEY);
  if (!validLabel(label)) throw new Error('account label must be lowercase letters, digits and - (max 32)');
  return h.slice(0, MAX_KEY - 2 - label.length) + '__' + label;
}

/** "site-play.google.com__work" -> { hostKey: "site-play.google.com", label: "work" }; not a site key -> null. */
export function parseSiteKey(key) {
  if (typeof key !== 'string' || !key.startsWith('site-')) return null;
  const i = key.indexOf('__'); // a hostname can never contain "_", so the first "__" always separates the label
  return i < 0 ? { hostKey: key, label: null } : { hostKey: key.slice(0, i), label: key.slice(i + 2) };
}

/** Does this saved-login key belong to this site? (host keys are cut to fit 63 characters, so long hosts compare by prefix) */
export function keyIsForUrl(key, url) {
  const p = parseSiteKey(key);
  if (!p) return false;
  let full;
  try { full = hostPart(url); } catch { return false; }
  const cap = MAX_KEY - (p.label ? 2 + p.label.length : 0);
  return p.hostKey === full || (p.hostKey.length === cap && full.length > cap && full.startsWith(p.hostKey));
}

/** Free text a person typed (a nickname): printable, one line, short. It is shown to agents, so it is treated as untrusted. */
const NOT_PRINTABLE = new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']+', 'g');
export const cleanLabel = (s, n = 40) => String(s ?? '').replace(NOT_PRINTABLE, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const LOCKING = new Set(['bad_credentials', 'bad_totp']);
function lockedState(name) {
  try { const s = JSON.parse(fs.readFileSync(path.join(stateDir(), name + '.json'), 'utf8')); return s.phase === 'failed' && LOCKING.has(s.reason); } catch { return false; }
}

function profileInfo(name) {
  let t = 0;
  for (const p of [path.join(stateDir(), name + '.json'), path.join(profilesDir(), name)]) { try { t = Math.max(t, fs.statSync(p).mtimeMs); } catch { /* none */ } }
  return { last_used: t ? new Date(t).toISOString() : null, age_days: t ? Math.floor((Date.now() - t) / 86400e3) : null };
}

const credentialAccount = (e) => ({
  as: e.name, kind: 'credential', name: e.name, session: 'hp-' + e.name,
  user: e.userHint || null, label: cleanLabel(e.label) || null, login_url: e.url,
  hands_free: true, totp: !!e.hasTotp, requires_approval: !!e.requireApproval,
  expires_at: e.expiresAt || null, expired: !!e.expiresAt && Date.parse(e.expiresAt) < Date.now(), locked: lockedState(e.name),
});

const profileAccount = (key) => {
  const p = parseSiteKey(key);
  return { as: p.label || DEFAULT_ACCOUNT, kind: 'profile', name: key, session: 'hp-' + key, label: p.label, hands_free: false, ...(p.label ? {} : { unnamed: true }), ...profileInfo(key) };
};

function savedProfiles(url) {
  let ents = [];
  try { ents = fs.readdirSync(profilesDir(), { withFileTypes: true }); } catch { /* none yet */ }
  return ents.filter((e) => e.isDirectory() && !splitLane(e.name) && keyIsForUrl(e.name, url)).map((e) => profileAccount(e.name))
    .sort((a, b) => (a.label === null) - (b.label === null) || a.as.localeCompare(b.as)); // default last, labels alphabetical
}

/**
 * Every login hallpass knows for the website of `url`.
 *   accounts   everything, for display
 *   choices    what a person must choose between. The unlabelled saved login is left out while a stored credential
 *              exists (that is how it has always behaved), but is still reachable with --as default.
 *   needs_choice  more than one choice: callers must ask the person, never guess.
 */
export function accountsFor(url) {
  const origin = parseOrigin(url);
  if (!origin) return { origin: null, accounts: [], choices: [], needs_choice: false };
  const names = new Set(vault.findByUrl(url));
  const creds = vault.list().filter((e) => !e.error && names.has(e.name)).map(credentialAccount);
  const profiles = savedProfiles(url);
  const accounts = [...creds, ...profiles];
  // a credential already called "default" before accounts existed keeps that name (the vault wins), so the unlabelled login cannot also be offered as "default"
  const defaultTaken = creds.some((c) => c.as === DEFAULT_ACCOUNT);
  const choices = creds.length ? [...creds, ...profiles.filter((p) => p.label)] : profiles.filter((p) => p.label || !defaultTaken);
  return { origin, accounts, choices, needs_choice: choices.length > 1 };
}

/** One line a person can pick from (used in questions and prompts). */
export function describeAccount(a) {
  const bits = [];
  if (a.kind === 'credential') {
    bits.push(a.user ? `stored login for ${a.user}` : 'stored login');
    if (a.label) bits.push(`"${a.label}"`);
    if (a.locked) bits.push('LOCKED after a rejected password');
    if (a.expired) bits.push('EXPIRED');
  } else {
    bits.push(a.label ? 'saved browser login' : 'earlier saved browser login that has no name yet');
    if (a.age_days !== null && a.age_days !== undefined) bits.push(a.age_days === 0 ? 'used today' : `used ${a.age_days}d ago`);
  }
  return `${a.as}: ${bits.join(', ')}`;
}

/** Everything hallpass has, grouped by site: for `hallpass accounts` with no URL. */
export function allAccounts() {
  const sites = new Map();
  const site = (host) => { if (!sites.has(host)) sites.set(host, { host, accounts: [] }); return sites.get(host).accounts; };
  for (const e of vault.list()) {
    if (e.error) continue;
    let host; try { host = new URL(e.url).hostname; } catch { host = '(unknown)'; }
    site(host).push(credentialAccount(e));
  }
  let ents = [];
  try { ents = fs.readdirSync(profilesDir(), { withFileTypes: true }); } catch { /* none yet */ }
  for (const e of ents) {
    const p = parseSiteKey(e.name);
    if (!e.isDirectory() || !p || splitLane(e.name)) continue; // lanes are scratch copies, not accounts
    site(p.hostKey.slice('site-'.length)).push(profileAccount(e.name));
  }
  return [...sites.values()].sort((a, b) => a.host.localeCompare(b.host));
}

/**
 * Which login does `hallpass open <url> [--as X]` mean?
 *   { entry }               a vault credential (log in hands-free)
 *   { key, label, isNew }   a saved browser login (the person logs in; the profile remembers)
 *   { error }               a failed result to return as is
 */
export function resolveAccount(url, as, { create = false } = {}) {
  const origin = parseOrigin(url);
  if (as !== undefined && as !== null && as !== '') {
    if (typeof as !== 'string') return { error: { status: 'failed', reason: 'bad_account_name', detail: '"as" must be a string' } };
    if (vault.validName(as) && vault.exists(as)) return { entry: as, account: as };
    if (as === DEFAULT_ACCOUNT) return { key: siteKey(url), label: DEFAULT_ACCOUNT, isNew: !fs.existsSync(path.join(profilesDir(), siteKey(url))) };
    if (!validLabel(as)) {
      return { error: { status: 'failed', reason: 'no_such_account', detail: `"${as}" is not a stored credential and is not a valid label for a saved login (lowercase letters, digits and - only, max 32). Run: hallpass accounts ${origin}` } };
    }
    const key = siteKey(url, as);
    const exists = fs.existsSync(path.join(profilesDir(), key));
    if (!exists && !create) {
      // A typo or an invented name must not silently start a new account (and pop up a login window): adding one is a deliberate act.
      const known = accountsFor(url).accounts.map((a) => a.as);
      return { error: { status: 'failed', reason: 'no_such_account', origin, candidates: known, detail: `There is no login called "${as}" for ${origin}${known.length ? ` (known: ${known.join(', ')})` : ''}. If the user wants to ADD a new account called "${as}", run the same open again with --new (MCP: new: true) and they sign in in the window; otherwise ask them which existing one to use.` } };
    }
    return { key, label: as, isNew: !exists };
  }
  const { choices } = accountsFor(url);
  if (choices.length > 1) {
    return {
      error: {
        status: 'failed', reason: 'ambiguous_account', origin,
        candidates: choices.map((c) => c.as),
        accounts: choices.map((c) => ({ as: c.as, kind: c.kind, user: c.user ?? null, label: c.label ?? null, description: describeAccount(c) })),
        detail: `${choices.length} logins are available for ${origin}. Ask the user which one to use (list them: ${choices.map((c) => c.as).join(', ')}), then run the same open again with --as <name> (MCP: "as"). To add a different, new account instead, pass a new short label as --as together with --new (MCP: new: true) and the user signs in in the window. Do not pick one yourself.${choices.some((c) => c.unnamed) ? ' The "default" login was saved before accounts had names: once the user says whose it is, offer to give it that name (hallpass name-login <url> <name>; MCP hallpass_name_login) so it is easy to pick later.' : ''}`,
      },
    };
  }
  const one = choices[0];
  if (!one)return { key: siteKey(url), label: DEFAULT_ACCOUNT, isNew: true };
  if (one.kind === 'credential') return { entry: one.name, account: one.name };
  return { key: one.name, label: one.label || DEFAULT_ACCOUNT, isNew: false };
}
