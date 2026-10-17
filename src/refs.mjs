// Password-manager references: store a POINTER, resolve the secret at login time through the manager's own CLI
// (which does its own unlock, e.g. biometrics). Supported:
//   op://Vault/Item/field            1Password CLI   (`op read`)       TOTP: op://Vault/Item/one-time password?attribute=otp
//   bw:<item-id>                     Bitwarden CLI   (`bw get password|username|totp <id>`; needs an unlocked BW_SESSION)
//   pass:<path>                      pass            (`pass show <path>`, first line)
// References can only be REGISTERED by a person in a terminal: a reference pinned to an attacker-chosen origin would
// otherwise let an agent route a password out of your password manager to that origin.
import { spawnSync } from 'node:child_process';

const SAFE = /^[A-Za-z0-9 _.@:+/?=~-]{1,300}$/; // no quotes, %, &, |, <, >, ^, ;, $, backticks: safe even through cmd.exe

export function parseRef(ref) {
  if (typeof ref !== 'string' || !SAFE.test(ref)) return null;
  if (ref.startsWith('op://')) return { kind: 'op', ref };
  if (ref.startsWith('bw:')) return /^bw:[0-9a-fA-F-]{8,64}$/.test(ref) ? { kind: 'bw', id: ref.slice(3) } : null;
  if (ref.startsWith('pass:')) return /^pass:[A-Za-z0-9_./@ +-]{1,200}$/.test(ref) && !ref.includes('..') ? { kind: 'pass', path: ref.slice(5) } : null;
  return null;
}

export class SecretUnavailable extends Error { constructor(m) { super(m); this.code = 'SECRET_UNAVAILABLE'; } }

function cli(cmd, args) {
  // On Windows many password-manager CLIs are .cmd shims; args are validated above, and quoted here.
  const win = process.platform === 'win32';
  const r = spawnSync(cmd, win ? args.map((a) => `"${a}"`) : args, { encoding: 'utf8', timeout: 60_000, shell: win, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (r.error || r.status !== 0) {
    const why = (r.stderr || r.error?.message || '').split(/\r?\n/).find(Boolean) || `exit ${r.status}`;
    throw new SecretUnavailable(`${cmd} could not provide the secret (${why.slice(0, 140)}). Is it installed, signed in and unlocked?`);
  }
  return r.stdout.replace(/\r?\n$/, '');
}

/** field: 'password' | 'username' | 'totp' */
export function resolveRef(ref, field = 'password') {
  const p = parseRef(ref);
  if (!p) throw new SecretUnavailable('invalid reference');
  let v;
  if (p.kind === 'op') v = cli('op', ['read', p.ref]);
  else if (p.kind === 'bw') v = cli('bw', ['get', field === 'totp' ? 'totp' : field, p.id]);
  else v = cli('pass', ['show', p.path]).split(/\r?\n/)[0];
  if (!v) throw new SecretUnavailable('the password manager returned an empty value');
  return v;
}

/** Turns the decrypted record into usable values. References are resolved NOW, in memory, and never stored. */
export function resolveSecrets(raw) {
  const out = { ...raw };
  if (raw.passwordRef) out.password = resolveRef(raw.passwordRef, 'password');
  if (raw.usernameRef) out.username = resolveRef(raw.usernameRef, 'username');
  return out; // totpRef is resolved at fill time (a code must be fresh)
}

export const looksLikeCode = (s) => /^\d{6,8}$/.test(String(s).trim());
