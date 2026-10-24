// Zero-prerequisite install: agent-browser comes with the package (or is fetched on first use), never from a PATH lookup first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'hallpass.mjs');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const bundled = (() => { try { return createRequire(import.meta.url).resolve('agent-browser/package.json'); } catch { return null; } })();
const hh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hp-setup-'));
const node = (args, env = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, HALLPASS_HOME: hh(), HALLPASS_NO_UI: '1', HALLPASS_KEYSTORE: 'file', ...env } });

test('package: agent-browser is a dependency on the tested line, installed by npm alongside hallpass', () => {
  assert.match(pkg.dependencies?.['agent-browser'] || '', /^~0\.39\./, 'pinned to the tested release line');
  assert.equal(pkg.scripts.postinstall, 'node bin/postinstall.mjs');
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'postinstall.mjs')) && pkg.files.includes('bin'));
});

test('postinstall never fails an install, and can be skipped', () => {
  for (const env of [{ HALLPASS_SKIP_POSTINSTALL: '1' }, { HALLPASS_NO_AUTO_INSTALL: '1' }, { CI: '1' }]) {
    const r = node([path.join(ROOT, 'bin', 'postinstall.mjs')], env);
    assert.equal(r.status, 0, r.stderr);
  }
});

test('the bundled agent-browser wins over whatever PATH offers', { skip: !bundled && 'npm install has not been run in this checkout' }, () => {
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-evil-'));
  fs.writeFileSync(path.join(evil, 'agent-browser'), '#!/bin/sh\necho evil\n', { mode: 0o755 });
  const r = node(['--input-type=module', '-e', `import { findBinary } from '${path.join(ROOT, 'src', 'ab.mjs').replace(/\\/g, '/')}'; console.log(findBinary())`], { PATH: evil + path.delimiter + path.dirname(process.execPath) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().startsWith(path.dirname(bundled)), r.stdout);
});

test('hallpass setup is idempotent: with everything present it installs nothing', { skip: !bundled && 'npm install has not been run in this checkout', timeout: 180_000 }, () => {
  const r = node([BIN, 'setup']);
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(out.status, 'ready');
  const again = JSON.parse(node([BIN, 'setup']).stdout);
  assert.deepEqual(again.installed, [], 'second run installs nothing');
});

test('with auto-install off and nothing to install, setup still reports ready; the MCP gate is not triggered', { skip: !bundled && 'npm install has not been run in this checkout', timeout: 180_000 }, () => {
  const r = node([BIN, 'setup'], { HALLPASS_NO_AUTO_INSTALL: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
