import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { entriesDir } from './paths.mjs';
import { masterKey } from './keystore.mjs';
import { parseOrigin, isAllowed } from './origin.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const validName = (n) => typeof n === 'string' && NAME_RE.test(n);

const file = (name) => {
  if (!validName(name)) throw new Error('invalid name: use lowercase letters, digits, . _ - (max 63)');
  return path.join(entriesDir(), name + '.json');
};

// Metadata is public (the agent may read it). It is bound to the ciphertext as AAD, so editing
// allowed origins or selectors on disk makes the entry fail to open instead of silently widening trust.
const aad = (name, meta) => Buffer.from(JSON.stringify({ name, meta }));

export function put(name, meta, secrets) {
  // "site-<host>" is the key of the saved-session profile for credential-less sites; a credential with that name would collide with it
  if (typeof name === 'string' && name.startsWith('site-')) throw new Error('names starting with "site-" are reserved');
  // If the master key is gone (new Windows profile, wiped keychain) but entries exist, minting a fresh key would
  // silently make every existing entry undecryptable. Refuse and say what happened instead.
  if (!masterKey({ create: false }) && fs.readdirSync(entriesDir()).some((f) => f.endsWith('.json'))) {
    throw new Error('the vault master key for this OS user is missing but entries exist; they cannot be opened. Remove them (hallpass remove <name>) and re-add, or restore the key.');
  }
  const key = masterKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(name, meta));
  const ct = Buffer.concat([c.update(JSON.stringify(secrets), 'utf8'), c.final()]);
  const doc = { v: 1, name, meta, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  const f = file(name);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

function read(name) {
  const f = file(name);
  if (!fs.existsSync(f)) throw new Error(`no credential named "${name}" (try: hallpass list)`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export const exists = (name) => fs.existsSync(file(name));
export const meta = (name) => read(name).meta;

export function list() {
  return fs.readdirSync(entriesDir()).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try { const d = JSON.parse(fs.readFileSync(path.join(entriesDir(), f), 'utf8')); return { name: d.name, ...d.meta }; }
    catch { return { name: f.replace(/\.json$/, ''), error: 'unreadable' }; }
  });
}

// Which stored credential applies to this URL? Matches the entry's own login origin, or a wildcard it approved
// (never a bare IdP origin like accounts.google.com, so one Google entry does not claim every Google-SSO site).
export function findByUrl(url) {
  const origin = parseOrigin(url);
  if (!origin) return [];
  return list()
    .filter((e) => !e.error && (parseOrigin(e.url) === origin || isAllowed(url, (e.allowed || []).filter((a) => a.includes('*.')))))
    .map((e) => e.name);
}

export function remove(name) {
  const f = file(name);
  if (!fs.existsSync(f)) throw new Error(`no credential named "${name}"`);
  fs.rmSync(f);
}

// The only decrypt path. Not exposed by any CLI command; login.mjs is its sole caller.
export function unseal(name) {
  const d = read(name);
  const key = masterKey({ create: false });
  if (!key) throw new Error('vault master key is missing for this OS user - entries cannot be opened');
  const x = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(d.iv, 'base64'));
  x.setAAD(aad(d.name, d.meta));
  x.setAuthTag(Buffer.from(d.tag, 'base64'));
  try {
    return JSON.parse(Buffer.concat([x.update(Buffer.from(d.ct, 'base64')), x.final()]).toString('utf8'));
  } catch {
    throw new Error(`entry "${name}" failed integrity check (tampered, or sealed by a different user/machine)`);
  }
}
