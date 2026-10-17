import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeFakeClis } from './fake-clis.mjs';

const BIN = makeFakeClis();
process.env.PATH = BIN + path.delimiter + process.env.PATH;
process.env.HP_FAKE_PW = 'Fake-Pw-12345';
process.env.HP_FAKE_USER = 'fake.user@example.test';
process.env.HP_FAKE_TOTP = '123456';
const { parseRef, resolveRef, resolveSecrets, SecretUnavailable } = await import('../src/refs.mjs');

test('parseRef: accepts the three supported forms', () => {
  assert.equal(parseRef('op://Personal/Supabase/password').kind, 'op');
  assert.equal(parseRef('op://Personal/Play Console/one-time password?attribute=otp').kind, 'op');
  assert.equal(parseRef('bw:6b5f6c1e-1111-2222-3333-444455556666').kind, 'bw');
  assert.equal(parseRef('pass:work/github.com').kind, 'pass');
});

test('parseRef: rejects anything that could inject into a shell or escape the intended item', () => {
  for (const bad of [
    'op://v/i/f" & calc', 'op://v/i/f$(whoami)', 'op://v/i/f`x`', 'op://v/i/f;rm -rf /', 'op://v/i/f|x', 'op://v/i/f%PATH%',
    'op://v/i/f\nnext', 'bw:../../x', 'bw:abc', 'pass:../../etc/passwd', 'pass:a/../b', 'ftp://x', 'plain-text', '', 'op://' + 'a'.repeat(400), null, 42,
  ]) assert.equal(parseRef(bad), null, JSON.stringify(bad));
});

test('resolve: op / bw / pass return the value and strip the trailing newline; pass uses line 1 only', () => {
  assert.equal(resolveRef('op://v/i/password'), 'Fake-Pw-12345');
  assert.equal(resolveRef('op://v/i/otp', 'totp'), '123456');
  assert.equal(resolveRef('bw:6b5f6c1e-1111-2222-3333-444455556666', 'password'), 'Fake-Pw-12345');
  assert.equal(resolveRef('bw:6b5f6c1e-1111-2222-3333-444455556666', 'username'), 'fake.user@example.test');
  assert.equal(resolveRef('bw:6b5f6c1e-1111-2222-3333-444455556666', 'totp'), '123456');
  assert.equal(resolveRef('pass:work/github.com'), 'Fake-Pw-12345');
});

test('resolveSecrets: replaces references with values in memory and leaves plain secrets alone', () => {
  const r = resolveSecrets({ username: 'u@x.test', passwordRef: 'op://v/i/password', totpRef: 'op://v/i/otp' });
  assert.equal(r.password, 'Fake-Pw-12345');
  assert.equal(r.totpRef, 'op://v/i/otp', 'totp is resolved later, when a fresh code is needed');
  assert.deepEqual(resolveSecrets({ username: 'u', password: 'plain-password' }), { username: 'u', password: 'plain-password' });
  const viaUserRef = resolveSecrets({ usernameRef: 'bw:6b5f6c1e-1111-2222-3333-444455556666', passwordRef: 'op://v/i/password' });
  assert.equal(viaUserRef.username, 'fake.user@example.test');
});

test('resolve: a locked or missing manager is a clear error that never contains a secret', () => {
  process.env.HP_FAKE_FAIL = '1';
  try {
    assert.throws(() => resolveRef('op://v/i/password'), (e) => e instanceof SecretUnavailable && /locked/.test(e.message) && !e.message.includes('Fake-Pw'));
  } finally { delete process.env.HP_FAKE_FAIL; }
  assert.throws(() => resolveRef('nonsense'), SecretUnavailable);
});
