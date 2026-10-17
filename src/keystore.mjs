// Seals the vault master key to the OS user account. The key never touches argv or disk in the clear.
//   Windows: DPAPI (CurrentUser scope) via PowerShell, data passed over stdin.
//   macOS:   login Keychain via `security`.            (untested - see SECURITY.md)
//   Linux:   libsecret via `secret-tool`, stdin only.  (untested - see SECURITY.md)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { home } from './paths.mjs';
import { sysExe } from './sysexe.mjs';

const need = (n) => sysExe(n) || (() => { throw new Error(`required system program "${n}" not found in a trusted location`); })();

const ENTROPY = 'hallpass-v1';

function ps(mode, b64) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())
$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$r=[Security.Cryptography.ProtectedData]::${mode}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($r))`;
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync(need('powershell'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { input: b64, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('DPAPI ' + mode.toLowerCase() + ' failed: ' + (r.stderr || '').trim().split('\n')[0]);
  return r.stdout.trim();
}

const wrappedPath = () => path.join(home(), 'master.key.dpapi');

const backends = {
  win32: {
    name: 'Windows DPAPI (CurrentUser)',
    load() { const p = wrappedPath(); return fs.existsSync(p) ? Buffer.from(ps('Unprotect', fs.readFileSync(p, 'utf8')), 'base64') : null; },
    store(key) { fs.writeFileSync(wrappedPath(), ps('Protect', key.toString('base64')), { mode: 0o600 }); },
  },
  darwin: {
    name: 'macOS Keychain',
    load() {
      const r = spawnSync(need('security'), ['find-generic-password', '-s', 'hallpass', '-a', 'master', '-w'], { encoding: 'utf8' });
      return r.status === 0 ? Buffer.from(r.stdout.trim(), 'hex') : null;
    },
    store(key) {
      // `security` has no stdin mode for -w; the key is briefly visible in argv once, at vault creation only.
      const r = spawnSync(need('security'), ['add-generic-password', '-U', '-s', 'hallpass', '-a', 'master', '-w', key.toString('hex')], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error('keychain store failed');
    },
  },
  linux: {
    name: 'libsecret (secret-tool)',
    load() {
      const r = spawnSync(need('secret-tool'), ['lookup', 'service', 'hallpass', 'account', 'master'], { encoding: 'utf8' });
      return r.status === 0 && r.stdout.trim() ? Buffer.from(r.stdout.trim(), 'hex') : null;
    },
    store(key) {
      const r = spawnSync(need('secret-tool'), ['store', '--label=hallpass master key', 'service', 'hallpass', 'account', 'master'], { input: key.toString('hex'), encoding: 'utf8' });
      if (r.status !== 0) throw new Error('secret-tool store failed (is libsecret-tools installed and a keyring unlocked?)');
    },
  },
};

// Explicit opt-in for containers/CI/servers with no OS keystore. The master key sits in a 0600 file next to the vault:
// it keeps other OS users out, and nothing else. Never chosen automatically.
const fileBackend = {
  name: 'file (opt-in; protects against other OS users only, NOT against code running as you)',
  load() { const p = path.join(home(), 'master.key'); return fs.existsSync(p) ? Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex') : null; },
  store(key) { fs.writeFileSync(path.join(home(), 'master.key'), key.toString('hex'), { mode: 0o600 }); },
};

export function backend() {
  if (process.env.HALLPASS_KEYSTORE === 'file') return fileBackend;
  const b = backends[process.platform];
  if (!b) throw new Error(`unsupported platform ${process.platform}`);
  return b;
}

let cached = null;
export function masterKey({ create = true } = {}) {
  if (cached) return cached;
  const b = backend();
  const existing = b.load();
  if (existing) return (cached = existing);
  if (!create) return null;
  const key = crypto.randomBytes(32);
  b.store(key);
  return (cached = key);
}
