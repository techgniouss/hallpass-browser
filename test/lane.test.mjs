// Parallel lanes: keys, seeding, filtering from accounts, cleanup. No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-lane-'));
process.env.HALLPASS_HOME = HOME;
process.env.HALLPASS_NO_BROWSER = '1';
const acc = await import('../src/accounts.mjs');
const { seedLane } = await import('../src/lane.mjs');
const { listSessions } = await import('../src/sessions.mjs');
const vault = await import('../src/vault.mjs');
const { logout } = await import('../src/login.mjs');

const prof = (key) => path.join(HOME, 'profiles', key);
const PLAY = 'https://play.google.com/console/u/0/developers';

test('lane keys: round-trip, validation, length cap', () => {
  assert.equal(acc.laneKey('play-console', 'app2'), 'play-console_l_app2');
  assert.deepEqual(acc.splitLane('play-console_l_app2'), { base: 'play-console', lane: 'app2' });
  assert.deepEqual(acc.splitLane('site-play.google.com__work_l_2'), { base: 'site-play.google.com__work', lane: '2' });
  assert.equal(acc.splitLane('play-console'), null);
  for (const bad of ['', 'A', 'a_b', '-x', 'a'.repeat(17), 'a b']) assert.throws(() => acc.laneKey('x', bad), /lane must be/);
  assert.throws(() => acc.laneKey('a'.repeat(60), 'lane1'), /too long/);
});

test('vault refuses names that look like lane keys', () => {
  assert.throws(() => vault.put('foo_l_bar', {}, {}), /reserved for parallel browser lanes/);
});

test('seedLane copies the cookie store, skips locks and caches, and leaves an existing lane alone', () => {
  const base = prof('site-play.google.com__work');
  fs.mkdirSync(path.join(base, 'Default', 'Network'), { recursive: true });
  fs.mkdirSync(path.join(base, 'Default', 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(base, 'Default', 'Network', 'Cookies'), 'store-bytes');
  fs.writeFileSync(path.join(base, 'Default', 'Cache', 'big'), 'x');
  fs.writeFileSync(path.join(base, 'SingletonLock'), 'pid');
  const lane = 'site-play.google.com__work_l_2';
  const r = seedLane('site-play.google.com__work', lane);
  assert.deepEqual([r.created, r.seeded, r.failed], [true, true, 0]);
  assert.equal(fs.readFileSync(path.join(prof(lane), 'Default', 'Network', 'Cookies'), 'utf8'), 'store-bytes');
  assert.ok(!fs.existsSync(path.join(prof(lane), 'SingletonLock')));
  assert.ok(!fs.existsSync(path.join(prof(lane), 'Default', 'Cache')));
  fs.writeFileSync(path.join(prof(lane), 'marker'), 'mine');
  assert.equal(seedLane('site-play.google.com__work', lane).created, false);
  assert.ok(fs.existsSync(path.join(prof(lane), 'marker')));
});

test('seedLane with no base login starts an empty lane, not seeded', () => {
  const r = seedLane('site-nothing.test', 'site-nothing.test_l_a');
  assert.deepEqual([r.created, r.seeded], [true, false]);
  assert.ok(fs.existsSync(prof('site-nothing.test_l_a')));
});

test('lanes never show up as accounts for a site, but are listed as lanes', () => {
  const key = acc.siteKey(PLAY, 'work');
  fs.mkdirSync(prof(key), { recursive: true });
  fs.mkdirSync(prof(acc.laneKey(key, '2')), { recursive: true });
  assert.deepEqual(acc.accountsFor(PLAY).accounts.map((a) => a.as), ['work']);
  assert.ok(acc.allAccounts().every((s) => s.accounts.every((a) => !/_l_/.test(a.name))));
  const lane = listSessions().find((s) => s.name === acc.laneKey(key, '2'));
  assert.equal(lane.kind, 'lane');
  assert.equal(lane.lane_of, key);
  assert.equal(lane.host, undefined);
});

test('closing a lane removes its profile; closing the base keeps it', () => {
  const key = acc.siteKey(PLAY, 'work');
  const lk = acc.laneKey(key, '2');
  assert.ok(fs.existsSync(prof(lk)));
  const r = logout(lk);
  assert.equal(r.profile_wiped, true);
  assert.equal(r.lane, '2');
  assert.ok(!fs.existsSync(prof(lk)));
  assert.equal(logout(key).profile_wiped, false);
  assert.ok(fs.existsSync(prof(key)));
});
