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
const grantFile = (name) => path.join(stateDir(), name + '.grant');
const key = () => masterKey({ create: false });

// Credential grants predate site grants and keep signing with an empty key when there is none (unchanged behaviour).
const mac = (name, exp) => crypto.createHmac('sha256', crypto.createHash('sha256').update('hallpass-grant-v1').update(key() || Buffer.alloc(0)).digest()).update(`${name}|${exp}`).digest('hex');

export function grantValid(name, now = Date.now()) {
  try {
    const g = JSON.parse(fs.readFileSync(grantFile(name), 'utf8'));
    return g.name === name && g.exp > now && crypto.timingSafeEqual(Buffer.from(g.mac, 'hex'), Buffer.from(mac(name, g.exp), 'hex'));
  } catch { return false; }
}
export function writeGrant(name, now = Date.now()) {
  const exp = now + GRANT_MS;
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(grantFile(name), JSON.stringify({ name, exp, mac: mac(name, exp) }), { mode: 0o600 });
}
export const revokeGrant = (name) => { try { fs.rmSync(grantFile(name)); } catch { /* none */ } };

// ---- site grants (click gate + uploads): one kind, one hallpass session, one origin ----
const memory = new Map(); // fallback when grants cannot be signed
const siteName = (kind, scope) => `site-${kind}-` + crypto.createHash('sha256').update(scope).digest('hex').slice(0, 32);

export function siteGrantValid(kind, scope, now = Date.now()) {
  if (!scope) return false;
  const name = siteName(kind, scope);
  if ((memory.get(name) || 0) > now) return true;
  return !!key() && grantValid(name, now);
}
export function writeSiteGrant(kind, scope, now = Date.now()) {
  if (!scope) return;
  const name = siteName(kind, scope);
  if (key()) { try { writeGrant(name, now); return; } catch { /* fall through to memory */ } }
  memory.set(name, now + GRANT_MS);
}
export function revokeSiteGrant(kind, scope) {
  if (!scope) return;
  const name = siteName(kind, scope);
  memory.delete(name); revokeGrant(name);
}
