// "Allow for 1 hour" grants, kept on disk so they survive between processes. `hallpass do` is a fresh process per command, so a
// grant held only in memory would be forgotten on the very next click and the person would be asked again for every action.
// Every grant is HMAC-signed with a key derived from the vault master key: writing a grant file by hand does nothing.
// With no master key (nothing in the vault yet) a grant cannot be signed, so site grants then live in this process only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { masterKey } from './keystore.mjs';
import { stateDir } from './paths.mjs';

export const GRANT_MS = 60 * 60 * 1000;
const key = () => masterKey({ create: false });

// Two grant families share the signing key but are domain-separated (different MAC label and different file extension), so a
// grant of one family can never satisfy a check of the other, whatever a stored login happens to be called.
const fileFor = (domain, name) => path.join(stateDir(), name + (domain === 'site' ? '.sgrant' : '.grant'));
// Credential grants predate site grants and keep signing with an empty key when there is none (unchanged behaviour).
const mac = (domain, name, exp) => crypto.createHmac('sha256', crypto.createHash('sha256').update(domain === 'site' ? 'hallpass-site-grant-v1' : 'hallpass-grant-v1').update(key() || Buffer.alloc(0)).digest()).update(`${name}|${exp}`).digest('hex');

function valid(domain, name, now) {
  try {
    const g = JSON.parse(fs.readFileSync(fileFor(domain, name), 'utf8'));
    return g.name === name && g.exp > now && crypto.timingSafeEqual(Buffer.from(g.mac, 'hex'), Buffer.from(mac(domain, name, g.exp), 'hex'));
  } catch { return false; }
}
function write(domain, name, now) {
  const exp = now + GRANT_MS;
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(fileFor(domain, name), JSON.stringify({ name, exp, mac: mac(domain, name, exp) }), { mode: 0o600 });
}
const revoke = (domain, name) => { try { fs.rmSync(fileFor(domain, name)); } catch { /* none */ } };

// ---- stored-login approval grants ----
export const grantValid = (name, now = Date.now()) => valid('cred', name, now);
export const writeGrant = (name, now = Date.now()) => write('cred', name, now);
export const revokeGrant = (name) => revoke('cred', name);

// ---- site grants (click gate + uploads): one kind, one hallpass session, one origin ----
const memory = new Map(); // fallback when grants cannot be signed
const siteName = (kind, scope) => `${kind}-` + crypto.createHash('sha256').update(scope).digest('hex').slice(0, 32);

export function siteGrantValid(kind, scope, now = Date.now()) {
  if (!scope) return false;
  const name = siteName(kind, scope);
  if ((memory.get(name) || 0) > now) return true;
  return !!key() && valid('site', name, now);
}
export function writeSiteGrant(kind, scope, now = Date.now()) {
  if (!scope) return;
  const name = siteName(kind, scope);
  if (key()) { try { write('site', name, now); return; } catch { /* fall through to memory */ } }
  memory.set(name, now + GRANT_MS);
}
export function revokeSiteGrant(kind, scope) {
  if (!scope) return;
  const name = siteName(kind, scope);
  memory.delete(name); revoke('site', name);
}
