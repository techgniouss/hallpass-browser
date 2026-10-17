// Operations features: export/import, session hygiene, file keystore, init.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'hallpass.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ops-'));
process.env.HALLPASS_HOME = HOME;
const vault = await import('../src/vault.mjs');
const { exportVault, importVault } = await import('../src/portable.mjs');
const { listSessions, pruneSessions } = await import('../src/sessions.mjs');
const keystoreOk = process.platform === 'win32' || process.env.HALLPASS_KEYSTORE === 'file' || !!process.env.HALLPASS_TEST_LIBSECRET;
const skipKs = { skip: !keystoreOk };

const meta = { url: 'https://x.test/login', allowed: ['https://x.test'], userHint: 'u***', hasTotp: false };

test('export/import: round-trips every entry (including references), rejects wrong passphrases and tampering', skipKs, () => {
  vault.put('exp-a', meta, { username: 'a@x.test', password: 'Secret-Passw0rd-A' });
  vault.put('exp-b', { ...meta, source: 'op' }, { username: 'b@x.test', passwordRef: 'op://v/i/password' });
  assert.throws(() => exportVault('short'), /at least 12/);
  const bundle = exportVault('correct horse battery staple');
  const raw = JSON.stringify(bundle);
  assert.ok(!raw.includes('Secret-Passw0rd-A') && !raw.includes('a@x.test') && !raw.includes('op://'), 'bundle is opaque');

  assert.throws(() => importVault(bundle, 'wrong passphrase here'), /wrong passphrase/);
  assert.throws(() => importVault({ ...bundle, ct: Buffer.from(bundle.ct, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b)).toString('base64') }, 'correct horse battery staple'), /wrong passphrase|modified/);
  assert.throws(() => importVault({ format: 'nope' }, 'x'), /not a hallpass export/);

  for (const n of ['exp-a', 'exp-b']) vault.remove(n);
  const r = importVault(bundle, 'correct horse battery staple');
  assert.deepEqual(r.imported.sort(), ['exp-a', 'exp-b']);
  assert.deepEqual(vault.unseal('exp-a'), { username: 'a@x.test', password: 'Secret-Passw0rd-A' });
  assert.deepEqual(vault.unseal('exp-b'), { username: 'b@x.test', passwordRef: 'op://v/i/password' });

  const again = importVault(bundle, 'correct horse battery staple');
  assert.deepEqual(again.imported, [], 'existing entries are not overwritten by default');
  assert.equal(again.skipped.length, 2);
  assert.equal(importVault(bundle, 'correct horse battery staple', { force: true }).imported.length, 2);
});

test('export/import: CLI refuses without a real terminal (an agent cannot dump the vault)', () => {
  for (const args of [['export', path.join(HOME, 'dump.json')], ['import', path.join(HOME, 'dump.json')]]) {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input: 'pw\n', env: { ...process.env, HALLPASS_HOME: HOME } });
    assert.equal(JSON.parse(r.stdout).status, 'usage_error', args[0]);
  }
  assert.ok(!fs.existsSync(path.join(HOME, 'dump.json')));
});

test('sessions: listing and pruning only touch saved browser profiles, never credentials', skipKs, () => {
  const prof = path.join(HOME, 'profiles');
  for (const n of ['site-fresh.test', 'site-stale.test', 'exp-a']) { fs.mkdirSync(path.join(prof, n), { recursive: true }); fs.writeFileSync(path.join(prof, n, 'Cookies'), 'x'.repeat(2048)); }
  const old = new Date(Date.now() - 60 * 86400e3);
  fs.utimesSync(path.join(prof, 'site-stale.test'), old, old);
  fs.utimesSync(path.join(prof, 'site-stale.test', 'Cookies'), old, old);

  const list = listSessions();
  const by = Object.fromEntries(list.map((s) => [s.name, s]));
  assert.equal(by['site-fresh.test'].kind, 'saved-login-site');
  assert.equal(by['exp-a'].kind, 'credential-profile');
  assert.ok(by['site-stale.test'].age_days >= 59);
  assert.equal(by['site-fresh.test'].running, false);

  const dry = pruneSessions({ olderThan: '30d', dryRun: true });
  assert.deepEqual(dry.removed, ['site-stale.test']);
  assert.ok(fs.existsSync(path.join(prof, 'site-stale.test')), 'dry run deletes nothing');
  assert.deepEqual(pruneSessions({ olderThan: '30d' }).removed, ['site-stale.test']);
  assert.ok(!fs.existsSync(path.join(prof, 'site-stale.test')) && fs.existsSync(path.join(prof, 'site-fresh.test')));
  assert.ok(vault.exists('exp-a'), 'credentials untouched');
  assert.throws(() => pruneSessions({ olderThan: 'soon' }), /12h, 30d or 2w/);
});

test('file keystore: explicit opt-in only; works end to end in its own vault', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-file-'));
  const run = (args, input, env = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input, env: { ...process.env, HALLPASS_HOME: home, ...env } });
  const add = run(['add', 'fk', '--url', 'https://f.test/login', '--stdin-json'], JSON.stringify({ username: 'u@f.test', password: 'file-key-password' }), { HALLPASS_KEYSTORE: 'file' });
  assert.equal(JSON.parse(add.stdout).status, 'saved', add.stdout + add.stderr);
  assert.match(JSON.parse(add.stdout).sealed_with, /file \(opt-in/);
  assert.ok(fs.existsSync(path.join(home, 'master.key')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'master.key')).mode & 0o077, 0, 'owner-only permissions');
  assert.ok(!fs.readFileSync(path.join(home, 'entries', 'fk.json'), 'utf8').includes('file-key-password'));
  assert.equal(JSON.parse(run(['show', 'fk']).stdout).name, 'fk');
  if (process.platform === 'win32') assert.ok(!fs.existsSync(path.join(home, 'master.key.dpapi')), 'never silently used the OS store');
  const doc = JSON.parse(run(['doctor'], '', { HALLPASS_KEYSTORE: 'file' }).stdout);
  assert.match(JSON.stringify(doc.checks), /file \(opt-in/);
});

test('init: dry run lists detected tools; --yes installs only user-level instructions for tools that exist', () => {
  const th = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-initHome-'));
  for (const d of ['.claude', '.codex', '.cursor']) fs.mkdirSync(path.join(th, d));
  const env = { ...process.env, HALLPASS_HOME: HOME, HALLPASS_TARGET_HOME: th };
  const run = (...a) => JSON.parse(spawnSync(process.execPath, [BIN, 'init', ...a], { encoding: 'utf8', env, cwd: th }).stdout);
  const dry = run();
  assert.deepEqual(dry.detected.sort(), ['claude', 'codex', 'cursor']);
  assert.deepEqual(dry.applied, []);
  assert.ok(!fs.existsSync(path.join(th, '.claude', 'skills')));
  const cursor = dry.plan.find((p) => p.tool === 'cursor');
  assert.match(cursor.scope, /project/);

  const yes = run('--yes');
  assert.deepEqual(yes.applied.map((a) => a.target).sort(), ['claude', 'codex']);
  assert.ok(fs.existsSync(path.join(th, '.claude', 'skills', 'hallpass', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(th, '.codex', 'AGENTS.md')));
  assert.ok(!fs.existsSync(path.join(th, '.gemini')), 'tools that are not installed are left alone');
  assert.ok(!fs.existsSync(path.join(th, '.cursor', 'rules')), 'project-level files are never written by init');
});
