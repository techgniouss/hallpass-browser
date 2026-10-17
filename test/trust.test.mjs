// Can an agent with a shell redirect the programs hallpass trusts? (PATH / env tricks on a single command line)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const imp = (rel) => 'file:///' + path.join(ROOT, rel).replace(/\\/g, '/');

test('findBinary ignores an env override and PATH tricks once pinned', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-trust-'));
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-evil-'));
  const exe = process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser';
  fs.copyFileSync(process.execPath, path.join(evil, exe)); // an executable named agent-browser that is not agent-browser
  const find = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', `import {findBinary} from '${imp('src/ab.mjs')}'; process.stdout.write(findBinary())`], { encoding: 'utf8', env: { ...process.env, HALLPASS_HOME: home, ...env } }).stdout;

  const legit = find({});
  assert.ok(legit && !legit.startsWith(evil), 'legit binary resolved: ' + legit);

  assert.equal(find({ HALLPASS_AB_BIN: path.join(evil, exe) }), legit, 'the env override no longer exists');
  const hijacked = find({ PATH: evil + path.delimiter + process.env.PATH });
  assert.equal(hijacked, legit, 'after the first resolution the path is pinned; PATH cannot redirect it');
  assert.ok(fs.existsSync(path.join(home, 'config.json')), 'pin is persisted');
});

test('trusted system programs are launched by absolute path, never by bare name', async () => {
  // A bare name is resolved through PATH/cwd, so an agent could substitute a fake that answers "Allow" or reads the master key.
  const bare = /spawn(Sync)?\(\s*['"](powershell(\.exe)?|osascript|security|secret-tool|zenity|kdialog|notify-send|xdg-open|rundll32|open)['"]/;
  for (const f of fs.readdirSync(path.join(ROOT, 'src')).filter((n) => n.endsWith('.mjs'))) {
    assert.ok(!bare.test(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')), f + ' launches a trusted program by bare name');
  }
  const { sysExe } = await import(imp('src/sysexe.mjs'));
  const known = { win32: 'powershell', darwin: 'osascript', linux: 'sh' }[process.platform];
  const p = sysExe(known);
  assert.ok(p && path.isAbsolute(p) && fs.existsSync(p), 'resolves to an absolute existing path: ' + p);
  assert.equal(sysExe('definitely-not-a-program'), null);
  if (process.platform === 'win32') assert.match(p.toLowerCase(), /\\windows\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/);
});
