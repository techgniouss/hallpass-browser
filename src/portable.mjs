// Encrypted export / import of the vault, for moving machines (the vault itself is bound to this OS account).
// The bundle is AES-256-GCM under a scrypt-derived key from a passphrase only the person knows.
// It is the ONE path that turns vault contents into bytes you can carry, so the CLI exposes it to a real terminal only.
import crypto from 'node:crypto';
import * as vault from './vault.mjs';
import { audit } from './audit.mjs';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const MIN_PASSPHRASE = 12;
const key = (pass, salt) => crypto.scryptSync(pass.normalize('NFKC'), salt, 32, SCRYPT);

export function exportVault(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const entries = vault.list().filter((e) => !e.error).map(({ name, ...meta }) => ({ name, meta, secrets: vault.unseal(name) }));
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  c.setAAD(Buffer.from('hallpass-export-v1'));
  const ct = Buffer.concat([c.update(JSON.stringify({ exportedAt: new Date().toISOString(), entries }), 'utf8'), c.final()]);
  audit('export', { count: entries.length });
  return { format: 'hallpass-export', v: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

export function importVault(bundle, passphrase, { force = false } = {}) {
  if (bundle?.format !== 'hallpass-export' || bundle.v !== 1) throw new Error('not a hallpass export file');
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(passphrase || '', Buffer.from(bundle.salt, 'base64')), Buffer.from(bundle.iv, 'base64'));
    d.setAAD(Buffer.from('hallpass-export-v1'));
    d.setAuthTag(Buffer.from(bundle.tag, 'base64'));
    plain = JSON.parse(Buffer.concat([d.update(Buffer.from(bundle.ct, 'base64')), d.final()]).toString('utf8'));
  } catch { throw new Error('wrong passphrase, or the file was modified'); }
  const result = { imported: [], skipped: [] };
  for (const e of plain.entries) {
    if (!vault.validName(e.name)) { result.skipped.push({ name: String(e.name).slice(0, 40), why: 'invalid name' }); continue; }
    if (vault.exists(e.name) && !force) { result.skipped.push({ name: e.name, why: 'exists (use --force to replace)' }); continue; }
    vault.put(e.name, e.meta, e.secrets);
    result.imported.push(e.name);
  }
  audit('import', { imported: result.imported.length, skipped: result.skipped.length });
  return result;
}
