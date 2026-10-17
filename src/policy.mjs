// Per-credential policy, enforced BEFORE any secret is decrypted:
//   requireApproval  a native dialog the agent cannot click ("Allow once / for 1 hour / Deny"); no GUI = deny
//   expiresAt        credential stops working after this time
//   maxUses          credential stops working after N sign-in attempts
// The policy fields live in the entry's authenticated metadata, so editing them on disk breaks the entry.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as vault from './vault.mjs';
import { masterKey } from './keystore.mjs';
import { ask } from './ui.mjs';
import { audit } from './audit.mjs';
import { stateDir } from './paths.mjs';
import { safeUrl } from './origin.mjs';

const GRANT_MS = 60 * 60 * 1000;
const grantFile = (name) => path.join(stateDir(), name + '.grant');
const usesFile = (name) => path.join(stateDir(), name + '.uses');

// Grants are HMAC-signed with a key derived from the vault master key: writing a grant file by hand does nothing.
const mac = (name, exp) => crypto.createHmac('sha256', crypto.createHash('sha256').update('hallpass-grant-v1').update(masterKey({ create: false }) || Buffer.alloc(0)).digest()).update(`${name}|${exp}`).digest('hex');

export function grantValid(name, now = Date.now()) {
  try {
    const g = JSON.parse(fs.readFileSync(grantFile(name), 'utf8'));
    return g.name === name && g.exp > now && crypto.timingSafeEqual(Buffer.from(g.mac, 'hex'), Buffer.from(mac(name, g.exp), 'hex'));
  } catch { return false; }
}
export function writeGrant(name, now = Date.now()) {
  const exp = now + GRANT_MS;
  fs.writeFileSync(grantFile(name), JSON.stringify({ name, exp, mac: mac(name, exp) }), { mode: 0o600 });
}
export const revokeGrant = (name) => { try { fs.rmSync(grantFile(name)); } catch { /* none */ } };

const usesOf = (name) => { try { return JSON.parse(fs.readFileSync(usesFile(name), 'utf8')).n || 0; } catch { return 0; } };
const bumpUses = (name) => fs.writeFileSync(usesFile(name), JSON.stringify({ n: usesOf(name) + 1 }));
export const resetUses = (name) => { try { fs.rmSync(usesFile(name)); } catch { /* none */ } };

const denied = (name, reason, detail) => ({ status: 'failed', name, reason, detail });
const oneLine = (s, n = 160) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n);

/** Cheap, metadata-only: is this credential still within its validity window? Needs no decryption, dialog or use. */
export function checkEligibility(name, { now = Date.now() } = {}) {
  const m = vault.meta(name);
  if (m.expiresAt && now > Date.parse(m.expiresAt)) {
    audit('policy', { name, decision: 'expired' });
    return denied(name, 'credential_expired', `The credential "${name}" expired on ${m.expiresAt.slice(0, 10)}. The user can renew it with: hallpass add ${name} --force`);
  }
  return null;
}

/**
 * Called at the moment a credential is about to be TYPED (not when a login is merely attempted), so a still-valid saved
 * session consumes no use, shows no dialog and touches no password manager.
 * Returns null when allowed, or a failed-result object. `approver` is injectable for tests only (never reachable from CLI/MCP).
 */
export function authorizeUse(name, { target, approver = ask, now = Date.now() } = {}) {
  const m = vault.meta(name);
  if (m.maxUses && usesOf(name) >= m.maxUses) {
    audit('policy', { name, decision: 'exhausted' });
    return denied(name, 'credential_exhausted', `The credential "${name}" has reached its limit of ${m.maxUses} sign-ins. The user can reset it with: hallpass add ${name} --force`);
  }
  if (m.requireApproval && !grantValid(name, now)) {
    const actor = process.env.HALLPASS_ACTOR || 'a command-line agent';
    const choice = approver({
      title: 'Hallpass: approve sign-in',
      message: `An AI agent (${actor}) wants to sign in using your stored login "${name}".\n\n` +
        `The password will only ever be typed into: ${(m.allowed || []).join(', ')}\n` +
        (target ? `Page it asked for: ${oneLine(safeUrl(target))}\n` : '') +
        `\nThe agent never sees the password. Approve only if you started this task.`,
      buttons: [{ id: 'deny', label: 'Deny' }, { id: 'hour', label: 'Allow for 1 hour' }, { id: 'once', label: 'Allow once' }],
      timeoutSec: process.env.HALLPASS_ACTOR === 'mcp' ? 45 : 120, // MCP clients often time out tool calls near 60s
    });
    audit('approval', { name, decision: choice || 'deny', target: target && safeUrl(target) });
    if (choice === 'hour') writeGrant(name, now);
    if (choice !== 'hour' && choice !== 'once') {
      return denied(name, 'approval_denied', 'The user did not approve this sign-in (denied, timed out, or no desktop dialog was available). Ask the user to approve it, or have them log in themselves with --headed.');
    }
  }
  bumpUses(name);
  return null;
}

/** Eligibility + authorisation in one call (used by tests and simple callers). */
export function checkPolicy(name, o = {}) {
  return checkEligibility(name, o) || authorizeUse(name, o);
}

/** "30d" | "12h" | "2w" | ISO date -> ISO timestamp, or null if unparseable. */
export function parseExpiry(s, now = Date.now()) {
  const m = /^(\d+)([hdw])$/.exec(String(s).trim());
  if (m) return new Date(now + Number(m[1]) * { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]]).toISOString();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
