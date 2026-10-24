// File upload, screenshot-to-file, and typed text that looks like a flag: vetting (no browser) and the real thing (browser).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'hallpass.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-upload-'));
const FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-files-'));
process.env.HALLPASS_HOME = HOME;
process.env.HALLPASS_OUT = path.join(FILES, 'out');
const { vetUploadFile, vetUploads, screenshotCommand } = await import('../src/upload.mjs');
const { runBrowser, guardBrowser, isRiskyLabel } = await import('../src/act.mjs');

const put = (rel, content = 'data-data') => { const f = path.join(FILES, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };

test('upload vetting: ordinary release assets pass, secrets and config do not', () => {
  for (const n of ['app-release.aab', 'phone-1.png', 'shot.JPG', 'notes.txt', 'symbols.zip', 'promo.mp4']) assert.equal(vetUploadFile(put(n)).ok, true, n);
  for (const n of ['vault.json', 'id_rsa', 'upload.keystore', 'release.jks', 'server.pem', 'cert.p12', 'run.sh', 'noext']) assert.equal(vetUploadFile(put(n)).ok, false, n);
  assert.match(vetUploadFile(put('.ssh/shot.png')).error, /hidden|config/);
  assert.match(vetUploadFile(put('proj/.git/shot.png')).error, /hidden|config/);
  assert.match(vetUploadFile(put('creds.txt', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc')).error, /private key/);
  assert.match(vetUploadFile(put('sa.txt', '{"private_key": "x"}')).error, /private key/);
  assert.match(vetUploadFile(path.join(FILES, 'nope.png')).error, /not found/);
  assert.match(vetUploadFile(FILES).error, /not a regular file/);
  assert.match(vetUploadFile(put('empty.png', '')).error, /empty/);
  assert.match(vetUploadFile('--executable-path').error, /flag/);
});

test('upload vetting: a symlink cannot smuggle in a vault file; the hallpass home is fenced', () => {
  const secret = path.join(HOME, 'vault.txt');
  fs.writeFileSync(secret, 'sealed');
  assert.match(vetUploadFile(secret).error, /hidden|protected/);
  const link = path.join(FILES, 'innocent.png');
  try { fs.symlinkSync(secret, link); } catch { return; } // symlinks need privileges on some Windows setups
  assert.equal(vetUploadFile(link).ok, false, 'resolved through the link');
});

test('upload vetting: batches are bounded and resolve to absolute paths', () => {
  assert.ok(vetUploads([]).error);
  assert.ok(vetUploads(Array.from({ length: 21 }, (_, i) => put(`m${i}.png`))).error);
  const prev = process.cwd(); process.chdir(FILES);
  try { const r = vetUploads(['phone-1.png']); assert.equal(path.isAbsolute(r.files[0].path), true); } finally { process.chdir(prev); }
});

test('screenshot names cannot escape the output folder', () => {
  const out = process.env.HALLPASS_OUT;
  for (const given of ['../../etc/passwd', '/etc/cron.d/x', '..\\..\\x', '.hidden', 'a b?.png']) {
    const { command, file } = screenshotCommand(['screenshot', '--full', given]);
    assert.equal(path.dirname(file), out, given);
    assert.ok(/\.(png|jpe?g)$/.test(file), file);
    assert.deepEqual(command.slice(0, 2), ['screenshot', '--full']);
  }
  assert.match(screenshotCommand(['screenshot'], 42).file, /shot-42\.png$/);
});

test('guard: typed text may look like a flag or a URL scheme, real flags and URLs still may not', () => {
  const g = (...command) => guardBrowser({ session: 'hp-x', command });
  for (const c of [['fill', '@e1', '--- fixed crashes'], ['fill', '@e1', '--json'], ['type', '@e1', 'Data: we collect none'], ['keyboard', 'type', 'file: notes'], ['find', 'label', 'Notes', 'fill', '-x'], ['upload', 'input[type=file]', '/tmp/a.png']]) assert.equal(g(...c), null, c.join(' '));
  for (const c of [['click', '--proxy'], ['open', 'file:///etc/passwd'], ['open', 'javascript:alert(1)'], ['snapshot', '--headed'], ['eval', '1'], ['download', '@e1', '/tmp/x']]) assert.ok(g(...c), c.join(' '));
});

test('gate: Play Console style "create release" is routine, "start rollout" and "publish" are not', () => {
  for (const l of ['Create new release', 'Review release', 'Release notes', 'Edit release', 'View releases', 'Release name', 'Release dashboard']) assert.equal(isRiskyLabel(l), false, l);
  for (const l of ['Start rollout to Internal testing', 'Publish release', 'Send 7 changes for review', 'Release to production', 'Roll out release', 'Submit']) assert.equal(isRiskyLabel(l), true, l);
});

let site, port;
before(async () => {
  site = spawn(process.execPath, [path.join(HERE, 'site-proc.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  port = await new Promise((resolve) => site.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
});
after(() => { site?.stdin.end(); });

function openSession() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, 'open', `http://127.0.0.1:${port}/play/app`, '--headless'], { env: { ...process.env, HALLPASS_HOME: HOME, HALLPASS_NO_UI: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('open failed: ' + out)); } });
  });
}
const run = (session, command, approver) => runBrowser({ session, command }, approver ? { approver } : undefined);
const text = (session, sel) => run(session, ['get', 'text', sel]).text;

test('real browser: upload to a hidden file input, approval, and the one-hour grant', { timeout: 300_000 }, async () => {
  const opened = await openSession();
  assert.equal(opened.status, 'logged_in', JSON.stringify(opened));
  const s = opened.session;
  const aab = put('app-release.aab', 'x'.repeat(5000)), png = put('phone-1.png', 'PNG');
  try {
    // no desktop dialog available (HALLPASS_NO_UI) = denied, and nothing reaches the page
    process.env.HALLPASS_NO_UI = '1';
    const none = run(s, ['upload', '#f', aab]);
    assert.equal(none.isError, true); assert.match(none.text, /did not approve/);
    assert.ok(!/app-release/.test(text(s, '#o')));

    // the person denies
    assert.match(run(s, ['upload', '#f', aab], () => 'deny').text, /did not approve/);

    // the person allows once: the dialog names the file and the site, and the page really receives it
    let shown = '';
    const once = run(s, ['upload', '#f', aab, png], ({ message }) => { shown = message; return 'once'; });
    assert.equal(once.isError, false, once.text);
    assert.match(shown, /app-release\.aab/); assert.match(shown, /127\.0\.0\.1/);
    assert.match(text(s, '#o'), /app-release\.aab:5000,phone-1\.png:3/);

    // "allow for 1 hour" is remembered for that site: the next upload asks nothing
    assert.equal(run(s, ['upload', '#f', png], () => 'hour').isError, false);
    let asked = false;
    assert.equal(run(s, ['upload', '#f', aab], () => { asked = true; return 'deny'; }).isError, false);
    assert.equal(asked, false, 'granted site is not asked again');

    // vetting still applies after a grant
    const bad = run(s, ['upload', '#f', path.join(HOME, 'vault.txt')], () => 'once');
    assert.equal(bad.isError, true); assert.match(bad.text, /refused/);
    assert.equal(run(s, ['upload', '#f', put('keys.json', '{}')], () => 'once').isError, true);

    // a read-only server cannot upload at all
    process.env.HALLPASS_READONLY = '1';
    assert.match(run(s, ['upload', '#f', png], () => 'once').text, /read-only/);
    delete process.env.HALLPASS_READONLY;

    // uploads can be switched off outright
    process.env.HALLPASS_UPLOAD = 'off';
    assert.match(run(s, ['upload', '#f', png], () => 'once').text, /disabled/);
    delete process.env.HALLPASS_UPLOAD;
  } finally { run(s, ['snapshot']); spawnSync(process.execPath, [BIN, 'logout', opened.name], { env: { ...process.env, HALLPASS_HOME: HOME } }); }
});

test('real browser: release notes starting with dashes, screenshot to a file, and routine vs final buttons', { timeout: 300_000 }, async () => {
  const opened = await openSession();
  const s = opened.session;
  try {
    for (const notes of ['--- Fixed crashes\n--- Faster start', '--json', '- bullet', 'Data: nothing is collected']) {
      const r = run(s, ['fill', '#notes', notes]);
      assert.equal(r.isError, false, notes + ' -> ' + r.text);
      assert.ok(run(s, ['get', 'value', '#notes']).text.includes(notes), 'typed literally: ' + notes);
    }
    const shot = run(s, ['screenshot', '--full', '../../evil.png']);
    assert.equal(shot.isError, false, shot.text);
    const saved = /Saved to (.+)$/m.exec(shot.text)?.[1];
    assert.equal(path.dirname(saved), process.env.HALLPASS_OUT);
    assert.ok(fs.statSync(saved).size > 500, 'a real PNG was written');
    assert.equal(fs.existsSync(path.join(FILES, '..', 'evil.png')), false);

    // a click whose label cannot be read is not waved through: the person is asked (fail closed)
    let asked = '';
    run(s, ['click', '#no-such-element'], ({ message }) => { asked = message; return 'deny'; });
    assert.match(asked, /confirm|wants to click/i, 'an unreadable target is put to the person');

    process.env.HALLPASS_NO_UI = '1';
    assert.equal(run(s, ['click', '#create']).isError, false, '"Create new release" is not interrupted');
    assert.match(run(s, ['get', 'title']).text, /CREATED/);
    assert.match(run(s, ['click', '#go']).text, /Blocked/, '"Start rollout" needs the person');
    assert.ok(!/ROLLED/.test(run(s, ['get', 'title']).text));
  } finally { spawnSync(process.execPath, [BIN, 'logout', opened.name], { env: { ...process.env, HALLPASS_HOME: HOME } }); }
});
